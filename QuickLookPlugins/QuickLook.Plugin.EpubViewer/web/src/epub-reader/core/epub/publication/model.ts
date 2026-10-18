/**
 * Headless EPUB publication model.
 *
 * Rules for this module:
 * - no React
 * - no DOM
 * - no epub.js / react-reader types
 * - preserve publication declarations; do not "repair" them here
 * - keep reading order, text direction, writing mode and spread placement distinct
 */

export type EpubVersion =
  '2' | '2.0' | '2.0.1' | '3' | '3.0' | '3.1' | '3.2' | '3.3' | (string & {});

/** Path inside the EPUB container, normalized to `/` separators and no leading slash. */
export type PublicationPath = string;

/** Canonical resolved reference: either a local PublicationPath or an absolute remote URL. */
export type PublicationHref = string;

/** A URL fragment without the leading `#`. */
export type FragmentId = string;

export type PageProgressionDirection = 'ltr' | 'rtl' | 'default';
export type TextDirection = 'ltr' | 'rtl' | 'auto';
export type WritingMode = 'horizontal-tb' | 'vertical-rl' | 'vertical-lr';

export type RenditionLayout = 'reflowable' | 'pre-paginated';
export type RenditionOrientation = 'auto' | 'portrait' | 'landscape';
/** `portrait` is deprecated in EPUB 3.3 but must be preserved when authored. */
export type RenditionSpread =
  'auto' | 'none' | 'landscape' | 'portrait' | 'both';
export type RenditionFlow =
  'auto' | 'paginated' | 'scrolled-continuous' | 'scrolled-doc';
export type PageSpread = 'left' | 'right' | 'center';

/**
 * Package-level rendition declarations.
 *
 * These are declarations, not a computed rendering plan. A spine item can
 * override several of them, and the reader may still apply user preferences
 * where the EPUB specification permits it.
 */
export interface PublicationRendition {
  readonly layout: RenditionLayout;
  readonly orientation: RenditionOrientation;
  readonly spread: RenditionSpread;
  readonly flow: RenditionFlow;
}

/**
 * Local overrides declared on a spine itemref.
 * `undefined` means "inherit the publication declaration/default".
 */
export interface SpineRenditionOverrides {
  readonly layout?: RenditionLayout;
  readonly orientation?: RenditionOrientation;
  readonly spread?: RenditionSpread;
  readonly flow?: RenditionFlow;

  /** Explicit placement request for synthetic spreads. */
  readonly pageSpread?: PageSpread;

  /** EPUB `rendition:align-x-center`. */
  readonly alignXCenter?: boolean;
}

export interface PackageIdentifier {
  readonly value: string;
  readonly scheme?: string;
}

export interface Contributor {
  readonly name: string;
  readonly role?: string;
  readonly fileAs?: string;
  readonly id?: string;
}

export interface MetadataEntry {
  /** Qualified/local property name as encountered in the package document. */
  readonly property: string;
  readonly value: string;
  readonly id?: string;
  readonly refines?: string;
  readonly scheme?: string;
  readonly language?: string;
  readonly direction?: TextDirection;
}

export interface PublicationMetadata {
  readonly identifier?: PackageIdentifier;
  readonly title?: string;
  readonly subtitle?: string;
  readonly language?: string;
  readonly modified?: string;
  readonly publisher?: string;
  readonly description?: string;
  readonly rights?: string;
  readonly creators: readonly Contributor[];
  readonly contributors: readonly Contributor[];

  /**
   * Lossless-enough metadata channel for fields/refinements the reader core does
   * not interpret yet. Parser phases should preserve rather than discard them.
   */
  readonly entries: readonly MetadataEntry[];
}

/**
 * Manifest properties we interpret directly. Unknown properties are preserved
 * in `properties` as strings so newer/extension vocabularies are not lost.
 */
export type KnownManifestProperty =
  'cover-image' | 'nav' | 'scripted' | 'mathml' | 'svg' | 'remote-resources';

export interface ManifestItem {
  readonly id: string;

  /** Authored `href` exactly as present in OPF. */
  readonly sourceHref: string;

  /** Resolved local path or absolute remote URL. */
  readonly href: PublicationHref;

  /** Present only for container-local resources. */
  readonly path?: PublicationPath;
  readonly remote: boolean;

  readonly mediaType: string;
  readonly mediaOverlay?: string;
  readonly fallback?: string;
  readonly properties: readonly string[];
}

/**
 * One item in the primary reading order.
 *
 * Important: this stores local declarations. Do not flatten an EPUB into a
 * single global `isFixedLayout` flag; mixed-layout publications are valid.
 */
export interface SpineItem {
  readonly index: number;
  readonly idref: string;

  /** Optional XML id authored on the package <itemref>. */
  readonly itemrefId?: string;

