import {
  resolveSpineRendition,
  type ContentPresentationHints,
  type Locator,
  type Publication,
  type PublicationDiagnostic,
} from '../../../epub/publication';
import type { PublicationContentDocumentCache } from '../../../epub/content';
import type {
  RenditionCompatibilityContext,
  RenditionCompatibilityDirectives,
} from '../../../epub/compatibility/rendition-policy';
import type { CompatibilityRunResult } from '../../../epub/compatibility/model';
import {
  DEFAULT_RENDITION_PLANNER_POLICY,
  planRendition,
  type RenditionPlan,
  type RenditionPlannerPolicy,
  type RendererKind,
} from '../../rendition';
import type {
  FixedLayoutHorizontalAlignment,
  FixedLayoutRendererPolicy,
} from '../fixed-layout';
import { FixedLayoutRenderer } from '../fixed-layout';
import type { ReflowableRendererPolicy } from '../reflowable';
import { ReflowableRenderer } from '../reflowable';
import type {
  LayoutStabilityReport,
  LayoutTransactionContext,
  RendererFactory,
  RendererInstance,
} from '../model';
import { resolveSpreadSlotAssignment } from './slots';
import {
  DEFAULT_SPREAD_RENDERER_POLICY,
  type SpreadChildSnapshot,
  type SpreadLayoutSnapshot,
  type SpreadRendererPolicy,
  type SpreadSlotName,
} from './model';

export interface ReadingRendererEnvironment {
  readonly container: HTMLElement;
  readonly publication: Publication;
  readonly contentDocumentCache: PublicationContentDocumentCache;
  readonly plannerPolicy?: RenditionPlannerPolicy;
  readonly reflowablePolicy?: ReflowableRendererPolicy;
  readonly fixedLayoutPolicy?: FixedLayoutRendererPolicy;
  readonly spreadPolicy?: SpreadRendererPolicy;
  readonly onDiagnostics?: (
    diagnostics: readonly PublicationDiagnostic[],
  ) => void;
  readonly themeResolver?: import('../../appearance').ReaderThemeResolver;
  readonly contentHintsForSpine?: (
    spineIndex: number,
  ) => ContentPresentationHints | undefined;
  /** Evaluate each leaf against the same publication-scoped profile as the root. */
  readonly resolveRenditionCompatibility?: (
    context: RenditionCompatibilityContext,
  ) => CompatibilityRunResult<RenditionCompatibilityDirectives>;
  readonly onPresentationHints?: (
    spineIndex: number,
    hints: ContentPresentationHints,
  ) => void;
}

/**
 * Preferred spread-aware factory set. Single plans create one page renderer; double
 * plans transparently create a spread compositor that owns two independent
 * page renderers, including mixed-layout pairs.
 */
export function createReadingRendererFactories(
  environment: ReadingRendererEnvironment,
): readonly RendererFactory[] {
  const kinds: readonly RendererKind[] = [
    'reflowable-paginated',
    'reflowable-scroll',
    'fixed-layout',
  ];
  return kinds.map((kind) => ({
    kind,
    create: (plan) => {
      if (plan?.spread.execution === 'cross-spine') {
        return new SyntheticSpreadRenderer(kind, environment);
      }
      return createSingleRenderer(
        kind,
        environment.container,
        environment,
        plan?.spineIndex ?? -1,
      );
    },
  }));
}

interface ChildState {
  readonly slot: SpreadSlotName;
  readonly container: HTMLElement;
  renderer: RendererInstance | null;
  plan: RenditionPlan | null;
  layoutCleanup: (() => void) | null;
}

export class SyntheticSpreadRenderer implements RendererInstance {
  readonly kind: RendererKind;

  private readonly policy: SpreadRendererPolicy;
  private root: HTMLElement | null = null;
  private left: ChildState | null = null;
  private right: ChildState | null = null;
  private plan: RenditionPlan | null = null;
  private activeSlot: SpreadSlotName = 'left';
  private gap = 0;
  private visible = true;
  private disposed = false;
  private readonly layoutListeners = new Set<
    (layout: import('../model').RendererLayoutSnapshot) => void
  >();

