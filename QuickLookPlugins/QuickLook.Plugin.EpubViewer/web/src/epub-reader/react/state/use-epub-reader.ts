import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type {
  EpubReaderHandle,
  EpubSource,
  UseEpubReaderOptions,
} from './model';
import { ReactEpubReaderStore } from './store';

/**
 * React bridge over the external BrowserEpubReader store.
 *
 * The source identity controls publication replacement. Reader preferences are
 * intentionally imperative after open (`reader.setPreferences`) so an inline
 * options object cannot accidentally reopen a large publication every render.
 */
export function useEpubReader(
  source: EpubSource,
  options: UseEpubReaderOptions = {},
): EpubReaderHandle {
  const store = useMemo(() => new ReactEpubReaderStore(), []);

  // Options and source are separate effects. Hosts pass an inline options
  // object, so callbacks are refreshed on every render, while the source effect
  // runs only when the publication actually changes.
  useEffect(() => {
    store.setOptions(options);
  });

  useEffect(() => {
    store.setSource(source);
  }, [store, source]);

  useEffect(() => store.retain(), [store]);

  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const viewportRef = useCallback(
    (element: HTMLDivElement | null) => store.attachViewport(element),
    [store],
  );

  return useMemo(
    () => ({
      state,
      viewportRef,
      retry: () => store.retry(),
      next: () => store.next(),
      previous: () => store.previous(),
      goTo: (target) => store.goTo(target),
      goToLocator: (locator) => store.goToLocator(locator),
      history: {
        back: (steps) => store.historyBack(steps),
        forward: (steps) => store.historyForward(steps),
      },
      setPreferences: (patch) => store.setPreferences(patch),
      captureLocator: () => store.captureLocator(),
      registerTheme: (theme) => store.registerTheme(theme),
      captureSelection: () => store.captureSelection(),
      clearSelection: () => store.clearSelection(),
      clearReadingSession: () => store.clearReadingSession(),
      addHighlightFromSelection: (highlight, color) =>
        store.addHighlightFromSelection(highlight, color),
      search: {
        run: (query, searchOptions) => store.searchRun(query, searchOptions),
        clear: () => store.searchClear(),
        clearCache: () => store.searchClearCache(),
        goTo: (index) => store.searchGoTo(index),
        next: () => store.searchNext(),
        previous: () => store.searchPrevious(),
      },
      marks: {
        addBookmark: (label) => store.addBookmark(label),
        addHighlight: (range, highlight, color, label, tags) =>
          store.addHighlight(range, highlight, color, label, tags),
        addAnnotation: (range, body, highlight, color, label, tags) =>
          store.addAnnotation(range, body, highlight, color, label, tags),
        remove: (id) => store.removeMark(id),
        removeMany: (ids) => store.removeMarks(ids),
        update: (id, patch) => store.updateMark(id, patch),
        clear: () => store.clearMarks(),
        goTo: (id) => store.goToMark(id),
      },
    }),
    [state, store, viewportRef],
  );
}
