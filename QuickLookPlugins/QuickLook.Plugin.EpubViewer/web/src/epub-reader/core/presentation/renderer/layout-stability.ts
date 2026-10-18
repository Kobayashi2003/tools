import { createAbortError, throwIfAborted } from './abort';
import {
  DEFAULT_LAYOUT_STABILITY_POLICY,
  type LayoutMeasurement,
  type LayoutStabilityPolicy,
  type LayoutStabilityReport,
  type LayoutStabilityTarget,
} from './model';

export async function waitForLayoutStability(
  target: LayoutStabilityTarget,
  signal: AbortSignal,
  policy: LayoutStabilityPolicy = DEFAULT_LAYOUT_STABILITY_POLICY,
): Promise<LayoutStabilityReport> {
  validatePolicy(policy);
  throwIfAborted(signal);

  const deadline = Date.now() + policy.timeoutMs;
  let fonts: LayoutStabilityReport['fonts'] = 'not-requested';
  let imageReport = { requested: 0, decoded: 0, failed: 0, timedOut: false };

  if (policy.waitForFonts) {
    const result = await settleBeforeDeadline(
      () => target.waitForFonts(signal),
      deadline,
      signal,
    );
    fonts = result === 'done' ? 'ready' : 'timed-out';
  }

  if (policy.decodeImages && remaining(deadline) > 0) {
    const result = await settleValueBeforeDeadline(
      () => target.decodeImages(signal),
      deadline,
      signal,
    );
    if (result.status === 'done') {
      imageReport = {
        requested: result.value.total,
        decoded: result.value.decoded,
        failed: result.value.failed,
        timedOut: false,
      };
    } else {
      imageReport = { ...imageReport, timedOut: true };
    }
  } else if (policy.decodeImages) {
    imageReport = { ...imageReport, timedOut: true };
  }

  const frames = await waitForStableGeometry(target, signal, policy, deadline);
  const timedOut =
    frames.timedOut || fonts === 'timed-out' || imageReport.timedOut;

  return {
    status: timedOut ? 'timed-out' : 'stable',
    fonts,
    images: imageReport,
    stableFramesObserved: frames.stableFramesObserved,
    measurement: frames.measurement,
  };
}

interface StableGeometryResult {
  readonly timedOut: boolean;
  readonly stableFramesObserved: number;
  readonly measurement: LayoutMeasurement;
}

async function waitForStableGeometry(
  target: LayoutStabilityTarget,
  signal: AbortSignal,
  policy: LayoutStabilityPolicy,
  deadline: number,
): Promise<StableGeometryResult> {
  let resizeVersion = 0;
  let seenResizeVersion = 0;
  const stopObserving =
    policy.observeResize && target.observeResize
      ? target.observeResize(() => {
          resizeVersion += 1;
        })
      : () => {};

  let previous = target.measure();
  let stableFrames = 0;

  try {
    while (remaining(deadline) > 0) {
      throwIfAborted(signal);
      const frame = await waitForFrame(target, signal, remaining(deadline));
      if (!frame) {
        return {
          timedOut: true,
          stableFramesObserved: stableFrames,
          measurement: target.measure(),
        };
      }

      const current = target.measure();
      const resizeChanged = resizeVersion !== seenResizeVersion;
      seenResizeVersion = resizeVersion;

      if (!resizeChanged && sameMeasurement(previous, current)) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }
      previous = current;

      if (stableFrames >= policy.stableFrames) {
        return {
          timedOut: false,
          stableFramesObserved: stableFrames,
          measurement: current,
        };
      }
    }

    return {
      timedOut: true,
      stableFramesObserved: stableFrames,
      measurement: target.measure(),
    };
  } finally {
    stopObserving();
  }
}

function waitForFrame(
  target: LayoutStabilityTarget,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<boolean> {
  if (timeoutMs <= 0) return Promise.resolve(false);

  return new Promise<boolean>((resolve, reject) => {
    let finished = false;
    let cancelFrame: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      cancelFrame();
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (value: boolean) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(
        signal.reason instanceof Error ? signal.reason : createAbortError(),
      );
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    try {
      // `requestFrame` is permitted to be synchronous in tests/adapters, so
      // finish() must already exist before the callback can run.
      cancelFrame = target.requestFrame(() => finish(true));
      if (finished) cancelFrame();
      else timer = setTimeout(() => finish(false), timeoutMs);
    } catch (error) {
      if (!finished) {
        finished = true;
        cleanup();
        reject(error);
      }
    }
  });
}

async function settleBeforeDeadline(
  operation: () => Promise<void>,
  deadline: number,
  signal: AbortSignal,
): Promise<'done' | 'timed-out'> {
  const result = await settleValueBeforeDeadline(
    async () => {
      await operation();
      return undefined;
    },
    deadline,
    signal,
  );
  return result.status;
}

async function settleValueBeforeDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<{ status: 'done'; value: T } | { status: 'timed-out' }> {
  throwIfAborted(signal);
  const timeoutMs = remaining(deadline);
  if (timeoutMs <= 0) return { status: 'timed-out' };

  return await new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish({ status: 'timed-out' }), timeoutMs);

    const onAbort = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(
        signal.reason instanceof Error ? signal.reason : createAbortError(),
      );
    };

    const finish = (
      value: { status: 'done'; value: T } | { status: 'timed-out' },
    ) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(error);
      return;
    }

    pending.then(
      (value) => finish({ status: 'done', value }),
      (error) => {
        if (signal.aborted) onAbort();
        else {
          finished = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      },
    );
  });
}

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function sameMeasurement(a: LayoutMeasurement, b: LayoutMeasurement): boolean {
  return (
    a.clientWidth === b.clientWidth &&
    a.clientHeight === b.clientHeight &&
    a.scrollWidth === b.scrollWidth &&
    a.scrollHeight === b.scrollHeight &&
    sameExtent(a.contentWidth, b.contentWidth) &&
    sameExtent(a.contentHeight, b.contentHeight)
  );
}

/**
 * Content bounds come from `getBoundingClientRect()`, so they carry sub-pixel
 * noise that would otherwise keep a document from ever being declared stable.
 */
function sameExtent(a: number | undefined, b: number | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) < 0.5;
}

function validatePolicy(policy: LayoutStabilityPolicy): void {
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new RangeError(
      'Layout stability timeoutMs must be a positive finite number.',
    );
  }
  if (!Number.isInteger(policy.stableFrames) || policy.stableFrames < 1) {
    throw new RangeError(
      'Layout stability stableFrames must be an integer >= 1.',
    );
  }
}
