import {
  commandForKey,
  commandForPageClick,
  commandForSwipe,
  commandForWheel,
} from './commands';
import { ReaderInputBindingRegistry } from './input-map';
import type { ReaderInputBinding, ReaderInputMap } from './model';

export const BUILT_IN_READER_INPUT_BINDINGS: readonly ReaderInputBinding[] =
  Object.freeze([
    {
      id: 'reader.input.keyboard-defaults',
      kinds: ['keyboard'],
      map: (signal, state) =>
        signal.kind === 'keyboard'
          ? commandForKey(signal, state.pageProgression)
          : null,
      shortcuts: [
        {
          label: 'Navigation',
          items: [
            { keys: ['←', '→'], action: 'Turn the physical page' },
            { keys: ['PgUp', 'PgDn'], action: 'Previous or next page' },
            { keys: ['⇧ Space', 'Space'], action: 'Previous or next page' },
            { keys: ['Alt ←', 'Alt →'], action: 'Reading history' },
          ],
        },
        {
          label: 'Reader tools',
          items: [
            { keys: ['Ctrl / ⌘ F'], action: 'Search this book' },
            { keys: ['C'], action: 'Show or hide controls' },
            { keys: ['?'], action: 'Keyboard help' },
            { keys: ['Esc'], action: 'Close the active tool' },
          ],
        },
      ],
    },
    {
      id: 'reader.input.wheel-defaults',
      kinds: ['wheel'],
      map: (signal) =>
        signal.kind === 'wheel'
          ? commandForWheel(signal.deltaY, signal.modified)
          : null,
      shortcuts: [
        {
          label: 'Reader tools',
          items: [{ keys: ['Ctrl / ⌘ Wheel'], action: 'Adjust text size' }],
        },
      ],
    },
    {
      id: 'reader.input.page-click-defaults',
      kinds: ['page-click'],
      map: (signal, state) =>
        signal.kind === 'page-click'
          ? commandForPageClick(
              signal.clientX,
              signal.width,
              signal.ratio,
              state.pageProgression,
              signal.edgeNavigation,
            )
          : null,
      shortcuts: [
        {
          label: 'Images',
          items: [
            { keys: ['Double-click'], action: 'Enlarge an image' },
            { keys: ['Long-press'], action: 'Enlarge an image on touch' },
            { keys: ['Enter'], action: 'Enlarge the focused image' },
          ],
        },
      ],
    },
    {
      id: 'reader.input.swipe-defaults',
      kinds: ['swipe'],
      map: (signal, state) =>
        signal.kind === 'swipe'
          ? commandForSwipe(
              signal.deltaX,
              signal.threshold,
              state.pageProgression,
            )
          : null,
    },
  ]);

export function createDefaultReaderInputMap(): ReaderInputMap {
  return new ReaderInputBindingRegistry(
    BUILT_IN_READER_INPUT_BINDINGS,
  ).createMap();
}
