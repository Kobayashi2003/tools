import type { MutableRefObject } from 'react';
import type { ReaderCompatibilityPreferences } from '../../../core';
import { ChevronIcon } from '../../chrome/reader-icons';
import type { EpubReaderHandle } from '../../state/model';
import { CompatibilitySettings } from './CompatibilitySettings';
import { ReadingDataSettings } from './ReadingDataSettings';

interface AdvancedReaderSettingsProps {
  rootRef: MutableRefObject<HTMLElement | null>;
  reader: EpubReaderHandle;
  preferences: ReaderCompatibilityPreferences;
  onBack: () => void;
}

export function AdvancedReaderSettings({
  rootRef,
  reader,
  preferences,
  onBack,
}: AdvancedReaderSettingsProps) {
  return (
    <section
      ref={rootRef}
      className="epub-reader-panel epub-settings-panel epub-settings-panel--advanced"
      aria-label="Advanced reader settings"
    >
      <div className="epub-settings-panel__advanced-head">
        <button
          className="epub-settings-panel__back"
          type="button"
          aria-label="Back to reader settings"
          onClick={onBack}
        >
          <ChevronIcon direction="left" />
        </button>
        <div>
          <h3>Advanced settings</h3>
          <span>Compatibility and maintenance</span>
        </div>
      </div>

      <CompatibilitySettings reader={reader} preferences={preferences} />
      <ReadingDataSettings reader={reader} />

      <div className="epub-settings-panel__apply-bar">
        <span>Apply compatibility changes and reset temporary caches.</span>
        <button
          className="epub-settings-panel__compatibility-apply"
          type="button"
          onClick={() => void reader.retry()}
        >
          Reopen and reset cache
        </button>
      </div>
    </section>
  );
}
