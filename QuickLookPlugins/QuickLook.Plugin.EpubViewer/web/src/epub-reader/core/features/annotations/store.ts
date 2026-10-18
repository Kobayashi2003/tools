import type {
  ReaderMark,
  ReaderMarkStore,
  ReaderMarkStoreSnapshot,
} from './model';
import { cloneAndFreezePlainData } from '../../shared/immutable';

export class MemoryReaderMarkStore implements ReaderMarkStore {
  private readonly marks = new Map<string, ReaderMark>();
  private readonly listeners = new Set<
    (snapshot: ReaderMarkStoreSnapshot) => void
  >();
  private revision = 0;
  private snapshotValue: ReaderMarkStoreSnapshot = cloneAndFreezePlainData({
    revision: 0,
    marks: [],
  });

  snapshot(): ReaderMarkStoreSnapshot {
    return this.snapshotValue;
  }

  put(mark: ReaderMark): void {
    this.marks.set(mark.id, freezeMark(mark));
    this.publish();
  }

  remove(id: string): boolean {
    const removed = this.marks.delete(id);
    if (removed) this.publish();
    return removed;
  }

  removeMany(ids: readonly string[]): number {
    const unique = new Set(ids);
    let removed = 0;
    for (const id of unique) {
      if (this.marks.delete(id)) removed += 1;
    }
    if (removed > 0) this.publish();
    return removed;
  }

  clear(): void {
    if (this.marks.size === 0) return;
    this.marks.clear();
    this.publish();
  }

  subscribe(listener: (snapshot: ReaderMarkStoreSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    this.revision += 1;
    this.snapshotValue = cloneAndFreezePlainData({
      revision: this.revision,
      marks: [...this.marks.values()].sort(compareMarks),
    });
    for (const listener of this.listeners) listener(this.snapshotValue);
  }
}

export function createMarkId(prefix = 'mark'): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return `${prefix}:${cryptoApi.randomUUID()}`;
  createMarkId.counter += 1;
  return `${prefix}:${Date.now().toString(36)}:${createMarkId.counter.toString(36)}`;
}
createMarkId.counter = 0;

function compareMarks(a: ReaderMark, b: ReaderMark): number {
  const aLocator = a.kind === 'bookmark' ? a.locator : a.range.start;
  const bLocator = b.kind === 'bookmark' ? b.locator : b.range.start;
  return (
    aLocator.spineIndex - bLocator.spineIndex ||
    progression(aLocator) - progression(bLocator) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function progression(
  locator: import('../../epub/publication').Locator,
): number {
  return locator.locations.progression ?? 0;
}

function freezeMark<T extends ReaderMark>(mark: T): T {
  return cloneAndFreezePlainData(mark);
}
