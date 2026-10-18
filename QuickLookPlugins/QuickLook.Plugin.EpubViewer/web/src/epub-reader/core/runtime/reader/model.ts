import type { ReaderAccessibilityDescription } from '../../features/accessibility';
import type {
  ReaderMarkStore,
  ReaderMarkStoreSnapshot,
} from '../../features/annotations';
import type { ReaderThemeDefinition } from '../../presentation/appearance';
import type {
  PublicationDiagnostic,
  Locator,
  LocatorRange,
  Publication,
  PublicationLayoutProfile,
  ReaderPreferences,
  PublicationControlDocumentLimits,
  WritingMode,
} from '../../epub/publication';
import type {
  ReaderHostCommand,
  ReaderInputMapDescription,
  ReaderInputPolicy,
} from '../../interaction/input';
import type { ReaderExtensionConfiguration } from '../configuration';
import type {
  PublicationSearchCachePolicy,
  ReaderSearchState,
  SearchOptions,
  SearchHit,
} from '../../features/search';
import type { RendererHostState } from '../../presentation/renderer';
import type {
  RenditionPlannerPolicy,
  ViewportMetrics,
} from '../../presentation/rendition';
import type { ResourceResolverOptions } from '../../epub/resources';
import type { PublicationLinkRouterOptions } from '../../interaction/navigation';
import type { ReaderNavigationHistorySnapshot } from '../../interaction/navigation';
import type { ReaderFootnote } from '../../interaction/navigation';
import type {
  ReaderSelection,
  ReaderSelectionActivation,
} from '../../interaction/selection';
import type { ReaderImageActivation } from '../../features/media';
import type { OcfCompatibilityMode, OcfZipLimits } from '../../epub/archive';
import type { CompatibilityReport } from '../../epub/compatibility';
import type { PublicationContentDocumentCachePolicy } from '../../epub/content';

export type BrowserEpubReaderStatus =
  'opening' | 'ready' | 'error' | 'disposed';

export type BrowserEpubReaderOpenPhase =
  'archive' | 'package' | 'preflight' | 'resources' | 'rendition';

export interface BrowserEpubReaderOpenProgress {
  readonly phase: BrowserEpubReaderOpenPhase;
  readonly label: string;
  /** Number of phases reached, from 1 through total. */
  readonly completed: number;
  /** Total number of phases in the open pipeline. */
  readonly total: number;
}

export interface ReaderMarkActivation {
  readonly mark:
    | import('../../features/annotations').Highlight
    | import('../../features/annotations').Annotation;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly returnFocus: HTMLElement;
}

export type ReaderEvent =
  | { readonly type: 'navigation-boundary'; readonly edge: 'start' | 'end' }
  | { readonly type: 'bookmark-added' }
  | {
      readonly type: 'footnote-activated';
      readonly footnote: ReaderFootnote;
      readonly trigger: HTMLElement;
    }
  | {
      readonly type: 'selection-changed';
      readonly activation: ReaderSelectionActivation | null;
    }
  | {
      readonly type: 'mark-activated';
      readonly activation: ReaderMarkActivation;
    }
  | {
      readonly type: 'image-activated';
      readonly activation: ReaderImageActivation;
    };

/**
 * Presentation facts that belong to the publication, not to the active page.
 *
 * The renderer plan is per spine item, so product chrome driven directly by it
 * restyles itself whenever the reader crosses into a differently-rendered page.
 * More than half of real light novels interleave pre-paginated illustration
 * pages with reflowable chapters, so that is a page turn, not an edge case.
 * Layout and chrome are resolved once from package metadata. Writing mode starts
 * from the render-critical preflight window and may be refined once when the
 * staged whole-publication profile completes; it never follows page-by-page
 * renderer changes.
 */
export interface ReaderPublicationPresentation {
  readonly layout: PublicationLayoutProfile;
  /** Best-known dominant writing mode of the reflowable reading order. */
  readonly writingMode: WritingMode;
  /**
   * `immersive` is the full-bleed treatment for publications that are entirely
   * pre-paginated (comics, art books): overlaid auto-hiding chrome on a dark
   * stage. Every other publication, mixed ones included, uses `standard`.
   */
  readonly chrome: 'standard' | 'immersive';
}

