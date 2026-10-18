import { useCallback, type KeyboardEvent } from 'react';
import type { ReaderSurfaces } from '../../chrome/reader-surfaces';
import type { EpubReaderHandle } from '../../state/model';
import type { ReaderSurfaceController } from './use-reader-surface-controller';
import type { ReaderToolRegistry } from '../../tools/model';

export function useReaderShellKeyboard(
  reader: EpubReaderHandle,
  surfaces: ReaderSurfaces,
  controller: Pick<ReaderSurfaceController, 'activeElement' | 'show' | 'close'>,
  tools: ReaderToolRegistry,
): (event: KeyboardEvent<HTMLDivElement>) => void {
  return useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target;
      const editable =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (event.key === 'Escape' && surfaces.open) {
        event.preventDefault();
        event.stopPropagation();
        if (surfaces.selection) reader.clearSelection();
        controller.close();
      } else if (
        event.key === '?' &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !editable
      ) {
        event.preventDefault();
        event.stopPropagation();
        const help = tools.forCommand('open-help');
        if (help)
          controller.show({
            kind: 'panel',
            panel: help.id,
            returnFocus: controller.activeElement(),
          });
      }
    },
    [controller, reader, surfaces, tools],
  );
}
