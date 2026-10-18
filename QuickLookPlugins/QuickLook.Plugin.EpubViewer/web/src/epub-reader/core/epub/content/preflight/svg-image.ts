import type { IntrinsicViewport } from '../../publication';
import type { XmlElementNode } from '../../xml';

/** Deliberately excludes drawings, text, foreignObject and nested SVG canvases. */
export function inspectSvgImage(svg: XmlElementNode):
  | {
      readonly source: string;
      readonly viewport?: IntrinsicViewport;
    }
  | undefined {
  let image: XmlElementNode | undefined;
  const visit = (node: XmlElementNode): boolean => {
    if (
      node !== svg &&
      !['g', 'a', 'image', 'title', 'desc'].includes(node.localName)
    )
      return false;
    if (node.localName === 'image') {
      if (image) return false;
      image = node;
    }
    return node.children.every(
      (child) => child.type === 'text' || visit(child),
    );
  };
  if (!visit(svg) || !image) return undefined;
  const source = (
    image.attributes.href ?? image.attributes['xlink:href']
  )?.trim();
  if (!source) return undefined;
  const box = svg.attributes.viewBox
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (
    box?.length === 4 &&
    box.every(Number.isFinite) &&
    box[2]! > 0 &&
    box[3]! > 0
  )
    return { source, viewport: { width: box[2]!, height: box[3]! } };
  const dimension = (value: string | undefined): number =>
    value && /^\d+(?:\.\d+)?(?:px)?$/u.test(value.trim())
      ? Number.parseFloat(value)
      : 0;
  const width = dimension(svg.attributes.width);
  const height = dimension(svg.attributes.height);
  return {
    source,
    ...(width > 0 && height > 0 ? { viewport: { width, height } } : {}),
  };
}
