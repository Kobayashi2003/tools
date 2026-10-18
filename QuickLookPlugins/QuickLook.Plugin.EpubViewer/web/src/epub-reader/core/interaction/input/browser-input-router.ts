import type { RendererContentDocument } from '../../presentation/renderer';
import { touchNavigationAllows } from './commands';
import { createDefaultReaderInputMap } from './built-in-bindings';
import {
  DEFAULT_READER_INPUT_POLICY,
  type ReaderCommand,
  type ReaderInputDispatcher,
  type ReaderInputMap,
  type ReaderInputPolicy,
  type ReaderInputSignal,
  type ReaderInputState,
} from './model';

interface PointerStart {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly target: EventTarget | null;
  readonly nativeScrollbar: boolean;
  /** Scroll positions of the overflow regions under the pointer at press time. */
  readonly scrollOwners: readonly ScrollMark[];
}

interface ScrollMark {
  readonly element: Element;
  readonly left: number;
  readonly top: number;
}

/**
 * Overlay scrollbars (Windows 11 Fluent, macOS, mobile) take no layout space,
 * so `clientHeight` cannot reveal them. Treat this band along the scrolling
 * edges of a scrollable region as its scrollbar.
 */
const OVERLAY_SCROLLBAR_BAND_PX = 16;

/**
 * A mouse click on an enlargeable image waits this long before acting as page
 * input, because a double-click on the same image opens the image viewer.
 */
const IMAGE_DOUBLE_CLICK_MS = 280;
const IMAGE_VIEWER_SELECTOR = '[data-epub-image-viewer]';

/**
 * DOM adapter only. It produces semantic commands and never calls a renderer
 * directly. Text selection and interactive publication controls take priority.
 */
