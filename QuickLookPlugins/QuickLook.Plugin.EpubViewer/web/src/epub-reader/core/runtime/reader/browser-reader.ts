import { openPublicationArchive } from '../../epub/archive';
import {
  createReaderCompatibilityProfile,
  runRenditionCompatibilityPolicies,
  type CompatibilityProfile,
} from '../../epub/compatibility';
import {
  BrowserDomXmlPlatform,
  PublicationContentDocumentCache,
  PublicationContentDocumentPipeline,
  PublicationContentPreflightSession,
  type PublicationContentPreflightResult,
} from '../../epub/content';
import {
  DEFAULT_READER_PREFERENCES,
  loadPublicationFromArchive,
  normalizeReaderPreferences,
  type ContentPresentationHints,
  type Locator,
  type Publication,
  type PublicationDiagnostic,
  type ReaderPreferences,
  type ReaderPreferencesPatch,
} from '../../epub/publication';
import {
  BrowserObjectUrlFactory,
  PublicationResourceSession,
  ResourceResolver,
} from '../../epub/resources';
import { describeReaderPosition } from '../../features/accessibility';
import {
  MemoryReaderMarkStore,
  ReaderMarkController,
  type AnnotationColor,
  type AnnotationHighlightStyle,
  type Highlight,
  type ReaderMark,
  type ReaderMarkStore,
  type ReaderMarkStoreSnapshot,
} from '../../features/annotations';
import {
  ReaderDecorationController,
  type ReaderDecorationActivation,
} from '../../features/decorations';
import {
  BrowserPublicationMediaRouter,
  type ReaderImageActivation,
} from '../../features/media';
import {
  BrowserPublicationSearchProvider,
  PublicationSearch,
  ReaderSearchController,
  type ReaderSearchNavigationResult,
  type ReaderSearchState,
  type SearchHit,
  type SearchOptions,
} from '../../features/search';
import {
  BrowserReaderInputRouter,
  ReaderInputController,
  type ReaderInputMap,
  type ReaderInputState,
} from '../../interaction/input';
import {
  loadPublicationFootnote,
  locatorFromCfi,
  locatorFromHref,
  PublicationLinkRouter,
  ReaderNavigationHistory,
  ReaderNavigator,
  type FootnoteLinkActivation,
  type NavigationPlanProvider,
  type NavigationTarget,
  type ReaderNavigationResult,
} from '../../interaction/navigation';
import {
  BrowserReaderSelectionRouter,
  captureSelectionFromDocuments,
  getDocumentSelection,
  type ReaderSelection,
  type ReaderSelectionActivation,
} from '../../interaction/selection';
import {
  ReaderThemeRegistry,
  type ReaderThemeDefinition,
} from '../../presentation/appearance';
import {
  createReadingRendererFactories,
  RendererHost,
  type RendererHostState,
} from '../../presentation/renderer';
import {
  planRendition,
  type RenditionPlannerPolicy,
  type ViewportMetrics,
} from '../../presentation/rendition';
import {
  configureReaderExtensions,
  type ReaderExtensionConfiguration,
} from '../configuration';
import { addBookmarkAndNotify } from './bookmark-event';
import {
  assertUsableContainer,
  isAbortError,
  measureViewport,
  normalizeViewport,
  preflightWindowIndexes,
  reportOpenProgress,
  resolveInitialLocator,
  throwIfAborted,
} from './browser-reader/open';
import {
  emptyRendererState,
  emptySearchState,
  mergeApproximateLocator,
  mergeHints,
  mergePlannerPolicy,
  renderPreferencesChanged,
  resolvePublicationPresentation,
  resolveReadingPosition,
  sameContentHints,
  samePreferences,
  sameViewport,
  spreadChanged,
} from './browser-reader/state';
import { PublicationDiagnosticCollector } from './diagnostic-collector';
import type {
  BrowserEpubReaderMarksApi,
  BrowserEpubReaderOptions,
  BrowserEpubReaderSearchApi,
  BrowserEpubReaderSnapshot,
  ReaderPublicationPresentation,
} from './model';
import { cloneAndFreezePlainData } from '../../shared/immutable';

type SnapshotListener = () => void;

export class BrowserEpubReaderOpenError extends Error {
  constructor(
    message: string,
    readonly diagnostics: readonly PublicationDiagnostic[],
  ) {
    super(message);
    this.name = 'BrowserEpubReaderOpenError';
  }
}

/** Keep input/compatibility choices while returning renderer-owned fields to
 * the last plan that committed successfully. */
function restoreRenderedPreferences(
  current: ReaderPreferences,
  committed: ReaderPreferences,
): ReaderPreferences {
  return cloneAndFreezePlainData({
    ...current,
    flow: committed.flow,
    spread: committed.spread,
    pageProgression: committed.pageProgression,
    fontSizePercent: committed.fontSizePercent,
    fontFamily: committed.fontFamily,
    lineHeight: committed.lineHeight,
    pageMarginPercent: committed.pageMarginPercent,
    fixedLayoutFit: committed.fixedLayoutFit,
    fixedLayoutGutter: committed.fixedLayoutGutter,
    theme: committed.theme,
  });
}

