import type { RenditionPlan } from '../../../rendition';
import type { ReadingDirection, RendererNavigationResult } from '../../model';
import { calculatePaginatedGeometry } from '../geometry';
import type {
  ReflowablePresentation,
  ReflowableRendererPolicy,
} from '../model';
import { reflowablePageGap, reflowablePageWidth } from '../styles';
import {
  getHorizontalLogicalOffset,
  getScrollingElement,
  measureDocument,
  pagingAxis,
  setHorizontalLogicalOffset,
  snapshotReflowableLayout,
  visiblePageCount,
} from './layout';

export function navigateReflowable(
  document: Document,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
  policy: ReflowableRendererPolicy,
  direction: ReadingDirection,
): RendererNavigationResult {
  const scrolling = getScrollingElement(document);
  const measurement = measureDocument(document);

  if (plan.renderer === 'reflowable-paginated') {
    const axis = pagingAxis(scrolling, measurement, plan, presentation);
    const geometry = calculatePaginatedGeometry({
      scrollExtent: axis.extent,
      pageExtent: reflowablePageWidth(plan, policy, presentation.writingMode),
      pageGap: reflowablePageGap(plan, policy, presentation.writingMode),
      logicalOffset: axis.read(),
    });
    const deltaPages =
      direction === 'forward'
        ? visiblePageCount(plan, presentation)
        : -visiblePageCount(plan, presentation);
    const targetPage = geometry.currentPage - 1 + deltaPages;
    if (targetPage < 0) return { status: 'boundary', edge: 'start' };
    if (targetPage >= geometry.pageCount) {
      return { status: 'boundary', edge: 'end' };
    }

    const requested = targetPage * geometry.pageAdvance;
    axis.write(requested);
    // The scroll range is authoritative when arithmetic page count and browser
    // layout disagree; never report a turn that did not physically happen.
    if (Math.abs(axis.read() - requested) > geometry.pageAdvance / 2) {
      return {
        status: 'boundary',
        edge: direction === 'forward' ? 'end' : 'start',
      };
    }
    return {
      status: 'moved',
      layout: snapshotReflowableLayout(document, plan, presentation, policy),
    };
  }

  const moved =
    presentation.scrollAxis === 'vertical'
      ? navigateVertical(scrolling, measurement.scrollHeight, plan, direction)
      : navigateHorizontal(
          scrolling,
          measurement.scrollWidth,
          plan,
          presentation,
          direction,
        );
  if (!moved) {
    return {
      status: 'boundary',
      edge: direction === 'forward' ? 'end' : 'start',
    };
  }
  return {
    status: 'moved',
    layout: snapshotReflowableLayout(document, plan, presentation, policy),
  };
}

function navigateVertical(
  scrolling: HTMLElement,
  scrollHeight: number,
  plan: RenditionPlan,
  direction: ReadingDirection,
): boolean {
  const max = Math.max(0, scrollHeight - plan.viewport.height);
  const current = Math.max(0, scrolling.scrollTop);
  const advance = Math.max(1, plan.viewport.height * 0.9);
  const target =
    direction === 'forward'
      ? Math.min(max, current + advance)
      : Math.max(0, current - advance);
  if (Math.abs(target - current) < 0.5) return false;
  scrolling.scrollTop = target;
  return true;
}

function navigateHorizontal(
  scrolling: HTMLElement,
  scrollWidth: number,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
  direction: ReadingDirection,
): boolean {
  const max = Math.max(0, scrollWidth - plan.viewport.width);
  const current = getHorizontalLogicalOffset(
    scrolling,
    presentation.horizontalFlow,
    max,
  );
  const advance = Math.max(1, plan.viewport.width * 0.9);
  const target =
    direction === 'forward'
      ? Math.min(max, current + advance)
      : Math.max(0, current - advance);
  if (Math.abs(target - current) < 0.5) return false;
  setHorizontalLogicalOffset(
    scrolling,
    presentation.horizontalFlow,
    max,
    target,
  );
  return true;
}