export class BrowserReaderInputRouter {
  private readonly policy: ReaderInputPolicy;
  private readonly cleanups: (() => void)[] = [];
  private readonly documentCleanups = new Map<Document, () => void>();
  private lastWheelAt = -Infinity;
  private pointer: PointerStart | null = null;
  private suppressClickUntil = -Infinity;
  private pendingImageClick: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly hostElement: HTMLElement,
    private readonly state: () => ReaderInputState,
    private readonly dispatcher: ReaderInputDispatcher,
    policy: Partial<ReaderInputPolicy> = {},
    private readonly onError: (
      error: unknown,
      command: ReaderCommand | null,
    ) => void = () => {},
    private readonly inputMap: ReaderInputMap = createDefaultReaderInputMap(),
  ) {
    this.policy = { ...DEFAULT_READER_INPUT_POLICY, ...policy };
    // Keyboard events only reach a listener on their own element or an ancestor
    // of it, so the element this router binds to has to be able to hold focus
    // itself. A host that made a *parent* focusable instead would leave the page
    // keys dead: the event would travel up from the parent and never pass here.
    if (!hostElement.hasAttribute?.('tabindex')) hostElement.tabIndex = -1;
    this.attachTarget(hostElement);
    const owner = hostElement.ownerDocument;
    if (owner) this.cleanups.push(this.attachAbandonedFocusFallback(owner));
  }

  /** The element that must hold focus for keyboard reading commands to arrive. */
  get keyboardTarget(): HTMLElement {
    return this.hostElement;
  }

  syncDocuments(contexts: readonly RendererContentDocument[]): void {
    this.assertAlive();
    const live = new Set(contexts.map((context) => context.document));
    for (const [document, cleanup] of this.documentCleanups) {
      if (!live.has(document)) {
        this.pointer = null;
        cleanup();
        this.documentCleanups.delete(document);
      }
    }
    for (const context of contexts) {
      if (this.documentCleanups.has(context.document)) continue;
      this.documentCleanups.set(
        context.document,
        this.attachTarget(context.document, context.surfaceElement),
      );
    }
    this.recaptureAbandonedFocus();
  }

  /**
   * Keyboard events only reach a listener on their own element or an ancestor,
   * and this router listens on the reader surface and on each content document.
   * Nothing else in the reader ever moves focus, so whenever focus ends up on
   * the top-level body every reading key becomes inert -- permanently, because
   * nothing puts it back. That happens on its own: swapping renderers destroys
   * the content document that held focus, and the browser hands focus to the
   * body rather than to the surface the document lived in.
   *
   * Focus is only claimed when it is sitting nowhere. A real control that holds
   * it -- a panel field, a toolbar button -- keeps it.
   */
  private recaptureAbandonedFocus(): void {
    const owner = this.hostElement.ownerDocument;
    if (!owner || !this.focusIsAbandoned(owner)) return;
    this.hostElement.focus?.({ preventScroll: true });
  }

  /** Focus sits on nothing: no element owns it, so no element can receive keys. */
  private focusIsAbandoned(owner: Document): boolean {
    const active = owner.activeElement;
    return !active || active === owner.body || active === owner.documentElement;
  }

  private dispatchKeyCommand(event: Event): void {
    if (!this.policy.keyboard || !this.state().enabled) return;
    const key = event as KeyboardEvent;
    if (isEditableTarget(key.target)) return;
    const command = this.resolve({
      kind: 'keyboard',
      key: key.key,
      ctrlKey: key.ctrlKey,
      metaKey: key.metaKey,
      altKey: key.altKey,
      shiftKey: key.shiftKey,
    });
    if (!command) return;
    if (shouldPreserveNativeSelectionCommand(key)) return;
    key.preventDefault();
    this.send(command);
  }

  /**
   * Last resort for keys pressed while focus is abandoned. Focus can be dropped
   * between the moments this router gets to look at it -- a dialog closing, the
   * host page reassigning it -- and from there no reading key would ever reach
   * a listener again, because nothing would move focus back.
   *
   * Nothing is double-handled: when any element owns focus, including this
   * router's own surface, the event reaches that element's listener and this
   * one declines. It only ever fires for keys that would otherwise be lost.
   */
  private attachAbandonedFocusFallback(owner: Document): () => void {
    const onKeyDown = (event: Event) => {
      if (!this.focusIsAbandoned(owner)) return;
      this.dispatchKeyCommand(event);
      this.recaptureAbandonedFocus();
    };
    owner.addEventListener('keydown', onKeyDown, { passive: false });
    return () => owner.removeEventListener('keydown', onKeyDown);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPendingImageClick();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const cleanup of this.documentCleanups.values()) cleanup();
    this.documentCleanups.clear();
    this.pointer = null;
  }

  private cancelPendingImageClick(): void {
    if (this.pendingImageClick != null) clearTimeout(this.pendingImageClick);
    this.pendingImageClick = null;
  }

  private attachTarget(
    target: EventTarget,
    surfaceElement?: HTMLElement,
  ): () => void {
    const cursorElement = semanticCursorElement(target);
    const originalCursor = cursorElement?.style.cursor ?? '';
    const onKeyDown = (event: Event) => this.dispatchKeyCommand(event);

    const onWheel = (event: Event) => {
      const state = this.state();
      if (!state.enabled) return;
      const wheel = event as WheelEvent;
      const modified = Boolean(wheel.ctrlKey || wheel.metaKey);
      if (modified && !this.policy.ctrlWheelFontSize) return;
      if (!modified && this.policy.wheel !== 'page') return;

      if (!modified) {
        const targetElement = asElement(wheel.target);
        // A document scrolling element is never an ordinary nested overflow
        // region. Paginated renderers use it as their private page transport,
        // while scrolled renditions should retain its native wheel behaviour.
        // Nested overflow regions remain eligible, as does a fixed-layout
        // container outside the iframe.
        const targetDocument = targetElement?.ownerDocument;
        const documentScrollingElement =
          targetDocument?.scrollingElement ?? null;
        const scrollOwner =
          findVerticalScrollOwner(targetElement, documentScrollingElement) ??
          (surfaceElement && state.contentKind === 'fixed-layout'
            ? findVerticalScrollOwner(surfaceElement)
            : null);
        if (scrollOwner && consumeVerticalWheel(scrollOwner, wheel)) {
          if (wheel.cancelable) wheel.preventDefault();
          return;
        }
        if (
          state.presentation === 'scrolled' &&
          !state.wheelBoundaryNavigation
        ) {
          // Keep the complete scroll chain inside the reader. A nested overflow
          // region gets first refusal above; once it reaches an edge, continue
          // on the publication document's scrolling element. Claiming the
          // event even at the document boundary prevents the host page behind
          // the reader from moving.
          if (
            surfaceElement &&
            documentScrollingElement &&
            hasVerticalScrollMetrics(documentScrollingElement)
          ) {
            consumeVerticalWheel(documentScrollingElement, wheel);
          }
          if (wheel.cancelable) wheel.preventDefault();
          return;
        }

        // Paginated and boundary-navigating fixed-layout surfaces own the
        // gesture even when this particular event is below the threshold or is
        // suppressed by the cooldown. Returning without claiming it would hand
        // it back to the browser's native scrolling after all.
        if (wheel.cancelable) wheel.preventDefault();
      }

      if (Math.abs(wheel.deltaY) < this.policy.wheelThreshold) return;
      const now = Date.now();
      if (!modified && now - this.lastWheelAt < this.policy.wheelCooldownMs)
        return;
      const command = this.resolve({
        kind: 'wheel',
        deltaY: wheel.deltaY,
        modified,
      });
      if (!command) return;
      if (!modified) this.lastWheelAt = now;
      if (modified && wheel.cancelable) wheel.preventDefault();
      this.send(command);
    };

    const onClick = (event: Event) => {
      const state = this.state();
      if (!state.enabled) return;
      const click = event as MouseEvent;
      if (Date.now() < this.suppressClickUntil) return;
      if (
        click.button !== 0 ||
        isNativeScrollbarTarget(click) ||
        isInteractivePublicationTarget(click.target) ||
        hasMeaningfulSelection(click.target)
      )
        return;
      const viewport = viewportWidthForTarget(
        target,
        this.hostElement,
        surfaceElement,
      );
      const x = clientXForTarget(
        click,
        target,
        this.hostElement,
        surfaceElement,
      );
      const ratio =
        state.pageTurnZonePercent == null
          ? this.policy.clickZoneRatio
          : state.pageTurnZonePercent / 100;
      const edgeNavigation =
        this.policy.clickZones &&
        state.presentation !== 'scrolled' &&
        touchNavigationAllows(state.touchNavigation, 'tap');
      const command = this.resolve({
        kind: 'page-click',
        clientX: x,
        width: viewport,
        ratio,
        edgeNavigation,
      });
      if (!command) return;
      if (command.type === 'navigate' && click.cancelable)
        click.preventDefault();
      if (isMouseClickOnViewableImage(click)) {
        this.cancelPendingImageClick();
        if (click.detail > 1) return;
        this.pendingImageClick = setTimeout(() => {
          this.pendingImageClick = null;
          if (!this.disposed) this.send(command);
        }, IMAGE_DOUBLE_CLICK_MS);
        return;
      }
      this.send(command);
    };
    const onDoubleClick = () => this.cancelPendingImageClick();

    const onPointerDown = (event: Event) => {
      const state = this.state();
      const pointer = event as PointerEvent;
      this.pointer = null;
      if (!state.enabled || pointer.button !== 0) return;
      // Native scrollbar controls target their owning element, not a button.
      // Remember the whole operation, including a release over page content.
      if (isNativeScrollbarTarget(pointer)) {
        this.pointer = {
          id: pointer.pointerId,
          x: pointer.clientX,
          y: pointer.clientY,
          target: pointer.target,
          nativeScrollbar: true,
          scrollOwners: [],
        };
        this.suppressClickUntil = Date.now() + 450;
        return;
      }
      if (
        !this.policy.swipe ||
        !state.enabled ||
        state.presentation === 'scrolled' ||
        !touchNavigationAllows(state.touchNavigation, 'swipe')
      )
        return;
      if (
        pointer.button !== 0 ||
        isInteractivePublicationTarget(pointer.target)
      )
        return;
      this.pointer = {
        id: pointer.pointerId,
        x: pointer.clientX,
        y: pointer.clientY,
        target: pointer.target,
        nativeScrollbar: false,
        scrollOwners: markScrollOwners(
          pointer.target,
          surfaceElement,
          this.hostElement,
        ),
      };
    };

    const onPointerUp = (event: Event) => {
      const pointer = event as PointerEvent;
      if (
        this.pointer?.id === pointer.pointerId &&
        this.pointer.nativeScrollbar
      ) {
        this.pointer = null;
        this.suppressClickUntil = Date.now() + 450;
        return;
      }
      const state = this.state();
      if (
        !this.pointer ||
        !this.policy.swipe ||
        !state.enabled ||
        state.presentation === 'scrolled' ||
        !touchNavigationAllows(state.touchNavigation, 'swipe')
      ) {
        this.pointer = null;
        return;
      }
      if (pointer.pointerId !== this.pointer.id) return;
      const start = this.pointer;
      this.pointer = null;
      if (hasMeaningfulSelection(pointer.target)) return;
      if (isNativeScrollbarTarget(pointer)) return;
      // A drag that moved an overflow region was a scroll (a scrollbar drag or
      // a pan across an oversized comic page), never a page-turn swipe.
      if (scrollOwnersMoved(start.scrollOwners)) {
        this.suppressClickUntil = Date.now() + 450;
        return;
      }
      const dx = pointer.clientX - start.x;
      const dy = pointer.clientY - start.y;
      if (Math.abs(dx) <= Math.abs(dy) * 1.15) return;
      const command = this.resolve({
        kind: 'swipe',
        deltaX: dx,
        threshold: this.policy.swipeThresholdPx,
      });
      if (!command) return;
      if (pointer.cancelable) pointer.preventDefault();
      this.suppressClickUntil = Date.now() + 450;
      this.send(command);
    };

    const onPointerCancel = () => {
      if (this.pointer?.nativeScrollbar)
        this.suppressClickUntil = Date.now() + 450;
      this.pointer = null;
    };

    const onPointerMove = (event: Event) => {
      if (!cursorElement) return;
      const pointer = event as PointerEvent;
      const state = this.state();
      if (
        (pointer.pointerType && pointer.pointerType !== 'mouse') ||
        !this.policy.clickZones ||
        !state.enabled ||
        state.contentKind !== 'fixed-layout' ||
        state.presentation === 'scrolled' ||
        !touchNavigationAllows(state.touchNavigation, 'tap') ||
        isInteractivePublicationTarget(pointer.target)
      ) {
        cursorElement.style.cursor = originalCursor;
        return;
      }
      const viewport = viewportWidthForTarget(
        target,
        this.hostElement,
        surfaceElement,
      );
      const x = clientXForTarget(
        pointer,
        target,
        this.hostElement,
        surfaceElement,
      );
      const ratio =
        state.pageTurnZonePercent == null
          ? this.policy.clickZoneRatio
          : state.pageTurnZonePercent / 100;
      cursorElement.style.cursor =
        semanticCursorForClickZone(x, viewport, ratio) ?? originalCursor;
    };

    const resetCursor = () => {
      if (cursorElement) cursorElement.style.cursor = originalCursor;
    };

    target.addEventListener('keydown', onKeyDown as EventListener, {
      passive: false,
    });
    target.addEventListener('wheel', onWheel as EventListener, {
      passive: false,
    });
    target.addEventListener('click', onClick as EventListener, {
      passive: false,
    });
    target.addEventListener('dblclick', onDoubleClick, { passive: true });
    target.addEventListener('pointerdown', onPointerDown as EventListener, {
      passive: true,
    });
    target.addEventListener('pointermove', onPointerMove as EventListener, {
      passive: true,
    });
    target.addEventListener('pointerup', onPointerUp as EventListener, {
      passive: false,
    });
    target.addEventListener('pointercancel', onPointerCancel as EventListener, {
      passive: true,
    });
    target.addEventListener('pointerleave', resetCursor as EventListener, {
      passive: true,
    });

    const cleanup = () => {
      target.removeEventListener('keydown', onKeyDown as EventListener);
      target.removeEventListener('wheel', onWheel as EventListener);
      target.removeEventListener('click', onClick as EventListener);
      target.removeEventListener('dblclick', onDoubleClick);
      target.removeEventListener('pointerdown', onPointerDown as EventListener);
      target.removeEventListener('pointermove', onPointerMove as EventListener);
      target.removeEventListener('pointerup', onPointerUp as EventListener);
      target.removeEventListener(
        'pointercancel',
        onPointerCancel as EventListener,
      );
      target.removeEventListener('pointerleave', resetCursor as EventListener);
      resetCursor();
    };
    if (target === this.hostElement) this.cleanups.push(cleanup);
    return cleanup;
  }

  private send(command: ReaderCommand): void {
    try {
      const result = this.dispatcher.dispatch(command);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch((error) =>
          this.onError(error, command),
        );
      }
    } catch (error) {
      this.onError(error, command);
    }
  }

  private resolve(signal: ReaderInputSignal): ReaderCommand | null {
    const resolution = this.inputMap.resolve(signal, this.state());
    for (const failure of resolution.failures)
      this.onError(failure.error, null);
    return resolution.command;
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new Error('BrowserReaderInputRouter has been disposed.');
  }
}

