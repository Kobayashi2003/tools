import type { Publication } from '../../epub/publication';
import type { RendererContentDocument } from '../../presentation/renderer';
import {
  resolveLocatorRangeInDocument,
  textFragmentRectangles,
} from '../../interaction/selection';
import type {
  DecorationTheme,
  ReaderDecoration,
  ReaderDecorationActivation,
} from './model';
import { DEFAULT_DECORATION_THEME } from './model';

const OVERLAY_ATTR = 'data-epub-reader-decoration-overlay';

/**
 * Non-invasive highlight renderer. It never wraps or rewrites publication text;
 * rectangles are painted in a fixed overlay and can be regenerated after reflow.
 */
export class DomDecorationLayer {
  private readonly entries = new Map<string, ReaderDecoration>();
  private overlay: HTMLElement | null = null;
  private disposeScroll: (() => void) | null = null;
  private frameCancel: (() => void) | null = null;
  private hitBoxes: readonly {
    readonly decoration: ReaderDecoration;
    readonly rectangle: DOMRect;
  }[] = [];
  private disposeActivation: (() => void) | null = null;

  constructor(
    private readonly context: RendererContentDocument,
    private readonly publication: Publication,
    private readonly theme: DecorationTheme = DEFAULT_DECORATION_THEME,
    private readonly onActivate?: (
      activation: ReaderDecorationActivation,
    ) => boolean,
  ) {
    this.installRefreshHooks();
    this.installActivation();
  }

  setDecorations(decorations: readonly ReaderDecoration[]): void {
    this.entries.clear();
    for (const decoration of decorations)
      this.entries.set(decoration.id, decoration);
    this.refresh();
  }

  refresh(): void {
    this.cancelFrame();
    const win = this.context.document.defaultView;
    if (!win) return;
    let frame = 0;
    frame = win.requestAnimationFrame(() => {
      this.frameCancel = null;
      this.paint();
    });
    this.frameCancel = () => win.cancelAnimationFrame(frame);
  }

  dispose(): void {
    this.cancelFrame();
    this.disposeScroll?.();
    this.disposeScroll = null;
    this.disposeActivation?.();
    this.disposeActivation = null;
    this.overlay?.remove();
    this.overlay = null;
    this.entries.clear();
    this.hitBoxes = [];
  }

  private paint(): void {
    const document = this.context.document;
    const root = document.documentElement;
    if (!root) return;
    const overlay = this.ensureOverlay();
    overlay.replaceChildren();
    const hitBoxes: { decoration: ReaderDecoration; rectangle: DOMRect }[] = [];

    for (const decoration of this.entries.values()) {
      const range = resolveLocatorRangeInDocument(
        this.context,
        this.publication,
        decoration.range,
      );
      if (!range) continue;
      const writingMode = rangeWritingMode(range);
      for (const rect of textFragmentRectangles(range)) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        const box = document.createElement('span');
        box.dataset.epubDecorationId = decoration.id;
        box.dataset.epubDecorationIntent = decoration.intent;
        box.setAttribute('aria-hidden', 'true');
        const style = box.style;
        style.position = 'fixed';
        style.left = `${rect.left}px`;
        style.top = `${rect.top}px`;
        style.width = `${rect.width}px`;
        style.height = `${rect.height}px`;
        style.pointerEvents = 'none';
        style.boxSizing = 'border-box';
        style.borderRadius = '0.12em';
        const semantic = decoration.color
          ? this.theme.semanticColors[decoration.color]
          : this.theme.semanticColors.yellow;
        if (decoration.intent === 'underline') {
          if (writingMode === 'vertical-lr')
            style.borderRight = `2px solid ${semantic}`;
          else if (writingMode.startsWith('vertical'))
            style.borderLeft = `2px solid ${semantic}`;
          else style.borderBottom = `2px solid ${semantic}`;
        } else if (decoration.intent === 'strikethrough') {
          if (writingMode.startsWith('vertical')) {
            style.width = '2px';
            style.left = `${rect.left + rect.width / 2}px`;
          } else {
            style.height = '2px';
            style.top = `${rect.top + rect.height / 2}px`;
          }
          style.background = semantic;
        } else if (decoration.intent === 'outline') {
          style.border = `1.5px solid ${semantic}`;
        } else {
          style.background =
            decoration.intent === 'search-current'
              ? this.theme.searchCurrentFill
              : decoration.intent === 'search'
                ? this.theme.searchFill
                : semantic;
        }
        overlay.appendChild(box);
        hitBoxes.push({ decoration, rectangle: rect });
      }
      range.detach?.();
    }
    this.hitBoxes = hitBoxes;
  }

  private ensureOverlay(): HTMLElement {
    if (this.overlay?.isConnected) return this.overlay;
    const document = this.context.document;
    const overlay = document.createElement('div');
    overlay.setAttribute(OVERLAY_ATTR, 'true');
    overlay.setAttribute('aria-hidden', 'true');
    const style = overlay.style;
    style.position = 'fixed';
    style.inset = '0';
    style.pointerEvents = 'none';
    style.zIndex = '2147483646';
    style.overflow = 'visible';
    style.contain = 'layout style paint';
    (document.documentElement ?? document.body).appendChild(overlay);
    this.overlay = overlay;
    return overlay;
  }

  private installRefreshHooks(): void {
    const document = this.context.document;
    const win = document.defaultView;
    if (!win) return;
    const refresh = () => this.refresh();
    document.addEventListener('scroll', refresh, true);
    win.addEventListener('resize', refresh);
    this.disposeScroll = () => {
      document.removeEventListener('scroll', refresh, true);
      win.removeEventListener('resize', refresh);
    };
  }

  private installActivation(): void {
    if (!this.onActivate) return;
    const listener = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const hit = [...this.hitBoxes]
        .reverse()
        .find((candidate) =>
          containsPoint(candidate.rectangle, event.clientX, event.clientY),
        );
      if (!hit) return;
      const handled = this.onActivate?.({
        decoration: hit.decoration,
        clientX: event.clientX,
        clientY: event.clientY,
        context: this.context,
      });
      if (!handled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    this.context.document.addEventListener('click', listener, true);
    this.disposeActivation = () =>
      this.context.document.removeEventListener('click', listener, true);
  }

  private cancelFrame(): void {
    this.frameCancel?.();
    this.frameCancel = null;
  }
}

function rangeWritingMode(range: Range): string {
  const element =
    range.startContainer.nodeType === 1
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const view = element?.ownerDocument.defaultView;
  return element && view ? view.getComputedStyle(element).writingMode : '';
}

function containsPoint(rectangle: DOMRect, x: number, y: number): boolean {
  return (
    x >= rectangle.left &&
    x <= rectangle.right &&
    y >= rectangle.top &&
    y <= rectangle.bottom
  );
}
