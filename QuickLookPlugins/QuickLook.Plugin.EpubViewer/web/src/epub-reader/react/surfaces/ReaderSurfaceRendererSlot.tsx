import type { ReactNode } from 'react';
import { ReaderContributionBoundary } from '../composition/ReaderContributionBoundary';
import type {
  ReaderSurfaceRenderer,
  ReaderSurfaceRendererContext,
  ReaderSurfaceRendererKind,
} from './model';

interface ReaderSurfaceRendererSlotProps<K extends ReaderSurfaceRendererKind> {
  readonly renderer: ReaderSurfaceRenderer<K>;
  readonly context: ReaderSurfaceRendererContext<K>;
  readonly fallback: ReactNode;
  readonly resetKey?: string;
}

function ReaderSurfaceRendererContent<K extends ReaderSurfaceRendererKind>({
  renderer,
  context,
}: Omit<ReaderSurfaceRendererSlotProps<K>, 'fallback'>) {
  return renderer.render(context);
}

/** Calls the selected provider below an error boundary so synchronous render failures are contained. */
export function ReaderSurfaceRendererSlot<K extends ReaderSurfaceRendererKind>({
  renderer,
  context,
  fallback,
  resetKey,
}: ReaderSurfaceRendererSlotProps<K>) {
  return (
    <ReaderContributionBoundary
      resetKey={resetKey}
      resetVersion={renderer}
      fallback={fallback}
    >
      <ReaderSurfaceRendererContent renderer={renderer} context={context} />
    </ReaderContributionBoundary>
  );
}
