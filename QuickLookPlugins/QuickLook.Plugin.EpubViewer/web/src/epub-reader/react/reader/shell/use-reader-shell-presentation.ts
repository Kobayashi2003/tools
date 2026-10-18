import type { BrowserEpubReaderSnapshot } from '../../../core';
import { useDelayedFlag, useHeldValue } from '../../chrome/loading-delay';
import type { ReaderUiMessages } from '../../configuration/model';
import type { ReactEpubReaderStatus } from '../../state/model';

interface ReaderShellPresentationOptions {
  readonly snapshot: BrowserEpubReaderSnapshot | null;
  readonly readerStatus: ReactEpubReaderStatus;
  readonly messages: ReaderUiMessages;
}

/** Derives stable publication chrome separately from the active page renderer. */
export function useReaderShellPresentation({
  snapshot,
  readerStatus,
  messages,
}: ReaderShellPresentationOptions) {
  const activeTheme = snapshot?.appearance.themes.find(
    (theme) => theme.id === snapshot.preferences.theme,
  );
  const title =
    snapshot?.publication.metadata.title?.trim() ||
    messages.openingPublicationTitle;

  // Hold the last chapter label across a short page-turn transaction. For a
  // genuinely slow turn, replace it with an explicit loading label.
  const turning = snapshot != null && readerStatus !== 'ready';
  const chapterName = useHeldValue(
    snapshot?.accessibility.chapter?.trim() ?? '',
    turning,
  );
  const turnIsSlow = useDelayedFlag(turning);
  const chapter =
    (turnIsSlow ? messages.loadingChapter : chapterName) ||
    (readerStatus === 'ready' || snapshot
      ? messages.reading
      : messages.preparingBook);

  // Publication chrome must not change when a mixed-layout book turns between
  // reflowable chapters and pre-paginated illustrations. Page-scoped renderer
  // attributes remain available to content-area styling.
  const presentation = snapshot?.presentation;
  const chrome = presentation?.chrome ?? 'standard';
  const readingMode =
    presentation?.layout === 'fixed-layout'
      ? 'fixed'
      : presentation && presentation.writingMode !== 'horizontal-tb'
        ? 'text-vertical'
        : 'text-horizontal';

  return {
    activeTheme,
    chapter,
    chrome,
    compatibility: snapshot?.compatibility.status,
    plan: snapshot?.renderer.plan,
    presentation,
    readingMode,
    title,
  } as const;
}
