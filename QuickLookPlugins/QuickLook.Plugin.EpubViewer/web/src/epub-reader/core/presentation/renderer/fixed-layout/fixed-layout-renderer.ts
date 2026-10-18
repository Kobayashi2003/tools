import {
  inspectSvgIntrinsicViewport,
  inspectXhtmlIntrinsicViewport,
  type PublicationContentDocumentCache,
} from '../../../epub/content';
import type {
  ContentPresentationHints,
  IntrinsicViewport,
  Locator,
  Publication,
  PublicationDiagnostic,
} from '../../../epub/publication';
import type { RenditionPlan, RendererKind } from '../../rendition';
import { BrowserIFrameContentSurface } from '../browser-iframe-surface';
import { LifecycleScope } from '../lifecycle';
import type {
  ContentSurface,
  LayoutStabilityReport,
  LayoutTransactionContext,
  RendererFactory,
  RendererInstance,
} from '../model';
import { calculateFixedLayoutPlacement } from './geometry';
import {
  DEFAULT_FIXED_LAYOUT_RENDERER_POLICY,
  type FixedLayoutPlacement,
  type FixedLayoutHorizontalAlignment,
  type FixedLayoutRendererPolicy,
  type FixedLayoutSnapshot,
} from './model';

export interface FixedLayoutRendererEnvironment {
  readonly container: HTMLElement;
  readonly publication: Publication;
  readonly contentDocumentCache: PublicationContentDocumentCache;
  readonly policy?: FixedLayoutRendererPolicy;
  readonly resolveHorizontalAlignment?: (
    plan: RenditionPlan,
  ) => FixedLayoutHorizontalAlignment;
  readonly createSurface?: () => ContentSurface;
  readonly onDiagnostics?: (
    diagnostics: readonly PublicationDiagnostic[],
  ) => void;
  readonly onPresentationHints?: (hints: ContentPresentationHints) => void;
}

export function createFixedLayoutRendererFactory(
  environment: FixedLayoutRendererEnvironment,
): RendererFactory {
  return {
    kind: 'fixed-layout',
    create: () => new FixedLayoutRenderer(environment),
  };
}

export class FixedLayoutRenderer implements RendererInstance {
  readonly kind: RendererKind = 'fixed-layout';

  private readonly lifecycle = new LifecycleScope();
  private readonly policy: FixedLayoutRendererPolicy;
  private surface: ContentSurface | null = null;
  private stage: HTMLElement | null = null;
  private document: Document | null = null;
  private plan: RenditionPlan | null = null;
  private intrinsic: IntrinsicViewport | null = null;
  private placement: FixedLayoutPlacement | null = null;
  private visible = true;
  private disposed = false;

  constructor(private readonly environment: FixedLayoutRendererEnvironment) {
    this.policy = environment.policy ?? DEFAULT_FIXED_LAYOUT_RENDERER_POLICY;
  }

  async mount(
    plan: RenditionPlan,
    transaction: LayoutTransactionContext,
  ): Promise<void> {
    this.assertAlive();
    this.assertPlan(plan);
    if (this.surface)
      throw new Error('FixedLayoutRenderer.mount() can only be called once.');

    const item = this.environment.publication.spine[plan.spineIndex];
    if (!item || item.href !== plan.href)
      throw new Error(
        `Rendition plan does not resolve to spine item ${plan.spineIndex}.`,
      );

    const ownerDocument = this.environment.container.ownerDocument;
    const mediaType = item.mediaType.split(';', 1)[0]?.trim().toLowerCase();
    const materialized =
      await this.environment.contentDocumentCache.materialize(item);
    transaction.throwIfSuperseded();
    this.environment.onDiagnostics?.(materialized.diagnostics);
    this.environment.onPresentationHints?.(materialized.hints);

    const surface =
      this.environment.createSurface?.() ??
      new BrowserIFrameContentSurface(ownerDocument, {
        title: `EPUB fixed page: ${item.href}`,
      });
    const stage = ownerDocument.createElement('div');
    let mounted = false;
    try {
      transaction.mutate(() => {
        prepareContainer(
          this.environment.container,
          plan.preferences.fixedLayoutFit,
        );
        prepareStage(stage);
        this.environment.container.appendChild(stage);
        surface.mount(stage);
        prepareSurfaceElement(surface.element);
        surface.element.style.visibility = this.visible ? 'visible' : 'hidden';
        this.surface = surface;
        this.stage = stage;
        mounted = true;
      });

      const loaded = await surface.load(
        {
          kind: 'url',
          url: materialized.url,
          srcdocFallback: { html: materialized.markup },
        },
        transaction.signal,
      );
      transaction.throwIfSuperseded();
      const intrinsic = resolveIntrinsicViewport(
        loaded.document,
        mediaType ?? '',
        plan,
      );
      if (!intrinsic) {
        const diagnostic: PublicationDiagnostic = {
          code: 'FXL_INTRINSIC_VIEWPORT_MISSING',
          severity: 'error',
          phase: 'rendition',
          spineIndex: plan.spineIndex,
          message: `Fixed-layout spine item ${plan.href} does not expose a usable intrinsic viewport; using the content slot size as an explicit compatibility fallback.`,
          repair: {
            strategy: 'use-content-slot-as-icb',
            description:
              'Use the current content slot dimensions as the missing fixed-layout initial containing block.',
            confidence: 0.25,
          },
        };
        this.environment.onDiagnostics?.([diagnostic]);
      }
      const effectiveIntrinsic = intrinsic ?? {
        width: plan.viewport.width,
        height: plan.viewport.height,
      };

      transaction.mutate(() => {
        this.document = loaded.document;
        this.plan = plan;
        this.intrinsic = effectiveIntrinsic;
        if (mediaType !== 'image/svg+xml')
          installFixedLayoutClipStyle(loaded.document);
        this.applyPlacement(plan, effectiveIntrinsic);
        this.installNavigationGuard(loaded.document);
        this.installFormGuard(loaded.document);
      });
    } catch (error) {
      if (mounted) surface.dispose();
      stage.remove();
      if (this.surface === surface) this.surface = null;
      if (this.stage === stage) this.stage = null;
      throw error;
    }
  }

