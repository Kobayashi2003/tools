import type { LocatorDomPoint } from '../../epub/publication';
import type { DomPoint } from './model';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

export function createDomPath(
  document: Document,
  point: DomPoint,
): LocatorDomPoint | undefined {
  const root = document.documentElement;
  if (!root) return undefined;
  let node: Node | null = point.node;
  const path: number[] = [];
  while (node && node !== root) {
    const parent: Node | null = node.parentNode;
    if (!parent) return undefined;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
    node = parent;
  }
  if (node !== root) return undefined;
  return {
    path,
    offset: point.offset,
    nodeType:
      point.node.nodeType === TEXT_NODE ||
      point.node.nodeType === CDATA_SECTION_NODE
        ? 'text'
        : 'element',
  };
}

export function resolveDomPath(
  document: Document,
  point: LocatorDomPoint,
): DomPoint | null {
  let node: Node | undefined = document.documentElement ?? undefined;
  if (!node) return null;
  for (const index of point.path) {
    if (!Number.isInteger(index) || index < 0) return null;
    node = node.childNodes[index];
    if (!node) return null;
  }
  const maximum =
    node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE
      ? (node.nodeValue?.length ?? 0)
      : node.nodeType === ELEMENT_NODE
        ? node.childNodes.length
        : 0;
  return { node, offset: Math.max(0, Math.min(maximum, point.offset)) };
}
