import { useState, type MutableRefObject } from 'react';
import type {
  Bookmark,
  BrowserEpubReaderSnapshot,
  CompatibilityStatus,
} from '../../../../core';
import { EpubReaderFullscreenButton } from '../../../chrome/EpubReaderFullscreen';
import { BookmarkIcon, PinIcon } from '../../../chrome/reader-icons';
import {
  CompactReaderToolsMenu,
  HistoryButton,
  PanelButton,
} from '../../../chrome/ReaderToolbar';
import type { EpubReaderFullscreenController } from '../../../chrome/use-epub-reader-fullscreen';
import type { ReaderChromeControls } from '../../../chrome/use-reader-chrome';
import { useEpubReaderContext } from '../../context';
import { useReaderUiConfiguration } from '../../../configuration/context';
import type { ReaderToolId, ReaderToolModule } from '../../../tools/model';

interface ReaderToolbarProps {
  readonly title: string;
  readonly chapter: string;
  readonly compatibility?: CompatibilityStatus;
  readonly panel: ReaderToolId | null;
  readonly panelId: string;
  readonly compactToolsMenuId: string;
  readonly compactLayout: boolean;
  readonly buttonRefs: MutableRefObject<Map<ReaderToolId, HTMLButtonElement>>;
  readonly fullscreen: EpubReaderFullscreenController;
  readonly readerChrome: ReaderChromeControls;
  readonly tools: readonly ReaderToolModule[];
  readonly onTogglePanel: (
    panel: ReaderToolId,
    origin: HTMLButtonElement,
  ) => void;
}

