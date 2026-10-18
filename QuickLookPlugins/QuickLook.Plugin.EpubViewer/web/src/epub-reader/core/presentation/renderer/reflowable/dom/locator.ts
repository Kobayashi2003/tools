import type { Locator } from '../../../../epub/publication';
import { isSemanticTextNode } from '../../../../epub/text';
import type { DomPoint } from '../../../../interaction/locator';
import type { RenditionPlan } from '../../../rendition';
import type {
  ReflowablePresentation,
  ReflowableRendererPolicy,
} from '../model';
import {
  getHorizontalLogicalOffset,
  getScrollingElement,
  measureDocument,
  pagingAxis,
  restoreProgression,
  setHorizontalLogicalOffset,
  snapPaginatedToPage,
  snapshotReflowableLayout,
} from './layout';

export function captureProvisionalLocator(
  document: Document,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
  policy: ReflowableRendererPolicy,
): Locator {
  const snapshot = snapshotReflowableLayout(
    document,
    plan,
    presentation,
    policy,
  );
  const visible = findVisibleTextAnchor(
    document,
    presentation,
    policy.locatorTextLength,
  );

  return {
    href: plan.href,
    spineIndex: plan.spineIndex,
    locations: {
      progression: snapshot.progression,
      ...(visible?.fragment ? { fragment: visible.fragment } : {}),
    },
    ...(visible?.text ? { text: visible.text } : {}),
  };
}

export function restoreProvisionalLocator(
  document: Document,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
  policy: ReflowableRendererPolicy,
  locator: Locator,
): void {
  const scrolling = getScrollingElement(document);
  let restored = false;

  if (locator.locations.fragment) {
    const element = document.getElementById(locator.locations.fragment);
    if (element) {
      element.scrollIntoView({
        block: 'start',
        inline: 'start',
        behavior: 'auto',
      });
      restored = true;
    }
  }

  if (!restored && locator.text?.highlight) {
    const parent = findText(document, locator.text.highlight)?.parentElement;
    if (parent) {
      parent.scrollIntoView({
        block: 'start',
        inline: 'start',
        behavior: 'auto',
      });
      restored = true;
    }
  }

  if (!restored && locator.locations.progression != null) {
    restoreProgression(
      document,
      plan,
      presentation,
      policy,
      locator.locations.progression,
    );
    return;
  }

  if (plan.renderer === 'reflowable-paginated') {
    snapPaginatedToPage(document, plan, presentation, policy);
  }

  if (!Number.isFinite(scrolling.scrollTop)) scrolling.scrollTop = 0;
}

/** Find a structural point near the visual reading-start edge. */
export function findVisibleDomPoint(
  document: Document,
  presentation: ReflowablePresentation,
): DomPoint | null {
  const win = document.defaultView;
  const body = document.body;
  if (!win || !body) return null;

  const walker = document.createTreeWalker(body, 4 /* SHOW_TEXT */);
  let best: { node: Text; score: number } | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data.trim() || !isSemanticTextNode(node)) continue;
    const score = firstVisibleRectScore(node, win, presentation);
    if (score != null && (!best || score < best.score)) best = { node, score };
  }
  if (!best) return null;

  return {
    node: best.node,
    offset: firstVisibleTextOffset(
      document,
      best.node,
      win.innerWidth,
      win.innerHeight,
    ),
  };
}

