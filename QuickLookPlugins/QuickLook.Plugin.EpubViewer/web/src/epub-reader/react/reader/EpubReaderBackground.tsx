import type { ReactNode } from 'react';
import type { ReaderTheme } from '../../core';

export interface EpubReaderBackgroundProps {
  readonly file: File | null;
  readonly picker: ReactNode;
  readonly reader?: ReactNode;
  /** Theme used by the showcase chrome; it is independent of rendition type. */
  readonly readerTheme?: ReaderTheme;
  readonly rejectedMessage?: string | null;
  readonly onCloseBook?: () => void;
}

/**
 * Decorative showcase surface for Component Atlas.
 *
 * The actual reader remains source-driven and reusable. This background owns
 * upload, framing and non-essential supporting UI so hosts can replace the
 * whole stage without touching the reader engine.
 */
export function EpubReaderBackground({
  file,
  picker,
  reader,
  readerTheme = 'publisher',
  rejectedMessage = null,
  onCloseBook,
}: EpubReaderBackgroundProps) {
  return (
    <main className={`epub-background${file ? ' is-reading' : ''}`}>
      {!file ? (
        <section
          className="epub-background__empty"
          aria-label="Open a local book"
        >
          <header className="epub-background__header">
            <div className="epub-background__eyebrow">
              Local reading workspace
            </div>
            <h1>Read your book</h1>
            <p>
              Open an EPUB or Kindle AZW3 book from this device. Your book and
              reading activity remain in this browser.
            </p>
          </header>
          {rejectedMessage ? (
            <p className="epub-background__notice" role="alert">
              {rejectedMessage}
            </p>
          ) : null}
          <div className="epub-background__dropzone">{picker}</div>
          <p className="epub-background__privacy">
            Your file stays on this device.
          </p>
        </section>
      ) : (
        <section
          className="epub-background__workspace"
          aria-label="EPUB reader showcase surface"
        >
          {rejectedMessage ? (
            <p className="epub-background__notice" role="alert">
              {rejectedMessage}
            </p>
          ) : null}
          <div className="epub-background__stage">
            <section
              className="epub-background__reader-shell"
              data-reader-theme={readerTheme}
              aria-label={`Reader demo: ${file.name}`}
            >
              <div className="epub-background__hostbar">
                <span className="epub-background__host-label">Local file</span>
                <div className="epub-background__bookactions">
                  <div className="epub-background__picker-slot">{picker}</div>
                  <button
                    className="epub-background__close"
                    type="button"
                    onClick={onCloseBook}
                    aria-label="Close book"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m7 7 10 10M17 7 7 17" />
                    </svg>
                    <span>Close book</span>
                  </button>
                </div>
              </div>
              <div className="epub-background__reader-frame">{reader}</div>
            </section>
          </div>
        </section>
      )}
    </main>
  );
}
