import {
  normalizeProgression,
  type TextDirection,
  type WritingMode,
} from '../../../../epub/publication';
import type { RenditionPlan } from '../../../rendition';
import {
  calculatePaginatedGeometry,
  pageOffsetForProgression,
  scrollProgression,
} from '../geometry';
import type {
  HorizontalFlowDirection,
  ReflowableLayoutSnapshot,
  ReflowablePresentation,
  ReflowableRendererPolicy,
} from '../model';
import { reflowablePageGap, reflowablePageWidth } from '../styles';

export interface PagingAxis {
  readonly extent: number;
  readonly max: number;
  read(): number;
  write(logicalOffset: number): void;
}

export interface DocumentMeasurement {
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
}

export function inspectComputedPresentation(
  document: Document,
  plan: RenditionPlan,
): ReflowablePresentation {
  const win = document.defaultView;
  const root = document.documentElement;
  const body = document.body;
  const rootStyle = root && win ? win.getComputedStyle(root) : null;
  const bodyStyle = body && win ? win.getComputedStyle(body) : null;

  const writingMode = normalizeWritingMode(
    bodyStyle?.writingMode || rootStyle?.writingMode || plan.writingMode.value,
  );
  const textDirection = normalizeDirection(
    bodyStyle?.direction || rootStyle?.direction || plan.textDirection.value,
  );

  return {
    writingMode,
    textDirection,
    scrollAxis: reflowableScrollAxis(writingMode, plan.renderer),
    horizontalFlow: horizontalFlow(writingMode, textDirection),
  };
}

/** Resolve the physical axis along which reading progression advances. */
export function reflowableScrollAxis(
  writingMode: WritingMode,
  renderer: RenditionPlan['renderer'],
): 'horizontal' | 'vertical' {
  if (renderer === 'reflowable-paginated') {
    return writingMode === 'horizontal-tb' ? 'horizontal' : 'vertical';
  }
  return writingMode === 'horizontal-tb' ? 'vertical' : 'horizontal';
}

export function snapshotReflowableLayout(
  document: Document,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
  policy: ReflowableRendererPolicy,
): ReflowableLayoutSnapshot {
  const scrolling = getScrollingElement(document);
  const measurement = measureDocument(document);

  if (plan.renderer === 'reflowable-paginated') {
    const axis = pagingAxis(scrolling, measurement, plan, presentation);
    const pageGap = reflowablePageGap(plan, policy, presentation.writingMode);
    const pageWidth = reflowablePageWidth(
      plan,
      policy,
      presentation.writingMode,
    );
    const geometry = calculatePaginatedGeometry({
      scrollExtent: axis.extent,
      pageExtent: pageWidth,
      pageGap,
      logicalOffset: axis.read(),
    });
    return {
      measurement,
      pageCount: geometry.pageCount,
      currentPage: geometry.currentPage,
      progression: geometry.progression,
      resourceBoundary: {
        atStart: geometry.currentPage === 1,
        atEnd:
          geometry.currentPage + visiblePageCount(plan, presentation) - 1 >=
          geometry.pageCount,
      },
      writingMode: presentation.writingMode,
      textDirection: presentation.textDirection,
      scrollAxis: presentation.scrollAxis,
      pageGap,
      pageWidth,
      visiblePageCount: visiblePageCount(plan, presentation),
    };
  }

  const horizontal = presentation.scrollAxis === 'horizontal';
  const max = horizontal
    ? Math.max(0, measurement.scrollWidth - plan.viewport.width)
    : Math.max(0, measurement.scrollHeight - plan.viewport.height);
  const logicalOffset = horizontal
    ? getHorizontalLogicalOffset(scrolling, presentation.horizontalFlow, max)
    : Math.max(0, scrolling.scrollTop);

  return {
    measurement,
    progression: scrollProgression(logicalOffset, max),
    resourceBoundary: {
      atStart: logicalOffset <= 1,
      atEnd: logicalOffset >= max - 1,
    },
    writingMode: presentation.writingMode,
    textDirection: presentation.textDirection,
    scrollAxis: presentation.scrollAxis,
  };
}

