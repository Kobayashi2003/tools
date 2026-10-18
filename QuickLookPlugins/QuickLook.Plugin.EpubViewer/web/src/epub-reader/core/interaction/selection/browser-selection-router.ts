import type { Publication } from '../../epub/publication';
import type { RendererContentDocument } from '../../presentation/renderer';
import type { ReaderSelection } from './model';
import {
  captureReaderSelection,
  getDocumentSelection,
  textFragmentRectangles,
} from './selection';

export interface ReaderSelectionAnchor {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface ReaderSelectionActivation {
  readonly selection: ReaderSelection;
  readonly anchor: ReaderSelectionAnchor;
  readonly focusToolbar: boolean;
  readonly returnFocus: HTMLElement;
}

/** Observes native selections inside isolated publication documents. */
export class BrowserReaderSelectionRouter {
  private readonly cleanups = new Map<Document, () => void>();
  private lastPolledSelectionKey = '';
  private disposed = false;

  constructor(
    private readonly publication: Publication,
    private readonly container: HTMLElement,
    private readonly onChange: (
      activation: ReaderSelectionActivation | null,
    ) => void,
  ) {}

  syncDocuments(contexts: readonly RendererContentDocument[]): void {
    this.assertAlive();
    const live = new Set(contexts.map((context) => context.document));
    let removed = false;
    for (const [document, cleanup] of this.cleanups) {
      if (!live.has(document)) {
        cleanup();
        this.cleanups.delete(document);
        removed = true;
      }
    }
    if (removed) {
      this.lastPolledSelectionKey = '';
      this.publish(null);
    }
    for (const context of contexts) {
      if (this.cleanups.has(context.document)) continue;
      this.cleanups.set(context.document, this.attach(context));
    }
  }

  /** Fallback for XML browsing contexts that omit selectionchange events. */
  pollDocuments(contexts: readonly RendererContentDocument[]): void {
    this.assertAlive();
    for (const context of contexts) {
      const native = getDocumentSelection(context.document);
      const text =
        native && !native.isCollapsed ? native.toString().trim() : '';
      if (!text || !native?.rangeCount) continue;
      const selection = captureReaderSelection(
        context,
        this.publication,
        native,
      );
      if (!selection || selection.collapsed) continue;
      const key = selectionKey(selection);
      if (key === this.lastPolledSelectionKey) return;
      const rectangle = selectionRectangle(native.getRangeAt(0), native);
      if (!rectangle) continue;
      this.lastPolledSelectionKey = key;
      this.publish(
        activationForRectangle(
          selection,
          rectangle,
          context.surfaceElement,
          context.document,
          this.container,
          Boolean(
            (context.document.activeElement as HTMLElement | null)
              ?.isContentEditable,
          ),
        ),
      );
      return;
    }
    if (this.lastPolledSelectionKey) {
      this.lastPolledSelectionKey = '';
      this.publish(null);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
    this.lastPolledSelectionKey = '';
  }

  private attach(context: RendererContentDocument): () => void {
    const document = context.document;
    const win = document.defaultView;
    let pointerActive = false;
    let timer: number | null = null;
    let focusRequested = false;
    const clearTimer = () => {
      if (timer != null) win?.clearTimeout(timer);
      timer = null;
    };
    const emit = () => {
      timer = null;
      const selection = captureReaderSelection(context, this.publication);
      const native = getDocumentSelection(document);
      if (
        !selection ||
        selection.collapsed ||
        !selection.text.trim() ||
        !native?.rangeCount
      ) {
        focusRequested = false;
        this.publish(null);
        return;
      }
      const rectangle = selectionRectangle(native.getRangeAt(0), native);
      if (!rectangle) return;
      const activation = activationForRectangle(
        selection,
        rectangle,
        context.surfaceElement,
        document,
        this.container,
        focusRequested,
      );
      focusRequested = false;
      this.publish(activation);
    };
    const schedule = (focusToolbar = false) => {
      focusRequested ||= focusToolbar;
      clearTimer();
      timer = win?.setTimeout(emit, 45) ?? null;
      if (!win) queueMicrotask(emit);
    };
    const onPointerDown = () => {
      pointerActive = true;
      clearTimer();
      this.publish(null);
    };
    const onPointerUp = () => {
      pointerActive = false;
      schedule(false);
    };
    const onPointerCancel = () => {
      pointerActive = false;
    };
    const onSelectionChange = () => {
      if (!pointerActive) schedule(false);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (
        event.shiftKey ||
        getDocumentSelection(document)?.isCollapsed === false
      )
        schedule(true);
    };
    const onScroll = () => this.publish(null);

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerCancel, true);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('scroll', onScroll, true);
    win?.addEventListener('pointerup', onPointerUp, true);
    win?.addEventListener('keyup', onKeyUp, true);
    win?.addEventListener('selectionchange', onSelectionChange);
    return () => {
      clearTimer();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerCancel, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('scroll', onScroll, true);
      win?.removeEventListener('pointerup', onPointerUp, true);
      win?.removeEventListener('keyup', onKeyUp, true);
      win?.removeEventListener('selectionchange', onSelectionChange);
    };
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new Error('BrowserReaderSelectionRouter has been disposed.');
  }

  private publish(activation: ReaderSelectionActivation | null): void {
    if (!activation) this.lastPolledSelectionKey = '';
    this.onChange(activation);
  }
}

function selectionRectangle(
  range: Range,
  selection: Selection,
): DOMRect | null {
  const rectangles = textFragmentRectangles(range).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  const focusAtStart =
    selection.focusNode === range.startContainer &&
    selection.focusOffset === range.startOffset;
  return (
    (focusAtStart ? rectangles[0] : rectangles.at(-1)) ??
    (range.getBoundingClientRect().width > 0
      ? range.getBoundingClientRect()
      : null)
  );
}

function selectionKey(selection: ReaderSelection): string {
  const point = (locator: ReaderSelection['range']['start']) =>
    `${locator.href}:${locator.locations.cfi ?? ''}:${locator.locations.fragment ?? ''}:${locator.locations.progression ?? ''}`;
  return `${point(selection.range.start)}>${point(selection.range.end)}:${selection.text}`;
}

function activationForRectangle(
  selection: ReaderSelection,
  rectangle: DOMRect,
  surface: HTMLElement,
  document: Document,
  container: HTMLElement,
  focusToolbar: boolean,
): ReaderSelectionActivation {
  const surfaceRect = surface.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const viewportWidth =
    document.defaultView?.innerWidth ||
    surface.clientWidth ||
    surfaceRect.width;
  const viewportHeight =
    document.defaultView?.innerHeight ||
    surface.clientHeight ||
    surfaceRect.height;
  const scaleX = surfaceRect.width / Math.max(1, viewportWidth);
  const scaleY = surfaceRect.height / Math.max(1, viewportHeight);
  const offsetX = surfaceRect.left - containerRect.left;
  const offsetY = surfaceRect.top - containerRect.top;
  return Object.freeze({
    selection,
    anchor: Object.freeze({
      left: offsetX + rectangle.left * scaleX,
      top: offsetY + rectangle.top * scaleY,
      right: offsetX + rectangle.right * scaleX,
      bottom: offsetY + rectangle.bottom * scaleY,
    }),
    focusToolbar,
    returnFocus: surface,
  });
}
