import { ReaderContributionBoundary } from '../composition/ReaderContributionBoundary';
import type { ReaderToolContext, ReaderToolModule } from './model';

export { ReaderContributionBoundary as ReaderToolBoundary };

export function ReaderToolContent({
  tool,
  context,
}: {
  readonly tool: ReaderToolModule;
  readonly context: ReaderToolContext;
}) {
  return tool.render(context);
}

function ReaderToolIconContent({ tool }: { readonly tool: ReaderToolModule }) {
  return tool.renderIcon();
}

export function ReaderToolModuleIcon({
  tool,
}: {
  readonly tool: ReaderToolModule;
}) {
  return (
    <ReaderContributionBoundary
      resetKey={tool}
      fallback={
        <span className="epub-reader-tool-icon" aria-hidden="true">
          •
        </span>
      }
    >
      <ReaderToolIconContent tool={tool} />
    </ReaderContributionBoundary>
  );
}