export function restoreProgression(
  document: Document,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
  policy: ReflowableRendererPolicy,
  progression: number,
): void {
  const scrolling = getScrollingElement(document);
  const measurement = measureDocument(document);
  const normalized = normalizeProgression(progression);

  if (plan.renderer === 'reflowable-paginated') {
    const axis = pagingAxis(scrolling, measurement, plan, presentation);
    const geometry = calculatePaginatedGeometry({
      scrollExtent: axis.extent,
      pageExtent: reflowablePageWidth(plan, policy, presentation.writingMode),
      pageGap: reflowablePageGap(plan, policy, presentation.writingMode),
      logicalOffset: 0,
    });
    axis.write(
      pageOffsetForProgression(
        normalized,
        geometry.pageCount,
        geometry.pageAdvance,
      ),
    );
    return;
  }

  if (presentation.scrollAxis === 'vertical') {
    const max = Math.max(0, measurement.scrollHeight - plan.viewport.height);
    scrolling.scrollTop = normalized * max;
    return;
  }

  const max = Math.max(0, measurement.scrollWidth - plan.viewport.width);
  setHorizontalLogicalOffset(
    scrolling,
    presentation.horizontalFlow,
    max,
    normalized * max,
  );
}

export function visiblePageCount(
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
): 1 | 2 {
  if (presentation.writingMode !== 'horizontal-tb') return 1;
  return plan.spread.execution === 'intra-document' ? 2 : 1;
}

export function pagingAxis(
  scrolling: HTMLElement,
  measurement: DocumentMeasurement,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
): PagingAxis {
  if (presentation.scrollAxis === 'vertical') {
    const extent = measurement.scrollHeight;
    const max = Math.max(0, extent - plan.viewport.height);
    return {
      extent,
      max,
      read: () => clamp(Math.max(0, scrolling.scrollTop), 0, max),
      write: (value) => {
        scrolling.scrollTop = clamp(value, 0, max);
      },
    };
  }

  const extent = measurement.scrollWidth;
  const max = Math.max(0, extent - plan.viewport.width);
  return {
    extent,
    max,
    read: () =>
      getHorizontalLogicalOffset(scrolling, presentation.horizontalFlow, max),
    write: (value) =>
      setHorizontalLogicalOffset(
        scrolling,
        presentation.horizontalFlow,
        max,
        value,
      ),
  };
}

export function snapPaginatedToPage(
  document: Document,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
  policy: ReflowableRendererPolicy,
): void {
  const axis = pagingAxis(
    getScrollingElement(document),
    measureDocument(document),
    plan,
    presentation,
  );
  const geometry = calculatePaginatedGeometry({
    scrollExtent: axis.extent,
    pageExtent: reflowablePageWidth(plan, policy, presentation.writingMode),
    pageGap: reflowablePageGap(plan, policy, presentation.writingMode),
    logicalOffset: axis.read(),
  });
  axis.write(geometry.snappedOffset);
}

const PAGE_EXTENT_MARKER_ID = 'epub-reader-page-extent';

/**
 * Paginated text ends short of a whole page in both writing modes: the margin
 * after the last column (the body's inline padding in vertical writing, the
 * page inset in horizontal writing) is not scrollable overflow. The last page
 * then cannot be reached, so it lands shifted by that margin — and in a
 * two-page spread a chapter with an odd page count could not reach its last
 * spread at all, so its final page was skipped. A 1px marker on the root
 * (outside the body, where search and locators never look) pads the extent so
 * the last page's offset is scrollable.
 */
function ensureWholePages(document: Document): void {
  const root = document.documentElement;
  const body = document.body;
  const view = document.defaultView;
  if (!root || !body || !view) return;
  // The body is the multicol container, so its writing mode decides the paging
  // axis. Publishers often set `vertical-rl` on the body alone and leave the
  // root `horizontal-tb`, so the root's writing mode is not a substitute.
  const bodyStyle = view.getComputedStyle(body);
  if (bodyStyle.columnWidth === 'auto') {
    document.getElementById(PAGE_EXTENT_MARKER_ID)?.remove();
    return;
  }
  const vertical = bodyStyle.writingMode !== 'horizontal-tb';
  const viewport = vertical ? root.clientHeight : root.clientWidth;
  if (viewport <= 0) return;
  // Pages advance by column plus gap, which the plan sizes from a floored
  // viewport measurement. The root's client box is rounded instead, so on a
  // fractional viewport it is a pixel larger than the advance; padding to whole
  // client boxes left the last page a pixel per page short of reachable.
  const measured =
    parseFloat(bodyStyle.columnWidth) + parseFloat(bodyStyle.columnGap);
  const advance =
    Number.isFinite(measured) && measured > 0 ? measured : viewport;
  // A horizontal spread shows two columns per viewport; vertical never does.
  const visible = vertical ? 1 : Math.max(1, Math.round(viewport / advance));

  // The body's extent never includes the root's marker, so the marker is moved,
  // not removed: removing it would clamp the scroll and re-trigger measuring.
  const extent = vertical ? body.scrollHeight : body.scrollWidth;
  // A pixel of tolerance: an extent a rounding error past a page is that page.
  const pages = Math.max(1, Math.ceil((extent - 1) / advance));
  // Page turns step by whole spreads from wherever reading currently is, so the
  // last spread starts on the same parity as the current one.
  const offset = Math.abs(vertical ? root.scrollTop : root.scrollLeft);
  const parity = Math.round(offset / advance) % visible;
  const lastStart =
    pages - 1 < parity
      ? 0
      : Math.floor((pages - 1 - parity) / visible) * visible + parity;
  // The last spread's offset plus one viewport must be scrollable.
  const whole = Math.ceil(lastStart * advance + Math.max(advance, viewport));

  let marker = document.getElementById(PAGE_EXTENT_MARKER_ID);
  if (!marker) {
    marker = document.createElement('div');
    marker.id = PAGE_EXTENT_MARKER_ID;
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText =
      'position:absolute;width:1px;height:1px;visibility:hidden;pointer-events:none;';
    root.append(marker);
  }
  const position = `${Math.max(0, whole - 1)}px`;
  // Right-to-left roots scroll into negative x, so the marker extends leftward.
  const rtl = !vertical && view.getComputedStyle(root).direction === 'rtl';
  const placement = {
    top: vertical ? position : '0px',
    left: vertical ? '0px' : rtl ? '' : position,
    right: rtl ? position : '',
  };
  for (const side of ['top', 'left', 'right'] as const) {
    if (marker.style[side] !== placement[side])
      marker.style[side] = placement[side];
  }
}

