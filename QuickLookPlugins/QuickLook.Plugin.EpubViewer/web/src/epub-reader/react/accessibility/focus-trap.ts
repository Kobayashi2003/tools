const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'a[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Install the reader's consistent, live-querying Tab loop for a modal region. */
export function installFocusTrap(container: HTMLElement): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const elements = focusableElements(container);
    const first = elements[0];
    const last = elements[elements.length - 1];
    const active = container.ownerDocument.activeElement;
    if (!first || !last) {
      event.preventDefault();
      container.focus();
    } else if (active === container || !container.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKeyDown);
  return () => container.removeEventListener('keydown', onKeyDown);
}

export function focusFirst(container: HTMLElement): void {
  (focusableElements(container)[0] ?? container).focus({ preventScroll: true });
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(isRenderedFocusable);
}

function isRenderedFocusable(element: HTMLElement): boolean {
  if (element.tabIndex < 0) return false;
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (
    style?.display === 'none' ||
    style?.visibility === 'hidden' ||
    style?.visibility === 'collapse'
  )
    return false;
  // querySelectorAll includes descendants of display:none ancestors. Such an
  // element ignores focus(), which can leave focus behind an inert modal layer.
  return element.getClientRects().length > 0;
}
