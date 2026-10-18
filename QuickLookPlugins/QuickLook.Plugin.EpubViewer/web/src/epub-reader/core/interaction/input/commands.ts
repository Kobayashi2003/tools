import { navigationForSide } from '../navigation';
import type { PageProgressionDirection } from '../../epub/publication';
import type { ReaderCommand } from './model';

export function touchNavigationAllows(
  preference:
    import('../../epub/publication').TouchNavigationPreference | undefined,
  gesture: 'tap' | 'swipe',
): boolean {
  return preference == null || preference === 'both' || preference === gesture;
}

export interface KeyLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

export function commandForKey(
  event: KeyLike,
  progression: PageProgressionDirection,
): ReaderCommand | null {
  const key = event.key;
  const primary = Boolean(event.ctrlKey || event.metaKey);
  if (primary && key.toLowerCase() === 'f')
    return { type: 'open-search', source: 'keyboard' };
  if (event.altKey && !primary && key === 'ArrowLeft')
    return { type: 'history-back', source: 'keyboard' };
  if (event.altKey && !primary && key === 'ArrowRight')
    return { type: 'history-forward', source: 'keyboard' };
  if (key === 'Escape') return { type: 'escape', source: 'keyboard' };
  if (key === '?' && !event.altKey && !primary)
    return { type: 'open-help', source: 'keyboard' };
  if (key.toLowerCase() === 'c' && !event.altKey && !primary)
    return { type: 'toggle-chrome', source: 'keyboard' };
  if (event.altKey || primary) return null;
  if (key === 'ArrowRight')
    return {
      type: 'navigate',
      direction: navigationForSide('right', resolved(progression)),
      source: 'keyboard',
    };
  if (key === 'ArrowLeft')
    return {
      type: 'navigate',
      direction: navigationForSide('left', resolved(progression)),
      source: 'keyboard',
    };
  if (key === 'PageDown' || (key === ' ' && !event.shiftKey))
    return { type: 'navigate', direction: 'forward', source: 'keyboard' };
  if (key === 'PageUp' || (key === ' ' && event.shiftKey))
    return { type: 'navigate', direction: 'backward', source: 'keyboard' };
  return null;
}

export function commandForWheel(
  deltaY: number,
  modified: boolean,
): ReaderCommand | null {
  if (!Number.isFinite(deltaY) || deltaY === 0) return null;
  if (modified)
    return { type: 'font-step', delta: deltaY < 0 ? 1 : -1, source: 'wheel' };
  return {
    type: 'navigate',
    direction: deltaY > 0 ? 'forward' : 'backward',
    source: 'wheel',
  };
}

export function commandForClickZone(
  clientX: number,
  width: number,
  ratio: number,
  progression: PageProgressionDirection,
): ReaderCommand | null {
  if (!(width > 0)) return null;
  const edge = Math.max(0.05, Math.min(0.45, ratio));
  if (clientX <= width * edge)
    return {
      type: 'navigate',
      direction: navigationForSide('left', resolved(progression)),
      source: 'click-zone',
    };
  if (clientX >= width * (1 - edge))
    return {
      type: 'navigate',
      direction: navigationForSide('right', resolved(progression)),
      source: 'click-zone',
    };
  return null;
}

export function commandForPageClick(
  clientX: number,
  width: number,
  ratio: number,
  progression: PageProgressionDirection,
  edgeNavigation: boolean,
): ReaderCommand | null {
  if (!(width > 0) || !Number.isFinite(clientX)) return null;
  const navigation = commandForClickZone(clientX, width, ratio, progression);
  if (navigation) return edgeNavigation ? navigation : null;
  return { type: 'toggle-chrome', source: 'center-tap' };
}

export function commandForSwipe(
  deltaX: number,
  threshold: number,
  progression: PageProgressionDirection,
): ReaderCommand | null {
  const distance = Math.abs(deltaX);
  if (distance < Math.max(16, threshold)) return null;
  // Finger moves left -> reveal content from physical right; finger moves right -> from left.
  const side = deltaX < 0 ? 'right' : 'left';
  return {
    type: 'navigate',
    direction: navigationForSide(side, resolved(progression)),
    source: 'swipe',
  };
}

function resolved(progression: PageProgressionDirection): 'ltr' | 'rtl' {
  return progression === 'rtl' ? 'rtl' : 'ltr';
}