export function semanticCursorForClickZone(
  clientX: number,
  width: number,
  ratio: number,
): 'pointer' | null {
  if (!(width > 0) || !Number.isFinite(clientX)) return null;
  const edge = Math.max(0.05, Math.min(0.45, ratio));
  return clientX <= width * edge || clientX >= width * (1 - edge)
    ? 'pointer'
    : null;
}

function semanticCursorElement(
  target: EventTarget,
): (Element & { style: CSSStyleDeclaration }) | null {
  const element = target as Element;
  if (element.nodeType === 1 && 'style' in element)
    return element as Element & { style: CSSStyleDeclaration };
  const document = target as Document;
  const root = document.documentElement;
  return root && 'style' in root
    ? (root as Element & { style: CSSStyleDeclaration })
    : null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = asElement(target);
  if (!element) return false;
  const local = element.localName.toLowerCase();
  return (
    element.hasAttribute('contenteditable') ||
    ['input', 'textarea', 'select', 'option'].includes(local)
  );
}

export function isInteractivePublicationTarget(
  target: EventTarget | null,
): boolean {
  const element = asElement(target);
  if (!element) return false;
  return (
    element.closest(
      'a, button, input, textarea, select, option, label, summary, audio, video, object, embed, iframe, [controls], [contenteditable], [role="button"]:not([data-epub-image-viewer]), [role="link"]',
    ) != null
  );
}

