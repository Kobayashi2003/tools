import type { ChangeEvent } from 'react';
import {
  DEFAULT_READER_PREFERENCES,
  type ReaderPreferences,
} from '../../../core';
import type { EpubReaderHandle } from '../../state/model';
import { TextLayoutPreview } from './ReaderSettingsPreviews';

const FONT_FAMILIES = [
  { value: '', label: 'Publisher default' },
  {
    value: 'Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif',
    label: 'Literary serif',
  },
  { value: 'Georgia, Times New Roman, serif', label: 'Classic serif' },
  {
    value:
      'Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    label: 'Modern sans',
  },
  { value: 'Arial, Helvetica, sans-serif', label: 'Neutral sans' },
  {
    value: 'SFMono-Regular, Consolas, Liberation Mono, monospace',
    label: 'Monospace',
  },
] as const;

const MARGIN_PRESETS = [
  { value: 0, label: 'Publisher' },
  { value: 6, label: 'Balanced' },
  { value: 12, label: 'Generous' },
] as const;

export function TypographySettings({
  reader,
  preferences,
  enabled,
  lineHeightEnabled,
  vertical,
}: {
  readonly reader: EpubReaderHandle;
  readonly preferences: ReaderPreferences;
  readonly enabled: boolean;
  readonly lineHeightEnabled: boolean;
  readonly vertical: boolean;
}) {
  return (
    <div className="epub-settings-panel__section">
      <div className="epub-settings-panel__head">
        <div>
          <span>Reading</span>
          <h3>Typography</h3>
        </div>
        <div className="epub-settings-panel__head-actions">
          <span>
            {enabled ? (vertical ? 'Vertical' : 'Horizontal') : 'Fixed'}
          </span>
          <button
            type="button"
            onClick={() =>
              void reader.setPreferences({
                fontFamily: DEFAULT_READER_PREFERENCES.fontFamily,
                fontSizePercent: DEFAULT_READER_PREFERENCES.fontSizePercent,
                lineHeight: DEFAULT_READER_PREFERENCES.lineHeight,
                pageMarginPercent: DEFAULT_READER_PREFERENCES.pageMarginPercent,
              })
            }
          >
            Reset
          </button>
        </div>
      </div>
      {enabled ? (
        <TextLayoutPreview
          fontFamily={preferences.fontFamily}
          fontSizePercent={preferences.fontSizePercent}
          lineHeight={preferences.lineHeight}
          marginPercent={preferences.pageMarginPercent}
          theme={preferences.theme}
          vertical={vertical}
        />
      ) : (
        <p className="epub-settings-panel__unavailable">
          Typography is controlled by this fixed-layout publication.
        </p>
      )}
      <label className="epub-settings-panel__select-row">
        <span>
          <strong>Font family</strong>
          <small>Overrides the publisher font when supported.</small>
        </span>
        <select
          value={preferences.fontFamily ?? ''}
          disabled={!enabled}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            void reader.setPreferences({
              fontFamily: event.currentTarget.value || null,
            })
          }
        >
          {FONT_FAMILIES.map((option) => (
            <option key={option.label} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="epub-settings-panel__range-field">
        <div className="epub-reader-panel__row">
          <span>Font size</span>
          <output>{preferences.fontSizePercent}%</output>
        </div>
        <input
          type="range"
          min="70"
          max="220"
          step="10"
          value={preferences.fontSizePercent}
          disabled={!enabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            void reader.setPreferences({
              fontSizePercent: Number(event.currentTarget.value),
            })
          }
        />
      </label>
      <label className="epub-settings-panel__range-field">
        <div className="epub-reader-panel__row">
          <span>Line height</span>
          <output>
            {preferences.lineHeight == null
              ? 'publisher'
              : preferences.lineHeight.toFixed(2)}
          </output>
        </div>
        <input
          type="range"
          min="0.9"
          max="2.4"
          step="0.05"
          value={preferences.lineHeight ?? 1.55}
          disabled={!lineHeightEnabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            void reader.setPreferences({
              lineHeight: Number(event.currentTarget.value),
            })
          }
        />
      </label>
      <button
        className="epub-settings-panel__quiet-action"
        type="button"
        disabled={!lineHeightEnabled || preferences.lineHeight == null}
        onClick={() => void reader.setPreferences({ lineHeight: null })}
      >
        Use publisher line height
      </button>
      <fieldset className="epub-settings-panel__margin" disabled={!enabled}>
        <legend>
          {vertical ? 'Top and bottom margins' : 'Page side margins'}
        </legend>
        <div className="epub-settings-panel__margin-presets">
          {MARGIN_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              aria-pressed={preferences.pageMarginPercent === preset.value}
              onClick={() =>
                void reader.setPreferences({ pageMarginPercent: preset.value })
              }
            >
              {preset.label}
            </button>
          ))}
        </div>
        <label className="epub-settings-panel__range-field">
          <div className="epub-reader-panel__row">
            <span>Custom margin</span>
            <output>{preferences.pageMarginPercent}%</output>
          </div>
          <input
            type="range"
            min="0"
            max="18"
            step="2"
            value={preferences.pageMarginPercent}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              void reader.setPreferences({
                pageMarginPercent: Number(event.currentTarget.value),
              })
            }
          />
        </label>
      </fieldset>
    </div>
  );
}
