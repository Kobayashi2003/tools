import { createAbortError, throwIfAborted } from './abort';
import type { LayoutMeasurement, LayoutStabilityTarget } from './model';

/** DOM implementation consumed by the browser-independent stability detector. */
export class BrowserDocumentLayoutTarget implements LayoutStabilityTarget {
  constructor(readonly document: Document) {}

  async waitForFonts(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const fonts = this.document.fonts;
    if (!fonts) return;
    await raceWithAbort(
      fonts.ready.then(() => undefined),
      signal,
    );
  }

  async decodeImages(
    signal: AbortSignal,
  ): Promise<{ decoded: number; failed: number; total: number }> {
    throwIfAborted(signal);
    const images = Array.from(this.document.images);
    let decoded = 0;
    let failed = 0;

    await Promise.all(
      images.map(async (image) => {
        throwIfAborted(signal);
        try {
          if (typeof image.decode === 'function') {
            await raceWithAbort(image.decode(), signal);
          } else if (!image.complete) {
            await waitForImage(image, signal);
          }
          decoded += 1;
        } catch (error) {
          if (signal.aborted) throw error;
          // Broken images are a content/resource diagnostic, not a reason to make
          // layout stability itself reject forever.
          failed += 1;
        }
      }),
    );

    return { decoded, failed, total: images.length };
  }

  measure(): LayoutMeasurement {
    const root = this.document.documentElement;
    const body = this.document.body;
    const content = measureContentBounds(this.document.body);
    return {
      clientWidth: root?.clientWidth ?? body?.clientWidth ?? 0,
      clientHeight: root?.clientHeight ?? body?.clientHeight ?? 0,
      scrollWidth: Math.max(root?.scrollWidth ?? 0, body?.scrollWidth ?? 0),
      scrollHeight: Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0),
      ...(content ?? {}),
    };
  }

  requestFrame(callback: () => void): () => void {
    const win = this.document.defaultView;
    if (win?.requestAnimationFrame) {
      const id = win.requestAnimationFrame(() => callback());
      return () => win.cancelAnimationFrame(id);
    }

    const id = setTimeout(callback, 16);
    return () => clearTimeout(id);
  }

  observeResize(callback: () => void): () => void {
    const win = this.document.defaultView;
    const ResizeObserverCtor = win?.ResizeObserver;
    if (!ResizeObserverCtor) return () => {};

    const observer = new ResizeObserverCtor(callback);
    if (this.document.documentElement)
      observer.observe(this.document.documentElement);
    if (this.document.body) observer.observe(this.document.body);
    return () => observer.disconnect();
  }
}

/**
 * Physical extent of the flow, measured so that leftward and upward overflow
 * counts. The body itself is sized by the reader, so its own box cannot report
 * the reflow; its first and last laid-out children bracket the content and at
 * least one of them moves whenever the flow grows in any direction.
 */
function measureContentBounds(
  body: HTMLElement | null,
): { contentWidth: number; contentHeight: number } | null {
  if (!body || typeof body.getBoundingClientRect !== 'function') return null;
  const rect = body.getBoundingClientRect();
  let left = rect.left;
  let right = rect.right;
  let top = rect.top;
  let bottom = rect.bottom;

  for (const child of [body.firstElementChild, body.lastElementChild]) {
    if (!child) continue;
    const box = child.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
    top = Math.min(top, box.top);
    bottom = Math.max(bottom, box.bottom);
  }

  return { contentWidth: right - left, contentHeight: bottom - top };
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const onAbort = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      reject(
        signal.reason instanceof Error ? signal.reason : createAbortError(),
      );
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function waitForImage(
  image: HTMLImageElement,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onLoad = () => finish();
    const onError = () =>
      finish(
        new Error(`Image failed to load: ${image.currentSrc || image.src}`),
      );
    const onAbort = () =>
      finish(
        signal.reason instanceof Error ? signal.reason : createAbortError(),
      );

    image.addEventListener('load', onLoad, { once: true });
    image.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