/** Enlargeable images stay ordinary page input; only mouse clicks wait for a double-click. */
function isMouseClickOnViewableImage(click: MouseEvent): boolean {
  const pointerType = (click as Partial<PointerEvent>).pointerType;
  if (pointerType && pointerType !== 'mouse') return false;
  return asElement(click.target)?.closest(IMAGE_VIEWER_SELECTOR) != null;
}

function hasMeaningfulSelection(target: EventTarget | null): boolean {
  const element = asElement(target);
  const document = element?.ownerDocument;
  const selection = document
    ? ((typeof document.getSelection === 'function'
        ? document.getSelection()
        : null) ?? document.defaultView?.getSelection())
    : null;
  return Boolean(
    selection && !selection.isCollapsed && selection.toString().trim(),
  );
}

function shouldPreserveNativeSelectionCommand(event: KeyboardEvent): boolean {
  return (
    event.shiftKey &&
    (event.key.startsWith('Arrow') ||
      event.key === 'PageUp' ||
      event.key === 'PageDown')
  );
}

function asElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== 'object') return null;
  const node = target as Node;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** Coordinates and metrics stay in the target document's realm, including iframes. */
export function isNativeScrollbarTarget(
  event: Pick<MouseEvent, 'target' | 'clientX' | 'clientY'>,
): boolean {
  const target = event.target as Node | null;
  const document =
    target?.nodeType === 9 ? (target as Document) : target?.ownerDocument;
  const win = document?.defaultView;
  if (!win) return false;

  // The root scrollbar belongs to the viewport; its element rect can move with
  // document scroll and must not be used as the viewport's hit-test rectangle.
  const root = document.documentElement;
  if (
    root &&
    ((win.innerWidth > root.clientWidth &&
      event.clientX >= root.clientWidth &&
      event.clientX < win.innerWidth) ||
      (win.innerHeight > root.clientHeight &&
        event.clientY >= root.clientHeight &&
        event.clientY < win.innerHeight))
  )
    return true;

  let element = asElement(event.target) as HTMLElement | null;
  while (element) {
    if (
      element !== root &&
      element !== document.scrollingElement &&
      element.offsetWidth > 0 &&
      element.offsetHeight > 0
    ) {
      const rect = element.getBoundingClientRect();
      const x =
        ((event.clientX - rect.left) * element.offsetWidth) / rect.width;
      const y =
        ((event.clientY - rect.top) * element.offsetHeight) / rect.height;
      const style = win.getComputedStyle(element);
      const borderLeft = parseFloat(style.borderLeftWidth) || 0;
      const borderRight = parseFloat(style.borderRightWidth) || 0;
      const borderTop = parseFloat(style.borderTopWidth) || 0;
      const borderBottom = parseFloat(style.borderBottomWidth) || 0;
      const inside =
        x >= borderLeft &&
        x < element.offsetWidth - borderRight &&
        y >= borderTop &&
        y < element.offsetHeight - borderBottom;
      if (inside) {
        const scrollsX = /^(auto|scroll|overlay)$/.test(style.overflowX);
        const scrollsY = /^(auto|scroll|overlay)$/.test(style.overflowY);
        const horizontal =
          scrollsX && y >= element.clientTop + element.clientHeight;
        const vertical =
          scrollsY &&
          (x < element.clientLeft ||
            x >= element.clientLeft + element.clientWidth);
        if (horizontal || vertical) return true;
        if (
          style.scrollbarWidth !== 'none' &&
          ((scrollsX &&
            element.scrollWidth > element.clientWidth + 1 &&
            element.offsetHeight - borderTop - borderBottom <=
              element.clientHeight &&
            y >=
              element.offsetHeight -
                borderBottom -
                OVERLAY_SCROLLBAR_BAND_PX) ||
            (scrollsY &&
              element.scrollHeight > element.clientHeight + 1 &&
              element.offsetWidth - borderLeft - borderRight <=
                element.clientWidth &&
              (style.direction === 'rtl'
                ? x < borderLeft + OVERLAY_SCROLLBAR_BAND_PX
                : x >=
                  element.offsetWidth -
                    borderRight -
                    OVERLAY_SCROLLBAR_BAND_PX)))
        )
          return true;
      }
    }
    element = element.parentElement;
  }
  return false;
}