export function measureDocument(document: Document): DocumentMeasurement {
  ensureWholePages(document);
  const root = document.documentElement;
  const body = document.body;
  return {
    clientWidth: root?.clientWidth ?? body?.clientWidth ?? 0,
    clientHeight: root?.clientHeight ?? body?.clientHeight ?? 0,
    scrollWidth: Math.max(root?.scrollWidth ?? 0, body?.scrollWidth ?? 0),
    scrollHeight: Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0),
  };
}

export function getScrollingElement(document: Document): HTMLElement {
  const element =
    document.scrollingElement ?? document.documentElement ?? document.body;
  if (!element || element.nodeType !== 1 || !('scrollLeft' in element)) {
    throw new Error(
      'Reflowable document does not expose an HTML scrolling element.',
    );
  }
  // The scrolling element belongs to the iframe realm; structural checks work
  // where instanceof HTMLElement against the parent realm would fail.
  return element as HTMLElement;
}

/** Normalize browser RTL scrollLeft models into distance from authored start. */
export function getHorizontalLogicalOffset(
  element: HTMLElement,
  flow: HorizontalFlowDirection,
  max: number,
): number {
  if (flow === 'left-to-right') {
    return clamp(Math.max(0, element.scrollLeft), 0, max);
  }

  const raw = element.scrollLeft;
  if (raw < 0) return clamp(-raw, 0, max);
  return detectPositiveRtlModel(element, raw) === 'start-at-max'
    ? clamp(max - raw, 0, max)
    : clamp(raw, 0, max);
}

export function setHorizontalLogicalOffset(
  element: HTMLElement,
  flow: HorizontalFlowDirection,
  max: number,
  logicalOffset: number,
): void {
  const value = clamp(logicalOffset, 0, max);
  if (flow === 'left-to-right') {
    element.scrollLeft = value;
    return;
  }

  const original = element.scrollLeft;
  element.scrollLeft = -value;
  if (value === 0 || element.scrollLeft < 0) return;

  element.scrollLeft = original;
  const model = detectPositiveRtlModel(element, original);
  element.scrollLeft = model === 'start-at-max' ? max - value : value;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function detectPositiveRtlModel(
  element: HTMLElement,
  current: number,
): 'start-at-zero' | 'start-at-max' {
  if (current > 0) return 'start-at-max';
  const original = element.scrollLeft;
  element.scrollLeft = 1;
  const acceptsPositive = element.scrollLeft > 0;
  element.scrollLeft = original;
  return acceptsPositive ? 'start-at-zero' : 'start-at-max';
}

function normalizeWritingMode(value: string): WritingMode {
  const normalized = value.trim().toLowerCase();
  return normalized === 'vertical-rl' || normalized === 'vertical-lr'
    ? normalized
    : 'horizontal-tb';
}

function normalizeDirection(value: string): TextDirection {
  const normalized = value.trim().toLowerCase();
  return normalized === 'rtl' || normalized === 'ltr' ? normalized : 'auto';
}

function horizontalFlow(
  writingMode: WritingMode,
  direction: TextDirection,
): HorizontalFlowDirection {
  if (writingMode === 'vertical-rl') return 'right-to-left';
  if (writingMode === 'vertical-lr') return 'left-to-right';
  return direction === 'rtl' ? 'right-to-left' : 'left-to-right';
}
