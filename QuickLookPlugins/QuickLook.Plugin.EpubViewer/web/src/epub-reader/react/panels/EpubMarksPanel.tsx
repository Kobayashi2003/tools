import { useMemo, useState } from 'react';
import type { ReaderMark, TocItem } from '../../core';
import { ReaderToolIcon } from '../chrome/reader-icons';
import { useOptionalEpubReaderContext } from '../reader/context';
import type { EpubReaderHandle } from '../state/model';
import { EpubMarkGroups } from './marks/EpubMarkGroups';
import {
  filterMarks,
  groupMarksByChapter,
  type MarkFilter,
} from './panel-model';

const FILTERS: readonly {
  readonly value: MarkFilter;
  readonly label: string;
}[] = [
  { value: 'all', label: 'All' },
  { value: 'bookmark', label: 'Bookmarks' },
  { value: 'highlight', label: 'Highlights' },
  { value: 'annotation', label: 'Notes' },
];
const EMPTY_MARKS: readonly ReaderMark[] = [];
const EMPTY_TOC: readonly TocItem[] = [];

export function EpubMarksPanel({
  reader: explicit,
}: {
  readonly reader?: EpubReaderHandle;
}) {
  const contextual = useOptionalEpubReaderContext();
  const reader = explicit ?? contextual;
  if (!reader)
    throw new Error(
      '<EpubMarksPanel> requires a reader prop or EpubReaderProvider.',
    );
  const snapshot = reader.state.reader;
  const marks = snapshot?.marks.marks ?? EMPTY_MARKS;
  const toc = snapshot?.publication.navigation.toc ?? EMPTY_TOC;
  const [filter, setFilter] = useState<MarkFilter>('all');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    new Set<string>(),
  );
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const visibleMarks = useMemo(
    () => filterMarks(marks, filter),
    [filter, marks],
  );
  const groups = useMemo(
    () => groupMarksByChapter(visibleMarks, toc),
    [toc, visibleMarks],
  );
  const activeSelected = useMemo(() => {
    const available = new Set(marks.map((mark) => mark.id));
    return new Set([...selected].filter((id) => available.has(id)));
  }, [marks, selected]);

  const chooseFilter = (next: MarkFilter) => {
    setFilter(next);
    setSelected(new Set());
    setSelecting(false);
    setConfirmBatchDelete(false);
  };
  const toggleSelection = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmBatchDelete(false);
  };
  const allVisibleSelected =
    visibleMarks.length > 0 &&
    visibleMarks.every((mark) => activeSelected.has(mark.id));
  const toggleAllVisible = () => {
    setSelected(() => {
      const next = new Set(activeSelected);
      if (allVisibleSelected)
        visibleMarks.forEach((mark) => next.delete(mark.id));
      else visibleMarks.forEach((mark) => next.add(mark.id));
      return next;
    });
    setConfirmBatchDelete(false);
  };
  const removeSelected = () => {
    if (!confirmBatchDelete) {
      setConfirmBatchDelete(true);
      return;
    }
    reader.marks.removeMany([...activeSelected]);
    setSelected(new Set());
    setSelecting(false);
    setConfirmBatchDelete(false);
  };
  return (
    <section className="epub-reader-panel epub-marks-panel" aria-label="Marks">
      {marks.length > 0 ? (
        <div className="epub-marks-panel__actions">
          <button
            type="button"
            className="epub-marks-panel__select"
            aria-pressed={selecting}
            onClick={() => {
              setSelecting((value) => !value);
              setSelected(new Set());
              setConfirmBatchDelete(false);
              setEditingId(null);
            }}
          >
            {selecting ? 'Done' : 'Select'}
          </button>
        </div>
      ) : null}

      {marks.length > 0 ? (
        <div
          className="epub-marks-panel__filters"
          role="group"
          aria-label="Filter saved marks"
        >
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={`Show ${option.label.toLowerCase()}`}
              aria-pressed={filter === option.value}
              onClick={() => chooseFilter(option.value)}
            >
              <span>{option.label}</span>
              <small>{countMarks(marks, option.value)}</small>
            </button>
          ))}
        </div>
      ) : null}

      {selecting ? (
        <div className="epub-marks-panel__bulk" aria-label="Bulk mark actions">
          <label>
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleAllVisible}
            />
            <span>Select visible</span>
          </label>
          <span>{activeSelected.size} selected</span>
          <button
            type="button"
            className={confirmBatchDelete ? 'is-confirming' : ''}
            disabled={activeSelected.size === 0}
            onClick={removeSelected}
          >
            {confirmBatchDelete
              ? `Confirm delete ${activeSelected.size}`
              : 'Delete'}
          </button>
        </div>
      ) : null}

      {marks.length === 0 ? (
        <div className="epub-reader-panel__empty epub-marks-panel__empty">
          <ReaderToolIcon id="marks" />
          <strong>No saved marks</strong>
          <span>Select text in the book to highlight or add a note.</span>
        </div>
      ) : visibleMarks.length === 0 ? (
        <div className="epub-reader-panel__empty">
          <strong>No {filterLabel(filter).toLowerCase()}</strong>
          <span>Choose another filter to view saved marks.</span>
        </div>
      ) : null}

      <EpubMarkGroups
        groups={groups}
        reader={reader}
        selecting={selecting}
        selected={activeSelected}
        editingId={editingId}
        onToggleSelection={toggleSelection}
        onEditingChange={setEditingId}
      />
    </section>
  );
}

function countMarks(marks: readonly ReaderMark[], filter: MarkFilter): number {
  return filter === 'all'
    ? marks.length
    : marks.filter((mark) => mark.kind === filter).length;
}

function filterLabel(filter: MarkFilter): string {
  return FILTERS.find((option) => option.value === filter)?.label ?? 'Marks';
}
