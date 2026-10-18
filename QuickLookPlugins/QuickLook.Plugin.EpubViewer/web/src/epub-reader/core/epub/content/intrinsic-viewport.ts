import type { IntrinsicViewport } from '../publication';

export interface ViewportDimensionContext {
  readonly deviceWidth: number;
  readonly deviceHeight: number;
}

export function parseViewportMetaContent(
  content: string,
  context?: ViewportDimensionContext,
): IntrinsicViewport | null {
  let width: number | null = null;
  let height: number | null = null;
  let sawWidth = false;
  let sawHeight = false;

  for (const declaration of content.split(/[;,]/)) {
    const eq = declaration.indexOf('=');
    if (eq < 0) continue;
    const name = declaration.slice(0, eq).trim().toLowerCase();
    const raw = declaration
      .slice(eq + 1)
      .trim()
      .toLowerCase();
    if (name === 'width' && !sawWidth) {
      sawWidth = true;
      width = parseViewportDimension(raw, 'width', context);
    }
    if (name === 'height' && !sawHeight) {
      sawHeight = true;
      height = parseViewportDimension(raw, 'height', context);
    }
  }

  return width != null && height != null && width > 0 && height > 0
    ? { width, height }
    : null;
}

export function inspectXhtmlIntrinsicViewport(
  document: Document,
  context?: ViewportDimensionContext,
): IntrinsicViewport | null {
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const metas = Array.from(document.getElementsByTagNameNS(XHTML_NS, 'meta'));
  const viewport = metas.find(
    (meta) =>
      (meta.getAttribute('name') ?? '').trim().toLowerCase() === 'viewport',
  );
  if (!viewport) return null;
  return parseViewportMetaContent(
    viewport.getAttribute('content') ?? '',
    context,
  );
}

export function inspectSvgIntrinsicViewport(
  document: Document,
): IntrinsicViewport | null {
  const root = document.documentElement;
  if (
    !root ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg' ||
    root.localName !== 'svg'
  )
    return null;
  return parseSvgViewBox(root.getAttribute('viewBox'));
}

export function parseSvgViewBox(
  value: string | null,
): IntrinsicViewport | null {
  if (!value) return null;
  const numbers = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    numbers.length !== 4 ||
    numbers.some((number) => !Number.isFinite(number))
  )
    return null;
  const width = numbers[2]!;
  const height = numbers[3]!;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function parseViewportDimension(
  value: string,
  axis: 'width' | 'height',
  context?: ViewportDimensionContext,
): number | null {
  if (value === 'device-width')
    return axis === 'width' && context ? context.deviceWidth : null;
  if (value === 'device-height')
    return axis === 'height' && context ? context.deviceHeight : null;

  // EPUB RS 3.3 recommends using a numeric prefix even when a unit-like suffix
  // makes the authored viewport value formally invalid (for example 500px).
  const match = /^\s*([+]?(?:\d+(?:\.\d*)?|\.\d+))/.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
