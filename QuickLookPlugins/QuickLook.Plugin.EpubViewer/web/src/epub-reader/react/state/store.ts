import {
  BrowserEpubReader,
  BrowserEpubReaderOpenError,
  DEFAULT_READER_PREFERENCES,
  type AnnotationColor,
  type AnnotationHighlightStyle,
  type BrowserEpubReaderSnapshot,
  type Locator,
  type LocatorRange,
  type NavigationTarget,
  type ReaderMarkPatch,
  type ReaderPreferences,
  type ReaderPreferencesPatch,
  type ReaderThemeDefinition,
  type ReadingSessionStorage,
  type SearchOptions,
} from '../../core';
import type {
  EpubSource,
  ReactEpubReaderSnapshot,
  UseEpubReaderOptions,
} from './model';
import {
  SERVER_SNAPSHOT,
  abortReason,
  combineAbortSignals,
  sourceBytes,
  statusFromReader,
  throwIfAborted,
} from './store/lifecycle';
import { mergePreferences } from './store/preferences';
import { createReaderOptions } from './store/reader-options';
import {
  createReadingSessionRecord,
  createRestoredMarkStore,
  resolveReadingSession,
} from './store/reading-session';

type Listener = () => void;

export type ReactEpubReaderOpener = typeof BrowserEpubReader.open;

/**
 * React-facing external store. It owns async open/swap races and a viewport
 * ResizeObserver, but it contains no React imports. This makes lifecycle tests
 * deterministic and keeps hooks as a very thin subscription adapter.
 */
export class ReactEpubReaderStore {
  constructor(
    private readonly openReader: ReactEpubReaderOpener = BrowserEpubReader.open,
  ) {}

  private readonly listeners = new Set<Listener>();
  private container: HTMLDivElement | null = null;
  private reader: BrowserEpubReader | null = null;
  private unsubscribeReader: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeFrame: number | null = null;
  private resizePendingDuringOpen = false;
  private viewportDetachTicket = 0;
  private source: EpubSource | null = null;
  private options: UseEpubReaderOptions = {};
  private generation = 0;
  private retainCount = 0;
  private disposeTicket = 0;
  private disposed = false;
  private readingSessionStorage: ReadingSessionStorage | null = null;
  private readingSessionKey: string | null = null;
  private readingSessionPersistPreferences = true;
  private readingSessionCleared = false;
  private readingSessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private openAbortController: AbortController | null = null;
  private reopenPreferences: ReaderPreferences | null = null;
  private snapshotValue: ReactEpubReaderSnapshot = Object.freeze({
    status: 'idle',
    reader: null,
    diagnostics: [],
    error: null,
  });

  get snapshot(): ReactEpubReaderSnapshot {
    return this.snapshotValue;
  }
  get activeReader(): BrowserEpubReader | null {
    return this.reader;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReactEpubReaderSnapshot => this.snapshotValue;
  getServerSnapshot = (): ReactEpubReaderSnapshot => SERVER_SNAPSHOT;

  /** StrictMode-safe lifecycle lease: the final release disposes in a microtask. */
  retain(): () => void {
    this.assertAlive();
    this.retainCount += 1;
    const ticket = ++this.disposeTicket;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retainCount = Math.max(0, this.retainCount - 1);
      queueMicrotask(() => {
        if (
          this.disposed ||
          this.retainCount !== 0 ||
          ticket !== this.disposeTicket
        )
          return;
        this.dispose();
      });
    };
  }

  /**
   * Refreshes the host callbacks without touching the open publication.
   *
   * Callbacks are invoked through this object rather than captured, so a host
   * that re-renders with new closures keeps working while a large book stays
   * open. Options consumed once at open time — preferences, mark store, reading
   * session — take effect on the next {@link setSource}.
   */
  setOptions(options: UseEpubReaderOptions): void {
    if (this.disposed) return;
    this.options = options;
  }

  setSource(source: EpubSource, options?: UseEpubReaderOptions): void {
    this.assertAlive();
    if (options) this.options = options;
    if (this.source === source) return;
    this.source = source;
    this.reopenPreferences = null;
    void this.reopen();
  }