/**
 * Browser composition root for the React adapter and any non-React host UI.
 *
 * This class owns one opened publication session. React never needs to know how
 * parser/resources/planner/renderers/navigation/search/marks are wired together;
 * it subscribes to this immutable snapshot and invokes semantic methods.
 */
export class BrowserEpubReader {
  readonly publication: Publication;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly cleanups: (() => void)[] = [];
  private readonly hints: Map<number, ContentPresentationHints>;
  /**
   * Package-level layout/chrome remain stable. Dominant writing mode starts
   * from the critical preflight window and is refined once after the staged
   * publication scan; it never tracks page-by-page renderer changes.
   */
  private presentation: ReaderPublicationPresentation;
  private readonly plannerPolicy: RenditionPlannerPolicy;
  private readonly compatibilityProfile: CompatibilityProfile;
  private readonly resources: PublicationResourceSession;
  private readonly contentPreflight: PublicationContentPreflightSession;
  private readonly contentDocumentCache: PublicationContentDocumentCache;
  private readonly host: RendererHost;
  private readonly navigator: ReaderNavigator;
  private readonly navigationHistory = new ReaderNavigationHistory();
  private readonly searchController: ReaderSearchController;
  private readonly markStore: ReaderMarkStore;
  private marksSnapshot: ReaderMarkStoreSnapshot;
  private readonly markController: ReaderMarkController;
  private readonly decorations: ReaderDecorationController;
  private readonly inputRouter: BrowserReaderInputRouter;
  private readonly inputMap: ReaderInputMap;
  private readonly linkRouter: PublicationLinkRouter;
  private readonly selectionRouter: BrowserReaderSelectionRouter;
  private readonly mediaRouter: BrowserPublicationMediaRouter;
  private readonly selectionPollTimer: number | null;
  private cancelBackgroundPreflight: (() => void) | null = null;
  private readonly themeRegistry: ReaderThemeRegistry;
  private readonly readerEvent: BrowserEpubReaderOptions['onEvent'];
  private readonly diagnostics: PublicationDiagnosticCollector;
  private preferences: ReaderPreferences;
  private committedRenderPreferences: ReaderPreferences;
  private viewport: ViewportMetrics;
  private committedViewport: ViewportMetrics;
  private locator: Locator | null = null;
  /** Target requested by a queued navigation; protects semantic anchors while layout commits. */
  private pendingNavigationLocator: Locator | null = null;
  private selection: ReaderSelection | null = null;
  private disposed = false;
  private snapshotValue: BrowserEpubReaderSnapshot;

  readonly search: BrowserEpubReaderSearchApi;
  readonly marks: BrowserEpubReaderMarksApi;

