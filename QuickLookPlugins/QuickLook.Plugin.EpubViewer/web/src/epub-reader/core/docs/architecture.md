# Core architecture

This document is the authoritative description of Core internals and
invariants. For host, React, and Reader Shell ownership, see the package-level
[architecture overview](../../docs/architecture.md).

## Dependency direction

The runtime is the composition layer. Domain modules provide contracts and
implementations without reaching back into it.

```text
epub -----------+
presentation ---+
interaction ----+--> runtime/reader --> immutable snapshot
features -------+
configuration --+

extension primitives support bounded mechanisms without owning features
validation observes contracts without participating in the reading runtime
```

The boundary checker enforces these important constraints:

- Core does not import React or showcase modules.
- EPUB processing does not import reader runtime modules.
- Reading features do not import reader runtime modules.
- Generic extension mechanisms do not import concrete reading features.
- EPUB compatibility may reuse extension ordering types, but not feature
  lifecycle, capability, or event mechanisms.

Organizational directories are not automatically public APIs. External callers
consume [`core/index.ts`](../index.ts); focused internal barrels exist to make
dependencies explicit inside Core.

## Publication opening lifecycle

[`BrowserEpubReader.open`](../runtime/reader/browser-reader.ts) coordinates an
abortable, staged pipeline:

1. Normalize preferences and resolve one immutable compatibility profile.
2. Detect the container format and open the archive under path and resource
   limits (`openPublicationArchive`). OCF ZIP is read directly; a Kindle KF8
   book is reassembled into an in-memory EPUB with a synthesized package and
   navigation document, so every later stage is format-independent. The KF8
   adapter is imported dynamically, so it is fetched only for a Kindle file.
3. Parse the container and package into a normalized `Publication`.
4. Inspect the initial spine window for render-critical content hints.
5. Create the publication resource session and content-document pipeline.
6. Plan and commit the initial rendition through `RendererHost`.
7. Publish the ready snapshot and finish remaining preflight work when idle.

Failure before reader construction disposes preflight state. Failure afterward
disposes the complete reader, including documents, listeners, caches, and object
URLs.

## Runtime collaboration

`BrowserEpubReader` owns one opened publication session. It wires the following
long-lived collaborators:

- `PublicationContentPreflightSession` and the content-document pipeline;
- `PublicationResourceSession` and resource resolver;
- `RendererHost` and renderer factories;
- `ReaderNavigator`, link routing, and navigation history;
- search, marks, decorations, selection, media, input, and themes;
- publication diagnostics and the immutable snapshot.

Feature modules report semantic results to the reader. They do not publish
runtime state themselves. The reader merges those results and notifies snapshot
subscribers from one ownership boundary.

## Runtime caches and disposal

Search indexes and serialized content documents are session-scoped performance
caches, not persisted reading data. The default search cache retains at most 12
section indexes or about 8 MiB; the content cache retains at most 8 documents or
about 8 MiB. Cache identities include the active Compatibility Profile signature.

`reader.search.clearCache()` clears search indexes without clearing visible
results. Disposing the reader clears both caches, live documents, pending work,
listeners, timers, and resource URLs through their owning session components.

## Presentation transaction model

Rendition planning is pure policy: publication metadata, content hints,
preferences, viewport metrics, and compatibility policies produce a
`RenditionPlan`.

Writing mode comes from the content unless the `writingMode` preference
overrides it for reflowable items; page direction then follows the override
when `pageProgression` is `auto`. The reflowable renderer applies the override
with the preference stylesheet, before it inspects the computed presentation,
so the page geometry it chooses is the overridden one. It does not report an
imposed writing mode back as a content hint: a hint outlives the preference
that produced it.

`RendererHost` serializes presentation work. A newer generation supersedes an
older one, and asynchronous renderer code must use the transaction context
before mutating live DOM or state. A successful commit yields layout stability,
an active plan, and the locator actually restored.

Renderers own renderer-specific DOM and geometry. The host owns renderer
selection, replacement, visibility, transaction ordering, and disposal.

## Locator and navigation model

A locator is the stable semantic position. Page indexes and scroll offsets are
layout projections and may change with viewport or preferences.

Renderers report visible resource boundaries separately from locator progression.
The runtime combines these with visible spine indexes into `readingPosition` in
the immutable snapshot. Chrome uses that projection for publication completion
and navigation availability; showing the final page never rewrites the saved
locator to progression 1. Reflowable SVG image pages retain their authored layout:
preflight recognizes a narrow single-image structure, the rendition compatibility
policy enables fitting, and the renderer owns canvas scaling and spread placement.

Navigation resolves a target to a publication locator, asks the active renderer
to restore it, and then records the healed locator returned by the renderer.
Fallback channels such as DOM paths, text quotes, and progression keep saved
positions usable when one locator representation cannot be restored exactly.

## Browser boundary

Pure parsing, normalization, planning, and locator syntax should remain
browser-independent. Browser-specific code is kept in explicitly named adapters
and routers, including DOM XML parsing, iframe surfaces, layout targets, input,
selection, and media activation.

Publication documents are isolated, scripts and automatic navigation are
disabled, and temporary URLs are owned by the publication resource session.
Never retain a live publication `Document` beyond its surface or renderer
lifetime.

## Stable design invariants

- Archive safety cannot be bypassed by compatibility behavior.
- One open session uses one compatibility profile.
- One resource session owns all temporary publication URLs.
- Only the active renderer transaction may mutate live presentation state.
- Public state is exposed as an immutable snapshot.
- Stable positions are locators, not displayed page numbers.
- Every listener, document, cache, timer, and URL has a disposal owner.
