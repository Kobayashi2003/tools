import type { ReaderMark } from '../../features/annotations';
import type { Locator, ReaderPreferences } from '../../epub/publication';

/** Framework-neutral state that can resume one publication reading session. */
export interface ReadingSessionRecord {
  readonly locator: Locator;
  readonly preferences?: ReaderPreferences;
  readonly marks: readonly ReaderMark[];
  readonly updatedAt: string;
}

/** Persistence port; browser, native and remote hosts provide their own adapters. */
export interface ReadingSessionStorage {
  load(key: string): ReadingSessionRecord | null;
  save(key: string, record: ReadingSessionRecord): void;
  remove(key: string): void;
}
