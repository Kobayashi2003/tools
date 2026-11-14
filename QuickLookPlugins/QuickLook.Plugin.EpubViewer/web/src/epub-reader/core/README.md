# EPUB Reader Core

`core` is the framework-independent browser engine of the EPUB reader. It owns
publication loading, compatibility repair, resource lifetime, rendition
planning, rendering, navigation, reading features, and the immutable reader
snapshot consumed by UI adapters.

The package-level public entry is [`index.ts`](./index.ts). Code outside Core
should import through that entry instead of depending on implementation files.

## Responsibilities

Core owns:

- safe OCF/ZIP access and EPUB package normalization;
- publication-scoped compatibility, content preflight, and resource handling;
- rendition planning and renderer transactions;
- locators, navigation, browser input routing, selection, and history;
- search, marks, media activation, appearance, and accessibility descriptions;
- one opened publication session and its immutable public snapshot.

Core does not own:

- React components or product UI;
- source acquisition, remote storage, or application workflows;
- arbitrary plugin UI or host-specific service integration.

## Processing overview

```text
EPUB bytes
  -> OCF archive and container validation
  -> package, metadata, reading order, and navigation
  -> compatibility profile and content preflight
  -> publication resource session
  -> rendition plan
  -> renderer commit
  -> locator and immutable reader snapshot
```

[`BrowserEpubReader`](./runtime/reader/browser-reader.ts) is the composition root
for this flow. Lower-level modules should remain usable without importing the
reader runtime.

## Directory guide

- `epub/` parses and adapts publication data and resources.
- `presentation/` decides and renders the active rendition.
- `interaction/` turns user intent and publication targets into navigation.
- `features/` implements reading capabilities on top of publication contracts.
- `runtime/` composes one reader session and exposes its snapshot and commands.
- `extension/` contains internal ordering, lifecycle, capability, and event
  primitives.
- `validation/` contains conformance models and reporting helpers.

See the detailed [module map](./docs/module-map.md) before placing new code.

## Development rules

1. Organize by domain and feature, not by technical category.
2. Keep types next to the domain that owns them; do not create global `models`
   or `interfaces` collections.
3. Add a shared utility only when it is domain-neutral, pure, stable, and used
   by multiple sibling modules. Otherwise keep the helper beside its caller.
4. Keep public barrels small. A same-name file may act as a facade for a
   same-name internal directory when an implementation becomes too large.
5. Preserve dependency direction: EPUB processing and features must not depend
   on the reader runtime, and Core must not depend on React or showcase code.
6. Browser resources must have an explicit owner and disposal path.
7. State changes after asynchronous layout work must pass through renderer
   transaction guards.

## Verification

Run commands from `components/data-display/epub-reader`:

```sh
pnpm boundaries:check
pnpm typecheck:core
pnpm test:unit
pnpm test:integration
pnpm check
```

Use the package-level [test guide](../tests/README.md) for corpus, browser,
conformance, and hardening checks.

## Maintainer documentation

- [Architecture](./docs/architecture.md)
- [Module map](./docs/module-map.md)
- [Extension guide](./docs/extension-guide.md)
- [Package architecture overview](../docs/architecture.md)
- [Domain language](../CONTEXT.md)
