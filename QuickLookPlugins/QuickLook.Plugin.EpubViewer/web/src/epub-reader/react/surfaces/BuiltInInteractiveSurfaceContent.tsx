import { EpubMarkPopoverContent } from '../overlays/EpubMarkPopover';
import { EpubSelectionToolbarContent } from '../overlays/EpubSelectionToolbar';
import type { ReaderSurfaceRendererContext } from './model';

export function BuiltInSelectionSurface({
  context,
}: {
  readonly context: ReaderSurfaceRendererContext<'selection'>;
}) {
  return (
    <EpubSelectionToolbarContent
      activation={context.surface.activation}
      reader={context.reader}
      onDismiss={(withFocus) => {
        context.reader.clearSelection();
        context.close(withFocus);
      }}
      onSaved={context.showSaved}
      onModeChange={context.setMode}
    />
  );
}

export function BuiltInMarkSurface({
  context,
}: {
  readonly context: ReaderSurfaceRendererContext<'mark'>;
}) {
  return (
    <EpubMarkPopoverContent
      activation={context.surface.activation}
      reader={context.reader}
      onClose={context.close}
      onChanged={(message) => context.showFeedback(message, 'success')}
    />
  );
}