/** The built-in toolbar presentation. Its tool metadata becomes configurable in UI-4. */
export function ReaderToolbar({
  title,
  chapter,
  compatibility,
  panel,
  panelId,
  compactToolsMenuId,
  compactLayout,
  buttonRefs,
  fullscreen,
  readerChrome,
  tools,
  onTogglePanel,
}: ReaderToolbarProps) {
  const reader = useEpubReaderContext();
  const [bookmarking, setBookmarking] = useState(false);
  const { messages } = useReaderUiConfiguration();
  const navigationTools = tools.filter(
    (tool) => tool.placement === 'navigation',
  );
  const primaryTools = tools.filter((tool) => tool.placement === 'primary');
  const secondaryTools = tools.filter((tool) => tool.placement === 'secondary');
  const pinLabel = readerChrome.pinned
    ? messages.allowControlsToHide
    : messages.keepControlsVisible;
  const currentBookmark = bookmarkAtCurrentPage(reader.state.reader);
  const readerReady = reader.state.reader != null;
  const bookmarkLabel = currentBookmark
    ? 'Remove bookmark from current page'
    : 'Bookmark current page';
  const toggleBookmark = async () => {
    if (bookmarking) return;
    if (currentBookmark) {
      reader.marks.remove(currentBookmark.id);
      return;
    }
    setBookmarking(true);
    try {
      await reader.marks.addBookmark();
    } finally {
      setBookmarking(false);
    }
  };
  return (
    <header
      className="epub-reader-shell__toolbar"
      aria-label={messages.toolbarLabel}
    >
      <div
        className="epub-reader-shell__toolbar-start"
        role="toolbar"
        aria-label={messages.publicationNavigationLabel}
      >
        <HistoryButton
          direction="back"
          enabled={reader.state.reader?.navigationHistory.canGoBack ?? false}
          label={messages.backToPreviousLocation}
          shortLabel={messages.back}
          onActivate={() => void reader.history.back()}
        />
        <HistoryButton
          direction="forward"
          enabled={reader.state.reader?.navigationHistory.canGoForward ?? false}
          label={messages.forwardToNextLocation}
          shortLabel={messages.forward}
          onActivate={() => void reader.history.forward()}
        />
        {navigationTools.map((item) => (
          <PanelButton
            key={item.id}
            item={item}
            panel={panel}
            panelId={panelId}
            buttonRefs={buttonRefs}
            onToggle={onTogglePanel}
          />
        ))}
      </div>
      <div
        className="epub-reader-shell__book-context"
        aria-live="polite"
        aria-atomic="true"
      >
        <strong title={title}>{title}</strong>
        <span title={chapter}>{chapter}</span>
      </div>
      <div
        className="epub-reader-shell__toolbar-end"
        role="toolbar"
        aria-label={messages.readingToolsLabel}
      >
        {primaryTools.map((item) => (
          <PanelButton
            key={item.id}
            item={item}
            panel={panel}
            panelId={panelId}
            buttonRefs={buttonRefs}
            onToggle={onTogglePanel}
          />
        ))}
        {compactLayout ? (
          <CompactReaderToolsMenu
            id={compactToolsMenuId}
            items={secondaryTools}
            panel={panel}
            panelId={panelId}
            fullscreen={fullscreen}
            readerChrome={readerChrome}
            messages={messages}
            bookmarkSaved={Boolean(currentBookmark)}
            bookmarkEnabled={readerReady && !bookmarking}
            onToggleBookmark={() => void toggleBookmark()}
            onTogglePanel={onTogglePanel}
          />
        ) : (
          <>
            <span
              className="epub-reader-shell__toolbar-divider"
              aria-hidden="true"
            />
            {secondaryTools.map((item) => (
              <PanelButton
                key={item.id}
                item={item}
                panel={panel}
                panelId={panelId}
                buttonRefs={buttonRefs}
                onToggle={onTogglePanel}
                secondary
              />
            ))}
            <button
              className="epub-reader-shell__tool is-secondary epub-reader-shell__bookmark-page"
              type="button"
              disabled={!readerReady || bookmarking}
              aria-label={bookmarkLabel}
              aria-pressed={Boolean(currentBookmark)}
              title={bookmarkLabel}
              onClick={() => void toggleBookmark()}
            >
              <BookmarkIcon active={Boolean(currentBookmark)} />
              <span>{currentBookmark ? 'Bookmarked' : 'Bookmark page'}</span>
            </button>
            <EpubReaderFullscreenButton
              controller={fullscreen}
              enterLabel={messages.enterFullscreen}
              exitLabel={messages.exitFullscreen}
              shortLabel={messages.fullscreen}
            />
            <button
              className="epub-reader-shell__tool is-secondary epub-reader-shell__chrome-pin"
              type="button"
              aria-label={pinLabel}
              aria-pressed={readerChrome.pinned}
              title={pinLabel}
              onClick={() => readerChrome.setPinned(!readerChrome.pinned)}
            >
              <PinIcon active={readerChrome.pinned} />
              <span>
                {readerChrome.pinned
                  ? messages.unpinControls
                  : messages.pinControls}
              </span>
            </button>
          </>
        )}
        {compatibility ? (
          <span
            className={`epub-reader-shell__health is-${compatibility}`}
            title={messages.compatibilityStatus(compatibility)}
          >
            <span aria-hidden="true" />
            <span className="epub-reader-visually-hidden">
              {messages.compatibilityStatus(compatibility)}
            </span>
          </span>
        ) : null}
      </div>
    </header>
  );
}

function bookmarkAtCurrentPage(
  snapshot: BrowserEpubReaderSnapshot | null,
): Bookmark | null {
  const locator = snapshot?.locator;
  if (!snapshot || !locator) return null;
  const pageCount = snapshot.renderer.layout?.pageCount;
  const currentPage = snapshot.renderer.layout?.currentPage;
  return (
    snapshot.marks.marks.find((mark): mark is Bookmark => {
      if (
        mark.kind !== 'bookmark' ||
        mark.locator.spineIndex !== locator.spineIndex
      )
        return false;
      if (pageCount != null && currentPage != null) {
        const progression = mark.locator.locations.progression ?? 0;
        const bookmarkPage =
          pageCount <= 1 ? 1 : Math.round(progression * (pageCount - 1)) + 1;
        return bookmarkPage === currentPage;
      }
      return (
        Math.abs(
          (mark.locator.locations.progression ?? 0) -
            (locator.locations.progression ?? 0),
        ) < 0.001
      );
    }) ?? null
  );
}