  /** Package-document CFI path ending in `!`, used as the base for content CFIs. */
  readonly cfiBase?: string;
  readonly href: PublicationHref;
  readonly path?: PublicationPath;
  readonly remote: boolean;
  readonly mediaType: string;
  readonly linear: boolean;
  readonly properties: readonly string[];
  readonly rendition: SpineRenditionOverrides;
}

/**
 * A TOC entry may be an unlinked grouping heading (`span`) in EPUB Navigation
 * Documents. In that case `href`/`path` are intentionally absent.
 */
export interface TocItem {
  readonly id?: string;
  readonly label: string;
  readonly href?: PublicationHref;
  readonly path?: PublicationPath;
  readonly fragment?: FragmentId;
  readonly children: readonly TocItem[];
}

export interface Landmark {
  readonly types: readonly string[];
  readonly label?: string;
  readonly href: PublicationHref;
  readonly path?: PublicationPath;
  readonly fragment?: FragmentId;
}

export interface PageListItem {
  readonly label: string;
  readonly href: PublicationHref;
  readonly path?: PublicationPath;
  readonly fragment?: FragmentId;
}

export type NavigationSource = 'epub3-nav' | 'ncx' | 'none';

export interface NavigationModel {
  readonly source: NavigationSource;
  readonly sourcePath?: PublicationPath;
  readonly toc: readonly TocItem[];
  readonly landmarks: readonly Landmark[];
  readonly pageList: readonly PageListItem[];
}

/**
 * Optional information discovered from an individual content document.
 * This is intentionally separate from page progression direction.
 */
export type ContentDocumentKind =
  'flowing-text' | 'single-image-page' | 'single-svg-page' | 'unknown';

/**
 * Structural presentation information discovered before the renderer runs.
 * It never changes the authored EPUB rendition declaration; the planner may
 * use it only to select a compatible execution strategy.
 */
export interface ContentPageProfile {
  readonly kind: ContentDocumentKind;
  readonly pageLike: boolean;
  readonly semanticTextLength: number;
  readonly replacedElementCount: number;
  readonly intrinsicViewport?: IntrinsicViewport;
  /** Heuristic for malformed reflowable EPUBs that contain an unmarked two-page image. */
  readonly likelySpanningSpread?: boolean;
}

export interface ContentPresentationHints {
  readonly writingMode?: WritingMode;
  readonly direction?: TextDirection;
  readonly viewport?: IntrinsicViewport;
  readonly page?: ContentPageProfile;
}

export interface IntrinsicViewport {
  readonly width: number;
  readonly height: number;
}

export interface Publication {
  readonly version: EpubVersion;
  readonly packagePath: PublicationPath;
  readonly metadata: PublicationMetadata;
  readonly manifest: readonly ManifestItem[];
  readonly spine: readonly SpineItem[];
  readonly navigation: NavigationModel;

  /** EPUB package `spine@page-progression-direction`. */
  readonly pageProgressionDirection: PageProgressionDirection;

  /** Global rendition declarations after specification defaults are applied. */
  readonly rendition: PublicationRendition;
}

/**
 * Effective rendition properties for one spine item after inheritance/defaults.
 * This is still publication intent, not a final viewport-specific render plan.
 */
export interface EffectiveSpineRendition extends PublicationRendition {
  readonly pageSpread?: PageSpread;
  readonly alignXCenter: boolean;
}

export type ReaderFlowPreference = 'auto' | 'paginated' | 'scrolled';
export type ReaderSpreadPreference = 'auto' | 'single' | 'double';
export type ReaderDirectionPreference = 'auto' | 'ltr' | 'rtl';
export type FixedLayoutFit = 'contain' | 'width' | 'height' | 'original';
export type FixedLayoutGutter = 'none' | 'normal';
export type TouchNavigationPreference = 'both' | 'tap' | 'swipe' | 'off';
export type ReaderTheme =
  'publisher' | 'light' | 'dark' | 'sepia' | (string & {});

export interface ReaderCompatibilityPreferences {
  /** Accept recoverable OCF/ZIP container deviations. */
  readonly recoverContainerStructure: boolean;
  /** Prefer the standard OPF rootfile when a container declares several. */
  readonly selectPreferredRootfile: boolean;
  /** Recover non-well-formed XHTML with the browser HTML parser. */
  readonly recoverMalformedXhtml: boolean;
  /** Use EPUB 2 NCX/Guide navigation when EPUB 3 navigation is unavailable. */
  readonly useLegacyNavigationFallback: boolean;
  /** Add standard CSS declarations for legacy EPUB/WebKit aliases. */
  readonly normalizeLegacyCss: boolean;
  /** Fit a sole image in a reflowable document into one reader viewport. */
  readonly fitSingleImagePages: boolean;
  /** Decode fonts protected with the standard IDPF obfuscation algorithm. */
  readonly deobfuscateIdpfFonts: boolean;
}

