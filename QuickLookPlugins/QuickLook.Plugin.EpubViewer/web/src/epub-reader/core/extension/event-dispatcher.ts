import { assertExtensionId } from './model';
import type { Cleanup } from './lifecycle-scope';

export type EventObserver<TEvent> = (event: TEvent) => void | Promise<void>;

export interface ObserverFailure<TEvent> {
  readonly observerId: string;
  readonly event: TEvent;
  readonly error: unknown;
}

export interface EventDispatcherOptions<TEvent> {
  readonly onObserverFailure?: (failure: ObserverFailure<TEvent>) => void;
}

export class DuplicateObserverIdError extends Error {
  constructor(readonly observerId: string) {
    super(`Duplicate event observer id: ${observerId}.`);
    this.name = 'DuplicateObserverIdError';
  }
}

/**
 * Ordered, read-only event fan-out. Dispatch never throws an Observer failure
 * back into the state transition that produced the event.
 */
export class EventDispatcher<TEvent> {
  private readonly observers = new Map<string, EventObserver<TEvent>>();
  private disposed = false;

  constructor(private readonly options: EventDispatcherOptions<TEvent> = {}) {}

  get size(): number {
    return this.observers.size;
  }

  observe(id: string, observer: EventObserver<TEvent>): Cleanup {
    if (this.disposed) throw new Error('EventDispatcher has been disposed.');
    assertExtensionId(id, 'Observer id');
    if (this.observers.has(id)) throw new DuplicateObserverIdError(id);
    this.observers.set(id, observer);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.observers.get(id) === observer) this.observers.delete(id);
    };
  }

  dispatch(event: TEvent): void {
    if (this.disposed) return;
    for (const [observerId, observer] of [...this.observers]) {
      try {
        const result = observer(event);
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch((error) =>
            this.reportFailure({ observerId, event, error }),
          );
        }
      } catch (error) {
        this.reportFailure({ observerId, event, error });
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observers.clear();
  }

  private reportFailure(failure: ObserverFailure<TEvent>): void {
    try {
      this.options.onObserverFailure?.(failure);
    } catch {
      // Failure reporting is itself observational and remains isolated.
    }
  }
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return (
    value != null && typeof (value as PromiseLike<void>).then === 'function'
  );
}
