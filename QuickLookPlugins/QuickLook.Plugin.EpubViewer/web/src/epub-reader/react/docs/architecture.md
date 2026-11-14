# React architecture

This document describes the internal React adapter and fixed Reader Shell. For
Core processing and renderer invariants, see the
[Core architecture](../../core/docs/architecture.md). For host-facing choices,
see [Host integration](../../docs/host-integration.md).

## Dependency direction

```text
showcase / host
       |
       v
react/reader/EpubReader
  |       |        |
  v       v        v
state   Shell   configuration
  |       |        |
  +-------+--------+
          |
          v
       core/index
```

React may consume public Core contracts. Core must never import React. Built-in
panels and overlays consume the public React reader handle rather than reaching
into the store or Core composition root.

## Composition root

`EpubReader` performs five high-level operations:

1. Resolve the validated `ReaderUiConfiguration`.
2. Create the public reader handle through the event-routing layer.
3. Derive Shell presentation data from the immutable Core snapshot.
4. Coordinate Chrome, focus, keyboard behavior, and mutually exclusive
   transient surfaces through focused Shell hooks.
5. Render the fixed Shell frame, viewport, panel host, modal host, and transient
   surface host.

Two props reach the host back: `readerRef` receives the handle (the same one
the Shell uses), and `onChromeVisibilityChange` reports the Chrome visibility
the Shell decided. Neither lets the host take over a Shell decision.

Keep this file declarative. New orchestration details belong in a focused hook
or Shell component when they can be named independently.

## State boundary

`ReactEpubReaderStore` contains no React imports. It owns the active
`BrowserEpubReader`, async open generations, abort controllers, viewport
observation, subscription publication, and reading-session persistence.

`useEpubReader` is intentionally thin: it retains the store, updates host
callbacks, applies source identity changes, subscribes with
`useSyncExternalStore`, and exposes stable command groups. Components render
immutable snapshots and issue commands through `EpubReaderHandle`.

This separation keeps lifecycle tests deterministic and prevents rendering from
becoming the owner of Core resources.

## Fixed Shell boundary

The Shell always owns:

- the DOM frame and named layout regions;
- compact and wide responsive semantics;
- focus capture, restoration, and Escape behavior;
- panel and transient-surface exclusivity;
- modal roles, dismissal layers, and external-link confirmation;
- toolbar and bottom-control visibility;
- error containment around contributed UI.

Tool modules may contribute one toolbar entry and panel body. Surface renderers
may contribute content for a known semantic surface. Neither mechanism may
replace the Shell lifecycle or inject arbitrary layout slots.

## Event and surface flow

Core emits semantic reader events such as selection, footnote, image, mark, and
external-link activation. `useReaderEventRouting` maps them to Shell surfaces.
`useReaderSurfaceController` owns the currently open surface, transition state,
trigger references, and close behavior.

The panel, modal, and transient hosts choose a registered renderer or a built-in
implementation. Raw DOM events and renderer internals do not cross this
boundary.

## Configuration flow

`configureReaderUi` validates messages, dimensions, appearance, tool modules,
surface renderers, and Core extension inputs once at application composition
time. It delegates themes, input bindings, and compatibility modules to Core so
React does not maintain parallel registries.

`ReaderUiConfigurationProvider` supplies the resolved configuration to the
fixed Shell. Avoid creating configuration on every render; compose it outside
the component tree or memoize it.

## Stable invariants

- Source identity, not options-object identity, controls publication reopening.
- One store lease owns one active Core reader and disposes it after the final
  React release.
- Components read immutable snapshots; commands mutate state through the reader
  handle.
- Shell focus and dismissal behavior cannot be delegated to optional content.
- Only one peer panel and one compatible transient surface are active at a
  time.
- Host callbacks cannot participate in reader lifecycle failure.
- Component CSS is loaded through one ordered package style entry.
