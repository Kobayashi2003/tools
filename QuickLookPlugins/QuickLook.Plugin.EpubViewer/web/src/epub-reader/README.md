# epub-reader (copy)

`core/`, `react/`, `types/` and `styles.css` are copied unchanged from
`components/data-display/epub-reader`, last on 2026-11-12. Do not edit them
here: change the original and copy it again, as its `docs/vendoring.md`
describes. `CONTEXT.md` is the original's domain language.

Nothing is trimmed: what the preview does not use (the file picker, the
showcase background) is never imported, so the bundler leaves it out. The
Kindle reader is a chunk of its own, loaded only for a Kindle file.
