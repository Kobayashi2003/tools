import type { ReaderPreferences } from '../../../core';
import type { EpubReaderHandle } from '../../state/model';
import { TouchNavigationPreview } from './ReaderSettingsPreviews';

export function TouchNavigationSettings({
  reader,
  preferences,
}: {
  readonly reader: EpubReaderHandle;
  readonly preferences: ReaderPreferences;
}) {
  return (
    <div className="epub-settings-panel__section epub-settings-panel__interaction">
      <div className="epub-settings-panel__head">
        <div>
          <span>Controls</span>
          <h3>Touch navigation</h3>
        </div>
      </div>
      <TouchNavigationPreview
        mode={preferences.touchNavigation}
        zonePercent={preferences.pageTurnZonePercent}
        progression={preferences.pageProgression}
      />
      <fieldset className="epub-settings-panel__segmented">
        <legend>Gestures</legend>
        <div>
          {(
            [
              ['both', 'Tap + swipe'],
              ['tap', 'Tap zones'],
              ['swipe', 'Swipe only'],
              ['off', 'Off'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={preferences.touchNavigation === value}
              onClick={() =>
                void reader.setPreferences({ touchNavigation: value })
              }
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="epub-settings-panel__segmented">
        <legend>Tap zone width</legend>
        <div>
          {[14, 22, 30, 38].map((value) => (
            <button
              key={value}
              type="button"
              disabled={
                preferences.touchNavigation === 'swipe' ||
                preferences.touchNavigation === 'off'
              }
              aria-label={`${value}% tap zone width`}
              aria-pressed={preferences.pageTurnZonePercent === value}
              onClick={() =>
                void reader.setPreferences({ pageTurnZonePercent: value })
              }
            >
              {value}%
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
