import type { Publication, SpineItem } from '../../../epub/publication';
import { resolveSpineRendition } from '../../../epub/publication';
import type { RenditionPlan, ResolvedPageProgression } from '../../rendition';
import type { SpreadSlotAssignment, SpreadSlotName } from './model';

/**
 * Resolve physical left/right slots for the spread containing the active item.
 * Explicit page-spread placement can insert a blank slot. A true-spread pair
 * is honored directly irrespective of authored spine order.
 */
export function resolveSpreadSlotAssignment(
  publication: Publication,
  activePlan: RenditionPlan,
  isEligible: (item: SpineItem) => boolean = defaultEligibility(publication),
): SpreadSlotAssignment {
  if (activePlan.spread.execution !== 'cross-spine') {
    throw new Error(
      'Physical left/right spine-slot assignment requires a cross-spine spread plan.',
    );
  }

  // An authored true-spread pair is honored directly, but only once both halves
  // are things this compositor may mount. Taking the hint unconditionally let a
  // pair that spans a layout boundary bypass the eligibility rule below.
  const trueSpread = activePlan.spread.trueSpread;
  if (
    trueSpread &&
    [trueSpread.leftSpineIndex, trueSpread.rightSpineIndex].every((index) => {
      const item = publication.spine[index];
      return item != null && isEligible(item);
    })
  ) {
    return {
      leftSpineIndex: trueSpread.leftSpineIndex,
      rightSpineIndex: trueSpread.rightSpineIndex,
      activeSlot:
        activePlan.spineIndex === trueSpread.leftSpineIndex ? 'left' : 'right',
      trueSpread: true,
    };
  }

  const progression = activePlan.pageProgression.value;
  let current: MutableSpread = emptySpread();

  const flushIfContainsActive = (): SpreadSlotAssignment | null => {
    if (
      current.left !== activePlan.spineIndex &&
      current.right !== activePlan.spineIndex
    )
      return null;
    return {
      leftSpineIndex: current.left,
      rightSpineIndex: current.right,
      activeSlot: current.left === activePlan.spineIndex ? 'left' : 'right',
      trueSpread: false,
    };
  };

  for (const item of publication.spine) {
    const rendition = resolveSpineRendition(publication, item);
    const placement = rendition.pageSpread;
    if (!isEligible(item) || placement === 'center') {
      const existing = flushIfContainsActive();
      if (existing) return existing;
      current = emptySpread();
      if (item.index === activePlan.spineIndex) {
        // Defensive fallback: the planner should have produced a single plan.
        return centeredFallback(activePlan.spineIndex, progression);
      }
      continue;
    }

    const desired =
      placement === 'left' || placement === 'right'
        ? placement
        : nextAvailableSlot(current, progression);

    if (current[desired] != null) {
      const existing = flushIfContainsActive();
      if (existing) return existing;
      current = emptySpread();
    }

    current[desired] = item.index;

    const placedSecondWithBlankFirst =
      isSecondSlot(desired, progression) &&
      current[firstSlot(progression)] == null;
    if (
      (current.left != null && current.right != null) ||
      placedSecondWithBlankFirst
    ) {
      const result = flushIfContainsActive();
      if (result) return result;
      current = emptySpread();
    }
  }

  const tail = flushIfContainsActive();
  if (tail) return tail;
  throw new RangeError(
    `Active spine item ${activePlan.spineIndex} could not be assigned to a synthetic spread.`,
  );
}

function defaultEligibility(
  publication: Publication,
): (item: SpineItem) => boolean {
  return (item) => {
    const rendition = resolveSpineRendition(publication, item);
    return rendition.spread !== 'none' && rendition.pageSpread !== 'center';
  };
}

interface MutableSpread {
  left: number | null;
  right: number | null;
}

function emptySpread(): MutableSpread {
  return { left: null, right: null };
}

function firstSlot(progression: ResolvedPageProgression): SpreadSlotName {
  return progression === 'rtl' ? 'right' : 'left';
}

function secondSlot(progression: ResolvedPageProgression): SpreadSlotName {
  return progression === 'rtl' ? 'left' : 'right';
}

function nextAvailableSlot(
  spread: MutableSpread,
  progression: ResolvedPageProgression,
): SpreadSlotName {
  const first = firstSlot(progression);
  return spread[first] == null ? first : secondSlot(progression);
}

function isSecondSlot(
  slot: SpreadSlotName,
  progression: ResolvedPageProgression,
): boolean {
  return slot === secondSlot(progression);
}

function centeredFallback(
  index: number,
  progression: ResolvedPageProgression,
): SpreadSlotAssignment {
  const slot = firstSlot(progression);
  return {
    leftSpineIndex: slot === 'left' ? index : null,
    rightSpineIndex: slot === 'right' ? index : null,
    activeSlot: slot,
    trueSpread: false,
  };
}
