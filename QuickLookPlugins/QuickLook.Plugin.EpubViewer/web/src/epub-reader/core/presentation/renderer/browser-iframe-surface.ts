import { createAbortError, linkAbortSignal, throwIfAborted } from './abort';
import { LifecycleScope } from './lifecycle';
import { BrowserDocumentLayoutTarget } from './browser-layout-target';
import { waitForLayoutStability } from './layout-stability';
import {
  DEFAULT_LAYOUT_STABILITY_POLICY,
  type ContentSurface,
  type ContentSurfaceLoadResult,
  type ContentSurfaceSource,
  type ContentSurfaceState,
  type LayoutStabilityPolicy,
  type LayoutStabilityReport,
} from './model';

export interface BrowserIFrameSurfaceOptions {
  readonly id?: string;
  readonly title?: string;
  /** Defaults to same-origin DOM access with scripts disabled. */
  readonly sandboxTokens?: readonly string[];
  /** `auto` probes Blob iframe support once per host document and falls back to srcdoc. */
  readonly navigationMode?: 'auto' | 'url' | 'srcdoc';
  readonly loadTimeoutMs?: number;
  readonly stabilityPolicy?: LayoutStabilityPolicy;
}

let nextSurfaceId = 1;

/**
 * Disposable iframe content surface. It is intentionally load-once; switching
 * spine items must allocate another surface so late events from the old
 * document cannot become events for the new one.
 */
export class BrowserIFrameContentSurface implements ContentSurface {
  readonly id: string;
  readonly element: HTMLIFrameElement;

  private currentState: ContentSurfaceState = 'created';
  private loaded = false;
  private readonly loadTimeoutMs: number;
  private readonly stabilityPolicy: LayoutStabilityPolicy;
  private readonly navigationMode: NonNullable<
    BrowserIFrameSurfaceOptions['navigationMode']
  >;
  private readonly lifecycle = new LifecycleScope();

  constructor(
    ownerDocument: Document,
    options: BrowserIFrameSurfaceOptions = {},
  ) {
    this.id = options.id ?? `epub-surface-${nextSurfaceId++}`;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 10_000;
    this.stabilityPolicy =
      options.stabilityPolicy ?? DEFAULT_LAYOUT_STABILITY_POLICY;
    this.navigationMode = options.navigationMode ?? 'auto';

    const frame = ownerDocument.createElement('iframe');
    frame.dataset.epubSurfaceId = this.id;
    frame.title = options.title ?? 'EPUB content';
    frame.setAttribute(
      'sandbox',
      (options.sandboxTokens ?? ['allow-same-origin']).join(' '),
    );
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.border = '0';
    frame.style.width = '100%';
    frame.style.height = '100%';
    frame.style.display = 'block';
    this.element = frame;
  }

  get state(): ContentSurfaceState {
    return this.currentState;
  }

  get document(): Document | null {
    if (this.currentState === 'disposed') return null;
    try {
      return this.element.contentDocument;
    } catch {
      return null;
    }
  }

  mount(parent: HTMLElement): void {
    this.assertAlive();
    if (this.currentState !== 'created') {
      throw new Error(`Content surface ${this.id} can only be mounted once.`);
    }
    parent.appendChild(this.element);
    this.currentState = 'mounted';
  }

  async load(
    source: ContentSurfaceSource,
    signal: AbortSignal,
  ): Promise<ContentSurfaceLoadResult> {
    this.assertAlive();
    if (this.currentState !== 'mounted') {
      throw new Error(
        `Content surface ${this.id} must be mounted before load().`,
      );
    }
    if (this.loaded) {
      throw new Error(
        `Content surface ${this.id} is single-load and cannot navigate to another document.`,
      );
    }
    this.loaded = true;
    this.currentState = 'loading';
    throwIfAborted(signal);

    const operation = new AbortController();
    const unlinkTransaction = linkAbortSignal(signal, operation);
    const unlinkLifecycle = linkAbortSignal(this.lifecycle.signal, operation);
    try {
      const selected = await selectNavigationSource(
        this.element.ownerDocument,
        source,
        this.navigationMode,
      );
      throwIfAborted(operation.signal);
      await this.navigateOnce(selected, operation.signal);
      throwIfAborted(operation.signal);

      const document = this.document;
      if (!document) {
        throw new Error(
          `Content surface ${this.id} loaded but its document is not accessible.`,
        );
      }

      this.currentState = 'ready';
      return { document };
    } finally {
      unlinkTransaction();
      unlinkLifecycle();
    }
  }

  async waitForLayoutStable(
    signal: AbortSignal,
  ): Promise<LayoutStabilityReport> {
    this.assertAlive();
    const document = this.document;
    if (!document)
      throw new Error(`Content surface ${this.id} has no accessible document.`);

    const operation = new AbortController();
    const unlinkTransaction = linkAbortSignal(signal, operation);
    const unlinkLifecycle = linkAbortSignal(this.lifecycle.signal, operation);
    try {
      return await waitForLayoutStability(
        new BrowserDocumentLayoutTarget(document),
        operation.signal,
        this.stabilityPolicy,
      );
    } finally {
      unlinkTransaction();
      unlinkLifecycle();
    }
  }