  private constructor(
    publication: Publication,
    private readonly container: HTMLElement,
    resources: PublicationResourceSession,
    contentPreflight: PublicationContentPreflightSession,
    diagnostics: readonly PublicationDiagnostic[],
    initialHints: ReadonlyMap<number, ContentPresentationHints>,
    preferences: ReaderPreferences,
    viewport: ViewportMetrics,
    compatibilityProfile: CompatibilityProfile,
    extensions: ReaderExtensionConfiguration,
    private readonly options: BrowserEpubReaderOptions,
  ) {
    this.publication = cloneAndFreezePlainData(publication);
    publication = this.publication;
    this.resources = resources;
    this.contentPreflight = contentPreflight;
    this.hints = new Map(initialHints);
    // Built from preflight hints only. Renderer feedback keeps refining
    // `this.hints` per spine item, but the publication-level answer must not
    // move underneath the UI once reading has started.
    this.presentation = resolvePublicationPresentation(
      publication,
      initialHints,
    );
    this.diagnostics = new PublicationDiagnosticCollector(diagnostics);
    this.preferences = cloneAndFreezePlainData(preferences);
    this.committedRenderPreferences = this.preferences;
    this.compatibilityProfile = compatibilityProfile;
    this.viewport = cloneAndFreezePlainData(viewport);
    this.committedViewport = this.viewport;
    this.plannerPolicy = mergePlannerPolicy(options.plannerPolicy);
    this.readerEvent = options.onEvent;
    // Copy the catalog so one reader owns later dynamic registrations without
    // mutating the application-level configuration shared by other readers.
    this.themeRegistry = new ReaderThemeRegistry(
      extensions.themeCatalog.list(),
    );
    this.inputMap = extensions.inputMap;
    this.markStore = options.markStore ?? new MemoryReaderMarkStore();
    this.marksSnapshot = cloneAndFreezePlainData(this.markStore.snapshot());

    const xmlPlatform = new BrowserDomXmlPlatform(container.ownerDocument);
    const contentPipeline = new PublicationContentDocumentPipeline(
      resources,
      xmlPlatform,
    );
    this.contentDocumentCache = new PublicationContentDocumentCache(
      contentPipeline,
      {
        policy: options.contentDocumentCachePolicy,
        preferredSpineIndex: () =>
          this.pendingNavigationLocator?.spineIndex ??
          this.locator?.spineIndex ??
          null,
      },
    );

    this.host = new RendererHost(
      createReadingRendererFactories({
        container,
        publication,
        contentDocumentCache: this.contentDocumentCache,
        plannerPolicy: this.plannerPolicy,
        themeResolver: this.themeRegistry,
        onDiagnostics: (next) => this.appendDiagnostics(next, this.options),
        contentHintsForSpine: (spineIndex) => this.hints.get(spineIndex),
        resolveRenditionCompatibility: (context) =>
          this.resolveRenditionCompatibility(context),
        onPresentationHints: (spineIndex, hints) => {
          this.hints.set(
            spineIndex,
            mergeHints(this.hints.get(spineIndex), hints),
          );
        },
      }),
    );

    const plans: NavigationPlanProvider = {
      planForSpine: (spineIndex) => this.planForSpine(spineIndex),
    };
    this.navigator = new ReaderNavigator(publication, this.host, plans);

    const searchProvider = new BrowserPublicationSearchProvider(
      publication,
      contentPipeline,
    );
    const publicationSearch = new PublicationSearch(
      publication,
      searchProvider,
      {
        cache: options.searchCachePolicy,
        cacheVariant: contentPipeline.analysisSignature,
        preferredSpineIndex: () =>
          this.locator?.spineIndex ?? this.host.state.plan?.spineIndex ?? null,
      },
    );
    this.searchController = new ReaderSearchController(
      publicationSearch,
      this.navigator,
    );
    this.markController = new ReaderMarkController(
      this.markStore,
      this.host,
      this.navigator,
    );
    this.decorations = new ReaderDecorationController(
      publication,
      this.host,
      this.markStore,
      undefined,
      (activation) => this.handleDecorationActivation(activation),
    );

    const inputController = new ReaderInputController({
      // Keys, taps and the wheel go through the reader's own navigation, not
      // straight to the navigator: only the reader records the new position and
      // republishes the snapshot that position readouts depend on.
      navigator: {
        next: () => this.next(),
        previous: () => this.previous(),
      },
      hostCommand: (command) => {
        if (this.selection) this.clearSelection();
        options.onCommand?.(command);
      },
      historyBack: async () => {
        await this.back();
      },
      historyForward: async () => {
        await this.forward();
      },
      stepFont: (delta) => this.stepFont(delta),
    });
    this.inputRouter = new BrowserReaderInputRouter(
      container,
      () => this.inputState(),
      inputController,
      options.inputPolicy,
      (error) => this.publishError(error),
      this.inputMap,
    );
    this.linkRouter = new PublicationLinkRouter(
      publication,
      this.navigator,
      {
        onExternalLink: options.onExternalLink,
        onUnresolvedPublicationLink: options.onUnresolvedPublicationLink,
        onFootnoteLink: (activation) => this.handleFootnoteLink(activation),
      },
      (href) => this.goToWithHistory({ kind: 'href', href }),
    );
    this.selectionRouter = new BrowserReaderSelectionRouter(
      publication,
      container,
      (activation) => this.handleSelectionChange(activation),
    );
    this.mediaRouter = new BrowserPublicationMediaRouter((activation) =>
      this.handleImageActivation(activation),
    );
    this.selectionPollTimer =
      container.ownerDocument.defaultView?.setInterval(() => {
        if (
          !this.disposed &&
          container.ownerDocument.visibilityState !== 'hidden'
        ) {
          this.selectionRouter.pollDocuments(this.host.contentDocuments);
        }
      }, 400) ?? null;

    this.snapshotValue = this.buildSnapshot('opening', null);

    this.cleanups.push(
      this.host.onStateChange((state) => this.handleRendererStateChange(state)),
    );
    this.cleanups.push(
      this.searchController.onChange((state) =>
        this.handleSearchStateChange(state),
      ),
    );
    this.cleanups.push(
      this.markStore.subscribe((snapshot) => {
        const next = cloneAndFreezePlainData(snapshot);
        if (next.revision === this.marksSnapshot.revision) return;
        this.marksSnapshot = next;
        this.publish(this.snapshotValue.status, this.snapshotValue.error);
      }),
    );

    this.search = this.createSearchApi();
    this.marks = this.createMarksApi();
  }

