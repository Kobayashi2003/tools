import type { SemanticTextProjection, SemanticTextSegment } from './model';

import {
  isSemanticBlockElementName,
  isSemanticExcludedElementName,
} from './policy';

/**
 * Project publisher DOM into the semantic reading text used by search and
 * resilient locator fallbacks. Ruby annotations are deliberately excluded from
 * the primary channel: <ruby>現実<rt>げんじつ</rt></ruby> projects as "現実".
 * Inline element boundaries never invent whitespace; block boundaries do.
 */
export function buildSemanticTextProjection(
  document: Document,
  root: Element = document.body ?? document.documentElement,
): SemanticTextProjection {
  const segments: SemanticTextSegment[] = [];
  let text = '';

  const appendSeparator = () => {
    if (!text || /\s$/u.test(text)) return;
    text += '\n';
  };

  const visit = (node: Node, hidden = false): void => {
    if (node.nodeType === 3) {
      const value = node as Text;
      if (hidden || !isSemanticTextNode(value)) return;
      const normalized = normalizeTextNode(value.data);
      if (!normalized.text) return;
      const start = text.length;
      text += normalized.text;
      segments.push({
        start,
        end: text.length,
        node: value,
        sourceBoundaries: normalized.sourceBoundaries,
      });
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const local = element.localName.toLowerCase();
    const nextHidden = hidden || isElementExcluded(element);
    if (nextHidden) return;
    const block = isSemanticBlockElementName(local);
    if (block) appendSeparator();
    for (const child of Array.from(element.childNodes)) visit(child, false);
    if (block) appendSeparator();
  };

  visit(root);
  // Trim synthetic edge separators without invalidating segment offsets at the
  // beginning (appendSeparator never adds one before actual text).
  text = text.replace(/\s+$/u, '');
  return { text, segments };
}

export function isSemanticTextNode(node: Text): boolean {
  if (!node.data) return false;
  let element = node.parentElement;
  while (element) {
    if (isElementExcluded(element)) return false;
    element = element.parentElement;
  }
  return true;
}

export function isRubyAnnotationNode(node: Node): boolean {
  let element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  while (element) {
    const local = element.localName.toLowerCase();
    if (local === 'rt' || local === 'rp') return true;
    element = element.parentElement;
  }
  return false;
}

function isElementExcluded(element: Element): boolean {
  const local = element.localName.toLowerCase();
  if (isSemanticExcludedElementName(local)) return true;
  return (
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true'
  );
}

function normalizeTextNode(source: string): {
  text: string;
  sourceBoundaries: number[];
} {
  let text = '';
  const sourceBoundaries: number[] = [0];
  let inWhitespace = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (/\s/u.test(char)) {
      if (inWhitespace) {
        sourceBoundaries[sourceBoundaries.length - 1] = i + 1;
        continue;
      }
      text += ' ';
      sourceBoundaries.push(i + 1);
      inWhitespace = true;
    } else {
      text += char;
      sourceBoundaries.push(i + 1);
      inWhitespace = false;
    }
  }
  return { text, sourceBoundaries };
}