export interface BrowserEpubReaderSnapshot {
  readonly status: BrowserEpubReaderStatus;
  readonly publication: Publication;
  /** Publication-scoped; writing mode may refine once after staged preflight completes. */
  readonly presentation: ReaderPublicationPresentation;
  readonly diagnostics: readonly PublicationDiagnostic[];
  readonly compatibility: CompatibilityReport;
  readonly preferences: ReaderPreferences;
  readonly viewport: ViewportMetrics;
  readonly renderer: RendererHostState;
  readonly locator: Locator | null;
  /** Display projection of visible boundaries; never persisted as a locator. */
  readonly readingPosition?: {
    readonly atStart: boolean;
    readonly atEnd: boolean;
    readonly publicationProgression: number;
  };
  readonly navigationHistory: ReaderNavigationHistorySnapshot;
  readonly search: ReaderSearchState;
  readonly marks: ReaderMarkStoreSnapshot;
  readonly selection: ReaderSelection | null;
  readonly accessibility: ReaderAccessibilityDescription;
  readonly appearance: { readonly themes: readonly ReaderThemeDefinition[] };
  readonly input: ReaderInputMapDescription;
  readonly error: unknown | null;
}

export interface BrowserEpubReaderOptions extends PublicationLinkRouterOptions {
  /** Cancels archive loading/preflight when a host replaces or closes a publication. */
  readonly signal?: AbortSignal;
  readonly onOpenProgress?: (progress: BrowserEpubReaderOpenProgress) => void;
  /** `compatible` is the practical-reader default; `strict` rejects recoverable OCF violations. */
  readonly compatibilityMode?: OcfCompatibilityMode;
  readonly preferences?: import('../../epub/publication').ReaderPreferencesPatch;
  readonly initialLocator?: Locator;
  readonly initialSpineIndex?: number;
  readonly plannerPolicy?: Partial<
    Omit<RenditionPlannerPolicy, 'syntheticSpreads'>
  > & {
    readonly syntheticSpreads?: Partial<
      RenditionPlannerPolicy['syntheticSpreads']
    >;
  };
  readonly resourcePolicy?: ResourceResolverOptions;
  readonly archiveLimits?: Partial<OcfZipLimits>;
  readonly controlDocumentLimits?: Partial<PublicationControlDocumentLimits>;
  readonly inputPolicy?: Partial<ReaderInputPolicy>;
  /** Validated, typed contributions composed before this reading session opens. */
  readonly extensions?: ReaderExtensionConfiguration;
  readonly searchCachePolicy?: Partial<PublicationSearchCachePolicy>;
  /** Bounds rewritten chapter markup retained for fast revisits. */
  readonly contentDocumentCachePolicy?: Partial<PublicationContentDocumentCachePolicy>;
  readonly markStore?: ReaderMarkStore;
  /** Requests a product-level action captured by the engine's input router. */
  readonly onCommand?: (command: ReaderHostCommand) => void;
  /** Reports semantic reader activity independently of product UI handling. */
  readonly onEvent?: (event: ReaderEvent) => void;
  readonly onDiagnostics?: (
    diagnostics: readonly PublicationDiagnostic[],
  ) => void;
}

export interface BrowserEpubReaderSearchApi {
  run(
    query: string,
    options?: Partial<SearchOptions>,
  ): Promise<readonly SearchHit[]>;
  clear(): void;
  /** Releases cached chapter indexes without clearing the visible result set. */
  clearCache(): void;
  goTo(index: number): Promise<SearchHit | null>;
  next(): Promise<SearchHit | null>;
  previous(): Promise<SearchHit | null>;
}

export interface BrowserEpubReaderMarksApi {
  addBookmark(
    label?: string,
  ): ReturnType<
    import('../../features/annotations').ReaderMarkController['addBookmark']
  >;
  addHighlight(
    range: LocatorRange,
    highlight?: import('../../features/annotations').AnnotationHighlightStyle,
    color?: import('../../features/annotations').AnnotationColor,
    label?: string,
    tags?: readonly string[],
  ): import('../../features/annotations').Highlight;
  addAnnotation(
    range: LocatorRange,
    body: string,
    highlight?: import('../../features/annotations').AnnotationHighlightStyle,
    color?: import('../../features/annotations').AnnotationColor,
    label?: string,
    tags?: readonly string[],
  ): import('../../features/annotations').Annotation;
  remove(id: string): boolean;
  removeMany(ids: readonly string[]): number;
  update(
    id: string,
    patch: import('../../features/annotations').ReaderMarkPatch,
  ): import('../../features/annotations').ReaderMark | null;
  clear(): void;
  goTo(id: string): Promise<boolean>;
}
