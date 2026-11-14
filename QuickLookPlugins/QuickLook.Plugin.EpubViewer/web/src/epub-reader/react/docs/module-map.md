# React module map

Use this map to locate an existing React responsibility before adding a file.

## Public entry

[`react/index.ts`](../index.ts) is the supported React entry. It exposes the
reader component and handle, UI configuration, selected built-in UI, and the
contracts needed for host integration.

Private Shell hooks, registry implementations, internal models, and helper
components remain deep modules. Add an export only when a host has a supported
reason to depend on the contract.

## Top-level areas

| Area            | Responsibility                                                 | Main boundary                |
| --------------- | -------------------------------------------------------------- | ---------------------------- |
| `state`         | external store, hook, source, session and preference storage   | `use-epub-reader.ts`         |
| `reader`        | React composition root, context, viewport, Shell coordination  | `EpubReader.tsx`             |
| `chrome`        | toolbar controls, reader status, feedback, fullscreen behavior | built-in Chrome components   |
| `panels`        | contents, search, marks, settings, and compatibility tools     | one component per panel      |
| `overlays`      | selection, mark, image, link, and keyboard surfaces            | one component per surface    |
| `configuration` | validated messages, layout, appearance, and registries         | `reader-ui-configuration.ts` |
| `tools`         | bounded toolbar/panel contribution model and registry          | `model.ts`                   |
| `surfaces`      | semantic surface renderer model and registry                   | `model.ts`                   |
| `composition`   | failure containment for contributed React content              | contribution boundary        |
| `source`        | reusable file-source selection UI                              | `EpubFilePicker.tsx`         |
| `styles`        | shared tokens, responsive behavior, and motion policy          | package style entry          |

## Facades and internal directories

Use a same-name facade and directory when one operation has multiple meaningful
parts:

```text
store.ts
store/
  lifecycle.ts
  preferences.ts
  reader-options.ts
  reading-session.ts
```

Current examples include `state/store`,
`configuration/reader-ui-configuration`, `chrome/reader-toolbar`,
`reader/shell`, and the feature-local directories below `panels`.

The facade retains the public contract and readable high-level sequence. Do not
create a directory merely to hide unrelated small helpers.

## File conventions

- Components use `PascalCase.tsx`; a component-owned stylesheet uses the same
  basename.
- Hooks use `use-*.ts` and own one coordination concern.
- A feature-local `model.ts` owns its contracts; avoid a global interfaces or
  models directory.
- A registry validates, orders, and resolves one bounded contribution type.
- A controller owns coordinated state and transitions; a host owns a fixed
  rendering boundary.
- Lowercase shared CSS names such as `panel-base.css` are reserved for genuine
  multi-component primitives.

## Placement guide

Place code according to the responsibility it changes:

- Core reader lifecycle adaptation or persistence -> `state`.
- Whole-reader composition or focus/event coordination -> `reader/shell`.
- Persistent controls visible around the viewport -> `chrome`.
- A toolbar-opened peer feature -> `panels`.
- A semantic temporary interaction -> `overlays` or `surfaces`.
- Host-defined UI composition -> `configuration`, `tools`, or `surfaces`.
- Source acquisition before opening -> `source`.

## Placement checklist

Before adding code, ask:

1. Is this publication behavior that belongs in Core?
2. Which component, hook, store, or registry owns its lifecycle?
3. Does the Shell need to retain accessibility or dismissal authority?
4. Is the contract host-facing or an internal collaboration detail?
5. Can the helper stay beside its only caller?
6. Does a same-name facade already represent the operation?
7. Which unit, integration, browser, or visual check protects the change?
