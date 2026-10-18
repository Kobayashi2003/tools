import type {
  ContentPageProfile,
  ContentPresentationHints,
  EffectiveSpineRendition,
  IntrinsicViewport,
  PageProgressionDirection,
  PageSpread,
  PublicationDiagnostic,
  PublicationHref,
  ReaderPreferences,
  RenditionOrientation,
  TextDirection,
  WritingMode,
} from '../../epub/publication';
import type { RenditionCompatibilityDirectives } from '../../epub/compatibility/rendition-policy';

export type RendererKind =
  'reflowable-paginated' | 'reflowable-scroll' | 'fixed-layout';

export type ResolvedPageProgression = Exclude<
  PageProgressionDirection,
  'default'
>;
export type ViewportOrientation = 'portrait' | 'landscape' | 'square';
export type PlanResolutionSource =
  | 'user'
  | 'spine'
  | 'publication'
  | 'content'
  | 'reading-system-default'
  | 'layout-requirement'
  | 'spread-placement';

export interface ViewportMetrics {
  /** Width of the content display area, not the whole application window. */
  readonly width: number;
  /** Height of the content display area, not the whole application window. */
  readonly height: number;
}

export interface RenditionPlannerPolicy {
  /** Used only when spine@page-progression-direction is `default`. */
  readonly defaultPageProgression: ResolvedPageProgression;

  /** Used only when both user and publication leave reflowable overflow on auto. */
  readonly defaultReflowableFlow: 'paginated' | 'scrolled-doc';

  /** Generic user preference `scrolled` resolves to this document relationship. */
  readonly defaultUserScrolledFlow: 'scrolled-doc' | 'scrolled-continuous';

  readonly syntheticSpreads: {
    readonly supported: boolean;
    /** Auto-spread is a reading-system optimization, not publication semantics. */
    readonly autoMode: 'never' | 'landscape-when-room' | 'when-room';
    /** Minimum content-display width before an automatic two-up view is considered. */
    readonly minViewportWidth: number;
    /** Minimum width available to each page in an automatically-created spread. */
    readonly minPageWidth: number;
  };
}

export const DEFAULT_RENDITION_PLANNER_POLICY: RenditionPlannerPolicy =
  Object.freeze({
    defaultPageProgression: 'ltr',
    defaultReflowableFlow: 'paginated',
    defaultUserScrolledFlow: 'scrolled-doc',
    syntheticSpreads: Object.freeze({
      // The spread compositor supports fixed/reflowable mixed slots.
      supported: true,
      autoMode: 'landscape-when-room',
      minViewportWidth: 720,
      minPageWidth: 320,
    }),
  });

export interface ResolvedValue<T> {
  readonly value: T;
  readonly source: PlanResolutionSource;
}

export type OverflowMode =
  'fixed-page' | 'paginated' | 'scrolled-doc' | 'scrolled-continuous';

export interface SpreadPairHint {
  readonly leftSpineIndex: number;
  readonly rightSpineIndex: number;
}

/**
 * Spread composition is deliberately independent from RendererKind. A spread
 * can contain heterogeneous neighboring spine items in a mixed-layout book.
 * The renderer executes this either inside one reflowable document or through the
 * cross-spine compositor, depending on the plan's execution mode.
 */
export type SpreadExecutionMode =
  'single' | 'intra-document' | 'spanning-document' | 'cross-spine';

export interface SpreadPlan {
  readonly mode: 'single' | 'double';
  /** How a double spread is executed: continuous columns, one spread-sized document, or multiple spine documents. */
  readonly execution: SpreadExecutionMode;
  readonly synthetic: boolean;
  readonly source: PlanResolutionSource;

  /** Explicit authored slot for the active spine item. */
  readonly placement: PageSpread | 'auto';

  /** Adjacent explicit left/right declarations that describe a likely true spread. */
  readonly trueSpread?: SpreadPairHint;

  /** Fixed-layout synthetic spreads and true spreads must not introduce a gutter. */
  readonly gap: 'none' | 'renderer-default';
}

export interface OrientationPlan {
  readonly requested: RenditionOrientation;
  readonly viewport: ViewportOrientation;
  readonly matchesRequested: boolean;
  /** The web component can surface this intent even when it cannot rotate the device. */
  readonly preference: 'any' | 'prefer-portrait' | 'prefer-landscape';
}

export interface RenditionCapabilities {
  readonly textCustomization: {
    readonly fontSize: boolean;
    readonly fontFamily: boolean;
    readonly lineHeight: boolean;
  };
  readonly navigation: {
    readonly paginated: boolean;
    readonly scroll: boolean;
    readonly syntheticSpread: boolean;
  };
  readonly presentation: {
    readonly intrinsicZoom: boolean;
    readonly horizontalCentering: boolean;
  };
}

export interface RenditionRequirements {
  /** Fixed layout cannot be scaled correctly until its XHTML viewport/SVG viewBox is known. */
  readonly intrinsicViewport: 'required' | 'not-required';
  /** Content CSS/attributes are authoritative for writing mode and text direction. */
  readonly contentPresentationInspection: 'recommended' | 'optional';
}

export interface RenditionPlan {
  readonly spineIndex: number;
  readonly href: PublicationHref;
  readonly renderer: RendererKind;

  /** Exact content display area used to create this plan. */
  readonly viewport: ViewportMetrics;

  /** Publication intent after package + itemref inheritance. */
  readonly publicationRendition: EffectiveSpineRendition;

  readonly pageProgression: ResolvedValue<ResolvedPageProgression>;
  readonly overflow: ResolvedValue<OverflowMode>;
  readonly writingMode: ResolvedValue<WritingMode>;
  readonly textDirection: ResolvedValue<TextDirection>;

  readonly orientation: OrientationPlan;
  readonly spread: SpreadPlan;
  readonly alignXCenter: boolean;
  /**
   * Structural page semantics discovered before rendering. Keep this distinct
   * from the authored rendition: a reflowable document may still be a single
   * image page that needs page-sized execution without being promoted to
   * fixed-layout.
   */
  readonly contentPage?: ContentPageProfile;
  readonly intrinsicViewport?: IntrinsicViewport;

  readonly preferences: ReaderPreferences;
  readonly compatibility: RenditionCompatibilityDirectives;
  readonly capabilities: RenditionCapabilities;
  readonly requirements: RenditionRequirements;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export interface PlanRenditionInput {
  readonly publication: import('../../epub/publication').Publication;
  readonly spineItem: import('../../epub/publication').SpineItem;
  readonly viewport: ViewportMetrics;
  readonly preferences?: ReaderPreferences;
  readonly contentHints?: ContentPresentationHints;
  readonly policy?: RenditionPlannerPolicy;
  readonly compatibility?: RenditionCompatibilityDirectives;
  readonly compatibilityDiagnostics?: readonly PublicationDiagnostic[];
}
