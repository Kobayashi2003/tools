# EPUB Reader React

`react` adapts the framework-independent Core reader to React and provides the
fixed Reader Shell. It owns source replacement, subscription state, UI
configuration, responsive Chrome, panels, transient surfaces, focus behavior,
and component styling.

The supported entry is [`index.ts`](./index.ts). Code outside this directory
should import React contracts through that entry rather than deep implementation
paths.

## Responsibilities

The React layer owns:

- the external store and `useSyncExternalStore` bridge around one Core reader;
- source-open races, viewport observation, and optional browser persistence;
- the fixed accessible Shell, toolbar, controls, panels, overlays, and feedback;
- validated UI configuration, built-in tools, and bounded surface renderers;
- conversion of semantic Core events into React-owned transient surfaces;
- component-owned CSS and the reader-wide style cascade.

It does not own EPUB parsing, resource rewriting, rendition planning, renderer
transactions, navigation semantics, or publication feature state. Those remain
in [`core`](../core/README.md).

## Runtime overview

```text
host source + UI configuration
  -> EpubReader
  -> useEpubReader / ReactEpubReaderStore
  -> BrowserEpubReader
  -> immutable snapshot
  -> fixed Reader Shell
  -> Chrome, panels, viewport, and transient surfaces
```

[`EpubReader`](./reader/EpubReader.tsx) is the React composition root.
[`ReactEpubReaderStore`](./state/store.ts) is the lifecycle boundary around the
Core reader. Shell hooks coordinate presentation and interaction without moving
publication logic into components.

## Directory guide

- `state/` owns the external store, public handle, source lifecycle, and reading
  session adapter.
- `reader/` owns the composition root, context, viewport, and private Shell
  coordination.
- `chrome/` owns persistent toolbar, status, navigation, and feedback UI.
- `panels/` owns built-in tool panels and their feature-local components.
- `overlays/` owns modal and transient reader surfaces.
- `configuration/` validates UI composition and resolves runtime registries.
- `tools/` defines bounded toolbar and panel contributions.
- `surfaces/` defines bounded semantic-surface renderers.
- `composition/` contains Shell-owned contribution error boundaries.
- `source/` contains source-acquisition UI that is reusable outside Showcase.
- `styles/` contains only cross-component tokens and behavioral adaptations.

See the detailed [module map](./docs/module-map.md) before placing new code.

## Development rules

1. Preserve the dependency direction `react -> core`; Core never imports React.
2. Keep publication behavior in Core and presentation behavior in React.
3. Keep the fixed Shell responsible for focus, dismissal, accessibility, and
   surface exclusivity.
4. Put component-specific helpers and CSS beside their owning component.
5. Use a same-name internal directory when a facade needs several cohesive
   implementation files.
6. Add shared code only when multiple sibling features use the same stable
   abstraction.
7. Export deliberate host-facing contracts from `react/index.ts`; do not expose
   private Shell coordination for import convenience.

## Verification

Run commands from `components/data-display/epub-reader`:

```sh
pnpm boundaries:check
pnpm typecheck:react
pnpm test:unit
pnpm test:integration
pnpm browser:check
pnpm visual:check
```

Use `pnpm check` for the normal complete static and automated test pass.

## Maintainer documentation

- [Architecture](./docs/architecture.md)
- [Module map](./docs/module-map.md)
- [State and lifecycle](./docs/state-and-lifecycle.md)
- [Styling](./docs/styling.md)
- [Package integration guide](../docs/host-integration.md)
- [UI configuration guide](../docs/ui-configuration.md)
- [Domain language](../CONTEXT.md)