/**
 * Record nested overflow regions under a pointer: its own ancestors, plus the
 * host-realm containers around the surface for a press inside a content
 * document. A document's scrolling element is excluded because paginated
 * renderers use it as their private page transport.
 */
function markScrollOwners(
  target: EventTarget | null,
  surfaceElement: HTMLElement | undefined,
  hostElement: HTMLElement,
): ScrollMark[] {
  const marks: ScrollMark[] = [];
  const visit = (start: Element | null, stop: Element | null) => {
    const scrollingElement = start?.ownerDocument.scrollingElement ?? null;
    for (
      let element = start;
      element && element !== scrollingElement;
      element = element.parentElement
    ) {
      if (
        element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1
      )
        marks.push({
          element,
          left: element.scrollLeft,
          top: element.scrollTop,
        });
      if (element === stop) break;
    }
  };
  visit(asElement(target), null);
  if (
    surfaceElement &&
    asElement(target)?.ownerDocument !== hostElement.ownerDocument
  )
    visit(surfaceElement, hostElement);
  return marks;
}

function scrollOwnersMoved(marks: readonly ScrollMark[]): boolean {
  return marks.some(
    ({ element, left, top }) =>
      Math.abs(element.scrollLeft - left) >= 1 ||
      Math.abs(element.scrollTop - top) >= 1,
  );
}

