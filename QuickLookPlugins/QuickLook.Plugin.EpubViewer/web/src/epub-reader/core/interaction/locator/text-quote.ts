import type { LocatorTextContext } from '../../epub/publication';
import { buildSemanticTextProjection } from '../../epub/text';
import type { DomPoint } from './model';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export function createTextQuote(
  document: Document,
  point: DomPoint,
  extent = 48,
): LocatorTextContext | undefined {
  const index = buildSemanticTextProjection(document);
  const absolute = absoluteTextOffset(index, point);
  if (absolute == null || index.text.length === 0) return undefined;
  const size = Math.max(8, extent);
  const highlight = index.text.slice(absolute, absolute + size);
  if (!highlight.trim()) return undefined;
  return {
    before: index.text.slice(Math.max(0, absolute - size), absolute),
    highlight,
    after: index.text.slice(
      absolute + highlight.length,
      absolute + highlight.length + size,
    ),
  };
}

export function resolveTextQuote(
  document: Document,
  quote: LocatorTextContext,
): DomPoint | null {
  const highlight = quote.highlight;
  if (!highlight) return null;
  const index = buildSemanticTextProjection(document);
  if (!index.text) return null;

  const candidates: number[] = [];
  let from = 0;
  while (from <= index.text.length) {
    const found = index.text.indexOf(highlight, from);
    if (found < 0) break;
    candidates.push(found);
    from = found + Math.max(1, highlight.length);
  }
  if (candidates.length === 0) return null;

  const best = candidates
    .map((offset) => ({
      offset,
      score: quoteScore(index.text, offset, highlight.length, quote),
    }))
    .sort((a, b) => b.score - a.score || a.offset - b.offset)[0]!;
  return pointAtAbsoluteOffset(index, best.offset);
}

function absoluteTextOffset(
  index: ReturnType<typeof buildSemanticTextProjection>,
  point: DomPoint,
): number | null {
  if (point.node.nodeType === TEXT_NODE) {
    const entry = index.segments.find(
      (candidate) => candidate.node === point.node,
    );
    if (!entry) return null;
    const sourceOffset = Math.max(
      0,
      Math.min(point.offset, entry.node.data.length),
    );
    let normalized = 0;
    for (let i = 0; i < entry.sourceBoundaries.length; i += 1) {
      if ((entry.sourceBoundaries[i] ?? 0) <= sourceOffset) normalized = i;
      else break;
    }
    return entry.start + Math.min(normalized, entry.end - entry.start);
  }
  if (point.node.nodeType === ELEMENT_NODE) {
    const element = point.node as Element;
    const childOffset = Math.max(
      0,
      Math.min(point.offset, element.childNodes.length),
    );
    const child =
      element.childNodes[childOffset] ?? element.childNodes[childOffset - 1];
    if (!child) return null;
    const first = index.segments.find(
      (entry) =>
        child === entry.node ||
        (child.nodeType === ELEMENT_NODE &&
          (child as Element).contains(entry.node)),
    );
    return first?.start ?? null;
  }
  return null;
}

function pointAtAbsoluteOffset(
  index: ReturnType<typeof buildSemanticTextProjection>,
  offset: number,
): DomPoint | null {
  const entry =
    index.segments.find(
      (candidate) => offset >= candidate.start && offset <= candidate.end,
    ) ?? index.segments.at(-1);
  if (!entry) return null;
  const normalizedOffset = Math.max(
    0,
    Math.min(entry.end - entry.start, offset - entry.start),
  );
  const sourceOffset =
    entry.sourceBoundaries[normalizedOffset] ?? entry.node.data.length;
  return {
    node: entry.node,
    offset: Math.max(0, Math.min(entry.node.data.length, sourceOffset)),
  };
}

function quoteScore(
  text: string,
  offset: number,
  length: number,
  quote: LocatorTextContext,
): number {
  let score = 0;
  if (quote.before)
    score += commonSuffix(
      text.slice(Math.max(0, offset - quote.before.length), offset),
      quote.before,
    );
  if (quote.after)
    score += commonPrefix(
      text.slice(offset + length, offset + length + quote.after.length),
      quote.after,
    );
  return score;
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}
