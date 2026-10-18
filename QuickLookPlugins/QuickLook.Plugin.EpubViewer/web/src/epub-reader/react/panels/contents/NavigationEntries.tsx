import type { Locator, TocItem } from '../../../core';
import type { EpubReaderHandle } from '../../state/model';
import { chapterContext, documentHref, locatorHref } from '../panel-model';

interface NavigationEntry {
  readonly href: string;
}

interface NavigationEntriesProps<T extends NavigationEntry> {
  readonly entries: readonly T[];
  readonly empty: string;
  readonly currentHref?: string;
  readonly label: (entry: T) => string;
  readonly meta: (entry: T) => string;
  readonly onActivate: (entry: T) => void;
}

export function NavigationEntries<T extends NavigationEntry>({
  entries,
  empty,
  currentHref,
  label,
  meta,
  onActivate,
}: NavigationEntriesProps<T>) {
  if (entries.length === 0)
    return <p className="epub-reader-panel__empty">{empty}</p>;

  return (
    <ol className="epub-contents__entries">
      {entries.map((entry, index) => (
        <li key={`${entry.href}:${index}`}>
          <button
            type="button"
            aria-current={
              navigationEntryIsCurrent(entry.href, currentHref)
                ? 'location'
                : undefined
            }
            onClick={() => onActivate(entry)}
          >
            <strong>{label(entry)}</strong>
            <small>{meta(entry)}</small>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function HistoryGroup({
  direction,
  label,
  locations,
  toc,
  reader,
}: {
  readonly direction: 'back' | 'forward';
  readonly label: string;
  readonly locations: readonly Locator[];
  readonly toc: readonly TocItem[];
  readonly reader: EpubReaderHandle;
}) {
  if (locations.length === 0) return null;

  return (
    <section className="epub-contents__history-group" aria-label={label}>
      <header>
        <strong>{label}</strong>
        <small>{locations.length}</small>
      </header>
      <ol className="epub-contents__entries">
        {locations.map((locator, index) => {
          const chapter = chapterContext(
            toc,
            locatorHref(locator),
            locator.spineIndex,
          );
          const preview = locator.text?.highlight?.replace(/\s+/gu, ' ').trim();

          return (
            <li
              key={`${locator.href}:${locator.locations.cfi ?? locator.locations.fragment ?? locator.locations.progression ?? 0}:${index}`}
            >
              <button
                type="button"
                onClick={() => void reader.history[direction](index + 1)}
              >
                <span>
                  <strong>{chapter.label}</strong>
                  <small>
                    {Math.round((locator.locations.progression ?? 0) * 100)}%
                  </small>
                </span>
                {preview ? <em>{preview}</em> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function navigationEntryIsCurrent(target: string, current?: string): boolean {
  if (!current) return false;
  return target.includes('#')
    ? target === current
    : documentHref(target) === documentHref(current);
}