function viewportWidthForTarget(
  target: EventTarget,
  fallback: HTMLElement,
  surfaceElement?: HTMLElement,
): number {
  if ((target as Document).documentElement) {
    // Every document in a synthetic spread is only one leaf. Tap zones belong
    // to the reader viewport, not to each leaf independently; otherwise the
    // visual centre/gutter is simultaneously the right edge of one iframe and
    // the left edge of the other, so a centre tap turns the page.
    if (surfaceElement) return fallback.getBoundingClientRect().width;
    const document = target as Document;
    return (
      document.defaultView?.innerWidth ?? document.documentElement.clientWidth
    );
  }

  return fallback.getBoundingClientRect().width;
}

function clientXForTarget(
  event: MouseEvent,
  target: EventTarget,
  fallback: HTMLElement,
  surfaceElement?: HTMLElement,
): number {
  if ((target as Document).documentElement) {
    if (!surfaceElement) return event.clientX;
    return mapContentClientXToViewport(
      event.clientX,
      surfaceElement.offsetWidth,
      surfaceElement.getBoundingClientRect(),
      fallback.getBoundingClientRect(),
    );
  }
  return event.clientX - fallback.getBoundingClientRect().left;
}

/** Map an iframe-local pointer coordinate into the shared reader viewport. */
export function mapContentClientXToViewport(
  clientX: number,
  surfaceLayoutWidth: number,
  surface: Pick<DOMRect, 'left' | 'width'>,
  viewport: Pick<DOMRect, 'left' | 'width'>,
): number {
  if (
    !Number.isFinite(clientX) ||
    !(surfaceLayoutWidth > 0) ||
    !(surface.width > 0) ||
    !(viewport.width > 0)
  )
    return clientX;
  // A real pointer event inside a transformed iframe reports coordinates in
  // that browsing context's untransformed CSS pixels. Translate through the
  // iframe's visual/layout scale before adding its position in the shared
  // reader viewport. Without this scale, fit-width pages classify their inner
  // half as an outer page-turn edge.
  return (
    surface.left -
    viewport.left +
    (clientX * surface.width) / surfaceLayoutWidth
  );
}

