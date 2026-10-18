import {
  DEFAULT_READER_COMPATIBILITY_PREFERENCES,
  type BrowserEpubReaderOptions,
  type ReaderMarkStore,
  type ReaderPreferences,
  type ReaderPreferencesPatch,
  type ReadingSessionRecord,
} from '../../../core';
import type { UseEpubReaderOptions } from '../model';
import { stripReactCallbacks } from './preferences';

type ReaderCallbacks = Pick<
  BrowserEpubReaderOptions,
  | 'onOpenProgress'
  | 'onCommand'
  | 'onEvent'
  | 'onDiagnostics'
  | 'onExternalLink'
  | 'onUnresolvedPublicationLink'
>;

interface CreateReaderOptionsInput {
  readonly options: UseEpubReaderOptions;
  readonly saved: ReadingSessionRecord | null;
  readonly persistSavedPreferences: boolean;
  readonly retryPreferences: ReaderPreferences | null;
  readonly restoredMarkStore?: ReaderMarkStore;
  readonly signal: AbortSignal;
  readonly callbacks: ReaderCallbacks;
}

export function createReaderOptions({
  options,
  saved,
  persistSavedPreferences,
  retryPreferences,
  restoredMarkStore,
  signal,
  callbacks,
}: CreateReaderOptionsInput): BrowserEpubReaderOptions {
  const savedPreferences: ReaderPreferencesPatch =
    saved && persistSavedPreferences ? (saved.preferences ?? {}) : {};
  const optionPreferences: ReaderPreferencesPatch = options.preferences ?? {};
  const retryPatch: ReaderPreferencesPatch = retryPreferences ?? {};

  return {
    ...stripReactCallbacks(options),
    ...(saved && options.initialLocator == null
      ? { initialLocator: saved.locator }
      : {}),
    preferences: {
      ...savedPreferences,
      ...optionPreferences,
      ...retryPatch,
      compatibility: {
        ...DEFAULT_READER_COMPATIBILITY_PREFERENCES,
        ...savedPreferences.compatibility,
        ...optionPreferences.compatibility,
        ...retryPatch.compatibility,
      },
    },
    ...(restoredMarkStore ? { markStore: restoredMarkStore } : {}),
    signal,
    ...callbacks,
  };
}
