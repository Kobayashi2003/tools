import { FullscreenIcon } from './reader-icons';
import type { EpubReaderFullscreenController } from './use-epub-reader-fullscreen';

export interface EpubReaderFullscreenButtonProps {
  readonly controller: EpubReaderFullscreenController;
  readonly className?: string;
  readonly enterLabel?: string;
  readonly exitLabel?: string;
  readonly shortLabel?: string;
}

export function EpubReaderFullscreenButton({
  controller,
  className = 'epub-reader-shell__tool is-secondary epub-reader-shell__fullscreen',
  enterLabel = 'Enter full screen',
  exitLabel = 'Exit full screen',
  shortLabel = 'Full screen',
}: EpubReaderFullscreenButtonProps) {
  const label = controller.active ? exitLabel : enterLabel;
  return (
    <button
      className={className}
      type="button"
      disabled={!controller.supported}
      aria-label={label}
      aria-pressed={controller.active}
      title={label}
      onClick={() => void controller.toggle()}
    >
      <FullscreenIcon active={controller.active} />
      <span>{controller.active ? exitLabel : shortLabel}</span>
    </button>
  );
}
