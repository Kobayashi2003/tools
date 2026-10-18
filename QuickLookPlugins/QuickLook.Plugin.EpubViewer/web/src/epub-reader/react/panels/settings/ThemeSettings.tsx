import {
  DEFAULT_READER_PREFERENCES,
  type ReaderPreferences,
  type ReaderThemeDefinition,
} from '../../../core';
import type { EpubReaderHandle } from '../../state/model';

export function ThemeSettings({
  reader,
  preferences,
  themes,
}: {
  readonly reader: EpubReaderHandle;
  readonly preferences: ReaderPreferences;
  readonly themes: readonly ReaderThemeDefinition[];
}) {
  return (
    <div className="epub-settings-panel__section">
      <div className="epub-settings-panel__head">
        <div>
          <span>Display</span>
          <h3>Color theme</h3>
        </div>
        <button
          type="button"
          onClick={() =>
            void reader.setPreferences({
              theme: DEFAULT_READER_PREFERENCES.theme,
            })
          }
        >
          Reset
        </button>
      </div>
      <div
        className="epub-settings-panel__theme-grid"
        role="group"
        aria-label="Theme presets"
      >
        {themes.map((theme) => (
          <button
            key={theme.id}
            type="button"
            className="epub-theme-chip"
            aria-pressed={preferences.theme === theme.id}
            onClick={() => void reader.setPreferences({ theme: theme.id })}
          >
            <span
              className="epub-theme-chip__swatch"
              style={theme.preview ? { background: theme.preview } : undefined}
              aria-hidden="true"
            />
            {theme.label ?? theme.id}
          </button>
        ))}
      </div>
    </div>
  );
}
