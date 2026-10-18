import type { ResolvedPageProgression } from '../../presentation/rendition';
import type { NavigationDirection } from './model';

/** Map a physical UI side to semantic reading-order navigation. */
export function navigationForSide(
  side: 'left' | 'right',
  progression: ResolvedPageProgression,
): NavigationDirection {
  if (progression === 'rtl') return side === 'left' ? 'forward' : 'backward';
  return side === 'right' ? 'forward' : 'backward';
}
