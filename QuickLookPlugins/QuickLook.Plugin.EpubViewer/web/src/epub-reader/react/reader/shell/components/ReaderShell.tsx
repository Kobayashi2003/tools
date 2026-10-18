import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import type { ReaderThemeDefinition } from '../../../../core';
import { EpubReaderControls } from '../../../chrome/EpubReaderControls';
import { EpubReaderFeedback } from '../../../chrome/EpubReaderFeedback';
import { useReaderUiConfiguration } from '../../../configuration/context';
import type { ReaderFeedbackController } from '../use-reader-feedback';

interface ReaderShellProps {
  readonly shellRef: { readonly current: HTMLDivElement | null };
  readonly chromeHidden: boolean;
  readonly fullscreenActive: boolean;
  readonly compactLayout: boolean;
  readonly chrome: string;
  readonly bookLayout?: string;
  readonly readingMode: string;
  readonly renderer?: string;
  readonly writingMode?: string;
  readonly pageProgression?: string;
  readonly spread?: string;
  readonly theme: string;
  readonly themeUi?: ReaderThemeDefinition['ui'];
  readonly footnoteOpen: boolean;
  readonly selectionToolsOpen: boolean;
  readonly markOpen: boolean;
  readonly imageOpen: boolean;
  readonly externalLinkOpen: boolean;
  readonly viewportId: string;
  readonly instructionsId: string;
  readonly onKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly toolbar: ReactNode;
  readonly children: ReactNode;
  readonly modalLayer?: ReactNode;
  readonly feedback: ReaderFeedbackController['feedback'];
}

/** Fixed reader DOM frame. Feature content is composed into its named internal regions. */
export function ReaderShell({
  shellRef,
  chromeHidden,
  fullscreenActive,
  compactLayout,
  chrome,
  bookLayout,
  readingMode,
  renderer,
  writingMode,
  pageProgression,
  spread,
  theme,
  themeUi,
  footnoteOpen,
  selectionToolsOpen,
  markOpen,
  imageOpen,
  externalLinkOpen,
  viewportId,
  instructionsId,
  onKeyDownCapture,
  toolbar,
  children,
  modalLayer,
  feedback,
}: ReaderShellProps) {
  const configuration = useReaderUiConfiguration();
  const { messages, appearance, layout } = configuration;
  return (
    <div
      ref={shellRef}
      className={`epub-reader-shell${chromeHidden ? ' is-chrome-hidden' : ''}${fullscreenActive ? ' is-fullscreen' : ''}`}
      data-layout={compactLayout ? 'compact' : 'wide'}
      data-density={appearance.density}
      data-motion={appearance.motion}
      data-chrome={chrome}
      data-book-layout={bookLayout}
      data-reading-mode={readingMode}
      data-renderer={renderer}
      data-writing-mode={writingMode}
      data-page-progression={pageProgression}
      data-spread={spread}
      data-theme={theme}
      style={themeUiStyle(themeUi, layout.panelWidthPx)}
      data-footnote-open={footnoteOpen ? 'true' : undefined}
      data-selection-tools-open={selectionToolsOpen ? 'true' : undefined}
      data-mark-open={markOpen ? 'true' : undefined}
      data-image-open={imageOpen ? 'true' : undefined}
      data-external-link-open={externalLinkOpen ? 'true' : undefined}
      onKeyDownCapture={onKeyDownCapture}
    >
      <a className="epub-reader-skip-link" href={`#${viewportId}`}>
        {messages.skipToContent}
      </a>
      <span id={instructionsId} className="epub-reader-visually-hidden">
        {messages.readerInstructions}
      </span>
      {toolbar}
      {children}
      <EpubReaderControls />
      {modalLayer}
      {feedback ? (
        <EpubReaderFeedback feedback={feedback} feedbackId={feedback.id} />
      ) : null}
    </div>
  );
}

function themeUiStyle(
  ui: ReaderThemeDefinition['ui'],
  panelWidthPx: number,
): CSSProperties {
  return {
    '--epub-panel-width': `${panelWidthPx}px`,
    '--epub-color-reader': ui?.reader,
    '--epub-color-surface': ui?.surface,
    '--epub-color-surface-raised': ui?.surfaceRaised,
    '--epub-color-surface-muted': ui?.surfaceMuted,
    '--epub-color-text': ui?.text,
    '--epub-color-text-muted': ui?.textMuted,
    '--epub-color-line': ui?.line,
    '--epub-color-line-strong': ui?.lineStrong,
    '--epub-color-accent': ui?.accent,
    '--epub-color-accent-strong': ui?.accentStrong,
    '--epub-color-accent-soft': ui?.accentSoft,
  } as CSSProperties;
}
