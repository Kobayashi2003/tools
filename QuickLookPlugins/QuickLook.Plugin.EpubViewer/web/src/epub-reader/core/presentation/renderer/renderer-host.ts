import type { Locator } from '../../epub/publication';
import type { RenditionPlan, RendererKind } from '../rendition';
import { isAbortError } from './abort';
import { LayoutTransactionCoordinator } from './layout-transaction';
import type {
  LayoutTransactionReason,
  RendererCommitEvent,
  ReadingDirection,
  RendererFactory,
  RendererHostState,
  RendererInstance,
  RendererNavigationResult,
  RendererPresentationResult,
} from './model';
import { cloneAndFreezePlainData } from '../../shared/immutable';

type StateListener = (state: RendererHostState) => void;
type CommitListener = (event: RendererCommitEvent) => void;

/**
 * Owns the active renderer and ensures that only the newest layout transaction
 * can publish state. React must talk to this host/controller layer rather than
 * mutating an iframe or renderer directly.
 */
export class RendererHost {
  private readonly coordinator = new LayoutTransactionCoordinator();
  private readonly factories = new Map<RendererKind, RendererFactory>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly commitListeners = new Set<CommitListener>();

  private activeRenderer: RendererInstance | null = null;
  private activeLayoutCleanup: (() => void) | null = null;
  private currentState: RendererHostState = cloneAndFreezePlainData({
    status: 'idle',
    generation: 0,
    plan: null,
    rendererKind: null,
    layout: null,
    stability: null,
    error: null,
  });
  private disposed = false;

  constructor(factories: readonly RendererFactory[]) {
    for (const factory of factories) {
      if (this.factories.has(factory.kind)) {
        throw new Error(`Duplicate renderer factory for ${factory.kind}.`);
      }
      this.factories.set(factory.kind, factory);
    }
  }

  get state(): RendererHostState {
    return this.currentState;
  }

