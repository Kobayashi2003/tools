import { useState } from 'react';
import type { EpubReaderHandle } from '../../state/model';

export function ReadingDataSettings({
  reader,
}: {
  readonly reader: EpubReaderHandle;
}) {
  const [clearState, setClearState] = useState<'idle' | 'confirm' | 'cleared'>(
    'idle',
  );
  return (
    <div className="epub-settings-panel__section epub-settings-panel__maintenance">
      <div className="epub-settings-panel__head">
        <div>
          <span>Maintenance</span>
          <h3>Local reading data</h3>
        </div>
        <span>Current book</span>
      </div>
      <p>
        Position, preferences and saved marks are cached locally for this
        publication. Reopening also rebuilds temporary rendering and resource
        caches.
      </p>
      {clearState === 'confirm' ? (
        <div
          className="epub-settings-panel__clear-confirm"
          role="group"
          aria-label="Confirm clearing saved reading data"
        >
          <span>This cannot be undone after the book is closed.</span>
          <div>
            <button type="button" onClick={() => setClearState('idle')}>
              Cancel
            </button>
            <button
              className="is-danger"
              type="button"
              onClick={() => {
                reader.clearReadingSession();
                setClearState('cleared');
              }}
            >
              Clear data
            </button>
          </div>
        </div>
      ) : (
        <button
          className="epub-settings-panel__maintenance-action"
          type="button"
          onClick={() => setClearState('confirm')}
        >
          <span>
            <strong>Clear saved reading data</strong>
            <small>Removes the locally cached session for this book.</small>
          </span>
          <span aria-hidden="true">×</span>
        </button>
      )}
      {clearState === 'cleared' ? (
        <p className="epub-settings-panel__maintenance-status" role="status">
          Saved reading data cleared.
        </p>
      ) : null}
    </div>
  );
}
