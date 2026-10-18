import type { Locator } from '../../epub/publication';
import type { RenditionPlan, RendererKind } from '../rendition';

export type RendererHostStatus =
  'idle' | 'rendering' | 'ready' | 'error' | 'disposed';

export type ReadingDirection = 'forward' | 'backward';

export type RendererNavigationResult =
  | { readonly status: 'moved'; readonly layout: RendererLayoutSnapshot }
  | { readonly status: 'boundary'; readonly edge: 'start' | 'end' };

export type LayoutTransactionReason =
  | 'initial-render'
  | 'navigation'
  | 'preferences'
  | 'viewport-resize'
  | 'spread-change'
  | 'content-change'
  | 'manual';

export interface LayoutMeasurement {
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  /**
   * Physical bounds of the laid-out content, including overflow toward negative
   * coordinates.
   *
   * `scrollWidth`/`scrollHeight` only ever grow in the positive direction, so
   * `vertical-rl` content — whose blocks advance leftward, off the origin — can
   * reflow from one page to twelve without moving either of them. Stability
   * detection that watched only the scrolling box would call such a document
   * settled while its fonts were still arriving, and the page map built from
   * that moment would be short. Optional because non-DOM layout targets in the
   * test suite do not report it.
   */
  readonly contentWidth?: number;
  readonly contentHeight?: number;
}

export interface LayoutStabilityPolicy {
  /** Maximum wall-clock time for fonts/images/layout to settle. */
  readonly timeoutMs: number;
  /** Consecutive frames with identical geometry required before commit. */
  readonly stableFrames: number;
  readonly waitForFonts: boolean;
  readonly decodeImages: boolean;
  readonly observeResize: boolean;
}

export const DEFAULT_LAYOUT_STABILITY_POLICY: LayoutStabilityPolicy =
  Object.freeze({
    timeoutMs: 4_000,
    stableFrames: 2,
    waitForFonts: true,
    decodeImages: true,
    observeResize: true,
  });

export interface LayoutStabilityReport {
  readonly status: 'stable' | 'timed-out';
  readonly fonts: 'not-requested' | 'ready' | 'timed-out';
  readonly images: {
    readonly requested: number;
    readonly decoded: number;
    readonly failed: number;
    readonly timedOut: boolean;
  };
  readonly stableFramesObserved: number;
  readonly measurement: LayoutMeasurement;
}

/**
 * Browser-independent adapter used by the stability detector. Browser code
 * supplies a DOM implementation; unit tests can supply a deterministic fake.
 */
export interface LayoutStabilityTarget {
  waitForFonts(signal: AbortSignal): Promise<void>;
  decodeImages(
    signal: AbortSignal,
  ): Promise<{ decoded: number; failed: number; total: number }>;
  measure(): LayoutMeasurement;
  requestFrame(callback: () => void): () => void;
  observeResize?(callback: () => void): () => void;
}

export type ContentSurfaceState =
  'created' | 'mounted' | 'loading' | 'ready' | 'disposed';

export type ContentSurfaceSource =
  | {
      readonly kind: 'srcdoc';
      readonly html: string;
      /** Optional base URL injected into the document head before loading. */
      readonly baseHref?: string;
    }
  | {
      readonly kind: 'url';
      readonly url: string;
      /** Rewritten markup used when the browser cannot load same-origin Blob documents in iframes. */
      readonly srcdocFallback?: {
        readonly html: string;
        readonly baseHref?: string;
      };
    };

export interface ContentSurfaceLoadResult {
  /** Document load is complete and same-origin DOM access is available. */
  readonly document: Document;
}

/**
 * One disposable browser-document lifetime. A surface is intentionally
 * single-load: navigating to another spine item creates another surface.
 */
export interface ContentSurface {
  readonly id: string;
  readonly state: ContentSurfaceState;
  readonly element: HTMLElement;
  readonly document: Document | null;

  mount(parent: HTMLElement): void;
  load(
    source: ContentSurfaceSource,
    signal: AbortSignal,
  ): Promise<ContentSurfaceLoadResult>;
  waitForLayoutStable(signal: AbortSignal): Promise<LayoutStabilityReport>;
  dispose(): void;
}