  get contentDocuments(): readonly import('./model').RendererContentDocument[] {
    return this.activeRenderer?.contentDocuments?.() ?? [];
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.currentState);
    return () => this.stateListeners.delete(listener);
  }

  onCommit(listener: CommitListener): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  /** Initial render, navigation to another spine item, or any relayout. */
  async present(
    plan: RenditionPlan,
    reason: LayoutTransactionReason = this.currentState.plan
      ? 'content-change'
      : 'initial-render',
    targetLocator?: Locator,
  ): Promise<RendererPresentationResult> {
    this.assertAlive();
    this.setState({
      ...this.currentState,
      status: 'rendering',
      generation: this.coordinator.currentGeneration + 1,
      error: null,
    });

    try {
      const result = await this.coordinator.run(reason, async (transaction) => {
        const previous = this.activeRenderer;
        const previousPlan = this.currentState.plan;
        const sameContent =
          previousPlan != null &&
          previousPlan.spineIndex === plan.spineIndex &&
          previousPlan.href === plan.href;
        // A renderer instance owns one spine-document lifetime. Even if two
        // adjacent chapters use the same renderer kind, navigation replaces
        // the instance/surface so old load/font/image events cannot leak into
        // the next document.
        // Factory topology is part of renderer identity. A single-page
        // renderer and the cross-spine compositor can expose the same RendererKind,
        // so spread changes must replace the instance when they cross that boundary.
        const sameTopology =
          previousPlan != null &&
          (previousPlan.spread.execution === 'cross-spine') ===
            (plan.spread.execution === 'cross-spine');
        const shouldReplace =
          previous == null ||
          previous.kind !== plan.renderer ||
          !sameContent ||
          !sameTopology;
        let captured: Locator | null = null;

        // Locator preservation is a relayout concern. Never restore the old
        // chapter's locator into a different spine item during navigation.
        if (previous && sameContent && !targetLocator) {
          captured = await previous.captureLocator(transaction);
          transaction.throwIfSuperseded();
        }

        if (shouldReplace) {
          const next = this.createRenderer(plan);
          next.setVisibility?.(false);
          let committed = false;
          try {
            await next.mount(plan, transaction);
            transaction.throwIfSuperseded();
            const stability = await next.waitForLayoutStable(transaction);
            transaction.throwIfSuperseded();
            const restoreTarget = targetLocatorMatchesPlan(targetLocator, plan)
              ? targetLocator
              : captured;
            let restoredLocator: Locator | null = null;
            if (restoreTarget) {
              restoredLocator = await next.restoreLocator(
                restoreTarget,
                transaction,
              );
              transaction.throwIfSuperseded();
            }

            const layout = next.snapshot();
            transaction.mutate(() => {
              next.setVisibility?.(true);
              this.activeLayoutCleanup?.();
              this.activeRenderer = next;
              this.activeLayoutCleanup = this.observeLiveLayout(next);
              previous?.dispose();
              committed = true;
              this.publishCommit(
                transaction.generation,
                reason,
                plan,
                layout,
                stability,
              );
            });
            return { state: this.currentState, locator: restoredLocator };
          } finally {
            if (!committed) next.dispose();
          }
        }

        // Same renderer kind: update in place. Every renderer-side mutation
        // after an await must use transaction.mutate()/throwIfSuperseded().
        await previous!.update(plan, transaction);
        transaction.throwIfSuperseded();
        const stability = await previous!.waitForLayoutStable(transaction);
        transaction.throwIfSuperseded();
        const restoreTarget = targetLocatorMatchesPlan(targetLocator, plan)
          ? targetLocator
          : captured;
        let restoredLocator: Locator | null = null;
        if (restoreTarget) {
          restoredLocator = await previous!.restoreLocator(
            restoreTarget,
            transaction,
          );
          transaction.throwIfSuperseded();
        }
        const layout = previous!.snapshot();
        transaction.mutate(() => {
          this.publishCommit(
            transaction.generation,
            reason,
            plan,
            layout,
            stability,
          );
        });
        return { state: this.currentState, locator: restoredLocator };
      });

      // A superseded transaction must never overwrite the state already being
      // produced by its successor.
      if (result.status === 'committed') return result.value;
      return { state: this.currentState, locator: null };
    } catch (error) {
      if (isAbortError(error))
        return { state: this.currentState, locator: null };
      if (!this.disposed) {
        const hasCommittedRenderer =
          this.activeRenderer != null && this.currentState.plan != null;
        this.setState({
          ...this.currentState,
          // A failed replacement or relayout leaves the last committed
          // renderer available. Only a failure before the initial commit is
          // fatal to the reader lifecycle.
          status: hasCommittedRenderer ? 'ready' : 'error',
          generation: this.coordinator.currentGeneration,
          error,
        });
      }
      throw error;
    }
  }

  async navigateWithin(
    direction: ReadingDirection,
  ): Promise<RendererNavigationResult> {
    this.assertAlive();
    const active = this.activeRenderer;
    if (!active)
      return {
        status: 'boundary',
        edge: direction === 'forward' ? 'end' : 'start',
      };
    const result = await this.coordinator.run('navigation', async (tx) => {
      const navigation = await active.navigate(direction, tx);
      tx.throwIfSuperseded();
      if (navigation.status === 'moved') {
        tx.mutate(() => {
          this.setState({
            ...this.currentState,
            generation: tx.generation,
            layout: navigation.layout,
          });
        });
      }
      return navigation;
    });
    return result.status === 'committed'
      ? result.value
      : { status: 'boundary', edge: direction === 'forward' ? 'end' : 'start' };
  }

  captureLocator(): Promise<Locator | null> {
    this.assertAlive();
    return this.coordinator
      .observe('manual', (tx) => {
        // Resolve the active instance only after observe() has waited for an
        // in-flight replacement to commit. Capturing it before that wait can
        // retain the renderer that the transaction is about to dispose.
        const active = this.activeRenderer;
        return active ? active.captureLocator(tx) : Promise.resolve(null);
      })
      .then((result) => (result.status === 'committed' ? result.value : null));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.coordinator.dispose();
    this.activeLayoutCleanup?.();
    this.activeLayoutCleanup = null;
    this.activeRenderer?.dispose();
    this.activeRenderer = null;
    this.stateListeners.clear();
    this.commitListeners.clear();
    this.currentState = cloneAndFreezePlainData({
      status: 'disposed',
      generation: this.coordinator.currentGeneration,
      plan: null,
      rendererKind: null,
      layout: null,
      stability: null,
      error: null,
    });
  }

  private observeLiveLayout(renderer: RendererInstance): (() => void) | null {
    if (!renderer.onLayoutChange) return null;
    return renderer.onLayoutChange((layout) => {
      if (
        this.disposed ||
        this.activeRenderer !== renderer ||
        this.currentState.status === 'disposed'
      )
        return;
      this.setState({ ...this.currentState, layout });
    });
  }

  private createRenderer(plan: RenditionPlan): RendererInstance {
    const kind = plan.renderer;
    const factory = this.factories.get(kind);
    if (!factory)
      throw new Error(`No renderer factory registered for ${kind}.`);
    const renderer = factory.create(plan);
    if (renderer.kind !== kind) {
      renderer.dispose();
      throw new Error(
        `Renderer factory ${kind} created mismatched renderer ${renderer.kind}.`,
      );
    }
    return renderer;
  }

  private publishCommit(
    generation: number,
    reason: LayoutTransactionReason,
    plan: RenditionPlan,
    layout: RendererHostState['layout'] & {},
    stability: RendererHostState['stability'] & {},
  ): void {
    this.setState({
      status: 'ready',
      generation,
      plan,
      rendererKind: plan.renderer,
      layout,
      stability,
      error: null,
    });
    const event: RendererCommitEvent = {
      generation,
      reason,
      plan,
      layout,
      stability,
    };
    for (const listener of this.commitListeners) listener(event);
  }

  private setState(state: RendererHostState): void {
    this.currentState = cloneAndFreezePlainData(state);
    for (const listener of this.stateListeners) listener(this.currentState);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('RendererHost has been disposed.');
  }
}

function targetLocatorMatchesPlan(
  locator: Locator | undefined,
  plan: RenditionPlan,
): locator is Locator {
  return (
    locator != null &&
    locator.spineIndex === plan.spineIndex &&
    locator.href === plan.href
  );
}
