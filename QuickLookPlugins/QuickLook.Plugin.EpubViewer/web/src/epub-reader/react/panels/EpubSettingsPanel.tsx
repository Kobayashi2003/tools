import { useRef, useState } from 'react';
import { useOptionalEpubReaderContext } from '../reader/context';
import type { EpubReaderHandle } from '../state/model';
import { AdvancedReaderSettings } from './settings/AdvancedReaderSettings';
import { ComicDisplaySettings } from './settings/ComicDisplaySettings';
import { PageLayoutSettings } from './settings/PageLayoutSettings';
import { readerSettingsSectionVisibility } from './settings/reader-settings-model';
import { ThemeSettings } from './settings/ThemeSettings';
import { TouchNavigationSettings } from './settings/TouchNavigationSettings';
import { TypographySettings } from './settings/TypographySettings';

export function EpubSettingsPanel({
  reader: explicit,
}: {
  readonly reader?: EpubReaderHandle;
}) {
  const [advanced, setAdvanced] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const contextual = useOptionalEpubReaderContext();
  const reader = explicit ?? contextual;
  if (!reader)
    throw new Error(
      '<EpubSettingsPanel> requires a reader prop or EpubReaderProvider.',
    );
  const snapshot = reader.state.reader;
  const preferences = snapshot?.preferences ?? reader.state.preferences;
  const navigateToAdvanced = (next: boolean) => {
    const scroller = rootRef.current?.closest<HTMLElement>(
      '.epub-reader-shell__panel-content',
    );
    if (scroller) scroller.scrollTop = 0;
    setAdvanced(next);
  };
  if (advanced && preferences) {
    return (
      <AdvancedReaderSettings
        rootRef={rootRef}
        reader={reader}
        preferences={preferences.compatibility}
        onBack={() => navigateToAdvanced(false)}
      />
    );
  }
  if (!snapshot || !preferences) {
    return (
      <section
        ref={rootRef}
        className="epub-reader-panel epub-settings-panel"
        aria-label="Reader settings"
      >
        {preferences ? (
          <button
            className="epub-settings-panel__advanced-entry"
            type="button"
            onClick={() => navigateToAdvanced(true)}
          >
            <span>
              <strong>Advanced settings</strong>
              <small>
                Recover from a compatibility setting that prevented the book
                from opening.
              </small>
            </span>
            <span aria-hidden="true">›</span>
          </button>
        ) : null}
      </section>
    );
  }

  const visibility = readerSettingsSectionVisibility({
    layout: snapshot.presentation.layout,
    writingMode: snapshot.presentation.writingMode,
    capabilities: snapshot.renderer.plan?.capabilities,
  });

  return (
    <section
      ref={rootRef}
      className="epub-reader-panel epub-settings-panel"
      aria-label="Reader settings"
    >
      {visibility.showComic ? (
        <ComicDisplaySettings reader={reader} preferences={preferences} />
      ) : null}
      {visibility.showText ? (
        <>
          <ThemeSettings
            reader={reader}
            preferences={preferences}
            themes={snapshot.appearance.themes}
          />
          <TypographySettings
            reader={reader}
            preferences={preferences}
            enabled={visibility.typographyEnabled}
            lineHeightEnabled={visibility.lineHeightEnabled}
            vertical={visibility.verticalWriting}
          />
        </>
      ) : null}
      <PageLayoutSettings
        reader={reader}
        preferences={preferences}
        showFlow={visibility.showText}
      />
      <TouchNavigationSettings reader={reader} preferences={preferences} />
      <div className="epub-settings-panel__section epub-settings-panel__section--link">
        <button
          className="epub-settings-panel__advanced-entry"
          type="button"
          onClick={() => navigateToAdvanced(true)}
        >
          <span>
            <strong>Advanced settings</strong>
            <small>Compatibility, local data and troubleshooting</small>
          </span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
    </section>
  );
}