export interface LayoutTransactionContext {
  readonly generation: number;
  readonly reason: LayoutTransactionReason;
  readonly signal: AbortSignal;

  /** Throws AbortError if a newer transaction has superseded this one. */
  throwIfSuperseded(): void;

  /**
   * Gate every DOM/state mutation that occurs after an await through this
   * method. Stale transactions are forbidden from mutating the live renderer.
   */
  mutate<T>(mutation: () => T): T;
}

export type LayoutTransactionResult<T> =
  | {
      readonly status: 'committed';
      readonly generation: number;
      readonly value: T;
    }
  | {
      readonly status: 'superseded';
      readonly generation: number;
    };

export interface RendererContentDocument {
  readonly spineIndex: number;
  readonly href: import('../../epub/publication').PublicationHref;
  readonly document: Document;
  readonly surfaceElement: HTMLElement;
}

export interface RendererLayoutSnapshot {
  /** Visible resource boundaries; independent of the semantic locator anchor. */
  readonly resourceBoundary?: {
    readonly atStart: boolean;
    readonly atEnd: boolean;
  };
  readonly measurement?: LayoutMeasurement;
  readonly pageCount?: number;
  readonly currentPage?: number;
  readonly progression?: number;
  /**
   * Spine items the reader can see right now, in reading order.
   *
   * A composed spread shows two spine documents at once. Navigation has to know
   * that to avoid spending a page turn re-composing the spread it is already
   * showing, and the product has to know it to report a position that covers
   * both rather than naming one and appearing to skip the other. Absent for
   * renderers that only ever show the active item.
   */
  readonly visibleSpineIndices?: readonly number[];
}

/**
 * Contract implemented by the reflowable and fixed-layout renderers. The host owns orchestration;
 * renderers own renderer-specific DOM and layout behavior.
 */
export interface RendererInstance {
  readonly kind: RendererKind;

  /** First render for this instance. */
  mount(
    plan: RenditionPlan,
    transaction: LayoutTransactionContext,
  ): Promise<void>;

  /** Relayout the same active renderer (preferences/viewport/etc.). */
  update(
    plan: RenditionPlan,
    transaction: LayoutTransactionContext,
  ): Promise<void>;

  captureLocator(
    transaction: LayoutTransactionContext,
  ): Promise<Locator | null>;
  /** Restores and returns a healed locator when a resilient channel was used. */
  restoreLocator(
    locator: Locator,
    transaction: LayoutTransactionContext,
  ): Promise<Locator | null>;
  navigate(
    direction: ReadingDirection,
    transaction: LayoutTransactionContext,
  ): Promise<RendererNavigationResult>;
  waitForLayoutStable(
    transaction: LayoutTransactionContext,
  ): Promise<LayoutStabilityReport>;
  snapshot(): RendererLayoutSnapshot;
  /** Live documents exposed to non-mutating reader feature layers. */
  contentDocuments?(): readonly RendererContentDocument[];
  /** Native scrolling can change geometry without a navigation transaction. */
  onLayoutChange?(
    listener: (layout: RendererLayoutSnapshot) => void,
  ): () => void;
  /** Optional visual activation gate used for atomic renderer replacement. */
  setVisibility?(visible: boolean): void;
  dispose(): void;
}

export interface RendererFactory {
  readonly kind: RendererKind;
  create(plan?: RenditionPlan): RendererInstance;
}

export interface RendererHostState {
  readonly status: RendererHostStatus;
  readonly generation: number;
  readonly plan: RenditionPlan | null;
  readonly rendererKind: RendererKind | null;
  readonly layout: RendererLayoutSnapshot | null;
  readonly stability: LayoutStabilityReport | null;
  readonly error: unknown | null;
}

/** Result of one committed presentation, including the locator actually restored. */
export interface RendererPresentationResult {
  readonly state: RendererHostState;
  readonly locator: Locator | null;
}

export interface RendererCommitEvent {
  readonly generation: number;
  readonly reason: LayoutTransactionReason;
  readonly plan: RenditionPlan;
  readonly layout: RendererLayoutSnapshot;
  readonly stability: LayoutStabilityReport;
}
