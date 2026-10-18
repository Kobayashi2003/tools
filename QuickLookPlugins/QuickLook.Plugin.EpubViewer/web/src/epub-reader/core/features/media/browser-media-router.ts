import type { RendererContentDocument } from '../../presentation/renderer';
import type { ReaderImageActivation, ReaderImageTrigger } from './model';

export const IMAGE_VIEWER_ATTRIBUTE = 'data-epub-image-viewer';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

/**
 * Adds host-owned image inspection without rewriting publication structure.
 *
 * A single click or tap stays ordinary reading input (page turns, controls),
 * so an illustration is never enlarged by accident. The viewer opens on a
 * double-click, a touch long-press, or Enter on a focused image.
 */
export class BrowserPublicationMediaRouter {
  private readonly cleanups = new Map<Document, () => void>();

  constructor(
    private readonly onImage: (activation: ReaderImageActivation) => void,
  ) {}

  syncDocuments(contexts: readonly RendererContentDocument[]): void {
    const live = new Set(contexts.map((context) => context.document));
    for (const [document, cleanup] of this.cleanups) {
      if (!live.has(document)) {
        cleanup();
        this.cleanups.delete(document);
      }
    }
    for (const context of contexts) {
      if (this.cleanups.has(context.document)) continue;
      this.cleanups.set(context.document, this.attach(context.document));
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
  }

  private attach(document: Document): () => void {
    const enhanced = collectViewableImages(document);
    // Read authored text before the accessible name below is added, so the
    // viewer never titles an image with the reader's own label.
    const altText = new Map(enhanced.map((image) => [image, imageAlt(image)]));
    const records = enhanced.map((image) => ({
      image,
      tabIndex: image.getAttribute('tabindex'),
      role: image.getAttribute('role'),
      ariaLabel: image.getAttribute('aria-label'),
    }));
    for (const image of enhanced) {
      image.setAttribute(IMAGE_VIEWER_ATTRIBUTE, 'true');
      if (!image.hasAttribute('tabindex')) image.setAttribute('tabindex', '0');
      if (!image.hasAttribute('role')) image.setAttribute('role', 'button');
      if (!image.hasAttribute('aria-label')) {
        const alt = altText.get(image) ?? '';
        image.setAttribute(
          'aria-label',
          alt ? `Enlarge image: ${alt}` : 'Enlarge publication image',
        );
      }
    }

    const activate = (target: EventTarget | null): boolean => {
      const image = closestViewableImage(target);
      if (!image) return false;
      const src = imageSource(image);
      if (!src) return false;
      const caption = image
        .closest('figure')
        ?.querySelector('figcaption')
        ?.textContent?.replace(/\s+/gu, ' ')
        .trim();
      const size = intrinsicSize(image);
      this.onImage({
        src,
        alt: altText.get(image) ?? '',
        ...(caption ? { caption } : {}),
        ...(size ? { intrinsicWidth: size.width } : {}),
        ...(size ? { intrinsicHeight: size.height } : {}),
        trigger: image,
      });
      return true;
    };

    const onDoubleClick = (event: Event) => {
      const click = event as MouseEvent;
      if (click.button !== 0 || hasModifier(click) || !activate(click.target))
        return;
      click.preventDefault();
      click.stopImmediatePropagation();
    };

    const onKeyDown = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Enter' || !activate(key.target)) return;
      key.preventDefault();
      key.stopImmediatePropagation();
    };

    // Touch long-press. The click that ends a recognised press is swallowed so
    // it cannot also turn the page underneath the opened viewer.
    let press: {
      id: number;
      x: number;
      y: number;
      timer: ReturnType<typeof setTimeout>;
    } | null = null;
    let swallowClick = false;
    const win = document.defaultView;
    const cancelPress = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    const onPointerDown = (event: Event) => {
      const pointer = event as PointerEvent;
      cancelPress();
      swallowClick = false;
      if (pointer.pointerType !== 'touch' || !pointer.isPrimary) return;
      const target = pointer.target;
      if (!closestViewableImage(target)) return;
      press = {
        id: pointer.pointerId,
        x: pointer.clientX,
        y: pointer.clientY,
        timer: setTimeout(() => {
          press = null;
          if (!activate(target)) return;
          swallowClick = true;
          win?.getSelection?.()?.removeAllRanges();
        }, LONG_PRESS_MS),
      };
    };
    const onPointerMove = (event: Event) => {
      const pointer = event as PointerEvent;
      if (
        press?.id === pointer.pointerId &&
        Math.hypot(pointer.clientX - press.x, pointer.clientY - press.y) >
          LONG_PRESS_SLOP_PX
      )
        cancelPress();
    };
    const onPointerEnd = (event: Event) => {
      if (press?.id === (event as PointerEvent).pointerId) cancelPress();
    };
    const onClick = (event: Event) => {
      // Assistive technology activates the image's button role with a
      // synthesized click (detail 0); pointer clicks stay page input.
      const activated =
        !swallowClick &&
        (event as MouseEvent).detail === 0 &&
        activate(event.target);
      if (!swallowClick && !activated) return;
      swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onContextMenu = (event: Event) => {
      // Suppress the native image callout that a long-press would also raise.
      if (press || swallowClick) event.preventDefault();
    };

    const listeners: [string, (event: Event) => void][] = [
      ['dblclick', onDoubleClick],
      ['keydown', onKeyDown],
      ['pointerdown', onPointerDown],
      ['pointermove', onPointerMove],
      ['pointerup', onPointerEnd],
      ['pointercancel', onPointerEnd],
      ['click', onClick],
      ['contextmenu', onContextMenu],
    ];
    for (const [type, listener] of listeners)
      document.addEventListener(type, listener, true);
    return () => {
      cancelPress();
      for (const [type, listener] of listeners)
        document.removeEventListener(type, listener, true);
      for (const record of records) {
        const { image } = record;
        image.removeAttribute(IMAGE_VIEWER_ATTRIBUTE);
        restoreAttribute(image, 'tabindex', record.tabIndex);
        restoreAttribute(image, 'role', record.role);
        restoreAttribute(image, 'aria-label', record.ariaLabel);
      }
    };
  }
}

/**
 * HTML images and SVG `<image>` elements, the latter being how most
 * pre-paginated comics and Japanese light novels wrap full-page artwork.
 * Images inside links keep the link behaviour; decorative images are skipped.
 */
function collectViewableImages(document: Document): ReaderImageTrigger[] {
  const html = Array.from(document.images) as ReaderImageTrigger[];
  const svg = Array.from(
    document.getElementsByTagNameNS(SVG_NAMESPACE, 'image'),
  ) as ReaderImageTrigger[];
  return [...html, ...svg].filter((image) => {
    const role = image.getAttribute('role')?.toLowerCase();
    return (
      !image.closest('a') &&
      image.getAttribute('aria-hidden') !== 'true' &&
      role !== 'presentation' &&
      role !== 'none' &&
      imageSource(image) !== ''
    );
  });
}

function closestViewableImage(
  target: EventTarget | null,
): ReaderImageTrigger | null {
  if (!target || typeof target !== 'object') return null;
  const node = target as Node;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const direct = element?.closest(`[${IMAGE_VIEWER_ATTRIBUTE}]`);
  if (direct) return direct as ReaderImageTrigger;
  // A click on an SVG wrapper around a single image belongs to that image.
  const svg = element?.closest('svg');
  const images = svg?.querySelectorAll(`[${IMAGE_VIEWER_ATTRIBUTE}]`);
  return images?.length === 1 ? (images[0] as ReaderImageTrigger) : null;
}

function imageSource(image: ReaderImageTrigger): string {
  if (isHtmlImage(image)) return image.currentSrc || image.src || '';
  const href =
    image.getAttribute('href') ??
    image.getAttributeNS(XLINK_NAMESPACE, 'href') ??
    '';
  if (!href) return '';
  try {
    return new URL(href, image.ownerDocument.baseURI).href;
  } catch {
    return href;
  }
}

function imageAlt(image: ReaderImageTrigger): string {
  if (isHtmlImage(image)) return image.alt.trim();
  return (
    image.getAttribute('aria-label') ??
    image.querySelector('title')?.textContent ??
    image.closest('svg')?.querySelector('title')?.textContent ??
    ''
  ).trim();
}

function intrinsicSize(
  image: ReaderImageTrigger,
): { width: number; height: number } | null {
  if (isHtmlImage(image))
    return image.naturalWidth > 0 && image.naturalHeight > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : null;
  // Percentage sizes describe the wrapper, not the artwork; the viewer then
  // measures the loaded image instead.
  const width = absoluteLength(image.getAttribute('width'));
  const height = absoluteLength(image.getAttribute('height'));
  return width > 0 && height > 0 ? { width, height } : null;
}

function absoluteLength(value: string | null): number {
  const match = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/u.exec(value ?? '');
  return match ? Number(match[1]) : 0;
}

function isHtmlImage(image: ReaderImageTrigger): image is HTMLImageElement {
  return image.localName.toLowerCase() === 'img' && 'naturalWidth' in image;
}

function hasModifier(event: MouseEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

function restoreAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  if (value == null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}
