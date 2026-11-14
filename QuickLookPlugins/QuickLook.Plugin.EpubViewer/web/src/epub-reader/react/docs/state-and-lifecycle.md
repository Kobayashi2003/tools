# React state and lifecycle

The React adapter owns the lifecycle around one framework-independent Core
reader. It must remain safe under source replacement, asynchronous opening,
React Strict Mode replay, viewport changes, and host callback replacement.

## Main participants

- `ReactEpubReaderStore` owns the active Core reader and publishes immutable
  React snapshots.
- `useEpubReader` retains and subscribes to the store and exposes a stable
  command handle.
- `EpubReader` composes Shell behavior from that handle.
- `EpubViewport` supplies the DOM container into which Core renderers mount.
- Shell controllers own focus, Chrome, feedback, and transient UI state.

## Open and replace flow

```text
source identity changes
  -> increment open generation
  -> abort and dispose previous open/session
  -> load source bytes
  -> restore optional reading session
  -> open BrowserEpubReader in the attached viewport
  -> reject stale generation results
  -> subscribe to Core snapshots
  -> publish ready React snapshot
```

Every asynchronous result must prove it still belongs to the current source,
viewport, and generation before becoming active. A stale reader is disposed
immediately.

Options are refreshed independently from source identity. New callback closures
take effect without reopening a large publication; open-time options apply on
the next source open.

## Store retention and disposal

The hook creates one store instance and acquires a lifecycle lease. Final
release schedules disposal in a microtask so React Strict Mode's intentional
mount/unmount replay does not close and reopen the publication.

Store disposal must release:

- the active open abort controller;
- Core snapshot subscriptions;
- the active `BrowserEpubReader`;
- `ResizeObserver` and scheduled animation frames;
- pending reading-session save timers;
- references to the viewport, storage, and source.

## Viewport lifecycle

The callback ref attaches the reader to a concrete viewport element. A real
detach tears down the active reader; a same-node Strict Mode replay is ignored
through a deferred detach ticket.

Viewport resizing is coalesced to one animation frame and forwarded to Core.
A resize does not repeatedly restart a slow open, and an open-error state stays
stable until retry or a source/container change.

## Snapshot and commands

React state has four top-level statuses: idle, loading, ready, and error. The
snapshot may retain attempted preferences while no Core snapshot is available,
but publication data always comes from the immutable Core snapshot.

Commands are grouped on `EpubReaderHandle`:

- navigation and history;
- preferences and themes;
- selection and locator capture;
- search;
- marks;
- reading-session maintenance.

Fire-and-forget Shell actions must route rejected operations into visible
feedback and the configured host error callback rather than leave unhandled
promises.

## Reading-session persistence

Persistence is optional and injected through the Core `ReadingSessionStorage`
port. The browser adapter uses local storage when enabled. The store resolves a
stable key, restores locator/preferences/marks before opening, and debounces
saves from committed snapshots. `flushReadingSession()` (the handle's
`saveReadingSession()`) saves at once and cancels the pending save; closing the
reader saves too.

With `preferenceScope: 'device'` the store also loads a
`ReaderPreferenceStorage` before opening, lays its `DEVICE_PREFERENCE_KEYS`
over the host's preferences, and saves the preferences there whenever it saves
the session and they have changed. Precedence and the key list are in
[Reading data](../../docs/reading-data.md).

Publication bytes, live documents, renderer objects, and transient surfaces are
never persisted. Clearing the session prevents disposal from immediately
writing the cleared record back.

## Shell lifecycle state

Shell state is intentionally separate from publication state:

- `useReaderSurfaceController` owns panels and semantic transient surfaces.
- `useReaderFocusManagement` restores focus across responsive panel/modal
  transitions.
- `useReaderShellChrome` owns fullscreen and immersive Chrome visibility.
- `useReaderShellKeyboard` applies Shell-level dismissal and shortcuts.
- `useReaderFeedback` owns short-lived user feedback.
- `useReaderShellPresentation` derives labels and layout attributes from the
  immutable reader snapshot.

Do not add these transient values to the Core reader snapshot or reading-session
record.

## Change checklist

When changing lifecycle code, verify:

1. Source replacement cannot commit a stale reader.
2. Every reader, observer, timer, subscription, and scheduled frame is disposed.
3. Strict Mode replay does not duplicate expensive opens.
4. Callback identity changes do not reopen the publication.
5. A rejected operation reaches feedback or `onError`.
6. Focus returns to a valid trigger or the viewport.
7. Unit and integration tests cover both success and interruption paths.
