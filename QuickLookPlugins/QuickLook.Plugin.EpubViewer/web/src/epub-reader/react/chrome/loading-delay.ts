import { useEffect, useState } from 'react';

/**
 * Grace period before a transient busy state is allowed to appear on screen.
 *
 * Reader work between two pages usually finishes in well under this, and a
 * loading state that paints and disappears inside a tenth of a second reads as
 * a flicker rather than as feedback.
 */
export const LOADING_VISIBILITY_DELAY_MS = 180;

/**
 * True only once `active` has stayed true for `delayMs` without interruption.
 *
 * Going false is immediate: once the work is finished there is nothing left to
 * wait for, and holding the indicator any longer would invent latency.
 */
export function useDelayedFlag(
  active: boolean,
  delayMs = LOADING_VISIBILITY_DELAY_MS,
): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      // Reset asynchronously so work that completes within the same commit
      // never schedules a render from inside this effect.
      const reset = setTimeout(() => setVisible(false), 0);
      return () => clearTimeout(reset);
    }
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return visible;
}

/**
 * `value`, except while `holding` is true, when it returns whatever the value
 * was before the hold began.
 *
 * This lets a field ride out the gap in the middle of a page turn without
 * blanking, while still telling the truth once things settle: a section with no
 * table-of-contents entry really has no chapter name, and continuing to show
 * the previous one would report a place the reader has already left.
 */
export function useHeldValue(value: string, holding: boolean): string {
  const [settled, setSettled] = useState(value);
  if (!holding && settled !== value) setSettled(value);
  return holding ? settled : value;
}
