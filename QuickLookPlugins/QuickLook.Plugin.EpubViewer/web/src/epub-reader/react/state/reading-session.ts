import { publicationSessionKey, type ReadingSessionStorage } from '../../core';
import type { EpubSource } from './model';
import type { ReaderPreferenceStorage } from './preference-storage';

export interface ReadingSessionOptions {
  readonly key?: string;
  readonly storage?: ReadingSessionStorage;
  readonly persistPreferences?: boolean;
  /**
   * Whose reading settings these are. `publication` (the default) keeps them
   * with each book. `device` keeps the ones that describe the reader rather
   * than the book (`DEVICE_PREFERENCE_KEYS`) in `preferenceStorage` and lays
   * them over every book opened; the rest stay with the book.
   */
  readonly preferenceScope?: 'publication' | 'device';
  /** Where device-scoped settings are kept; browser localStorage by default. */
  readonly preferenceStorage?: ReaderPreferenceStorage;
  readonly saveDelayMs?: number;
}

export function readingSessionKey(
  source: EpubSource,
  bytes: Uint8Array | ArrayBuffer,
): string {
  return publicationSessionKey(
    bytes,
    isNamedSource(source) ? source.name : undefined,
  );
}

function isNamedSource(
  source: EpubSource,
): source is EpubSource & { readonly name: string } {
  return typeof (source as { readonly name?: unknown }).name === 'string';
}