  static async open(
    source: Uint8Array | ArrayBuffer,
    container: HTMLElement,
    options: BrowserEpubReaderOptions = {},
  ): Promise<BrowserEpubReader> {
    assertUsableContainer(container);
    throwIfAborted(options.signal);
    const preferences = normalizeReaderPreferences({
      ...DEFAULT_READER_PREFERENCES,
      ...options.preferences,
      compatibility: {
        ...DEFAULT_READER_PREFERENCES.compatibility,
        ...options.preferences?.compatibility,
      },
    });
    const extensions = options.extensions ?? configureReaderExtensions();
    const compatibilityProfile = createReaderCompatibilityProfile(
      preferences.compatibility,
      extensions.compatibilityModules,
    );
    reportOpenProgress(options, 'archive', 'Opening EPUB container', 1);
    const opened = await openPublicationArchive(
      source,
      options.archiveLimits,
      options.compatibilityMode ??
        (preferences.compatibility.recoverContainerStructure
          ? 'compatible'
          : 'strict'),
    );
    throwIfAborted(options.signal);
    if (!opened.archive) {
      // Kindle failures (DRM, legacy MOBI) explain themselves better than the
      // generic container message.
      const kindle = opened.diagnostics.find(
        (diagnostic) =>
          diagnostic.severity === 'fatal' && diagnostic.code.startsWith('KF8_'),
      );
      throw new BrowserEpubReaderOpenError(
        kindle?.message ?? 'The EPUB container could not be opened.',
        opened.diagnostics,
      );
    }
    reportOpenProgress(options, 'package', 'Reading publication metadata', 2);
    const loaded = await loadPublicationFromArchive(
      opened.archive,
      opened.diagnostics,
      {
        controlDocumentLimits: options.controlDocumentLimits,
        compatibilityProfile,
      },
    );
    throwIfAborted(options.signal);
    if (!loaded.publication) {
      throw new BrowserEpubReaderOpenError(
        'The EPUB package could not be parsed.',
        loaded.diagnostics,
      );
    }
    const initial = resolveInitialLocator(loaded.publication, options);
    const contentPreflight = new PublicationContentPreflightSession(
      opened.archive,
      loaded.publication,
      options.signal,
      compatibilityProfile,
    );
    let reader: BrowserEpubReader | null = null;
    try {
      const initialWindow = preflightWindowIndexes(
        loaded.publication,
        initial.spineIndex,
      );
      reportOpenProgress(
        options,
        'preflight',
        `Inspecting ${initialWindow.length} render-critical reading sections`,
        3,
      );
      const preflight = await contentPreflight.inspect(initialWindow);
      throwIfAborted(options.signal);
      reportOpenProgress(
        options,
        'resources',
        'Preparing publication resources',
        4,
      );
      const resource = await ResourceResolver.create(
        opened.archive,
        loaded.publication,
        compatibilityProfile,
        options.resourcePolicy,
      );
      throwIfAborted(options.signal);
      const resources = new PublicationResourceSession(
        resource.resolver,
        new BrowserObjectUrlFactory(),
      );
      const diagnostics = [
        ...loaded.diagnostics,
        ...preflight.diagnostics,
        ...resource.diagnostics,
      ];
      const viewport = measureViewport(container);
      reader = new BrowserEpubReader(
        loaded.publication,
        container,
        resources,
        contentPreflight,
        diagnostics,
        preflight.hints,
        preferences,
        viewport,
        compatibilityProfile,
        extensions,
        options,
      );

      reportOpenProgress(
        options,
        'rendition',
        'Laying out the first section',
        5,
      );
      await reader.goToLocator(initial);
      throwIfAborted(options.signal);
      contentPreflight.detachParentSignal();
      reader.publish('ready', null);
      reader.startBackgroundPreflight();
      return reader;
    } catch (error) {
      if (reader) reader.dispose();
      else contentPreflight.dispose();
      throw error;
    }
  }