  async update(
    plan: RenditionPlan,
    transaction: LayoutTransactionContext,
  ): Promise<void> {
    this.assertAlive();
    this.assertPlan(plan);
    if (!this.document || !this.plan || !this.intrinsic)
      throw new Error('FixedLayoutRenderer must be mounted before update().');
    if (
      this.plan.spineIndex !== plan.spineIndex ||
      this.plan.href !== plan.href
    ) {
      throw new Error(
        'FixedLayoutRenderer cannot update to a different spine document.',
      );
    }
    transaction.mutate(() => {
      this.plan = plan;
      this.applyPlacement(plan, this.intrinsic!);
    });
  }

  async captureLocator(
    transaction: LayoutTransactionContext,
  ): Promise<Locator | null> {
    this.assertAlive();
    transaction.throwIfSuperseded();
    const plan = this.plan;
    if (!plan) return null;
    return {
      href: plan.href,
      spineIndex: plan.spineIndex,
      locations: { progression: 0 },
    };
  }

  async restoreLocator(
    locator: Locator,
    transaction: LayoutTransactionContext,
  ): Promise<Locator | null> {
    this.assertAlive();
    transaction.throwIfSuperseded();
    // A pre-paginated spine item is exactly one page. There is no intra-page
    // pagination state to restore; fragment and annotation navigation is handled above the renderer.
    const plan = this.plan;
    if (
      !plan ||
      locator.spineIndex !== plan.spineIndex ||
      locator.href !== plan.href
    )
      return null;
    return { ...locator, locations: { ...locator.locations, progression: 0 } };
  }

  async navigate(
    direction: import('../model').ReadingDirection,
    transaction: LayoutTransactionContext,
  ): Promise<import('../model').RendererNavigationResult> {
    this.assertAlive();
    transaction.throwIfSuperseded();
    return {
      status: 'boundary',
      edge: direction === 'forward' ? 'end' : 'start',
    };
  }

  async waitForLayoutStable(
    transaction: LayoutTransactionContext,
  ): Promise<LayoutStabilityReport> {
    this.assertAlive();
    if (!this.surface)
      throw new Error('FixedLayoutRenderer has no content surface.');
    const report = await this.surface.waitForLayoutStable(transaction.signal);
    transaction.throwIfSuperseded();
    return report;
  }

  contentDocuments(): readonly import('../model').RendererContentDocument[] {
    if (!this.document || !this.plan || !this.surface) return [];
    return [
      {
        spineIndex: this.plan.spineIndex,
        href: this.plan.href,
        document: this.document,
        surfaceElement: this.surface.element,
      },
    ];
  }

  snapshot(): Partial<FixedLayoutSnapshot> {
    this.assertAlive();
    const placement = this.placement;
    if (!placement) return {};
    return {
      pageCount: 1,
      resourceBoundary: { atStart: true, atEnd: true },
      currentPage: 1,
      // A pre-paginated page is one whole page, so there is no position inside
      // it. Reporting that explicitly matters: the reader repairs its locator
      // from whatever the renderer says its progression is, and omitting the
      // field left fixed-layout books with a locator frozen wherever it was
      // last set by hand — which is what pinned their progress readout at 0%.
      progression: 0,
      intrinsicViewport: placement.intrinsic,
      scale: placement.scale,
      renderedWidth: placement.renderedWidth,
      renderedHeight: placement.renderedHeight,
      offsetX: placement.offsetX,
      offsetY: placement.offsetY,
    };
  }

