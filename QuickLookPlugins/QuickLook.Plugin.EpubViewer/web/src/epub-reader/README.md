# epub-reader (copy)

`core/`, `react/`, `types/` and `styles.css` are copies of EPUB Reader.
`CONTEXT.md` defines the reader's domain terms. QuickLook-specific integration
lives in the plugin's own code.

Nothing is trimmed: what the preview does not use (the file picker, the
showcase background) is never imported, so the bundler leaves it out. The
Kindle reader is a chunk of its own, loaded only for a Kindle file.
