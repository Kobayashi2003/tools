# Core module map

Use this map to locate existing responsibilities before adding a new file.

## Public entry

[`core/index.ts`](../index.ts) is the supported Core entry for React and host
code. It intentionally exports reader and domain contracts without exporting
every implementation detail.

Internal code should import the narrowest appropriate sibling entry. Avoid
expanding the public barrel only to shorten an internal import.

## Top-level areas

| Area                      | Responsibility                                              | Typical entry            |
| ------------------------- | ----------------------------------------------------------- | ------------------------ |
| `epub/archive`            | format detection, ZIP/OCF safety, KF8 adapter, file access  | `archive/index.ts`       |
| `epub/publication`        | package parsing, metadata, reading order, navigation        | `publication/index.ts`   |
| `epub/compatibility`      | bounded authored-book recovery and diagnostics              | `compatibility/index.ts` |
| `epub/content`            | content parsing, preflight, materialization, document cache | `content/index.ts`       |
| `epub/resources`          | MIME handling, rewriting, decryption, object URL lifetime   | `resources/index.ts`     |
| `epub/text`               | DOM/XML text projection and text policy                     | `text/index.ts`          |
| `epub/xml`                | namespace-aware XML helpers                                 | `xml/index.ts`           |
| `presentation/rendition`  | effective layout and renderer planning                      | `rendition/index.ts`     |
| `presentation/renderer`   | transactions, surfaces, renderer host and renderers         | `renderer/index.ts`      |
| `presentation/appearance` | validated reader theme definitions and catalog              | `appearance/index.ts`    |
| `interaction/locator`     | CFI, DOM path, text quote, and progression locators         | `locator/index.ts`       |
| `interaction/navigation`  | target resolution, page movement, links, history            | `navigation/index.ts`    |
| `interaction/input`       | normalized signals, bindings, commands, browser routing     | `input/index.ts`         |
| `interaction/selection`   | browser selection capture and semantic ranges               | `selection/index.ts`     |
| `features/search`         | publication search index, state, and navigation             | `search/index.ts`        |
| `features/annotations`    | bookmarks, highlights, notes, and stores                    | `annotations/index.ts`   |
| `features/decorations`    | DOM rendering and activation of marks/search hits           | `decorations/index.ts`   |
| `features/media`          | semantic publication-media activation                       | `media/index.ts`         |
| `features/accessibility`  | accessible position descriptions                            | `accessibility/index.ts` |
| `runtime/configuration`   | validated Core extension contributions                      | `configuration/index.ts` |
| `runtime/reader`          | session composition, commands, snapshot, disposal           | `reader/index.ts`        |
| `runtime/session`         | serializable reading-session data and fingerprints          | `session/index.ts`       |
| `extension`               | internal generic extension primitives                       | `extension/index.ts`     |
| `validation/conformance`  | corpus and conformance reporting models                     | `conformance/index.ts`   |

## Facades and internal directories

When one operation has several cohesive implementation stages, retain a small
same-name facade and place details in a same-name directory:

```text
package-parser.ts
package-parser/
  diagnostics.ts
  guide.ts
  manifest.ts
  metadata.ts
  rendition.ts
  spine.ts
```

Current examples:

- `epub/publication/package-parser.ts` orchestrates OPF parsing.
- `epub/archive/kf8-archive.ts` reassembles a Kindle KF8 book (Palm database,
  decompression, index tables, resources) into an in-memory EPUB archive. Only
  `publication-format.ts` reaches it, through a dynamic import; keep it that
  way, or every host bundles it.
- `epub/content/xhtml-materializer.ts` orchestrates document hardening and
  reference rewriting.
- `epub/content/preflight.ts` orchestrates presentation and image inspection.
- `interaction/locator/cfi.ts` preserves the CFI facade.
- `presentation/renderer/reflowable/dom.ts` groups DOM layout, locator, and
  navigation behavior.
- `runtime/reader/browser-reader.ts` delegates open-time and state helpers while
  remaining the session composition root.

A facade should contain the public contract and high-level sequence. Internal
files should each describe one meaningful phase, not merely reduce line count.

## File conventions

- `model.ts` contains the contracts of one feature or domain only.
- `index.ts` is a deliberate boundary, not a list of every file in a directory.
- A browser-specific implementation uses a `browser-` prefix when a pure or
  alternate implementation also makes sense.
- A registry owns validation, uniqueness, ordering, and lookup for a bounded
  contribution type.
- A controller coordinates feature state; a router translates external events;
  a store owns persistence; a renderer owns presentation-specific DOM.

Avoid generic root-level `utils`, `helpers`, `interfaces`, or `models`
directories. A helper belongs beside the domain operation that gives it meaning.
Only promote a helper after multiple sibling domains use the same stable,
domain-neutral operation.

## Placement checklist

Before adding code, ask:

1. Which domain owns the invariant and disposal responsibility?
2. Is this a public contract, orchestration step, adapter, or implementation
   detail?
3. Can the code remain browser-independent?
4. Does an existing facade already represent this operation?
5. Would the import violate a checked boundary or create a dependency cycle?
6. Which unit and integration tests demonstrate the new behavior?
