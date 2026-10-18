import type { Locator } from '../../epub/publication';
import { cloneAndFreezePlainData } from '../../shared/immutable';

export interface ReaderNavigationHistorySnapshot {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly backCount: number;
  readonly forwardCount: number;
  /** Oldest to newest; the final entry is the immediate Back destination. */
  readonly back: readonly Locator[];
  /** Oldest to newest; the final entry is the immediate Forward destination. */
  readonly forward: readonly Locator[];
}

/** Stores branch navigation without mixing ordinary sequential page turns into history. */
export class ReaderNavigationHistory {
  private readonly backStack: Locator[] = [];
  private readonly forwardStack: Locator[] = [];
  private snapshotValue: ReaderNavigationHistorySnapshot | null = null;

  constructor(private readonly limit = 64) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError(
        'Navigation history limit must be a positive integer.',
      );
  }

  get snapshot(): ReaderNavigationHistorySnapshot {
    return (this.snapshotValue ??= cloneAndFreezePlainData({
      canGoBack: this.backStack.length > 0,
      canGoForward: this.forwardStack.length > 0,
      backCount: this.backStack.length,
      forwardCount: this.forwardStack.length,
      back: this.backStack,
      forward: this.forwardStack,
    }));
  }

  record(origin: Locator | null, destination: Locator | null): void {
    if (!origin || !destination || sameLocator(origin, destination)) return;
    const latest = this.backStack.at(-1);
    if (!latest || !sameLocator(latest, origin))
      this.backStack.push(copyLocator(origin));
    if (this.backStack.length > this.limit)
      this.backStack.splice(0, this.backStack.length - this.limit);
    this.forwardStack.length = 0;
    this.snapshotValue = null;
  }

  peekBack(): Locator | null {
    return copyOptional(this.backStack.at(-1));
  }

  peekForward(): Locator | null {
    return copyOptional(this.forwardStack.at(-1));
  }

  commitBack(current: Locator | null): void {
    if (this.backStack.length === 0) return;
    this.backStack.pop();
    if (current) this.forwardStack.push(copyLocator(current));
    this.snapshotValue = null;
  }

  commitForward(current: Locator | null): void {
    if (this.forwardStack.length === 0) return;
    this.forwardStack.pop();
    if (current) this.backStack.push(copyLocator(current));
    this.snapshotValue = null;
  }

  clear(): void {
    if (this.backStack.length === 0 && this.forwardStack.length === 0) return;
    this.backStack.length = 0;
    this.forwardStack.length = 0;
    this.snapshotValue = null;
  }
}

function sameLocator(left: Locator, right: Locator): boolean {
  if (left.spineIndex !== right.spineIndex || left.href !== right.href)
    return false;
  const a = left.locations;
  const b = right.locations;
  if (a.cfi || b.cfi) return a.cfi === b.cfi;
  if (a.fragment || b.fragment) return a.fragment === b.fragment;
  return Math.abs((a.progression ?? 0) - (b.progression ?? 0)) < 0.001;
}

function copyOptional(locator: Locator | undefined): Locator | null {
  return locator ? copyLocator(locator) : null;
}

function copyLocator(locator: Locator): Locator {
  const dom = locator.locations.dom
    ? Object.freeze({
        ...locator.locations.dom,
        path: Object.freeze([...locator.locations.dom.path]),
      })
    : undefined;
  const locations = Object.freeze({
    ...locator.locations,
    ...(dom ? { dom } : {}),
  });
  const text = locator.text ? Object.freeze({ ...locator.text }) : undefined;
  return Object.freeze({ ...locator, locations, ...(text ? { text } : {}) });
}
