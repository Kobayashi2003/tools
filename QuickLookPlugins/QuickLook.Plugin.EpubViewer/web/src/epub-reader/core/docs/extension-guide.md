# Core extension guide

Core supports a small set of typed contribution points. It does not expose a
generic plugin pipeline. Each extension must have a fixed phase, bounded input
and output, validation, deterministic ordering, and a clear lifecycle owner.

For host-facing usage and the complete checked example, see
[Extensions](../../docs/extensions.md) and
[`examples/reader-extensions.ts`](../../examples/reader-extensions.ts).

## Choose the extension type

| Need                                              | Extension point           | Registration path                                               |
| ------------------------------------------------- | ------------------------- | --------------------------------------------------------------- |
| Recover a known authored-EPUB defect              | Compatibility Module      | `configureReaderExtensions`                                     |
| Map a normalized input signal to a reader command | Input Binding             | `configureReaderExtensions`                                     |
| Add a validated reading appearance                | Theme                     | `configureReaderExtensions` or active reader theme registration |
| Add a new Core renderer kind                      | Internal renderer factory | renderer composition code                                       |
| Add a locator representation or fallback          | Internal locator modules  | locator facade and navigation resolution                        |

The generic mechanisms under `core/extension` remain internal. Do not expose
them as host authority without defining public versioning, lifecycle, failure,
and disposal contracts.

## Add a compatibility module

1. Identify the earliest safe stage: publication, content document, resource,
   or rendition.
2. Define one stable ID and declare only same-stage dependencies.
3. Inspect narrowly and return a bounded repair or policy result plus structured
   diagnostics.
4. Preserve archive/path/resource safety; compatibility cannot relax those
   limits.
5. Export the module from `epub/compatibility` when it is supported API.
6. Add it to `BUILT_IN_COMPATIBILITY_MODULES` only when it is a default built-in;
   host modules enter through `configureReaderExtensions`.

Add focused unit coverage for ordering, enablement, diagnostics, and failure
behavior. Add an integration test when the rule changes package loading,
materialized content, resources, or the final rendition plan.

## Add an input binding

1. Implement `ReaderInputBinding` against normalized `ReaderInputSignal` and
   immutable `ReaderInputState`.
2. Return only a closed `ReaderCommand`; never retain DOM events or call a
   renderer directly.
3. Assign priority intentionally. Built-ins use priority `0`; host overrides
   require an explicit higher priority.
4. Supply shortcut description data from the binding so behavior and help text
   remain synchronized.
5. Register built-ins in `BUILT_IN_READER_INPUT_BINDINGS`; host bindings use
   `configureReaderExtensions`.

Test signal matching, priority conflicts, invalid results, and exceptions. DOM
gesture recognition belongs in the browser input router, not in a binding.

## Add a theme

1. Define a `ReaderThemeDefinition` using the closed theme token model.
2. Keep publication declarations and optional host palette values free of
   arbitrary selectors, executable values, and network-backed URLs.
3. Register a default theme in `BUILTIN_READER_THEMES`, or accept it from the
   host through `configureReaderExtensions`.
4. Verify duplicate IDs, invalid values, catalog resolution, and application to
   reflowable content.

Theme definitions describe appearance. Layout policy belongs to rendition
planning and renderer styles.

## Add or change a renderer

Renderer work is an internal architecture change, not a host plugin.

1. Define or extend the renderer kind and the plan data that selects it.
2. Implement `RendererInstance` with explicit mount, update, navigation,
   locator, stability, snapshot, and disposal behavior.
3. Guard every post-`await` DOM or state mutation with the active layout
   transaction context.
4. Keep live documents inside the renderer/surface lifetime and report them only
   through the read-only content-document contract.
5. Provide a `RendererFactory` and wire it through
   `createReadingRendererFactories`.
6. Add lifecycle, supersession, navigation-boundary, locator restoration, and
   disposal tests. Add browser/conformance coverage for real layout behavior.

Do not put renderer-specific DOM geometry into the generic host. The host owns
transactions and replacement; the renderer owns its layout implementation.

## Add a locator channel

1. Define the serialized data in the locator domain model.
2. Keep syntax parsing and serialization browser-independent when possible.
3. Add DOM capture/restore code in a focused adapter.
4. Integrate the channel into composite capture and fallback resolution in a
   deterministic order.
5. Return a healed locator after fallback restoration so later saves use the
   strongest available position.

Test round trips, malformed input, missing nodes, text changes, reading-order
boundaries, and fallback behavior. Never use displayed page numbers as the
stable locator.

## Required verification

Run at least:

```sh
pnpm boundaries:check
pnpm typecheck:core
pnpm test:unit
pnpm test:integration
```

Use `pnpm check` before handing off a Core change. Renderer, browser-event,
archive, or compatibility changes may also require the browser, corpus,
conformance, stress, or hardening commands described in the
[test guide](../../tests/README.md).
