import type {
  ReaderUiAppearanceConfiguration,
  ReaderUiLayoutConfiguration,
  ReaderUiMessages,
} from '../model';

const defaultReaderUiMessages: ReaderUiMessages = {
  openingPublicationTitle: 'Opening publication…',
  loadingChapter: 'Loading…',
  reading: 'Reading',
  preparingBook: 'Preparing your book',
  skipToContent: 'Skip to reading content',
  readerInstructions:
    'Use the Left and Right Arrow keys to turn pages. Press C to toggle controls or question mark for keyboard help.',
  toolbarLabel: 'EPUB reader toolbar',
  publicationNavigationLabel: 'Publication navigation',
  readingToolsLabel: 'Reading tools',
  back: 'Back',
  forward: 'Forward',
  backToPreviousLocation: 'Back to previous reading location',
  forwardToNextLocation: 'Forward to next reading location',
  moreTools: 'More reader tools',
  enterFullscreen: 'Enter full screen',
  exitFullscreen: 'Exit full screen',
  fullscreen: 'Full screen',
  fullscreenUnavailable: 'Full screen is not available.',
  pinControls: 'Pin controls',
  unpinControls: 'Unpin controls',
  keepControlsVisible: 'Keep controls visible',
  allowControlsToHide: 'Allow controls to hide automatically',
  actionFailed: 'That did not work. Try again.',
  unresolvedPublicationLink: 'This book link could not be opened.',
  bookmarkSaved: 'Bookmark saved',
  beginningOfBook: 'Beginning of book',
  endOfBook: 'End of book',
  highlightSaved: 'Highlight saved',
  noteSaved: 'Note saved',
  closeFootnote: 'Close footnote',
  openNoteLocation: 'Open note location',
  readingNavigation: 'Reading navigation',
  previous: 'Previous',
  next: 'Next',
  unavailable: 'Unavailable',
  opening: 'Opening…',
  ready: 'Ready',
  loadingEpub: 'Loading EPUB…',
  preparing: 'Preparing…',
  openingPublication: 'Opening publication',
  unableToOpenEpub: 'Unable to open EPUB',
  epubOpenFailed: 'The EPUB could not be opened.',
  tryAgain: 'Try again',
  compatibilityStatus: (status) => `Compatibility: ${status}`,
  closePanel: (label) => `Close ${label}`,
  sectionPosition: (section, total) => `Section ${section} of ${total}`,
  sectionsPosition: (start, end, total) =>
    `Sections ${start}–${end} of ${total}`,
  positionInPublication: 'Position in publication',
  positionInSection: 'Position in current section',
  progressThrough: (percent, scope) => `${percent}% through ${scope}`,
  openPhase: (phase) =>
    ({
      archive: 'Opening archive…',
      package: 'Reading publication metadata…',
      preflight: 'Checking book content…',
      resources: 'Preparing book resources…',
      rendition: 'Preparing the reading view…',
    })[phase],
};

export const DEFAULT_READER_UI_MESSAGES: ReaderUiMessages = Object.freeze(
  defaultReaderUiMessages,
);

export const DEFAULT_READER_UI_LAYOUT: ReaderUiLayoutConfiguration =
  Object.freeze({
    compactBreakpointPx: 700,
    panelWidthPx: 380,
  });

export const DEFAULT_READER_UI_APPEARANCE: ReaderUiAppearanceConfiguration =
  Object.freeze({
    density: 'comfortable',
    motion: 'system',
  });
