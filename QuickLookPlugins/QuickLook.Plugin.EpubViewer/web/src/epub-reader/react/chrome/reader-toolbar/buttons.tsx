import type { MouseEvent, MutableRefObject } from 'react';
import type { ReaderToolId, ReaderToolModule } from '../../tools/model';
import { ReaderToolModuleIcon } from '../../tools/ReaderToolBoundary';
import { HistoryIcon } from '../reader-icons';

export function HistoryButton({
  direction,
  enabled,
  label,
  shortLabel,
  onActivate,
}: {
  readonly direction: 'back' | 'forward';
  readonly enabled: boolean;
  readonly label?: string;
  readonly shortLabel?: string;
  readonly onActivate: () => void;
}) {
  const back = direction === 'back';
  const resolvedLabel =
    label ??
    (back
      ? 'Back to previous reading location'
      : 'Forward to next reading location');

  return (
    <button
      className={`epub-reader-shell__tool is-secondary epub-reader-shell__history is-${direction}`}
      type="button"
      disabled={!enabled}
      aria-label={resolvedLabel}
      aria-keyshortcuts={back ? 'Alt+ArrowLeft' : 'Alt+ArrowRight'}
      title={`${resolvedLabel} (${back ? 'Alt+Left' : 'Alt+Right'})`}
      onClick={onActivate}
    >
      <HistoryIcon direction={direction} />
      <span>{shortLabel ?? (back ? 'Back' : 'Forward')}</span>
    </button>
  );
}

interface PanelButtonProps {
  readonly key?: string;
  readonly item: ReaderToolModule;
  readonly panel: ReaderToolId | null;
  readonly panelId: string;
  readonly buttonRefs: MutableRefObject<Map<ReaderToolId, HTMLButtonElement>>;
  readonly onToggle: (panel: ReaderToolId, origin: HTMLButtonElement) => void;
  readonly secondary?: boolean;
}

export function PanelButton({
  item,
  panel,
  panelId,
  buttonRefs,
  onToggle,
  secondary = false,
}: PanelButtonProps) {
  return (
    <button
      className={`epub-reader-shell__tool${secondary ? ' is-secondary' : ''}`}
      type="button"
      ref={(element: HTMLButtonElement | null) => {
        if (element) buttonRefs.current.set(item.id, element);
        else buttonRefs.current.delete(item.id);
      }}
      aria-pressed={panel === item.id}
      aria-expanded={panel === item.id}
      aria-controls={panel === item.id ? panelId : undefined}
      aria-keyshortcuts={item.ariaKeyShortcuts}
      aria-label={item.label}
      title={item.label}
      onClick={(event: MouseEvent<HTMLButtonElement>) =>
        onToggle(item.id, event.currentTarget)
      }
    >
      <ReaderToolModuleIcon tool={item} />
      <span>{item.shortLabel}</span>
    </button>
  );
}
