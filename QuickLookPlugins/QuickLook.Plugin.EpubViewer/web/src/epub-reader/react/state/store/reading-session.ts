import {
  MemoryReaderMarkStore,
  type BrowserEpubReaderSnapshot,
  type Locator,
  type ReaderMark,
  type ReadingSessionRecord,
  type ReadingSessionStorage,
} from '../../../core';
import { BrowserReadingSessionStorage } from '../browser-reading-session-storage';
import type { EpubSource, UseEpubReaderOptions } from '../model';
import { readingSessionKey } from '../reading-session';

export interface ResolvedReadingSession {
  readonly storage: ReadingSessionStorage | null;
  readonly key: string;
  readonly persistPreferences: boolean;
  readonly saveDelayMs: number;
}

export function resolveReadingSession(
  options: UseEpubReaderOptions['readingSession'],
  source: EpubSource,
  bytes: Uint8Array | ArrayBuffer,
  ownerWindow: Window | null,
): ResolvedReadingSession {
  if (options === false) {
    return {
      storage: null,
      key: '',
      persistPreferences: false,
      saveDelayMs: 0,
    };
  }

  let storage = options?.storage ?? null;
  if (!storage && ownerWindow) {
    try {
      storage = new BrowserReadingSessionStorage(ownerWindow.localStorage);
    } catch {
      storage = null;
    }
  }

  return {
    storage,
    key: options?.key?.trim() || readingSessionKey(source, bytes),
    persistPreferences: options?.persistPreferences !== false,
    saveDelayMs: Math.max(0, options?.saveDelayMs ?? 300),
  };
}

export function createRestoredMarkStore(
  marks: readonly ReaderMark[],
): MemoryReaderMarkStore {
  const store = new MemoryReaderMarkStore();
  for (const mark of marks) store.put(mark);
  return store;
}

export function createReadingSessionRecord(
  snapshot: BrowserEpubReaderSnapshot,
  locator: Locator,
  persistPreferences: boolean,
): ReadingSessionRecord {
  return {
    // Physical progression is the durable source for reopening. Exact content
    // anchors remain on explicit bookmarks and annotations.
    locator: readingSessionPositionLocator(
      locator,
      snapshot.renderer?.layout?.progression,
    ),
    ...(persistPreferences ? { preferences: snapshot.preferences } : {}),
    marks: snapshot.marks?.marks ?? [],
    updatedAt: new Date().toISOString(),
  };
}

function readingSessionPositionLocator(
  locator: Locator,
  rendererProgression?: number,
): Locator {
  const progression = rendererProgression ?? locator.locations.progression ?? 0;
  return {
    href: locator.href,
    spineIndex: locator.spineIndex,
    locations: { progression: Math.max(0, Math.min(1, progression)) },
  };
}
