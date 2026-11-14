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
  /** The device's own settings, when preferences are device-scoped. */
  readonly devicePreferences?: ReaderPreferencesPatch | null;
  readonly restoredMarkStore?: ReaderMarkStore;
  readonly signal: AbortSignal;
  readonly callbacks: ReaderCallbacks;
}

export function createReaderOptions({
  options,
  saved,
  persistSavedPreferences,
  retryPreferences,
  devicePreferences,
  restoredMarkStore,
  signal,
  callbacks,
}: CreateReaderOptionsInput): BrowserEpubReaderOptions {
  const savedPreferences: ReaderPreferencesPatch =
    saved && persistSavedPreferences ? (saved.preferences ?? {}) : {};
  // The host's opening preferences, then what the reader last chose on this
  // device: a choice the reader made wins over the host's defaults.
  const optionPreferences: ReaderPreferencesPatch = {
    ...options.preferences,
    ...devicePreferences,
  };
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
