import type { ChangeEvent } from 'react';
import type { ReaderPreferences } from '../../../core';
import type { EpubReaderHandle } from '../../state/model';

export function PageLayoutSettings({
  reader,
  preferences,
  showFlow,
}: {
  readonly reader: EpubReaderHandle;
  readonly preferences: ReaderPreferences;
  readonly showFlow: boolean;
}) {
  return (
    <div className="epub-settings-panel__section">
      <div className="epub-settings-panel__head">
        <div>
          <span>Pages</span>
          <h3>Layout</h3>
        </div>
      </div>
      {showFlow ? (
        <label className="epub-settings-panel__select-row">
          <span>
            <strong>Flow</strong>
            <small>Choose paging or continuous scrolling.</small>
          </span>
          <select
            value={preferences.flow}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              void reader.setPreferences({
                flow: event.currentTarget.value as ReaderPreferences['flow'],
              })
            }
          >
            <option value="auto">Auto</option>
            <option value="paginated">Paginated</option>
            <option value="scrolled">Scrolled</option>
          </select>
        </label>
      ) : null}
      <label className="epub-settings-panel__select-row">
        <span>
          <strong>Spread</strong>
          <small>Show one or two pages when space allows.</small>
        </span>
        <select
          value={preferences.spread}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            void reader.setPreferences({
              spread: event.currentTarget.value as ReaderPreferences['spread'],
            })
          }
        >
          <option value="auto">Auto</option>
          <option value="single">Single page</option>
          <option value="double">Double page</option>
        </select>
      </label>
      <label className="epub-settings-panel__select-row">
        <span>
          <strong>Page direction</strong>
          <small>Override the direction declared by the book.</small>
        </span>
        <select
          value={preferences.pageProgression}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            void reader.setPreferences({
              pageProgression: event.currentTarget
                .value as ReaderPreferences['pageProgression'],
            })
          }
        >
          <option value="auto">Auto</option>
          <option value="ltr">Left to right</option>
          <option value="rtl">Right to left</option>
        </select>
      </label>
    </div>
  );
}
