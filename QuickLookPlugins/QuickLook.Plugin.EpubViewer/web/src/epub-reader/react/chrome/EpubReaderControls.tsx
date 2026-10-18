import { useEffect, useState, type ChangeEvent } from 'react';
import type { EpubReaderHandle } from '../state/model';
import { useOptionalEpubReaderContext } from '../reader/context';
import {
  fixedLayoutPublicationProgress,
  locationForPublicationProgress,
  publicationProgress,
  spineIndexForPublicationProgress,
} from '../../core';
import { ChevronIcon } from './reader-icons';
import { useReaderUiConfiguration } from '../configuration/context';

export function EpubReaderControls({
  reader: explicit,
}: {
  readonly reader?: EpubReaderHandle;
}) {
  const contextual = useOptionalEpubReaderContext();
  const reader = explicit ?? contextual;
  if (!reader)
    throw new Error(
      '<EpubReaderControls> requires a reader prop or EpubReaderProvider.',
    );
  return <ResolvedEpubReaderControls reader={reader} />;
}

function ResolvedEpubReaderControls({
  reader,
}: {
  readonly reader: EpubReaderHandle;
}) {
  const { messages } = useReaderUiConfiguration();
  const snapshot = reader.state.reader;
  // Rendering the next page puts the whole reader back into `loading`, which is
  // the same status as opening a publication from nothing. They are not the
  // same thing to a reader: one is a wait, the other is a page turn that lasts
  // a twentieth of a second. Telling them apart is what keeps the controls from
  // blanking out and the buttons from going dead on every turn.
  const opened = snapshot != null;
  const failed = reader.state.status === 'error';
  const opening = !opened && !failed;
  const interactive = opened && !failed;
  const layout = snapshot?.renderer.layout;
  const page = layout?.currentPage;
  const total = layout?.pageCount;
  const progression = snapshot?.renderer.plan?.pageProgression.value ?? 'ltr';
  const rtl = progression === 'rtl';
  // Publication-scoped, not plan-scoped: a mixed-layout book must not switch the
  // position readout between "page in section" and "page in publication" every
  // time the reader turns into an illustration page.
  const fixedLayout = snapshot?.presentation.layout === 'fixed-layout';
  // A mixed book is mostly single-page sections — plates, title pages, a table
  // of contents — and none of those is ever partway through itself. Reporting
  // the position inside the current section leaves the bar at 0% for the whole
  // front matter, so mixed books measure against the publication like fully
  // pre-paginated ones, with the current section's own progress blended in so a
  // long chapter still advances it.
  const publicationScoped =
    fixedLayout || snapshot?.presentation.layout === 'mixed';
  const spineCount = snapshot?.publication.spine.length ?? 0;
  const spineIndex = snapshot?.locator?.spineIndex ?? 0;
  const sectionProgression =
    snapshot?.locator?.locations.progression ?? layout?.progression ?? 0;
  const resolvedProgress = publicationScoped
    ? (snapshot?.readingPosition?.publicationProgression ??
      (fixedLayout
        ? fixedLayoutPublicationProgress(spineIndex, spineCount)
        : publicationProgress(spineIndex, spineCount, sectionProgression)))
    : sectionProgression;
  const progress = Math.round(resolvedProgress * 100);
  // A composed spread shows two sections at once, so name both. Reporting only
  // the active one made every spread look like it had skipped a section.
  const visibleSections = layout?.visibleSpineIndices?.length
    ? [...layout.visibleSpineIndices].sort((a, b) => a - b)
    : snapshot?.locator
      ? [snapshot.locator.spineIndex]
      : [];
  const sectionPosition =
    visibleSections.length && !fixedLayout
      ? visibleSections.length > 1
        ? messages.sectionsPosition(
            visibleSections[0]! + 1,
            visibleSections[visibleSections.length - 1]! + 1,
            spineCount,
          )
        : messages.sectionPosition(visibleSections[0]! + 1, spineCount)
      : null;
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  // A page turn can reach the draft before the debounce fires. Discard it in
  // this render so a later page turn cannot turn the old draft into a new seek.
  if (seekDraft === progress) setSeekDraft(null);
  const seekValue = seekDraft ?? progress;
  useEffect(() => {
    const locator = snapshot?.locator;
    if (seekDraft == null) return;
    if (!locator || !interactive) return;
    const timer = setTimeout(() => {
      // The scrubber has to seek in whatever unit it is displaying, so a
      // publication-scoped bar resolves back to a section plus an offset
      // inside it rather than scrubbing the current section alone.
      const destination = fixedLayout
        ? {
            spineIndex: spineIndexForPublicationProgress(
              seekDraft / 100,
              spineCount,
            ),
            progression: 0,
          }
        : publicationScoped
          ? locationForPublicationProgress(seekDraft / 100, spineCount)
          : { spineIndex: locator.spineIndex, progression: seekDraft / 100 };
      const target = snapshot?.publication.spine[destination.spineIndex];
      void reader
        .goToLocator(
          publicationScoped && target
            ? {
                href: target.href,
                spineIndex: destination.spineIndex,
                locations: { progression: destination.progression },
              }
            : {
                href: locator.href,
                spineIndex: locator.spineIndex,
                locations: { progression: destination.progression },
              },
        )
        .finally(() =>
          setSeekDraft((current) => (current === seekDraft ? null : current)),
        );
    }, 120);
    return () => clearTimeout(timer);
  }, [
    fixedLayout,
    interactive,
    progress,
    publicationScoped,
    reader,
    seekDraft,
    snapshot?.locator,
    snapshot?.publication.spine,
    spineCount,
  ]);
  const status = failed
    ? messages.unavailable
    : opening
      ? messages.opening
      : fixedLayout && snapshot?.locator
        ? `${spineIndex + 1} / ${spineCount}`
        : page != null && total != null
          ? `${page} / ${total}`
          : messages.ready;

  return (
    <div
      className={`epub-reader-controls is-${progression}`}
      data-page-progression={progression}
      role="group"
      aria-label={messages.readingNavigation}
    >
      <button
        className="epub-reader-controls__nav epub-reader-controls__nav--previous"
        type="button"
        aria-keyshortcuts="PageUp Shift+Space"
        onClick={() => void reader.previous()}
        disabled={!interactive || snapshot?.readingPosition?.atStart === true}
      >
        {rtl ? (
          <>
            <span>{messages.previous}</span>
            <ChevronIcon direction="right" />
          </>
        ) : (
          <>
            <ChevronIcon direction="left" />
            <span>{messages.previous}</span>
          </>
        )}
      </button>
      <div className="epub-reader-controls__position">
        <div className="epub-reader-controls__status" aria-live="off">
          <strong>{status}</strong>
          <span aria-hidden={!opened}>
            {opened
              ? [sectionPosition, `${progress}%`].filter(Boolean).join(' · ')
              : '\u00a0'}
          </span>
        </div>
        <input
          className="epub-reader-controls__seek"
          type="range"
          dir={progression}
          min="0"
          max="100"
          step="1"
          value={seekValue}
          disabled={!interactive || !snapshot?.locator}
          aria-label={
            publicationScoped
              ? messages.positionInPublication
              : messages.positionInSection
          }
          aria-valuetext={messages.progressThrough(
            seekValue,
            publicationScoped ? 'publication' : 'section',
          )}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const value = Number(event.currentTarget.value);
            setSeekDraft(value);
          }}
        />
      </div>
      <button
        className="epub-reader-controls__nav epub-reader-controls__nav--next"
        type="button"
        aria-keyshortcuts="PageDown Space"
        onClick={() => void reader.next()}
        disabled={!interactive || snapshot?.readingPosition?.atEnd === true}
      >
        {rtl ? (
          <>
            <ChevronIcon direction="left" />
            <span>{messages.next}</span>
          </>
        ) : (
          <>
            <span>{messages.next}</span>
            <ChevronIcon direction="right" />
          </>
        )}
      </button>
    </div>
  );
}
