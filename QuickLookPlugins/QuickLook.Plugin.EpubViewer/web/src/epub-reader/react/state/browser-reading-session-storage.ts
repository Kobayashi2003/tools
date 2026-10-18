import {
  parseReadingSessionRecord,
  type ReadingSessionRecord,
  type ReadingSessionStorage,
} from '../../core';

/** Best-effort localStorage adapter for the framework-neutral session port. */
export class BrowserReadingSessionStorage implements ReadingSessionStorage {
  constructor(
    private readonly storage: Storage,
    private readonly namespace = 'component-atlas:epub-reader:',
  ) {}

  load(key: string): ReadingSessionRecord | null {
    try {
      const raw = this.storage.getItem(this.namespace + key);
      if (!raw) return null;
      return parseReadingSessionRecord(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  save(key: string, record: ReadingSessionRecord): void {
    try {
      this.storage.setItem(this.namespace + key, JSON.stringify(record));
    } catch {
      /* storage is best effort */
    }
  }

  remove(key: string): void {
    try {
      this.storage.removeItem(this.namespace + key);
    } catch {
      /* storage is best effort */
    }
  }
}
