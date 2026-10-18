import {
  normalizeReaderPreferences,
  type BrowserEpubReaderOptions,
  type ReaderPreferences,
  type ReaderPreferencesPatch,
} from '../../../core';
import type { UseEpubReaderOptions } from '../model';

export function mergePreferences(
  base: ReaderPreferences,
  patch: ReaderPreferencesPatch,
): ReaderPreferences {
  return normalizeReaderPreferences({
    ...base,
    ...patch,
    compatibility: {
      ...base.compatibility,
      ...patch.compatibility,
    },
  });
}

export function stripReactCallbacks(
  options: UseEpubReaderOptions,
): BrowserEpubReaderOptions {
  const core = { ...options };
  delete core.onReady;
  delete core.onError;
  delete core.readingSession;
  return core;
}
