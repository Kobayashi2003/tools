import type { Locator, Publication } from '../../epub/publication';
import { locatorAtResourceEnd, locatorAtResourceStart } from '../locator';
import type { LayoutTransactionReason } from '../../presentation/renderer';
import type {
  NavigationDirection,
  NavigationPlanProvider,
  NavigationRendererHost,
  NavigationTarget,
  ReaderNavigationPolicy,
  ReaderNavigationResult,
} from './model';
import { DEFAULT_READER_NAVIGATION_POLICY } from './model';
import { locatorFromCfi, locatorFromHref } from './targets';

/**
 * Publication-level navigation coordinator.
 *
 * Renderers only know how to move inside their currently loaded content. When
 * they report a boundary, this class advances through the EPUB spine and asks
 * the plan provider for the next rendition. Physical left/right controls are
 * intentionally outside this API; they map to forward/backward using the plan's
 * page-progression direction.
 *
 * Navigation is serialized, not latest-wins: two rapid "next" inputs represent
 * two intentional reading steps. Layout transactions remain latest-wins inside
 * RendererHost, but publication navigation preserves user input order.
 */
export class ReaderNavigator {
  private readonly policy: ReaderNavigationPolicy;
  private queue: Promise<void> = Promise.resolve();
  private pendingRelayout: RelayoutRequest | null = null;

  constructor(
    private readonly publication: Publication,
    private readonly host: NavigationRendererHost,
    private readonly plans: NavigationPlanProvider,
    policy: Partial<ReaderNavigationPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_READER_NAVIGATION_POLICY, ...policy };
  }

  next(): Promise<ReaderNavigationResult> {
    return this.move('forward');
  }

  previous(): Promise<ReaderNavigationResult> {
    return this.move('backward');
  }

  move(direction: NavigationDirection): Promise<ReaderNavigationResult> {
    return this.enqueue(() => this.performMove(direction));
  }

  goTo(target: NavigationTarget): Promise<Locator | null> {
    return this.enqueue(async () => {
      if ('kind' in target) {
        return target.kind === 'href'
          ? this.performGoToLocator(
              locatorFromHref(this.publication, target.href),
            )
          : this.performGoToLocator(
              locatorFromCfi(this.publication, target.cfi),
            );
      }
      return this.performGoToLocator(target);
    });
  }

  goToLocator(locator: Locator): Promise<Locator | null> {
    return this.enqueue(() => this.performGoToLocator(locator));
  }

  relayout(reason: LayoutTransactionReason): Promise<void> {
    // Navigation remains strictly ordered, but repeated layout invalidations
    // that have not started yet all describe the same desired final state.
    // Share one queued operation and let its most recent reason win.
    if (this.pendingRelayout) {
      this.pendingRelayout.reason = reason;
      return this.pendingRelayout.promise;
    }

    const promise = this.enqueue(async () => {
      if (this.pendingRelayout === request) this.pendingRelayout = null;
      const current = this.host.state.plan;
      if (!current) return;
      const plan = await this.plans.planForSpine(current.spineIndex);
      await this.host.present(plan, request.reason);
    });
    const request: RelayoutRequest = { reason, promise };
    this.pendingRelayout = request;
    return promise;
  }

  private async performMove(
    direction: NavigationDirection,
  ): Promise<ReaderNavigationResult> {
    const currentPlan = this.host.state.plan;
    if (!currentPlan) {
      const first = this.findSequentialSpine(
        direction === 'forward' ? -1 : this.publication.spine.length,
        direction,
      );
      if (first == null)
        return {
          status: 'boundary',
          edge: direction === 'forward' ? 'end' : 'start',
        };
      const locator =
        direction === 'forward'
          ? locatorAtResourceStart(this.publication, first)
          : locatorAtResourceEnd(this.publication, first);
      await this.performGoToLocator(locator);
      return {
        status: 'moved',
        locator: await this.host.captureLocator(),
        spineChanged: true,
      };
    }

    const within = await this.host.navigateWithin(direction);
    if (within.status === 'moved') {
      return {
        status: 'moved',
        locator: await this.host.captureLocator(),
        spineChanged: false,
      };
    }

    // A page turn has to reach content that is not already on screen. When a
    // spread composes two spine items, both are being read at once, so the move
    // starts from the far edge of what is visible rather than from the active
    // item — advancing to the other half of the spread the reader is looking at
    // would re-compose the same spread and spend the turn showing nothing new.
    const visible = visibleSpineIndices(
      this.host.state.layout,
      currentPlan.spineIndex,
    );
    const anchor =
      direction === 'forward' ? Math.max(...visible) : Math.min(...visible);
    const nextIndex = this.findSequentialSpine(anchor, direction);
    if (nextIndex == null) {
      return {
        status: 'boundary',
        edge: direction === 'forward' ? 'end' : 'start',
      };
    }

    const locator =
      direction === 'forward'
        ? locatorAtResourceStart(this.publication, nextIndex)
        : locatorAtResourceEnd(this.publication, nextIndex);
    await this.performGoToLocator(locator);
    return {
      status: 'moved',
      locator: await this.host.captureLocator(),
      spineChanged: true,
    };
  }

  private async performGoToLocator(locator: Locator): Promise<Locator | null> {
    const item = this.publication.spine[locator.spineIndex];
    if (!item || item.href !== locator.href) {
      throw new RangeError(
        'Locator does not resolve to this publication spine.',
      );
    }
    const plan = await this.plans.planForSpine(locator.spineIndex);
    if (plan.spineIndex !== locator.spineIndex || plan.href !== locator.href) {
      throw new Error(
        'Navigation plan provider returned a plan for the wrong spine item.',
      );
    }
    const presented = await this.host.present(plan, 'navigation', locator);
    return presented.locator ?? this.host.captureLocator();
  }

  private findSequentialSpine(
    anchor: number,
    direction: NavigationDirection,
  ): number | null {
    const delta = direction === 'forward' ? 1 : -1;
    for (
      let index = anchor + delta;
      index >= 0 && index < this.publication.spine.length;
      index += delta
    ) {
      const item = this.publication.spine[index]!;
      if (!this.policy.skipNonLinear || item.linear) return index;
    }
    return null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

interface RelayoutRequest {
  reason: LayoutTransactionReason;
  readonly promise: Promise<void>;
}

function visibleSpineIndices(layout: unknown, fallback: number): number[] {
  const reported = (
    layout as { visibleSpineIndices?: readonly number[] } | null | undefined
  )?.visibleSpineIndices;
  if (!reported || reported.length === 0) return [fallback];
  return reported.filter((index) => Number.isInteger(index));
}