export const DEFAULT_READER_COMPATIBILITY_PREFERENCES: ReaderCompatibilityPreferences =
  Object.freeze({
    recoverContainerStructure: true,
    selectPreferredRootfile: true,
    recoverMalformedXhtml: true,
    useLegacyNavigationFallback: true,
    normalizeLegacyCss: true,
    fitSingleImagePages: true,
    deobfuscateIdpfFonts: true,
  });

/**
 * User preferences are requests, not commands. The rendition planner decides
 * which preferences are meaningful for the active spine item. For example,
 * font size is ignored by a fixed-layout page.
 */
export interface ReaderPreferences {
  readonly flow: ReaderFlowPreference;
  readonly spread: ReaderSpreadPreference;
  readonly pageProgression: ReaderDirectionPreference;
  readonly fontSizePercent: number;
  readonly fontFamily: string | null;
  readonly lineHeight: number | null;
  /** Reader-owned breathing room inside each reflowable page, as a percentage of the page inline extent. */
  readonly pageMarginPercent: number;
  /** Scaling strategy for fixed-layout pages and comics. */
  readonly fixedLayoutFit: FixedLayoutFit;
  /** Whether synthetic fixed-layout spreads suppress or retain their normal page spacing. */
  readonly fixedLayoutGutter: FixedLayoutGutter;
  /** Enabled touch/pointer page-turn gestures. Keyboard navigation remains available. */
  readonly touchNavigation: TouchNavigationPreference;
  /** Width of each page-turn edge zone as a percentage of the viewport. */
  readonly pageTurnZonePercent: number;
  readonly compatibility: ReaderCompatibilityPreferences;
  readonly theme: ReaderTheme;
}

export type ReaderPreferencesPatch = Omit<
  Partial<ReaderPreferences>,
  'compatibility'
> & {
  readonly compatibility?: Partial<ReaderCompatibilityPreferences>;
};

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = Object.freeze({
  flow: 'auto',
  spread: 'auto',
  pageProgression: 'auto',
  fontSizePercent: 100,
  fontFamily: null,
  lineHeight: null,
  pageMarginPercent: 6,
  fixedLayoutFit: 'contain',
  fixedLayoutGutter: 'none',
  touchNavigation: 'both',
  pageTurnZonePercent: 22,
  compatibility: DEFAULT_READER_COMPATIBILITY_PREFERENCES,
  theme: 'publisher',
});

/**
 * Logical reading position. A displayed page number is deliberately absent:
 * page numbers are layout-dependent projections of a locator.
 */
export interface Locator {
  readonly href: PublicationHref;
  readonly spineIndex: number;
  readonly locations: LocatorLocations;
  readonly text?: LocatorTextContext;
}

export interface LocatorLocations {
  /** Standard EPUB Canonical Fragment Identifier point location. */
  readonly cfi?: string;
  readonly fragment?: FragmentId;

  /** Implementation fallback kept separate from the interoperable EPUB CFI. */
  readonly dom?: LocatorDomPoint;

  /** 0..1 progression within the active resource. */
  readonly progression?: number;

  /** Optional stable position index produced by a future position service. */
  readonly position?: number;
}

export interface LocatorDomPoint {
  /** childNodes indices from documentElement to the target node. */
  readonly path: readonly number[];
  readonly offset: number;
  readonly nodeType: 'text' | 'element';
}

export interface LocatorRange {
  readonly start: Locator;
  readonly end: Locator;
}

export interface LocatorTextContext {
  readonly before?: string;
  readonly highlight?: string;
  readonly after?: string;
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error' | 'fatal';
export type DiagnosticPhase =
  | 'archive'
  | 'container'
  | 'package'
  | 'navigation'
  | 'resource'
  | 'content'
  | 'rendition'
  | 'feature'
  | 'compatibility';

/**
 * Parser and compatibility code report problems instead of silently mutating
 * publication semantics. A future repair layer can attach an explicit repair.
 */
export interface PublicationDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly phase: DiagnosticPhase;
  readonly message: string;
  readonly path?: PublicationPath;
  readonly spineIndex?: number;
  readonly repair?: CompatibilityRepair;
  readonly cause?: unknown;
}

export interface CompatibilityRepair {
  readonly strategy: string;
  readonly description: string;
  readonly confidence?: number;
  /** Earlier diagnostic codes this repair explicitly makes non-blocking. */
  readonly resolvesCodes?: readonly string[];
}

export interface PublicationLoadResult {
  readonly publication: Publication | null;
  readonly diagnostics: readonly PublicationDiagnostic[];
}
