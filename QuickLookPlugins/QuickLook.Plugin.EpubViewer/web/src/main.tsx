import { createRoot } from 'react-dom/client';
import { EpubReader } from './epub-reader/react';
import './epub-reader/styles.css';
import './app.css';

// The plugin serves the previewed book at ./book and passes its file name and QuickLook's
// theme in the query string.
const params = new URLSearchParams(window.location.search);
const name = params.get('name') ?? 'book.epub';
const dark = params.get('theme') === 'dark';
const root = createRoot(document.getElementById('root')!);

async function open(): Promise<void> {
  const response = await fetch('./book');
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);

  // A named File keys the saved reading position to this book, so reopening it resumes.
  const file = new File([await response.arrayBuffer()], name);
  root.render(
    <EpubReader
      source={file}
      readerOptions={dark ? { preferences: { theme: 'dark' } } : undefined}
    />,
  );
}

open().catch((error: unknown) => {
  root.render(
    <p className="host-error">
      {error instanceof Error ? error.message : String(error)}
    </p>,
  );
});
