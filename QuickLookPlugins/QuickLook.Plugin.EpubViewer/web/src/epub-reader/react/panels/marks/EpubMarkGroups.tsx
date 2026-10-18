import type { ReaderMarkKind } from '../../../core';
import type { EpubReaderHandle } from '../../state/model';
import type { MarkChapterGroup } from '../panel-model';
import { markLocator, markPreview } from '../panel-model';
import { EpubMarkEditor } from './EpubMarkEditor';

interface EpubMarkGroupsProps {
  readonly groups: readonly MarkChapterGroup[];
  readonly reader: EpubReaderHandle;
  readonly selecting: boolean;
  readonly selected: ReadonlySet<string>;
  readonly editingId: string | null;
  readonly onToggleSelection: (id: string) => void;
  readonly onEditingChange: (id: string | null) => void;
}

export function EpubMarkGroups({
  groups,
  reader,
  selecting,
  selected,
  editingId,
  onToggleSelection,
  onEditingChange,
}: EpubMarkGroupsProps) {
  return (
    <div className="epub-marks-panel__groups">
      {groups.map((group) => (
        <section
          key={group.key}
          className="epub-marks-panel__group"
          aria-labelledby={`marks-${safeId(group.key)}`}
        >
          <header>
            <div>
              <strong id={`marks-${safeId(group.key)}`}>
                {group.chapter.label}
              </strong>
              {group.chapter.path.length > 1 ? (
                <span>{group.chapter.path.slice(0, -1).join(' / ')}</span>
              ) : null}
            </div>
            <small>{group.marks.length}</small>
          </header>
          <ol className="epub-marks-panel__list">
            {group.marks.map((mark) => {
              const locator = markLocator(mark);
              const editing = editingId === mark.id;

              return (
                <li
                  key={mark.id}
                  data-mark-kind={mark.kind}
                  className={[
                    selected.has(mark.id) ? 'is-selected' : '',
                    editing ? 'is-editing' : '',
                    selecting ? 'is-selecting' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {selecting ? (
                    <label className="epub-marks-panel__selector">
                      <input
                        type="checkbox"
                        checked={selected.has(mark.id)}
                        aria-label={`Select ${kindLabel(mark.kind)} from ${group.chapter.label}`}
                        onChange={() => onToggleSelection(mark.id)}
                      />
                    </label>
                  ) : null}
                  <button
                    className="epub-marks-panel__location"
                    type="button"
                    onClick={() => void reader.marks.goTo(mark.id)}
                  >
                    <span className="epub-marks-panel__meta">
                      <small>{kindLabel(mark.kind)}</small>
                      <span className="epub-marks-panel__status">
                        {mark.kind !== 'bookmark' ? (
                          <i
                            className={`is-${mark.color}`}
                            aria-label={`${mark.color} ${mark.highlight}`}
                          />
                        ) : null}
                        <span>
                          {Math.round(
                            (locator.locations.progression ?? 0) * 100,
                          )}
                          %
                        </span>
                      </span>
                    </span>
                    <strong>{markPreview(mark)}</strong>
                    {mark.kind === 'bookmark' && mark.label ? (
                      <span className="epub-marks-panel__note">
                        {mark.label}
                      </span>
                    ) : null}
                    {mark.kind === 'annotation' ? (
                      <span className="epub-marks-panel__note">
                        {mark.body}
                      </span>
                    ) : null}
                    {mark.tags?.length ? (
                      <span className="epub-marks-panel__tags">
                        {mark.tags.map((tag) => (
                          <em key={tag}>{tag}</em>
                        ))}
                      </span>
                    ) : null}
                  </button>
                  {!selecting ? (
                    <button
                      className="epub-marks-panel__edit"
                      type="button"
                      aria-expanded={editing}
                      aria-controls={`mark-editor-${safeId(mark.id)}`}
                      onClick={() => onEditingChange(editing ? null : mark.id)}
                    >
                      Edit
                    </button>
                  ) : null}
                  {editing ? (
                    <div
                      className="epub-marks-panel__editor"
                      id={`mark-editor-${safeId(mark.id)}`}
                    >
                      <EpubMarkEditor
                        mark={mark}
                        onCancel={() => onEditingChange(null)}
                        onDelete={() => {
                          reader.marks.remove(mark.id);
                          onEditingChange(null);
                        }}
                        onSave={(patch) => {
                          reader.marks.update(mark.id, patch);
                          onEditingChange(null);
                        }}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

function kindLabel(kind: ReaderMarkKind): string {
  return kind === 'annotation'
    ? 'Note'
    : kind === 'highlight'
      ? 'Highlight'
      : 'Bookmark';
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}
