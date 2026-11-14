import {
  parseReaderPreferences,
  type ReaderPreferences,
  type ReaderPreferencesPatch,
} from '../../core';

/**
 * Where a host keeps the reading settings that belong to the device rather than
 * to one book. Synchronous, like the Reading Session port, because the reader
 * reads it while opening.
 */
export interface ReaderPreferenceStorage {
  load(): ReaderPreferences | null;
  save(preferences: ReaderPreferences): void;
}

/**
 * The settings that follow the reader from book to book when preferences are
 * device-scoped: how text looks, how pages are laid out, how they are turned,
 * and the theme. What a particular book needs stays with that book: its
 * writing mode and page direction, and the compatibility switches used to
 * repair it.
 */
export const DEVICE_PREFERENCE_KEYS = [
  'flow',
  'spread',
  'fontSizePercent',
  'fontFamily',
  'lineHeight',
  'pageMarginPercent',
  'fixedLayoutFit',
  'fixedLayoutGutter',
  'touchNavigation',
  'pageTurnZonePercent',
  'theme',
] as const satisfies readonly (keyof ReaderPreferences)[];

export function devicePreferences(
  preferences: ReaderPreferences,
): ReaderPreferencesPatch {
  const patch: Record<string, unknown> = {};
  for (const key of DEVICE_PREFERENCE_KEYS) patch[key] = preferences[key];
  return patch as ReaderPreferencesPatch;
}

/** Best-effort localStorage adapter; a failure leaves the settings for this book only. */
export class BrowserReaderPreferenceStorage implements ReaderPreferenceStorage {
  constructor(
    private readonly storage: Storage,
    private readonly key = 'epub-reader:device-preferences',
  ) {}

  load(): ReaderPreferences | null {
    try {
      const raw = this.storage.getItem(this.key);
      return raw ? parseReaderPreferences(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  save(preferences: ReaderPreferences): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(preferences));
    } catch {
      /* storage is best effort */
    }
  }
}