  dispose(): void {
    if (this.currentState === 'disposed') return;
    this.currentState = 'disposed';
    this.lifecycle.dispose(`Content surface ${this.id} disposed.`);
    // Replacing the document before detaching helps cancel outstanding browser
    // work; the browsing context is then removed and never reused.
    try {
      this.element.src = 'about:blank';
    } catch {
      // Ignore browser-specific teardown failures.
    }
    this.element.remove();
  }

  private navigateOnce(
    source: ContentSurfaceSource,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(
        () => finish(new Error(`Content surface ${this.id} load timed out.`)),
        this.loadTimeoutMs,
      );

      const cleanup = () => {
        clearTimeout(timer);
        this.element.removeEventListener('load', onLoad);
        this.element.removeEventListener('error', onError);
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
        finish(new Error(`Content surface ${this.id} failed to load.`));
      const onAbort = () =>
        finish(
          signal.reason instanceof Error ? signal.reason : createAbortError(),
        );

      this.element.addEventListener('load', onLoad, { once: true });
      this.element.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        if (source.kind === 'srcdoc') {
          this.element.srcdoc = source.baseHref
            ? injectBaseHref(source.html, source.baseHref)
            : source.html;
        } else {
          this.element.src = source.url;
        }
      } catch (error) {
        finish(error);
        return;
      }

      if (signal.aborted) onAbort();
    });
  }

  private assertAlive(): void {
    if (this.currentState === 'disposed') {
      throw new Error(`Content surface ${this.id} has been disposed.`);
    }
  }
}

const blobIframeSupport = new WeakMap<Document, Promise<boolean>>();

async function selectNavigationSource(
  ownerDocument: Document,
  source: ContentSurfaceSource,
  mode: NonNullable<BrowserIFrameSurfaceOptions['navigationMode']>,
): Promise<ContentSurfaceSource> {
  if (source.kind === 'srcdoc' || !source.srcdocFallback) return source;
  const fallback: ContentSurfaceSource = {
    kind: 'srcdoc',
    html: source.srcdocFallback.html,
    ...(source.srcdocFallback.baseHref
      ? { baseHref: source.srcdocFallback.baseHref }
      : {}),
  };
  if (mode === 'srcdoc') return fallback;
  if (mode === 'url' || !source.url.startsWith('blob:')) return source;
  return (await supportsBlobIframeNavigation(ownerDocument))
    ? source
    : fallback;
}

function supportsBlobIframeNavigation(
  ownerDocument: Document,
): Promise<boolean> {
  const existing = blobIframeSupport.get(ownerDocument);
  if (existing) return existing;
  const probe = probeBlobIframeNavigation(ownerDocument);
  blobIframeSupport.set(ownerDocument, probe);
  return probe;
}

function probeBlobIframeNavigation(ownerDocument: Document): Promise<boolean> {
  return new Promise((resolve) => {
    const win = ownerDocument.defaultView;
    const parent = ownerDocument.body ?? ownerDocument.documentElement;
    if (
      !win ||
      !parent ||
      !('srcdoc' in ownerDocument.createElement('iframe'))
    ) {
      resolve(false);
      return;
    }

    const frame = ownerDocument.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText =
      'position:fixed;width:1px;height:1px;left:-10000px;top:-10000px;visibility:hidden;';
    parent.appendChild(frame);

    const marker = 'epub-reader-surface-probe';
    const blob = new win.Blob(
      [
        `<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${marker}</title></head><body></body></html>`,
      ],
      { type: 'application/xhtml+xml;charset=utf-8' },
    );
    const url = win.URL.createObjectURL(blob);
    let finished = false;
    const timer = win.setTimeout(() => finish(false), 750);
    const cleanup = () => {
      win.clearTimeout(timer);
      frame.removeEventListener('load', onLoad);
      frame.removeEventListener('error', onError);
      frame.remove();
      win.URL.revokeObjectURL(url);
    };
    const finish = (supported: boolean) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(supported);
    };
    const onLoad = () => finish(frame.contentDocument?.title === marker);
    const onError = () => finish(false);
    frame.addEventListener('load', onLoad, { once: true });
    frame.addEventListener('error', onError, { once: true });
    frame.src = url;
  });
}

function injectBaseHref(html: string, baseHref: string): string {
  const escaped = escapeAttribute(baseHref);
  const base = `<base href="${escaped}">`;

  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${base}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(
      /<html(\s[^>]*)?>/i,
      (match) => `${match}<head>${base}</head>`,
    );
  }
  return `<html><head>${base}</head><body>${html}</body></html>`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
