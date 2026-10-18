import { createAbortError, isAbortError } from './abort';
import type {
  LayoutTransactionContext,
  LayoutTransactionReason,
  LayoutTransactionResult,
} from './model';

/**
 * Serializes ownership, not execution. Starting generation N+1 aborts N
 * immediately; N is allowed to unwind, but its transaction context can no
 * longer mutate live renderer state.
 */
export class LayoutTransactionCoordinator {
  private generation = 0;
  private active: AbortController | null = null;
  private activeCompletion: Promise<void> | null = null;
  private readonly observers = new Set<AbortController>();
  private disposed = false;

  get currentGeneration(): number {
    return this.generation;
  }

  async run<T>(
    reason: LayoutTransactionReason,
    operation: (transaction: LayoutTransactionContext) => Promise<T>,
  ): Promise<LayoutTransactionResult<T>> {
    this.assertAlive();
    for (const observer of this.observers)
      observer.abort(createAbortError('Superseded by a layout transaction.'));
    this.active?.abort(
      createAbortError('Superseded by a newer layout transaction.'),
    );

    const generation = ++this.generation;
    const controller = new AbortController();
    this.active = controller;
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.activeCompletion = completion;

    const context: LayoutTransactionContext = {
      generation,
      reason,
      signal: controller.signal,
      throwIfSuperseded: () => {
        if (
          controller.signal.aborted ||
          this.disposed ||
          generation !== this.generation
        ) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : createAbortError('Layout transaction was superseded.');
        }
      },
      mutate: <R>(mutation: () => R): R => {
        context.throwIfSuperseded();
        return mutation();
      },
    };

    try {
      const value = await operation(context);
      context.throwIfSuperseded();
      return { status: 'committed', generation, value };
    } catch (error) {
      if (
        isAbortError(error) ||
        controller.signal.aborted ||
        generation !== this.generation
      ) {
        return { status: 'superseded', generation };
      }
      throw error;
    } finally {
      if (this.active === controller) this.active = null;
      if (this.activeCompletion === completion) this.activeCompletion = null;
      complete();
    }
  }

  /**
   * Run a read against the last committed renderer without taking transaction
   * ownership. Reads wait for current layout work and are cancelled, rather
   * than cancelling that work, when a newer layout starts.
   */
  async observe<T>(
    reason: LayoutTransactionReason,
    operation: (transaction: LayoutTransactionContext) => Promise<T>,
  ): Promise<LayoutTransactionResult<T>> {
    this.assertAlive();
    while (this.activeCompletion) await this.activeCompletion;
    this.assertAlive();

    const generation = this.generation;
    const controller = new AbortController();
    this.observers.add(controller);
    const context: LayoutTransactionContext = {
      generation,
      reason,
      signal: controller.signal,
      throwIfSuperseded: () => {
        if (
          controller.signal.aborted ||
          this.disposed ||
          generation !== this.generation
        ) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : createAbortError('Layout observation was superseded.');
        }
      },
      mutate: <R>(mutation: () => R): R => {
        context.throwIfSuperseded();
        return mutation();
      },
    };

    try {
      const value = await operation(context);
      context.throwIfSuperseded();
      return { status: 'committed', generation, value };
    } catch (error) {
      if (
        isAbortError(error) ||
        controller.signal.aborted ||
        generation !== this.generation
      )
        return { status: 'superseded', generation };
      throw error;
    } finally {
      this.observers.delete(controller);
    }
  }

  supersede(reason = 'Layout transaction cancelled.'): void {
    if (!this.active && this.observers.size === 0) return;
    this.active?.abort(createAbortError(reason));
    for (const observer of this.observers)
      observer.abort(createAbortError(reason));
    this.active = null;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.abort(
      createAbortError('Layout transaction coordinator disposed.'),
    );
    for (const observer of this.observers)
      observer.abort(
        createAbortError('Layout transaction coordinator disposed.'),
      );
    this.observers.clear();
    this.active = null;
    this.generation += 1;
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new Error('LayoutTransactionCoordinator has been disposed.');
  }
}