  get snapshot(): BrowserEpubReaderSnapshot {
    return this.snapshotValue;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async next(): Promise<ReaderNavigationResult> {
    this.assertAlive();
    const result = await this.navigator.next();
    if (result.status === 'moved') this.locator = result.locator;
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
    if (result.status === 'boundary')
      this.readerEvent?.({ type: 'navigation-boundary', edge: result.edge });
    return result;
  }

  async previous(): Promise<ReaderNavigationResult> {
    this.assertAlive();
    const result = await this.navigator.previous();
    if (result.status === 'moved') this.locator = result.locator;
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
    if (result.status === 'boundary')
      this.readerEvent?.({ type: 'navigation-boundary', edge: result.edge });
    return result;
  }

  async goTo(target: NavigationTarget): Promise<Locator | null> {
    this.assertAlive();
    return this.goToWithHistory(target);
  }

  async back(steps = 1): Promise<Locator | null> {
    this.assertAlive();
    return this.restoreHistorySteps('back', steps);
  }

  async forward(steps = 1): Promise<Locator | null> {
    this.assertAlive();
    return this.restoreHistorySteps('forward', steps);
  }

  async goToLocator(locator: Locator): Promise<Locator | null> {
    this.assertAlive();
    return this.withPendingNavigation(locator, async () => {
      const restored = await this.navigator.goToLocator(locator);
      this.locator = restored ?? locator;
      this.publish(this.snapshotValue.status, this.snapshotValue.error);
      return restored;
    });
  }

  async setPreferences(patch: ReaderPreferencesPatch): Promise<void> {
    this.assertAlive();
    const next = normalizeReaderPreferences({
      ...this.preferences,
      ...patch,
      compatibility: {
        ...this.preferences.compatibility,
        ...patch.compatibility,
      },
    });
    if (samePreferences(this.preferences, next)) return;
    const previous = this.preferences;
    const needsRelayout =
      this.host.state.plan != null &&
      (renderPreferencesChanged(previous, next) ||
        renderPreferencesChanged(this.committedRenderPreferences, next));
    this.preferences = next;
    try {
      if (needsRelayout) {
        await this.navigator.relayout(
          spreadChanged(previous, next) ||
            spreadChanged(this.committedRenderPreferences, next)
            ? 'spread-change'
            : 'preferences',
        );
      }
    } catch (error) {
      // The public snapshot must never claim a preference was applied when the
      // renderer rejected that transition. The host owns renderer rollback/error
      // state; the composition root owns preference-state rollback.
      if (this.preferences === next) {
        this.preferences = restoreRenderedPreferences(
          next,
          this.committedRenderPreferences,
        );
      }
      this.publish(this.snapshotValue.status, error);
      throw error;
    }
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
  }

  async setViewport(viewport: ViewportMetrics): Promise<void> {
    this.assertAlive();
    const next = cloneAndFreezePlainData(normalizeViewport(viewport));
    if (sameViewport(this.viewport, next)) return;
    this.viewport = next;
    try {
      if (this.host.state.plan) {
        await this.navigator.relayout('viewport-resize');
      } else this.committedViewport = next;
    } catch (error) {
      // ResizeObserver can race with renderer work. Keep the externally visible
      // viewport aligned with the last successfully committed layout.
      if (this.viewport === next) this.viewport = this.committedViewport;
      this.publish(this.snapshotValue.status, error);
      throw error;
    }
    this.decorations.refresh();
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
  }

  async syncViewportFromElement(): Promise<void> {
    return this.setViewport(measureViewport(this.container));
  }

  captureSelection(): ReaderSelection | null {
    this.assertAlive();
    this.selection = captureSelectionFromDocuments(
      this.host.contentDocuments,
      this.publication,
    );
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
    return this.selection;
  }

  clearSelection(): void {
    this.assertAlive();
    this.selection = null;
    for (const context of this.host.contentDocuments)
      getDocumentSelection(context.document)?.removeAllRanges();
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
  }

  async addHighlightFromSelection(
    highlight: AnnotationHighlightStyle = 'solid',
    color: AnnotationColor = 'yellow',
  ): Promise<Highlight | null> {
    const selection = this.captureSelection();
    if (!selection || selection.collapsed || !selection.text.trim())
      return null;
    const mark = this.markController.addHighlight(
      selection.range,
      highlight,
      color,
    );
    this.clearSelection();
    return mark;
  }

  async captureLocator(): Promise<Locator | null> {
    this.assertAlive();
    const locator = await this.host.captureLocator();
    if (locator) {
      this.locator = locator;
      this.publish(this.snapshotValue.status, this.snapshotValue.error);
    }
    return locator;
  }

  async registerTheme(theme: ReaderThemeDefinition): Promise<void> {
    this.assertAlive();
    const unregister = this.themeRegistry.register(theme);
    try {
      if (this.host.state.plan && this.preferences.theme === theme.id) {
        await this.navigator.relayout('preferences');
      }
    } catch (error) {
      unregister();
      throw error;
    }
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelBackgroundPreflight?.();
    this.cancelBackgroundPreflight = null;
    this.contentPreflight.dispose();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.inputRouter.dispose();
    this.linkRouter.dispose();
    if (this.selectionPollTimer != null)
      this.container.ownerDocument.defaultView?.clearInterval(
        this.selectionPollTimer,
      );
    this.selectionRouter.dispose();
    this.mediaRouter.dispose();
    this.decorations.dispose();
    this.searchController.dispose();
    this.host.dispose();
    this.contentDocumentCache.dispose();
    this.resources.dispose();
    this.snapshotValue = this.buildSnapshot('disposed', null);
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }

  private handleDecorationActivation(
    activation: ReaderDecorationActivation,
  ): boolean {
    const mark = this.markStore
      .snapshot()
      .marks.find((candidate) => candidate.id === activation.decoration.id);
    if (!mark || mark.kind === 'bookmark' || !this.readerEvent) return false;

    const surface = activation.context.surfaceElement;
    const surfaceRect = surface.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const viewportWidth =
      activation.context.document.defaultView?.innerWidth ||
      surface.clientWidth ||
      surfaceRect.width;
    const viewportHeight =
      activation.context.document.defaultView?.innerHeight ||
      surface.clientHeight ||
      surfaceRect.height;

    this.readerEvent({
      type: 'mark-activated',
      activation: {
        mark,
        anchor: {
          x:
            surfaceRect.left -
            containerRect.left +
            (activation.clientX * surfaceRect.width) /
              Math.max(1, viewportWidth),
          y:
            surfaceRect.top -
            containerRect.top +
            (activation.clientY * surfaceRect.height) /
              Math.max(1, viewportHeight),
        },
        returnFocus: surface,
      },
    });
    return true;
  }

  private async handleFootnoteLink(
    activation: FootnoteLinkActivation,
  ): Promise<boolean> {
    if (!this.readerEvent) return false;
    const footnote = await loadPublicationFootnote(
      this.resources.resolver,
      this.container.ownerDocument,
      activation.href,
      activation.label,
    );
    if (!footnote || this.disposed) return false;

    this.readerEvent({
      type: 'footnote-activated',
      footnote,
      trigger: activation.trigger,
    });
    return true;
  }

  private handleSelectionChange(
    activation: ReaderSelectionActivation | null,
  ): void {
    this.selection = activation?.selection ?? null;
    this.readerEvent?.({ type: 'selection-changed', activation });
  }

  private handleImageActivation(activation: ReaderImageActivation): void {
    this.readerEvent?.({ type: 'image-activated', activation });
  }

  private handleRendererStateChange(state: RendererHostState): void {
    this.syncLiveDocuments();
    if (state.status === 'ready' && state.plan) {
      this.committedRenderPreferences = state.plan.preferences;
      this.committedViewport = state.plan.viewport;
    }
    if (state.plan && state.layout?.progression != null) {
      const progression = state.layout.progression;
      const pending = this.pendingNavigationLocator;
      this.locator =
        pending?.spineIndex === state.plan.spineIndex &&
        pending.href === state.plan.href
          ? { ...pending, locations: { ...pending.locations, progression } }
          : mergeApproximateLocator(
              this.locator,
              state.plan.spineIndex,
              state.plan.href,
              progression,
            );
    }

    const status =
      state.status === 'error'
        ? 'error'
        : state.status === 'disposed'
          ? 'disposed'
          : state.status === 'ready'
            ? 'ready'
            : 'opening';
    this.publish(status, state.error);
  }

  private handleSearchStateChange(state: ReaderSearchState): void {
    const currentHitId =
      state.index >= 0 ? (state.hits[state.index]?.id ?? null) : null;
    this.decorations.setSearchHits(state.hits, currentHitId);
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
  }

  private createSearchApi(): BrowserEpubReaderSearchApi {
    return Object.freeze<BrowserEpubReaderSearchApi>({
      run: async (
        query: string,
        searchOptions: Partial<SearchOptions> = {},
      ) => {
        this.assertAlive();
        const result = await this.searchController.run(query, searchOptions);
        return result.hits;
      },
      clear: () => {
        this.assertAlive();
        this.searchController.clear();
      },
      clearCache: () => {
        this.assertAlive();
        this.searchController.clearCache();
      },
      goTo: (index) => {
        this.assertAlive();
        return this.searchWithHistory(() =>
          this.searchController.goToHit(index),
        );
      },
      next: () => {
        this.assertAlive();
        return this.searchWithHistory(() => this.searchController.next());
      },
      previous: () => {
        this.assertAlive();
        return this.searchWithHistory(() => this.searchController.previous());
      },
    });
  }

  private createMarksApi(): BrowserEpubReaderMarksApi {
    return Object.freeze<BrowserEpubReaderMarksApi>({
      addBookmark: (label) => {
        this.assertAlive();
        return addBookmarkAndNotify(
          (nextLabel) => this.markController.addBookmark(nextLabel),
          label,
          this.options.onEvent,
        );
      },
      addHighlight: (range, highlight, color, label, tags) => {
        this.assertAlive();
        return this.markController.addHighlight(
          range,
          highlight,
          color,
          label,
          tags,
        );
      },
      addAnnotation: (range, body, highlight, color, label, tags) => {
        this.assertAlive();
        return this.markController.addAnnotation(
          range,
          body,
          highlight,
          color,
          label,
          tags,
        );
      },
      remove: (id) => {
        this.assertAlive();
        return this.markStore.remove(id);
      },
      removeMany: (ids) => {
        this.assertAlive();
        return this.markStore.removeMany(ids);
      },
      update: (id, patch) => {
        this.assertAlive();
        return this.markController.update(id, patch);
      },
      clear: () => {
        this.assertAlive();
        this.markStore.clear();
      },
      goTo: (id) => {
        this.assertAlive();
        return this.goToMark(id);
      },
    });
  }

  private async goToMark(id: string): Promise<boolean> {
    const mark = this.markStore
      .snapshot()
      .marks.find((candidate) => candidate.id === id);
    if (!mark) return false;

    const origin = await this.currentHistoryLocator();
    const restored = await this.markController.goToMark(mark as ReaderMark);
    this.locator =
      restored ?? (mark.kind === 'bookmark' ? mark.locator : mark.range.start);
    this.navigationHistory.record(origin, this.locator);
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
    return true;
  }

  private async planForSpine(spineIndex: number) {
    const preflight = await this.contentPreflight.inspect(
      preflightWindowIndexes(this.publication, spineIndex),
    );
    this.applyContentPreflight(preflight, false);
    return this.buildPlanForSpine(spineIndex);
  }

  private buildPlanForSpine(spineIndex: number) {
    const spineItem = this.publication.spine[spineIndex];
    if (!spineItem)
      throw new RangeError(
        `Spine index ${spineIndex} is outside the publication reading order.`,
      );
    const contentHints = this.hints.get(spineIndex);
    const compatibility = this.resolveRenditionCompatibility({
      publication: this.publication,
      spineItem,
      contentHints,
      preferences: this.preferences,
    });
    return planRendition({
      publication: this.publication,
      spineItem,
      viewport: this.viewport,
      preferences: this.preferences,
      contentHints,
      policy: this.plannerPolicy,
      compatibility: compatibility.value,
      compatibilityDiagnostics: compatibility.diagnostics,
    });
  }

  private resolveRenditionCompatibility(
    context: import('../../epub/compatibility/rendition-policy').RenditionCompatibilityContext,
  ) {
    return runRenditionCompatibilityPolicies(
      this.compatibilityProfile.renditionPolicies,
      context,
      { fitSingleImagePage: false },
    );
  }

  private inputState(): ReaderInputState {
    const plan = this.host.state.plan;
    return {
      enabled: !this.disposed && this.host.state.status === 'ready',
      pageProgression: plan?.pageProgression.value ?? 'ltr',
      contentKind:
        plan?.renderer === 'fixed-layout' ? 'fixed-layout' : 'reflowable',
      presentation:
        plan &&
        (plan.overflow.value === 'scrolled-doc' ||
          plan.overflow.value === 'scrolled-continuous')
          ? 'scrolled'
          : 'paginated',
      wheelBoundaryNavigation: plan?.renderer === 'fixed-layout',
      touchNavigation: this.preferences.touchNavigation,
      pageTurnZonePercent: this.preferences.pageTurnZonePercent,
    };
  }

  private syncLiveDocuments(): void {
    const documents = this.host.contentDocuments;
    this.inputRouter?.syncDocuments(documents);
    this.linkRouter?.syncDocuments(documents);
    this.selectionRouter?.syncDocuments(documents);
    this.mediaRouter?.syncDocuments(documents);
  }

  private async goToWithHistory(
    target: NavigationTarget,
  ): Promise<Locator | null> {
    const origin = await this.currentHistoryLocator();
    const requested =
      'kind' in target
        ? target.kind === 'href'
          ? locatorFromHref(this.publication, target.href)
          : locatorFromCfi(this.publication, target.cfi)
        : target;
    return this.withPendingNavigation(requested, async () => {
      const locator = await this.navigator.goTo(target);
      this.locator = locator;
      this.navigationHistory.record(origin, locator);
      this.publish(this.snapshotValue.status, this.snapshotValue.error);
      return locator;
    });
  }

  private async withPendingNavigation<T>(
    locator: Locator,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.pendingNavigationLocator = locator;
    try {
      return await operation();
    } finally {
      if (this.pendingNavigationLocator === locator)
        this.pendingNavigationLocator = null;
    }
  }

  private async searchWithHistory(
    operation: () => Promise<ReaderSearchNavigationResult | null>,
  ): Promise<SearchHit | null> {
    const origin = await this.currentHistoryLocator();
    const navigation = await operation();
    if (navigation) {
      this.locator = navigation.locator;
      this.navigationHistory.record(origin, this.locator);
    }
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
    return navigation?.hit ?? null;
  }

  private async restoreHistory(
    direction: 'back' | 'forward',
  ): Promise<Locator | null> {
    const target =
      direction === 'back'
        ? this.navigationHistory.peekBack()
        : this.navigationHistory.peekForward();
    if (!target) return null;
    const current = await this.currentHistoryLocator();
    const restored = await this.navigator.goToLocator(target);
    this.locator = restored ?? target;
    if (direction === 'back') this.navigationHistory.commitBack(current);
    else this.navigationHistory.commitForward(current);
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
    return this.locator;
  }

  private async restoreHistorySteps(
    direction: 'back' | 'forward',
    steps: number,
  ): Promise<Locator | null> {
    if (!Number.isInteger(steps) || steps < 1)
      throw new RangeError('History steps must be a positive integer.');
    let restored: Locator | null = null;
    for (let step = 0; step < steps; step += 1) {
      const next = await this.restoreHistory(direction);
      if (!next) break;
      restored = next;
    }
    return restored;
  }

  private async currentHistoryLocator(): Promise<Locator | null> {
    return (await this.host.captureLocator()) ?? this.locator;
  }

  private stepFont(delta: 1 | -1): Promise<void> {
    const step = delta > 0 ? 10 : -10;
    return this.setPreferences({
      fontSizePercent: this.preferences.fontSizePercent + step,
    });
  }

  private appendDiagnostics(
    next: readonly PublicationDiagnostic[],
    options: BrowserEpubReaderOptions,
  ): void {
    if (next.length === 0) return;
    const unique = this.diagnostics.append(next);
    if (unique.length === 0) return;
    options.onDiagnostics?.(unique);
    this.publish(this.snapshotValue.status, this.snapshotValue.error);
  }

  private startBackgroundPreflight(): void {
    if (this.disposed || this.cancelBackgroundPreflight) return;
    const run = () => {
      this.cancelBackgroundPreflight = null;
      void this.contentPreflight.inspect().then(
        (result) => {
          if (!this.disposed) this.applyContentPreflight(result, true);
        },
        (error) => {
          if (this.disposed || isAbortError(error)) return;
          this.appendDiagnostics(
            [
              {
                code: 'CONTENT_PREFLIGHT_BACKGROUND_FAILED',
                severity: 'warning',
                phase: 'content',
                message:
                  'Background content preflight stopped unexpectedly; renderer-side inspection remains available.',
                cause: error,
              },
            ],
            this.options,
          );
        },
      );
    };
    const view = this.container.ownerDocument.defaultView;
    if (!view) {
      run();
      return;
    }
    if (typeof view.requestIdleCallback === 'function') {
      const handle = view.requestIdleCallback(run, { timeout: 250 });
      this.cancelBackgroundPreflight = () => view.cancelIdleCallback(handle);
      return;
    }
    const handle = view.setTimeout(run, 0);
    this.cancelBackgroundPreflight = () => view.clearTimeout(handle);
  }

  private applyContentPreflight(
    result: PublicationContentPreflightResult,
    complete: boolean,
  ): void {
    let hintsChanged = false;
    for (const [spineIndex, hints] of result.hints) {
      const current = this.hints.get(spineIndex);
      // Renderer-computed presentation is more authoritative than the static
      // CSS subset, while preflight still fills page/viewport fields the live
      // renderer does not report.
      const merged = mergeHints(hints, current ?? {});
      if (!sameContentHints(current, merged)) hintsChanged = true;
      this.hints.set(spineIndex, merged);
    }
    const previousPresentation = this.presentation;
    if (complete)
      this.presentation = resolvePublicationPresentation(
        this.publication,
        this.hints,
      );
    const unique = this.diagnostics.append(result.diagnostics);
    if (unique.length > 0) this.options.onDiagnostics?.(unique);
    if (
      hintsChanged ||
      unique.length > 0 ||
      previousPresentation !== this.presentation
    ) {
      this.publish(this.snapshotValue.status, this.snapshotValue.error);
    }
  }

  private publishError(error: unknown): void {
    // Input/host-callback failures are operational errors, not evidence that the
    // active publication can no longer render. Preserve the current lifecycle status.
    this.publish(this.snapshotValue.status, error);
  }

  private publish(
    status: BrowserEpubReaderSnapshot['status'],
    error: unknown | null,
  ): void {
    if (this.disposed && status !== 'disposed') return;
    this.snapshotValue = this.buildSnapshot(status, error);
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(
    status: BrowserEpubReaderSnapshot['status'],
    error: unknown | null,
  ): BrowserEpubReaderSnapshot {
    const renderer = this.host?.state ?? emptyRendererState();
    const accessibility = describeReaderPosition(this.publication, {
      locator: this.locator,
      layout: renderer.layout,
    });
    return cloneAndFreezePlainData({
      status,
      publication: this.publication,
      presentation: this.presentation,
      diagnostics: this.diagnostics.all,
      compatibility: this.diagnostics.compatibility,
      preferences: this.preferences,
      viewport: this.viewport,
      renderer,
      locator: this.locator,
      navigationHistory: this.navigationHistory.snapshot,
      readingPosition: resolveReadingPosition(
        this.publication,
        this.locator,
        renderer,
        this.presentation,
      ),
      search: this.searchController?.state ?? emptySearchState(),
      marks: this.marksSnapshot,
      selection: this.selection,
      accessibility,
      appearance: { themes: this.themeRegistry.list() },
      input: this.inputMap.description,
      error,
    });
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('BrowserEpubReader has been disposed.');
  }
}
