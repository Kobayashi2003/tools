import type {
  BrowserEpubReaderOpenPhase,
  CompatibilityStatus,
  ReaderExtensionConfiguration,
  ReaderExtensionContributions,
} from '../../core';
import type { ReaderToolModule } from '../tools/model';
import type { AnyReaderSurfaceRenderer } from '../surfaces/model';

export type ReaderUiDensity = 'comfortable' | 'compact';
export type ReaderUiMotion = 'system' | 'reduced';

export interface ReaderUiLayoutConfiguration {
  /** Width at which panels become modal sheets and the compact tool menu is used. */
  readonly compactBreakpointPx: number;
  /** Maximum width of a non-compact side panel. */
  readonly panelWidthPx: number;
}

export interface ReaderUiAppearanceConfiguration {
  readonly density: ReaderUiDensity;
  readonly motion: ReaderUiMotion;
}

export interface ReaderUiMessages {
  readonly openingPublicationTitle: string;
  readonly loadingChapter: string;
  readonly reading: string;
  readonly preparingBook: string;
  readonly skipToContent: string;
  readonly readerInstructions: string;
  readonly toolbarLabel: string;
  readonly publicationNavigationLabel: string;
  readonly readingToolsLabel: string;
  readonly back: string;
  readonly forward: string;
  readonly backToPreviousLocation: string;
  readonly forwardToNextLocation: string;
  readonly moreTools: string;
  readonly enterFullscreen: string;
  readonly exitFullscreen: string;
  readonly fullscreen: string;
  readonly fullscreenUnavailable: string;
  readonly pinControls: string;
  readonly unpinControls: string;
  readonly keepControlsVisible: string;
  readonly allowControlsToHide: string;
  readonly actionFailed: string;
  readonly unresolvedPublicationLink: string;
  readonly bookmarkSaved: string;
  readonly beginningOfBook: string;
  readonly endOfBook: string;
  readonly highlightSaved: string;
  readonly noteSaved: string;
  readonly closeFootnote: string;
  readonly openNoteLocation: string;
  readonly readingNavigation: string;
  readonly previous: string;
  readonly next: string;
  readonly unavailable: string;
  readonly opening: string;
  readonly ready: string;
  readonly loadingEpub: string;
  readonly preparing: string;
  readonly openingPublication: string;
  readonly unableToOpenEpub: string;
  readonly epubOpenFailed: string;
  readonly tryAgain: string;
  readonly compatibilityStatus: (status: CompatibilityStatus) => string;
  readonly closePanel: (label: string) => string;
  readonly sectionPosition: (section: number, total: number) => string;
  readonly sectionsPosition: (
    start: number,
    end: number,
    total: number,
  ) => string;
  readonly positionInPublication: string;
  readonly positionInSection: string;
  readonly progressThrough: (
    percent: number,
    scope: 'publication' | 'section',
  ) => string;
  readonly openPhase: (phase: BrowserEpubReaderOpenPhase) => string;
}

export interface ReaderUiConfigurationOptions extends ReaderExtensionContributions {
  /** Peer panel tools appended after the built-ins in registration order. */
  readonly tools?: readonly ReaderToolModule[];
  /** Single-provider content overrides for Shell-framed semantic surfaces. */
  readonly surfaceRenderers?: readonly AnyReaderSurfaceRenderer[];
  readonly messages?: Partial<ReaderUiMessages>;
  readonly layout?: Partial<ReaderUiLayoutConfiguration>;
  readonly appearance?: Partial<ReaderUiAppearanceConfiguration>;
}

/** Fully validated configuration consumed by the React Reader Shell. */
export interface ReaderUiConfiguration {
  /** The existing Core configuration remains the authority for book compatibility, input, and themes. */
  readonly extensions: ReaderExtensionConfiguration;
  /** Validated peer tools; the React composition root combines these with built-ins. */
  readonly toolModules: readonly ReaderToolModule[];
  readonly surfaceRenderers: readonly AnyReaderSurfaceRenderer[];
  readonly messages: ReaderUiMessages;
  readonly layout: ReaderUiLayoutConfiguration;
  readonly appearance: ReaderUiAppearanceConfiguration;
}