  setVisibility(visible: boolean): void {
    this.visible = visible;
    if (this.surface)
      this.surface.element.style.visibility = visible ? 'visible' : 'hidden';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.dispose('Fixed-layout renderer disposed.');
    this.surface?.dispose();
    this.stage?.remove();
    this.surface = null;
    this.stage = null;
    this.document = null;
    this.plan = null;
    this.intrinsic = null;
    this.placement = null;
  }

  private applyPlacement(
    plan: RenditionPlan,
    intrinsic: IntrinsicViewport,
  ): void {
    const surface = this.surface;
    const stage = this.stage;
    if (!surface || !stage)
      throw new Error(
        'Cannot place a fixed-layout page before its surface is mounted.',
      );
    prepareContainer(
      this.environment.container,
      plan.preferences.fixedLayoutFit,
    );
    const calculated = calculateFixedLayoutPlacement(
      intrinsic,
      plan.viewport,
      plan.preferences.fixedLayoutFit,
      this.environment.resolveHorizontalAlignment?.(plan) ?? 'center',
    );
    const placement = this.policy.center
      ? calculated
      : { ...calculated, offsetX: 0, offsetY: 0 };
    this.placement = placement;
    stage.style.left = `${placement.offsetX}px`;
    stage.style.top = `${placement.offsetY}px`;
    stage.style.width = `${placement.renderedWidth}px`;
    stage.style.height = `${placement.renderedHeight}px`;
    const style = surface.element.style;
    style.position = 'absolute';
    style.left = '0';
    style.top = '0';
    style.width = `${intrinsic.width}px`;
    style.height = `${intrinsic.height}px`;
    style.transformOrigin = '0 0';
    style.transform = `scale(${placement.scale})`;
    style.border = '0';
    style.margin = '0';
    style.padding = '0';
    style.overflow = 'hidden';
  }

  private installNavigationGuard(document: Document): void {
    this.lifecycle.listen(
      document,
      'click',
      (event) => {
        const target = event.target;
        if (!target || (target as Node).nodeType !== 1) return;
        const anchor = (target as Element).closest(
          'a[href], a[data-epub-href]',
        );
        if (!anchor) return;
        const href = anchor.getAttribute('href') ?? '';
        if (href.startsWith('#')) return;
        event.preventDefault();
      },
      true,
    );
  }

  private installFormGuard(document: Document): void {
    this.lifecycle.listen(
      document,
      'submit',
      (event) => event.preventDefault(),
      true,
    );
  }

  private assertPlan(plan: RenditionPlan): void {
    if (
      plan.renderer !== 'fixed-layout' ||
      plan.publicationRendition.layout !== 'pre-paginated'
    ) {
      throw new Error(
        `FixedLayoutRenderer received incompatible plan ${plan.renderer}/${plan.publicationRendition.layout}.`,
      );
    }
    if (plan.spread.mode === 'double') {
      throw new Error(
        'FixedLayoutRenderer renders one content slot; use the spread-aware factory for double-page plans.',
      );
    }
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new Error('FixedLayoutRenderer has been disposed.');
  }
}

function resolveIntrinsicViewport(
  document: Document,
  mediaType: string,
  plan: RenditionPlan,
): IntrinsicViewport | null {
  if (plan.intrinsicViewport) return plan.intrinsicViewport;
  if (mediaType === 'image/svg+xml')
    return inspectSvgIntrinsicViewport(document);
  return inspectXhtmlIntrinsicViewport(document, {
    deviceWidth: plan.viewport.width,
    deviceHeight: plan.viewport.height,
  });
}

function prepareContainer(
  container: HTMLElement,
  fit: import('../../../epub/publication').FixedLayoutFit,
): void {
  if (!container.style.position) container.style.position = 'relative';
  container.style.overflow = fit === 'contain' ? 'hidden' : 'auto';
  container.style.overscrollBehavior = 'contain';
}

function prepareStage(stage: HTMLElement): void {
  stage.dataset.epubFixedLayoutStage = 'true';
  stage.style.position = 'absolute';
  stage.style.overflow = 'visible';
}

function prepareSurfaceElement(element: HTMLElement): void {
  element.style.display = 'block';
  element.style.maxWidth = 'none';
  element.style.maxHeight = 'none';
}

function installFixedLayoutClipStyle(document: Document): void {
  const id = 'epub-reader-fixed-layout-clip';
  let style = document.getElementById(id);
  if (!style) {
    style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
    style.id = id;
    (document.head ?? document.documentElement).appendChild(style);
  }
  style.textContent = `html { overflow: hidden !important; }`;
}