  async retry(): Promise<void> {
    this.assertAlive();
    if (!this.source || !this.container) return;
    this.reopenPreferences =
      this.reader?.snapshot.preferences ?? this.reopenPreferences;
    return this.reopen();
  }

  attachViewport(element: HTMLDivElement | null): void {
    this.assertAlive();

    if (!element) {
      const detached = this.container;
      if (!detached) return;
      const ticket = ++this.viewportDetachTicket;
      // React StrictMode intentionally replays callback refs in development.
      // Defer destructive teardown by one microtask so null → same-node replay
      // does not close and reopen a large publication session. A real detach
      // still tears down before the next task.
      queueMicrotask(() => {
        if (
          this.disposed ||
          ticket !== this.viewportDetachTicket ||
          this.container !== detached
        )
          return;
        this.detachResizeObserver();
        this.container = null;
        this.closeReader();
        this.publish({
          status: this.source ? 'loading' : 'idle',
          reader: null,
          diagnostics: [],
          error: null,
        });
      });
      return;
    }

    ++this.viewportDetachTicket;
    if (this.container === element) return;
    this.detachResizeObserver();
    this.container = element;
    this.resizeObserver =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => this.scheduleResize())
        : null;
    this.resizeObserver?.observe(element);
    void this.reopen();
  }

  /**
   * Runs a command against the open reader and reports a failure instead of
   * leaving it as an unhandled rejection.
   *
   * The shell fires these and ignores the result (`void reader.next()`), so a
   * failure must be surfaced here or the reader would never see it. `null`
   * means the command failed and has already been reported.
   */
  private async run<T>(
    operation: (reader: BrowserEpubReader) => Promise<T>,
  ): Promise<T | null> {
    const reader = this.reader;
    if (!reader) {
      this.notifyError(new Error('EPUB reader is not ready.'));
      return null;
    }
    try {
      return await operation(reader);
    } catch (error) {
      this.reportOperationalError(reader, error);
      return null;
    }
  }

  /**
   * A failure on an already-open reader. The publication is still readable, so
   * the core lifecycle status is preserved rather than replaced with a
   * React-only fatal state.
   */
  private reportOperationalError(
    reader: BrowserEpubReader,
    error: unknown,
  ): void {
    if (this.reader !== reader || this.disposed) return;
    this.publish({
      status: statusFromReader(reader.snapshot),
      reader: reader.snapshot,
      diagnostics: reader.snapshot.diagnostics,
      error,
    });
    this.notifyError(error);
  }

  next() {
    return this.run((reader) => reader.next());
  }
  previous() {
    return this.run((reader) => reader.previous());
  }
  async goTo(target: NavigationTarget): Promise<Locator | null> {
    return this.run((reader) => reader.goTo(target));
  }
  async goToLocator(locator: Locator): Promise<Locator | null> {
    return this.run((reader) => reader.goToLocator(locator));
  }
  async historyBack(steps = 1): Promise<Locator | null> {
    return this.run((reader) => reader.back(steps));
  }
  async historyForward(steps = 1): Promise<Locator | null> {
    return this.run((reader) => reader.forward(steps));
  }
  async setPreferences(patch: ReaderPreferencesPatch): Promise<void> {
    if (this.reader) {
      await this.run((reader) => reader.setPreferences(patch));
      return;
    }
    const current = this.snapshotValue.preferences;
    if (!current) return;
    const next = mergePreferences(current, patch);
    this.reopenPreferences = next;
    this.publish({ ...this.snapshotValue, preferences: next });
  }
  captureLocator(): Promise<Locator | null> {
    return this.run((reader) => reader.captureLocator());
  }
  async registerTheme(theme: ReaderThemeDefinition): Promise<void> {
    await this.run((reader) => reader.registerTheme(theme));
  }
  captureSelection() {
    return this.reader?.captureSelection() ?? null;
  }
  clearSelection(): void {
    this.reader?.clearSelection();
  }
  clearReadingSession(): void {
    if (this.readingSessionStorage && this.readingSessionKey) {
      this.readingSessionStorage.remove(this.readingSessionKey);
    }
    if (this.readingSessionSaveTimer != null)
      clearTimeout(this.readingSessionSaveTimer);
    this.readingSessionSaveTimer = null;
    this.readingSessionCleared = true;
  }
  addHighlightFromSelection(
    highlight?: AnnotationHighlightStyle,
    color?: AnnotationColor,
  ) {
    return this.run((reader) =>
      reader.addHighlightFromSelection(highlight, color),
    );
  }
  /** A failed search reports no hits rather than a null the panel must handle. */
  async searchRun(query: string, options?: Partial<SearchOptions>) {
    return (
      (await this.run((reader) => reader.search.run(query, options))) ?? []
    );
  }
  searchClear(): void {
    this.reader?.search.clear();
  }
  searchClearCache(): void {
    this.reader?.search.clearCache();
  }
  searchGoTo(index: number) {
    return this.run((reader) => reader.search.goTo(index));
  }
  searchNext() {
    return this.run((reader) => reader.search.next());
  }
  searchPrevious() {
    return this.run((reader) => reader.search.previous());
  }
  // Capturing a locator can fail the same way a page turn can, and both are
  // reached from a button that ignores the result. Unguarded, the rejection
  // had nowhere to go.
  addBookmark(label?: string) {
    return this.run((reader) => reader.marks.addBookmark(label));
  }
  addHighlight(
    range: LocatorRange,
    highlight?: AnnotationHighlightStyle,
    color?: AnnotationColor,
    label?: string,
    tags?: readonly string[],
  ) {
    return this.requireReader().marks.addHighlight(
      range,
      highlight,
      color,
      label,
      tags,
    );
  }
  addAnnotation(
    range: LocatorRange,
    body: string,
    highlight?: AnnotationHighlightStyle,
    color?: AnnotationColor,
    label?: string,
    tags?: readonly string[],
  ) {
    return this.requireReader().marks.addAnnotation(
      range,
      body,
      highlight,
      color,
      label,
      tags,
    );
  }
  removeMark(id: string): boolean {
    return this.requireReader().marks.remove(id);
  }
  removeMarks(ids: readonly string[]): number {
    return this.requireReader().marks.removeMany(ids);
  }
  updateMark(id: string, patch: ReaderMarkPatch) {
    return this.requireReader().marks.update(id, patch);
  }
  clearMarks(): void {
    this.requireReader().marks.clear();
  }
  goToMark(id: string): Promise<boolean | null> {
    return this.run((reader) => reader.marks.goTo(id));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.detachResizeObserver();
    this.closeReader();
    this.publish({
      status: 'disposed',
      reader: null,
      diagnostics: [],
      error: null,
    });
    this.listeners.clear();
  }

  private async reopen(): Promise<void> {
    if (this.disposed || !this.source || !this.container) return;
    const element = this.container;
    const rect = element.getBoundingClientRect();
    const width = rect.width || element.clientWidth;
    const height = rect.height || element.clientHeight;
    // A React tree can attach the ref before layout has assigned its final size.
    // Wait for ResizeObserver rather than opening the engine with an invalid 0×0 viewport.
    if (!(width > 0 && height > 0)) {
      this.publish({
        status: 'loading',
        reader: null,
        diagnostics: [],
        error: null,
      });
      return;
    }

    const generation = ++this.generation;
    this.closeReader();
    const openController = new AbortController();
    const externalSignal = this.options.signal;
    const openSignal = combineAbortSignals(
      externalSignal,
      openController.signal,
    );
    this.openAbortController = openController;
    this.publish({
      status: 'loading',
      reader: null,
      diagnostics: [],
      error: null,
    });
    try {
      const bytes = await sourceBytes(this.source);
      throwIfAborted(openSignal);
      if (
        this.disposed ||
        generation !== this.generation ||
        this.container !== element
      )
        return;
      const session = resolveReadingSession(
        this.options.readingSession,
        this.source,
        bytes,
        element.ownerDocument.defaultView,
      );
      const saved = session.storage?.load(session.key) ?? null;
      const restoredMarkStore =
        saved && !this.options.markStore
          ? createRestoredMarkStore(saved.marks)
          : undefined;
      this.readingSessionStorage = session.storage;
      this.readingSessionKey = session.storage ? session.key : null;
      this.readingSessionPersistPreferences = session.persistPreferences;
      this.readingSessionCleared = false;
      const readerOptions = createReaderOptions({
        options: this.options,
        saved,
        persistSavedPreferences: session.persistPreferences,
        retryPreferences: this.reopenPreferences,
        restoredMarkStore,
        signal: openSignal,
        callbacks: {
          onOpenProgress: (progress) => {
            if (
              this.disposed ||
              generation !== this.generation ||
              openSignal.aborted
            )
              return;
            this.publish({
              status: 'loading',
              reader: null,
              preferences: this.snapshotValue.preferences,
              diagnostics: [],
              error: null,
              openProgress: progress,
            });
            this.invokeHostCallback(this.options.onOpenProgress, progress);
          },
          // Resolve host callbacks through current options so new callback
          // identities do not force a publication reopen.
          onCommand: (command) =>
            this.invokeHostCallback(this.options.onCommand, command),
          onEvent: (event) =>
            this.invokeHostCallback(this.options.onEvent, event),
          onDiagnostics: (diagnostics) =>
            this.invokeHostCallback(this.options.onDiagnostics, diagnostics),
          onExternalLink: (href) =>
            this.invokeHostCallback(this.options.onExternalLink, href),
          onUnresolvedPublicationLink: (href) =>
            this.invokeHostCallback(
              this.options.onUnresolvedPublicationLink,
              href,
            ),
        },
      });
      const attemptedPreferences = mergePreferences(
        DEFAULT_READER_PREFERENCES,
        readerOptions.preferences ?? {},
      );
      this.publish({
        status: 'loading',
        reader: null,
        preferences: attemptedPreferences,
        diagnostics: [],
        error: null,
      });
      const reader = await this.openReader(bytes, element, readerOptions);
      if (openSignal.aborted) {
        reader.dispose();
        throw abortReason(openSignal);
      }
      if (
        this.disposed ||
        generation !== this.generation ||
        this.container !== element
      ) {
        reader.dispose();
        return;
      }
      this.reader = reader;
      this.reopenPreferences = null;
      if (this.openAbortController === openController)
        this.openAbortController = null;
      this.unsubscribeReader = reader.subscribe(() => {
        if (this.reader !== reader) return;
        this.publish({
          status: statusFromReader(reader.snapshot),
          reader: reader.snapshot,
          preferences: reader.snapshot.preferences,
          diagnostics: reader.snapshot.diagnostics,
          error: reader.snapshot.error,
        });
        this.scheduleReadingSessionSave(
          reader.snapshot,
          session.saveDelayMs,
          session.persistPreferences,
        );
      });
      this.publish({
        status: 'ready',
        reader: reader.snapshot,
        preferences: reader.snapshot.preferences,
        diagnostics: reader.snapshot.diagnostics,
        error: null,
      });
      this.scheduleReadingSessionSave(
        reader.snapshot,
        session.saveDelayMs,
        session.persistPreferences,
      );
      if (this.resizePendingDuringOpen) {
        this.resizePendingDuringOpen = false;
        this.scheduleResize();
      }
      this.invokeHostCallback(this.options.onReady, reader.snapshot);
    } catch (error) {
      if (this.openAbortController === openController)
        this.openAbortController = null;
      if (this.disposed || generation !== this.generation) return;
      if (openController.signal.aborted) return;
      if (externalSignal?.aborted) {
        this.publish({
          status: 'idle',
          reader: null,
          diagnostics: [],
          error: null,
        });
        return;
      }
      this.publish({
        status: 'error',
        reader: null,
        preferences: this.reopenPreferences ?? this.snapshotValue.preferences,
        diagnostics:
          error instanceof BrowserEpubReaderOpenError ? error.diagnostics : [],
        error,
      });
      this.notifyError(error);
    }
  }

  private scheduleResize(): void {
    if (!this.container || this.disposed) return;
    if (!this.reader) {
      // ResizeObserver can fire repeatedly while an open error is visible.
      // Keep the failure stable until the source/container changes or the user retries.
      if (this.snapshotValue.status === 'error') return;
      // The observer also delivers notifications while a slow publication is
      // still opening. Restarting here aborts that open and can create an
      // endless loop for layout-heavy books. A missing controller means the
      // store is only waiting for its previously zero-sized viewport to become
      // measurable, which is the one case where a resize should start opening.
      if (this.openAbortController) {
        this.resizePendingDuringOpen = true;
        return;
      }
      void this.reopen();
      return;
    }
    if (this.resizeFrame != null) return;
    const ownerWindow = this.container.ownerDocument.defaultView;
    const request =
      ownerWindow?.requestAnimationFrame?.bind(ownerWindow) ??
      ((callback: FrameRequestCallback) =>
        globalThis.setTimeout(
          () => callback(Date.now()),
          16,
        ) as unknown as number);
    this.resizeFrame = request(() => {
      this.resizeFrame = null;
      const reader = this.reader;
      if (!reader) return;
      void reader
        .syncViewportFromElement()
        .catch((error) => this.reportOperationalError(reader, error));
    });
  }

  private detachResizeObserver(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeFrame != null && this.container) {
      const ownerWindow = this.container.ownerDocument.defaultView;
      if (ownerWindow?.cancelAnimationFrame)
        ownerWindow.cancelAnimationFrame(this.resizeFrame);
      else clearTimeout(this.resizeFrame);
      this.resizeFrame = null;
    }
  }

  private closeReader(): void {
    this.resizePendingDuringOpen = false;
    this.openAbortController?.abort(
      new DOMException('Publication replaced or closed.', 'AbortError'),
    );
    this.openAbortController = null;
    if (this.reader && !this.readingSessionCleared)
      this.saveReadingSession(
        this.reader.snapshot,
        this.readingSessionPersistPreferences,
      );
    if (this.readingSessionSaveTimer != null)
      clearTimeout(this.readingSessionSaveTimer);
    this.readingSessionSaveTimer = null;
    this.unsubscribeReader?.();
    this.unsubscribeReader = null;
    this.reader?.dispose();
    this.reader = null;
    this.readingSessionStorage = null;
    this.readingSessionKey = null;
  }

  private scheduleReadingSessionSave(
    snapshot: BrowserEpubReaderSnapshot,
    delayMs: number,
    persistPreferences: boolean,
  ): void {
    if (
      !this.readingSessionStorage ||
      !this.readingSessionKey ||
      !snapshot.locator
    )
      return;
    this.readingSessionCleared = false;
    if (this.readingSessionSaveTimer != null)
      clearTimeout(this.readingSessionSaveTimer);
    this.readingSessionSaveTimer = setTimeout(() => {
      this.readingSessionSaveTimer = null;
      this.saveReadingSession(snapshot, persistPreferences);
    }, delayMs);
  }

  private saveReadingSession(
    snapshot: BrowserEpubReaderSnapshot,
    persistPreferences: boolean,
  ): void {
    if (
      !this.readingSessionStorage ||
      !this.readingSessionKey ||
      !snapshot.locator
    )
      return;
    const record = createReadingSessionRecord(
      snapshot,
      snapshot.locator,
      persistPreferences,
    );
    this.readingSessionStorage.save(this.readingSessionKey, record);
  }

  private requireReader(): BrowserEpubReader {
    if (!this.reader) throw new Error('EPUB reader is not ready.');
    return this.reader;
  }

  private publish(snapshot: ReactEpubReaderSnapshot): void {
    this.snapshotValue = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }

  private invokeHostCallback<T>(
    callback: ((value: T) => void) | undefined,
    value: T,
  ): void {
    if (!callback) return;
    try {
      callback(value);
    } catch (error) {
      this.notifyError(error);
    }
  }

  private notifyError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Host error handlers cannot participate in reader lifecycle state.
    }
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new Error('ReactEpubReaderStore has been disposed.');
  }
}
