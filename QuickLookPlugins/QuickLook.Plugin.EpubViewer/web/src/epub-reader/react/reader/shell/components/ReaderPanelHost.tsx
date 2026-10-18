import { useRef, type PointerEvent } from 'react';
import type { ReaderShortcutGroup } from '../../../../core';
import { CloseIcon } from '../../../chrome/reader-icons';
import type { ReaderSurfaceController } from '../use-reader-surface-controller';
import { useReaderUiConfiguration } from '../../../configuration/context';
import { useEpubReaderContext } from '../../context';
import type {
  ReaderToolContext,
  ReaderToolId,
  ReaderToolModule,
} from '../../../tools/model';
import type { EpubSource } from '../../../state/model';
import {
  ReaderToolBoundary,
  ReaderToolContent,
  ReaderToolModuleIcon,
} from '../../../tools/ReaderToolBoundary';

interface ReaderPanelHostProps {
  readonly source: EpubSource;
  readonly panel: ReaderToolId | null;
  readonly panelId: string;
  readonly panelTitleId: string;
  readonly compactLayout: boolean;
  readonly closing: boolean;
  readonly panelRef: ReaderSurfaceController['panelRef'];
  readonly shellRef: { readonly current: HTMLDivElement | null };
  readonly shortcutGroups?: readonly ReaderShortcutGroup[];
  readonly tools: readonly ReaderToolModule[];
  readonly onShowSurface: ReaderSurfaceController['show'];
  readonly onClose: ReaderSurfaceController['close'];
}

const SHEET_DISMISS_DISTANCE_PX = 80;

/** Renders registered tool content while the Shell owns the panel lifecycle. */
export function ReaderPanelHost({
  source,
  panel,
  panelId,
  panelTitleId,
  compactLayout,
  closing,
  panelRef,
  shellRef,
  shortcutGroups,
  tools,
  onShowSurface,
  onClose,
}: ReaderPanelHostProps) {
  const reader = useEpubReaderContext();
  const { messages } = useReaderUiConfiguration();
  const sheetDrag = useRef<{ id: number; y: number; dy: number } | null>(null);
  if (!panel) return null;
  const activeTool = tools.find((tool) => tool.id === panel);
  if (!activeTool) return null;
  const openMarkEditor: ReaderToolContext['openMarkEditor'] = (
    mark,
    trigger,
  ) => {
    const shellBounds = shellRef.current?.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    onShowSurface({
      kind: 'mark',
      source,
      activation: {
        mark,
        anchor: {
          x:
            triggerBounds.left +
            triggerBounds.width / 2 -
            (shellBounds?.left ?? 0),
          y: triggerBounds.bottom - (shellBounds?.top ?? 0),
        },
        returnFocus: trigger,
      },
    });
  };
  // On compact layouts the panel is a bottom sheet: dragging its header down
  // past a threshold dismisses it, as the grab handle suggests.
  const endSheetDrag = (
    event: PointerEvent<HTMLElement>,
    cancelled: boolean,
  ) => {
    const drag = sheetDrag.current;
    if (drag?.id !== event.pointerId) return;
    sheetDrag.current = null;
    const sheet = panelRef.current;
    if (sheet) {
      sheet.style.transform = '';
      sheet.style.transition = '';
    }
    if (!cancelled && drag.dy > SHEET_DISMISS_DISTANCE_PX) onClose();
  };
  const sheetHandlers = compactLayout
    ? {
        onPointerDown: (event: PointerEvent<HTMLElement>) => {
          if (event.button !== 0 || (event.target as Element).closest('button'))
            return;
          sheetDrag.current = { id: event.pointerId, y: event.clientY, dy: 0 };
          event.currentTarget.setPointerCapture(event.pointerId);
        },
        onPointerMove: (event: PointerEvent<HTMLElement>) => {
          const drag = sheetDrag.current;
          const sheet = panelRef.current;
          if (drag?.id !== event.pointerId || !sheet) return;
          drag.dy = Math.max(0, event.clientY - drag.y);
          sheet.style.transition = 'none';
          sheet.style.transform = `translateY(${drag.dy}px)`;
        },
        onPointerUp: (event: PointerEvent<HTMLElement>) =>
          endSheetDrag(event, false),
        onPointerCancel: (event: PointerEvent<HTMLElement>) =>
          endSheetDrag(event, true),
        onLostPointerCapture: (event: PointerEvent<HTMLElement>) =>
          endSheetDrag(event, true),
      }
    : {};
  return (
    <aside
      id={panelId}
      key="reader-panel"
      ref={panelRef}
      className={`epub-reader-shell__panel${closing ? ' is-closing' : ''}`}
      role={compactLayout ? 'dialog' : undefined}
      aria-modal={compactLayout ? 'true' : undefined}
      aria-labelledby={panelTitleId}
      tabIndex={-1}
    >
      <header className="epub-reader-shell__panel-head" {...sheetHandlers}>
        <div className="epub-reader-shell__panel-context">
          <span className="epub-reader-shell__panel-icon">
            <ReaderToolModuleIcon tool={activeTool} />
          </span>
          <div>
            <strong id={panelTitleId}>{activeTool.label}</strong>
            <span>{activeTool.description}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onClose()}
          aria-label={messages.closePanel(activeTool.label)}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="epub-reader-shell__panel-content">
        <ReaderToolBoundary
          resetKey={activeTool}
          fallback={<p role="alert">{messages.actionFailed}</p>}
        >
          <ReaderToolContent
            tool={activeTool}
            context={{ reader, shortcutGroups, openMarkEditor }}
          />
        </ReaderToolBoundary>
      </div>
    </aside>
  );
}