  constructor(
    kind: RendererKind,
    private readonly environment: ReadingRendererEnvironment,
  ) {
    this.kind = kind;
    this.policy = environment.spreadPolicy ?? DEFAULT_SPREAD_RENDERER_POLICY;
  }

  async mount(
    plan: RenditionPlan,
    transaction: LayoutTransactionContext,
  ): Promise<void> {
    this.assertAlive();
    this.assertPlan(plan);
    if (this.root)
      throw new Error(
        'SyntheticSpreadRenderer.mount() can only be called once.',
      );

    const ownerDocument = this.environment.container.ownerDocument;
    const root = ownerDocument.createElement('div');
    const leftContainer = ownerDocument.createElement('div');
    const rightContainer = ownerDocument.createElement('div');
    prepareSpreadRoot(root);
    prepareSlot(leftContainer, 'left');
    prepareSlot(rightContainer, 'right');
    root.append(leftContainer, rightContainer);

    transaction.mutate(() => {
      root.style.visibility = this.visible ? 'visible' : 'hidden';
      this.environment.container.appendChild(root);
      this.root = root;
      this.left = {
        slot: 'left',
        container: leftContainer,
        renderer: null,
        plan: null,
        layoutCleanup: null,
      };
      this.right = {
        slot: 'right',
        container: rightContainer,
        renderer: null,
        plan: null,
        layoutCleanup: null,
      };
      this.plan = plan;
    });

    try {
      await this.applySpread(plan, transaction);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  async update(
    plan: RenditionPlan,
    transaction: LayoutTransactionContext,
  ): Promise<void> {
    this.assertAlive();
    this.assertPlan(plan);
    if (!this.root || !this.plan)
      throw new Error(
        'SyntheticSpreadRenderer must be mounted before update().',
      );
    transaction.mutate(() => {
      this.plan = plan;
    });
    await this.applySpread(plan, transaction);
  }

  async captureLocator(
    transaction: LayoutTransactionContext,
  ): Promise<Locator | null> {
    this.assertAlive();
    transaction.throwIfSuperseded();
    const active = this.child(this.activeSlot).renderer;
    return active ? active.captureLocator(transaction) : null;
  }

  async restoreLocator(
    locator: Locator,
    transaction: LayoutTransactionContext,
  ): Promise<Locator | null> {
    this.assertAlive();
    transaction.throwIfSuperseded();
    const target = [this.left, this.right].find(
      (child) => child?.plan?.spineIndex === locator.spineIndex,
    );
    return target?.renderer
      ? await target.renderer.restoreLocator(locator, transaction)
      : null;
  }

  async navigate(
    direction: import('../model').ReadingDirection,
    transaction: LayoutTransactionContext,
  ): Promise<import('../model').RendererNavigationResult> {
    this.assertAlive();
    transaction.throwIfSuperseded();
    const active = this.child(this.activeSlot).renderer;
    if (!active)
      return {
        status: 'boundary',
        edge: direction === 'forward' ? 'end' : 'start',
      };
    return active.navigate(direction, transaction);
  }

  async waitForLayoutStable(
    transaction: LayoutTransactionContext,
  ): Promise<LayoutStabilityReport> {
    this.assertAlive();
    const reports = await Promise.all(
      [this.left?.renderer, this.right?.renderer]
        .filter((renderer): renderer is RendererInstance => renderer != null)
        .map((renderer) => renderer.waitForLayoutStable(transaction)),
    );
    transaction.throwIfSuperseded();
    return mergeStabilityReports(reports, this.root!);
  }

  contentDocuments(): readonly import('../model').RendererContentDocument[] {
    const documents: import('../model').RendererContentDocument[] = [];
    for (const child of [this.left, this.right]) {
      if (child?.renderer?.contentDocuments)
        documents.push(...child.renderer.contentDocuments());
    }
    return documents;
  }

  onLayoutChange(
    listener: (layout: import('../model').RendererLayoutSnapshot) => void,
  ): () => void {
    this.layoutListeners.add(listener);
    return () => this.layoutListeners.delete(listener);
  }

  snapshot(): Partial<SpreadLayoutSnapshot> {
    this.assertAlive();
    if (!this.root) return {};
    const ordered = [this.left, this.right]
      .filter((child): child is ChildState => child?.plan != null)
      .sort((a, b) => a.plan!.spineIndex - b.plan!.spineIndex);
    return {
      spread: true,
      resourceBoundary: {
        atStart:
          ordered[0]?.renderer?.snapshot().resourceBoundary?.atStart === true,
        atEnd:
          ordered.at(-1)?.renderer?.snapshot().resourceBoundary?.atEnd === true,
      },
      gap: this.gap,
      left: childSnapshot(this.left),
      right: childSnapshot(this.right),
      activeSlot: this.activeSlot,
      // Reading order: right leaf first for right-to-left publications.
      visibleSpineIndices: (this.plan?.pageProgression.value === 'rtl'
        ? [this.right, this.left]
        : [this.left, this.right]
      )
        .map((child) => child?.plan?.spineIndex)
        .filter((index): index is number => Number.isInteger(index)),
      // A composed spread is one physical page turn, so it reports a position
      // the same way a single pre-paginated page does. Omitting these left the
      // product's position readout with nothing to show, so it blanked out and
      // came back every time the reader crossed an illustration spread, and left
      // the reader with no progression to repair its locator from.
      pageCount: 1,
      currentPage: 1,
      progression:
        this.child(this.activeSlot).renderer?.snapshot?.()?.progression ?? 0,
      measurement: {
        clientWidth: this.root.clientWidth,
        clientHeight: this.root.clientHeight,
        scrollWidth: this.root.scrollWidth,
        scrollHeight: this.root.scrollHeight,
      },
    };
  }

  setVisibility(visible: boolean): void {
    this.visible = visible;
    if (this.root) this.root.style.visibility = visible ? 'visible' : 'hidden';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.left?.layoutCleanup?.();
    this.right?.layoutCleanup?.();
    this.left?.renderer?.dispose();
    this.right?.renderer?.dispose();
    this.layoutListeners.clear();
    this.left = null;
    this.right = null;
    this.root?.remove();
    this.root = null;
    this.plan = null;
  }

  private async applySpread(
    plan: RenditionPlan,
    transaction: LayoutTransactionContext,
  ): Promise<void> {
    const root = this.root;
    if (!root || !this.left || !this.right)
      throw new Error('Synthetic spread DOM is not mounted.');

    const assignment = resolveSpreadSlotAssignment(
      this.environment.publication,
      plan,
      // Only items that would compose across spine documents themselves may be
      // pulled into this spread. A flowing chapter also plans as a double
      // spread, but it executes that inside its own document as two columns, so
      // pairing it with a plate showed it once on its own and then a second
      // time as the facing leaf.
      (item) =>
        this.planCandidate(item.index, plan).spread.execution === 'cross-spine',
    );
    const gap = resolveSpreadGap(
      this.environment.publication,
      plan,
      assignment,
      this.policy.pageGap,
    );
    const slotWidth = Math.max(1, (plan.viewport.width - gap) / 2);
    const slotViewport = { width: slotWidth, height: plan.viewport.height };

    transaction.mutate(() => {
      this.activeSlot = assignment.activeSlot;
      this.gap = gap;
      root.style.gap = `${gap}px`;
      root.style.width = `${plan.viewport.width}px`;
      root.style.height = `${plan.viewport.height}px`;
      this.left!.container.style.width = `${slotWidth}px`;
      this.left!.container.style.height = `${plan.viewport.height}px`;
      this.right!.container.style.width = `${slotWidth}px`;
      this.right!.container.style.height = `${plan.viewport.height}px`;
    });

    await this.updateChild(
      this.left,
      assignment.leftSpineIndex,
      slotViewport,
      plan,
      transaction,
    );
    await this.updateChild(
      this.right,
      assignment.rightSpineIndex,
      slotViewport,
      plan,
      transaction,
    );
    transaction.mutate(() => {
      // A cover or closing page has no facing leaf. Collapse the blank slot so
      // the page is centred instead of sitting beside an empty half of the
      // viewport; blank slots elsewhere keep the authored facing-page side.
      const loneEdge = loneEdgePage(assignment, this.environment.publication);
      this.left!.container.style.display =
        loneEdge && assignment.leftSpineIndex == null ? 'none' : '';
      this.right!.container.style.display =
        loneEdge && assignment.rightSpineIndex == null ? 'none' : '';
      this.gap = loneEdge ? 0 : gap;
      root.style.gap = `${this.gap}px`;
      const scrollableFixedLayout =
        plan.renderer === 'fixed-layout' &&
        plan.preferences.fixedLayoutFit !== 'contain';
      root.style.overflow = scrollableFixedLayout ? 'auto' : 'hidden';
      root.style.overscrollBehavior = scrollableFixedLayout ? 'contain' : '';
      this.left!.container.style.overflow = scrollableFixedLayout
        ? 'visible'
        : 'hidden';
      this.right!.container.style.overflow = scrollableFixedLayout
        ? 'visible'
        : 'hidden';
    });
  }

  private async updateChild(
    child: ChildState,
    spineIndex: number | null,
    viewport: { readonly width: number; readonly height: number },
    outerPlan: RenditionPlan,
    transaction: LayoutTransactionContext,
  ): Promise<void> {
    if (spineIndex == null) {
      transaction.mutate(() => {
        child.layoutCleanup?.();
        child.layoutCleanup = null;
        child.renderer?.dispose();
        child.renderer = null;
        child.plan = null;
        child.container.replaceChildren();
        child.container.dataset.epubBlankSpreadSlot = 'true';
      });
      return;
    }

    transaction.mutate(() => {
      delete child.container.dataset.epubBlankSpreadSlot;
    });
    const childPlan = this.childPlan(spineIndex, viewport, outerPlan);
    const sameContent =
      child.plan?.spineIndex === childPlan.spineIndex &&
      child.plan.href === childPlan.href &&
      child.renderer?.kind === childPlan.renderer;

    if (sameContent && child.renderer) {
      await child.renderer.update(childPlan, transaction);
      transaction.throwIfSuperseded();
      transaction.mutate(() => {
        child.plan = childPlan;
      });
      return;
    }

    const next = createSingleRenderer(
      childPlan.renderer,
      child.container,
      this.environment,
      childPlan.spineIndex,
      child.slot,
    );
    next.setVisibility?.(false);
    let committed = false;
    try {
      await next.mount(childPlan, transaction);
      transaction.throwIfSuperseded();
      transaction.mutate(() => {
        next.setVisibility?.(true);
        child.layoutCleanup?.();
        child.renderer?.dispose();
        child.renderer = next;
        child.plan = childPlan;
        child.layoutCleanup =
          next.onLayoutChange?.(() => this.emitLiveLayout()) ?? null;
        committed = true;
      });
    } finally {
      if (!committed) next.dispose();
    }
  }

  private emitLiveLayout(): void {
    if (this.disposed) return;
    const layout = this.snapshot();
    for (const listener of this.layoutListeners) listener(layout);
  }

  private planCandidate(
    spineIndex: number,
    outerPlan: RenditionPlan,
  ): RenditionPlan {
    const item = this.environment.publication.spine[spineIndex]!;
    const contentHints = this.environment.contentHintsForSpine?.(spineIndex);
    return planRendition({
      publication: this.environment.publication,
      spineItem: item,
      viewport: outerPlan.viewport,
      preferences: outerPlan.preferences,
      contentHints,
      ...this.compatibilityFor(spineIndex, contentHints, outerPlan),
      policy:
        this.environment.plannerPolicy ?? DEFAULT_RENDITION_PLANNER_POLICY,
    });
  }

  private childPlan(
    spineIndex: number,
    viewport: { readonly width: number; readonly height: number },
    outerPlan: RenditionPlan,
  ): RenditionPlan {
    const item = this.environment.publication.spine[spineIndex]!;
    const basePolicy =
      this.environment.plannerPolicy ?? DEFAULT_RENDITION_PLANNER_POLICY;
    const noNestedSpread: RenditionPlannerPolicy = {
      ...basePolicy,
      syntheticSpreads: { ...basePolicy.syntheticSpreads, supported: false },
    };
    const preflightHints = this.environment.contentHintsForSpine?.(spineIndex);
    const activeHints =
      spineIndex === outerPlan.spineIndex
        ? {
            ...preflightHints,
            writingMode: outerPlan.writingMode.value,
            direction: outerPlan.textDirection.value,
            ...(outerPlan.intrinsicViewport
              ? { viewport: outerPlan.intrinsicViewport }
              : {}),
          }
        : preflightHints;
    return planRendition({
      publication: this.environment.publication,
      spineItem: item,
      viewport,
      preferences: outerPlan.preferences,
      contentHints: activeHints,
      ...this.compatibilityFor(spineIndex, activeHints, outerPlan),
      policy: noNestedSpread,
    });
  }

  private compatibilityFor(
    spineIndex: number,
    contentHints: ContentPresentationHints | undefined,
    outerPlan: RenditionPlan,
  ) {
    const result = this.environment.resolveRenditionCompatibility?.({
      publication: this.environment.publication,
      spineItem: this.environment.publication.spine[spineIndex]!,
      contentHints,
      preferences: outerPlan.preferences,
    });
    return result
      ? {
          compatibility: result.value,
          compatibilityDiagnostics: result.diagnostics,
        }
      : {};
  }

  private child(slot: SpreadSlotName): ChildState {
    const child = slot === 'left' ? this.left : this.right;
    if (!child) throw new Error('Spread child is not mounted.');
    return child;
  }

  private assertPlan(plan: RenditionPlan): void {
    if (plan.renderer !== this.kind)
      throw new Error(
        `Spread renderer ${this.kind} received plan ${plan.renderer}.`,
      );
    if (plan.spread.mode !== 'double')
      throw new Error('SyntheticSpreadRenderer requires a double-spread plan.');
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new Error('SyntheticSpreadRenderer has been disposed.');
  }
}

function createSingleRenderer(
  kind: RendererKind,
  container: HTMLElement,
  environment: ReadingRendererEnvironment,
  spineIndex: number,
  spreadSlot?: SpreadSlotName,
): RendererInstance {
  if (kind === 'fixed-layout') {
    return new FixedLayoutRenderer({
      container,
      publication: environment.publication,
      contentDocumentCache: environment.contentDocumentCache,
      policy: environment.fixedLayoutPolicy,
      resolveHorizontalAlignment: spreadSlot
        ? (plan) =>
            resolveFixedLayoutSpreadAlignment(
              plan.preferences.fixedLayoutGutter,
              spreadSlot,
            )
        : undefined,
      onDiagnostics: environment.onDiagnostics,
      onPresentationHints: (hints) =>
        environment.onPresentationHints?.(spineIndex, hints),
    });
  }
  return new ReflowableRenderer(kind, {
    container,
    publication: environment.publication,
    contentDocumentCache: environment.contentDocumentCache,
    policy: environment.reflowablePolicy,
    themeResolver: environment.themeResolver,
    onDiagnostics: environment.onDiagnostics,
    onPresentationHints: (hints) =>
      environment.onPresentationHints?.(spineIndex, hints),
  });
}

function prepareSpreadRoot(root: HTMLElement): void {
  root.dataset.epubSpread = 'true';
  root.style.display = 'flex';
  root.style.flexDirection = 'row';
  root.style.alignItems = 'stretch';
  root.style.justifyContent = 'center';
  root.style.overflow = 'hidden';
  root.style.position = 'relative';
  root.style.boxSizing = 'border-box';
}

function prepareSlot(slot: HTMLElement, name: SpreadSlotName): void {
  slot.dataset.epubSpreadSlot = name;
  slot.style.position = 'relative';
  slot.style.overflow = 'hidden';
  slot.style.flex = '0 0 auto';
  slot.style.minWidth = '0';
  slot.style.minHeight = '0';
}

function childSnapshot(child: ChildState | null): SpreadChildSnapshot | null {
  if (!child?.renderer || !child.plan) return null;
  return {
    spineIndex: child.plan.spineIndex,
    renderer: child.plan.renderer,
    layout: child.renderer.snapshot(),
  };
}

function mergeStabilityReports(
  reports: readonly LayoutStabilityReport[],
  root: HTMLElement,
): LayoutStabilityReport {
  if (reports.length === 0) {
    return {
      status: 'stable',
      fonts: 'not-requested',
      images: { requested: 0, decoded: 0, failed: 0, timedOut: false },
      stableFramesObserved: 0,
      measurement: {
        clientWidth: root.clientWidth,
        clientHeight: root.clientHeight,
        scrollWidth: root.scrollWidth,
        scrollHeight: root.scrollHeight,
      },
    };
  }
  return {
    status: reports.some((report) => report.status === 'timed-out')
      ? 'timed-out'
      : 'stable',
    fonts: reports.some((report) => report.fonts === 'timed-out')
      ? 'timed-out'
      : reports.every((report) => report.fonts === 'not-requested')
        ? 'not-requested'
        : 'ready',
    images: reports.reduce<{
      requested: number;
      decoded: number;
      failed: number;
      timedOut: boolean;
    }>(
      (total, report) => ({
        requested: total.requested + report.images.requested,
        decoded: total.decoded + report.images.decoded,
        failed: total.failed + report.images.failed,
        timedOut: total.timedOut || report.images.timedOut,
      }),
      { requested: 0, decoded: 0, failed: 0, timedOut: false },
    ),
    stableFramesObserved: Math.min(
      ...reports.map((report) => report.stableFramesObserved),
    ),
    measurement: {
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
    },
  };
}

function shouldSuppressSpreadGap(
  publication: Publication,
  plan: RenditionPlan,
  assignment: {
    readonly leftSpineIndex: number | null;
    readonly rightSpineIndex: number | null;
    readonly trueSpread: boolean;
  },
): boolean {
  if (plan.spread.gap === 'none' || assignment.trueSpread) return true;
  for (const index of [assignment.leftSpineIndex, assignment.rightSpineIndex]) {
    if (index == null) continue;
    const item = publication.spine[index];
    if (
      item &&
      resolveSpineRendition(publication, item).layout === 'pre-paginated'
    )
      return true;
  }
  return false;
}

export function resolveSpreadGap(
  publication: Publication,
  plan: RenditionPlan,
  assignment: {
    readonly leftSpineIndex: number | null;
    readonly rightSpineIndex: number | null;
    readonly trueSpread: boolean;
  },
  defaultGap: number,
): number {
  if (plan.renderer === 'fixed-layout') {
    return plan.preferences.fixedLayoutGutter === 'none' ? 0 : defaultGap;
  }
  return shouldSuppressSpreadGap(publication, plan, assignment)
    ? 0
    : defaultGap;
}

/** A first or last page with no facing leaf and no authored left/right side. */
function loneEdgePage(
  assignment: {
    readonly leftSpineIndex: number | null;
    readonly rightSpineIndex: number | null;
  },
  publication: Publication,
): boolean {
  const { leftSpineIndex: left, rightSpineIndex: right } = assignment;
  if ((left == null) === (right == null)) return false;
  const index = left ?? right!;
  if (index !== 0 && index !== publication.spine.length - 1) return false;
  const item = publication.spine[index];
  const placement = item
    ? resolveSpineRendition(publication, item).pageSpread
    : null;
  return placement !== 'left' && placement !== 'right';
}

export function resolveFixedLayoutSpreadAlignment(
  gutter: RenditionPlan['preferences']['fixedLayoutGutter'],
  slot: SpreadSlotName,
): FixedLayoutHorizontalAlignment {
  if (gutter === 'normal') return 'center';
  return slot === 'left' ? 'end' : 'start';
}
