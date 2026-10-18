import { locatorAtResourceStart } from '../../../interaction/locator';
import type { Locator, Publication } from '../../../epub/publication';
import type { ViewportMetrics } from '../../../presentation/rendition';
import type {
  BrowserEpubReaderOpenProgress,
  BrowserEpubReaderOptions,
} from '../model';

export function assertUsableContainer(container: HTMLElement): void {
  if (!container?.ownerDocument) {
    throw new TypeError(
      'BrowserEpubReader requires a live HTMLElement container.',
    );
  }
  measureViewport(container);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('EPUB open aborted.', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function reportOpenProgress(
  options: BrowserEpubReaderOptions,
  phase: BrowserEpubReaderOpenProgress['phase'],
  label: string,
  completed: number,
): void {
  options.onOpenProgress?.({ phase, label, completed, total: 5 });
}

export function resolveInitialLocator(
  publication: Publication,
  options: BrowserEpubReaderOptions,
): Locator {
  if (options.initialLocator) return options.initialLocator;

  const spineIndex =
    options.initialSpineIndex ??
    publication.spine.find((item) => item.linear)?.index ??
    0;
  if (!publication.spine[spineIndex]) {
    throw new RangeError(
      `Initial spine index ${spineIndex} is outside the publication.`,
    );
  }
  return locatorAtResourceStart(publication, spineIndex);
}

/**
 * Floor measured dimensions so multiplied page extents cannot drift beyond an
 * iframe's integer-rounded viewport on later pages.
 */
export function measureViewport(container: HTMLElement): ViewportMetrics {
  const rect = container.getBoundingClientRect();
  return normalizeViewport({
    width: Math.max(1, Math.floor(rect.width || container.clientWidth)),
    height: Math.max(1, Math.floor(rect.height || container.clientHeight)),
  });
}

export function normalizeViewport(viewport: ViewportMetrics): ViewportMetrics {
  if (
    !Number.isFinite(viewport.width) ||
    viewport.width <= 0 ||
    !Number.isFinite(viewport.height) ||
    viewport.height <= 0
  ) {
    throw new RangeError(
      'Reader viewport width and height must both be positive finite numbers.',
    );
  }
  return Object.freeze({ width: viewport.width, height: viewport.height });
}

export function preflightWindowIndexes(
  publication: Publication,
  spineIndex: number,
): readonly number[] {
  const indexes: number[] = [];
  for (let index = spineIndex - 1; index <= spineIndex + 1; index += 1) {
    if (publication.spine[index]) indexes.push(index);
  }
  return indexes;
}