function findVerticalScrollOwner(
  start: Element | null,
  excluded: Element | null = null,
): HTMLElement | null {
  let current: Element | null = start;
  while (current) {
    // Content elements belong to the iframe realm, where `instanceof` against
    // the host window's HTMLElement constructor is false. Scroll metrics are a
    // sufficient structural check and work in both realms.
    if (
      current !== excluded &&
      hasVerticalScrollMetrics(current) &&
      current.scrollHeight > current.clientHeight + 1
    ) {
      const style =
        current.ownerDocument.defaultView?.getComputedStyle(current);
      const overflowY = style?.overflowY ?? 'visible';
      if (
        overflowY === 'auto' ||
        overflowY === 'scroll' ||
        overflowY === 'overlay'
      )
        return current;
    }
    current = current.parentElement;
  }
  return null;
}

function hasVerticalScrollMetrics(element: Element): element is HTMLElement {
  const candidate = element as Partial<HTMLElement>;
  return (
    typeof candidate.scrollTop === 'number' &&
    typeof candidate.scrollHeight === 'number' &&
    typeof candidate.clientHeight === 'number'
  );
}

function consumeVerticalWheel(owner: HTMLElement, event: WheelEvent): boolean {
  const delta = wheelDeltaPixels(event, owner.clientHeight);
  const target = verticalScrollTarget(
    owner.scrollTop,
    owner.scrollHeight - owner.clientHeight,
    delta,
  );
  if (target == null) return false;
  owner.scrollTop = target;
  return true;
}

export function verticalScrollTarget(
  current: number,
  extent: number,
  delta: number,
): number | null {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(extent) ||
    !Number.isFinite(delta) ||
    delta === 0
  )
    return null;
  const maximum = Math.max(0, extent);
  const before = Math.max(0, Math.min(maximum, current));
  const target = Math.max(0, Math.min(maximum, before + delta));
  return Math.abs(target - before) < 0.5 ? null : target;
}

function wheelDeltaPixels(event: WheelEvent, pageSize: number): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * Math.max(1, pageSize);
  return event.deltaY;
}
