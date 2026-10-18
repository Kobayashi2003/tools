import {
  DEFAULT_READER_PREFERENCES,
  type ReaderPreferences,
} from '../../../core';
import type { EpubReaderHandle } from '../../state/model';
import { ComicLayoutPreview } from './ReaderSettingsPreviews';

export function ComicDisplaySettings({
  reader,
  preferences,
}: {
  readonly reader: EpubReaderHandle;
  readonly preferences: ReaderPreferences;
}) {
  return (
    <div className="epub-settings-panel__section epub-settings-panel__comic">
      <div className="epub-settings-panel__head">
        <h3>Comic display</h3>
        <button
          type="button"
          onClick={() =>
            void reader.setPreferences({
              fixedLayoutFit: DEFAULT_READER_PREFERENCES.fixedLayoutFit,
              fixedLayoutGutter: DEFAULT_READER_PREFERENCES.fixedLayoutGutter,
              spread: DEFAULT_READER_PREFERENCES.spread,
              pageProgression: DEFAULT_READER_PREFERENCES.pageProgression,
            })
          }
        >
          Reset
        </button>
      </div>
      <ComicLayoutPreview
        fit={preferences.fixedLayoutFit}
        gutter={preferences.fixedLayoutGutter}
        spread={preferences.spread}
        progression={preferences.pageProgression}
      />
      <fieldset className="epub-settings-panel__segmented">
        <legend>Page fit</legend>
        <div>
          {(
            [
              ['contain', 'Whole page'],
              ['width', 'Fit width'],
              ['height', 'Fit height'],
              ['original', 'Original'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={preferences.fixedLayoutFit === value}
              onClick={() =>
                void reader.setPreferences({ fixedLayoutFit: value })
              }
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="epub-settings-panel__segmented">
        <legend>Page gutter</legend>
        <div>
          {(
            [
              ['none', 'None'],
              ['normal', 'Normal'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              disabled={preferences.spread === 'single'}
              aria-pressed={preferences.fixedLayoutGutter === value}
              onClick={() =>
                void reader.setPreferences({ fixedLayoutGutter: value })
              }
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