export function restoreDomPoint(
  document: Document,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
  policy: ReflowableRendererPolicy,
  point: DomPoint,
): void {
  const scrolling = getScrollingElement(document);

  const bringToPageStart = (rect: DOMRect): void => {
    const axis = pagingAxis(
      scrolling,
      measureDocument(document),
      plan,
      presentation,
    );
    const delta =
      presentation.scrollAxis === 'vertical'
        ? rect.top
        : presentation.horizontalFlow === 'right-to-left'
          ? plan.viewport.width - rect.right
          : rect.left;
    axis.write(axis.read() + delta);
    snapPaginatedToPage(document, plan, presentation, policy);
  };

  // Element-boundary ranges are ambiguous in vertical pagination; use the
  // element box itself when restoring a fragment target.
  if (point.node.nodeType === 1 && point.offset === 0) {
    const element = point.node as Element;
    if (plan.renderer === 'reflowable-paginated') {
      bringToPageStart(element.getBoundingClientRect());
    } else {
      element.scrollIntoView({
        behavior: 'auto',
        block: 'start',
        inline: 'start',
      });
    }
    return;
  }

  const range = document.createRange();
  try {
    range.setStart(point.node, Math.max(0, point.offset));
    range.collapse(true);
  } catch {
    const element =
      point.node.nodeType === 1
        ? (point.node as Element)
        : point.node.parentElement;
    element?.scrollIntoView({
      behavior: 'auto',
      block: 'start',
      inline: 'start',
    });
    if (plan.renderer === 'reflowable-paginated') {
      snapPaginatedToPage(document, plan, presentation, policy);
    }
    return;
  }

  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  range.detach?.();
  if (!rect) return;
  if (plan.renderer === 'reflowable-paginated') {
    bringToPageStart(rect);
    return;
  }

  if (presentation.scrollAxis === 'vertical') {
    scrolling.scrollTop += rect.top;
    return;
  }

  const measurement = measureDocument(document);
  const max = Math.max(0, measurement.scrollWidth - plan.viewport.width);
  const current = getHorizontalLogicalOffset(
    scrolling,
    presentation.horizontalFlow,
    max,
  );
  const delta =
    presentation.horizontalFlow === 'right-to-left'
      ? plan.viewport.width - rect.right
      : rect.left;
  setHorizontalLogicalOffset(
    scrolling,
    presentation.horizontalFlow,
    max,
    current + delta,
  );
}

function findVisibleTextAnchor(
  document: Document,
  presentation: ReflowablePresentation,
  maxLength: number,
): {
  fragment?: string;
  text?: { before?: string; highlight?: string; after?: string };
} | null {
  const win = document.defaultView;
  const body = document.body;
  if (!win || !body) return null;

  const walker = document.createTreeWalker(body, 4 /* SHOW_TEXT */);
  let best: { node: Text; score: number } | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data.trim() || !isSemanticTextNode(node)) continue;
    const score = firstVisibleRectScore(node, win, presentation);
    if (score != null && (!best || score < best.score)) best = { node, score };
  }
  if (!best) return null;

  const text = best.node.data.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const fragment = nearestElementId(best.node.parentElement);
  return {
    ...(fragment ? { fragment } : {}),
    text: { highlight: text.slice(0, Math.max(8, maxLength)) },
  };
}

function firstVisibleRectScore(
  node: Text,
  win: Window,
  presentation: ReflowablePresentation,
): number | null {
  const range = node.ownerDocument.createRange();
  range.selectNodeContents(node);
  const rects = Array.from(range.getClientRects());
  range.detach?.();

  for (const rect of rects) {
    if (
      rect.bottom > 0 &&
      rect.top < win.innerHeight &&
      rect.right > 0 &&
      rect.left < win.innerWidth
    ) {
      return visibleRectScore(rect, presentation);
    }
  }
  return null;
}

function visibleRectScore(
  rect: DOMRect,
  presentation: ReflowablePresentation,
): number {
  if (presentation.writingMode === 'vertical-rl') {
    return Math.max(0, 100_000 - rect.right) + Math.max(0, rect.top);
  }
  if (presentation.writingMode === 'vertical-lr') {
    return Math.max(0, rect.left) * 100_000 + Math.max(0, rect.top);
  }
  return Math.max(0, rect.top) * 100_000 + Math.max(0, rect.left);
}

function nearestElementId(element: Element | null): string | undefined {
  let current = element;
  while (current) {
    if (current.id) return current.id;
    current = current.parentElement;
  }
  return undefined;
}

function findText(document: Document, needle: string): Text | null {
  const body = document.body;
  if (!body || !needle) return null;
  const walker = document.createTreeWalker(body, 4 /* SHOW_TEXT */);
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    if (isSemanticTextNode(text) && text.data.includes(needle)) return text;
  }
  return null;
}

function firstVisibleTextOffset(
  document: Document,
  node: Text,
  viewportWidth: number,
  viewportHeight: number,
): number {
  if (node.data.length === 0) return 0;

  let low = 1;
  let high = node.data.length;
  let answer = node.data.length;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, midpoint);
    const visible = Array.from(range.getClientRects()).some(
      (rect) =>
        rect.bottom > 0 &&
        rect.top < viewportHeight &&
        rect.right > 0 &&
        rect.left < viewportWidth,
    );
    range.detach?.();
    if (visible) {
      answer = midpoint;
      high = midpoint - 1;
    } else {
      low = midpoint + 1;
    }
  }
  return Math.max(0, answer - 1);
}
