import type { CfiPath, CfiStep, CfiTextAssertion, DomPoint } from '../model';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

export function createContentCfiPath(
  document: Document,
  point: DomPoint,
): CfiPath {
  const root = document.documentElement;
  if (!root) {
    throw new Error(
      'Cannot create a CFI for a document without a root element.',
    );
  }

  let current: Node = point.node;
  const steps: CfiStep[] = [];
  let characterOffset: number | undefined;

  if (isCharacterData(current)) {
    const parent = current.parentNode;
    if (!isElement(parent)) {
      throw new Error('CFI character data must have an element parent.');
    }
    const chunk = characterDataChunk(parent, current);
    steps.unshift({ index: chunk.index });
    characterOffset = clamp(
      point.offset + chunk.offsetBeforeNode,
      0,
      chunk.length,
    );
    current = parent;
  } else if (!isElement(current)) {
    throw new Error('CFI point must target an element or character-data node.');
  }

  while (current !== root) {
    const parent = current.parentNode;
    if (!isElement(parent) || !isElement(current)) {
      throw new Error('CFI target is not contained by the document element.');
    }
    steps.unshift(elementStep(parent, current));
    current = parent;
  }

  if (steps.length === 0) {
    const first = root.children[0];
    steps.push(first ? elementStep(root, first) : { index: 1 });
  }
  return {
    steps,
    ...(characterOffset !== undefined ? { characterOffset } : {}),
  };
}

export function resolveContentCfiPath(
  document: Document,
  path: CfiPath,
): DomPoint {
  const root = document.documentElement;
  if (!root) {
    throw new Error(
      'Cannot resolve a CFI in a document without a root element.',
    );
  }
  let current: Node = root;

  for (let index = 0; index < path.steps.length; index += 1) {
    const step = path.steps[index]!;
    const last = index === path.steps.length - 1;
    if (!isElement(current)) {
      throw new RangeError('CFI attempts to traverse below character data.');
    }

    if (step.index % 2 === 0) {
      const elements = Array.from(current.children);
      if (step.index === 0 || step.index === (elements.length + 1) * 2) {
        if (!last) {
          throw new RangeError(
            'A virtual CFI element can only terminate a point path.',
          );
        }
        return {
          node: current,
          offset: step.index === 0 ? 0 : current.childNodes.length,
        };
      }

      const elementIndex = step.index / 2 - 1;
      let next = elementIndex >= 0 ? elements[elementIndex] : undefined;
      if (step.assertion && next?.id !== step.assertion) {
        // ID assertions can correct a structural path after an authored edit.
        next = document.getElementById(step.assertion) ?? undefined;
      }
      if (!next) {
        throw new RangeError(
          `CFI element step /${step.index} cannot be resolved.`,
        );
      }
      if (last) return { node: next, offset: 0 };
      current = next;
      continue;
    }

    if (!last) {
      throw new RangeError(
        'A character-data CFI step must terminate the content path.',
      );
    }
    return resolveCharacterChunkPoint(
      current,
      step.index,
      path.characterOffset ?? 0,
    );
  }
  return { node: current, offset: 0 };
}

export function matchesTextAssertion(
  document: Document,
  point: DomPoint,
  assertion: CfiTextAssertion,
): boolean {
  const raw = rawTextIndex(document);
  const absolute = rawOffsetForPoint(raw, point);
  if (absolute == null) return false;
  const before = normalizeCfiText(raw.text.slice(0, absolute));
  const after = normalizeCfiText(raw.text.slice(absolute));
  return (
    (!assertion.before ||
      before.endsWith(normalizeCfiText(assertion.before))) &&
    (!assertion.after || after.startsWith(normalizeCfiText(assertion.after)))
  );
}

export function correctPointFromTextAssertion(
  document: Document,
  original: DomPoint | null,
  assertion: CfiTextAssertion,
): DomPoint | null {
  const stream = normalizedTextStream(document);
  const before = assertion.before ? normalizeCfiText(assertion.before) : '';
  const after = assertion.after ? normalizeCfiText(assertion.after) : '';
  if (!before && !after) return null;

  const raw = rawTextIndex(document);
  const rawOriginal = original ? (rawOffsetForPoint(raw, original) ?? 0) : 0;
  const approximate = normalizeCfiText(raw.text.slice(0, rawOriginal)).length;
  const candidates: number[] = [];
  for (let index = 0; index <= stream.text.length; index += 1) {
    if (before && !stream.text.slice(0, index).endsWith(before)) continue;
    if (after && !stream.text.slice(index).startsWith(after)) continue;
    candidates.push(index);
  }
  if (candidates.length === 0) return null;
  candidates.sort(
    (left, right) =>
      Math.abs(left - approximate) - Math.abs(right - approximate),
  );
  return (
    stream.points[Math.min(candidates[0]!, stream.points.length - 1)] ?? null
  );
}

function elementStep(parent: Element, child: Element): CfiStep {
  const index = Array.from(parent.children).indexOf(child);
  if (index < 0) {
    throw new Error('Element is not a child of its expected parent.');
  }
  return {
    index: (index + 1) * 2,
    ...(child.id ? { assertion: child.id } : {}),
  };
}

function characterDataChunk(
  parent: Element,
  node: Node,
): { index: number; offsetBeforeNode: number; length: number } {
  let elementsBefore = 0;
  let found = false;
  let offsetBeforeNode = 0;
  let length = 0;

  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === ELEMENT_NODE) {
      if (found) break;
      elementsBefore += 1;
      offsetBeforeNode = 0;
      continue;
    }
    if (!isCharacterData(child)) continue;
    if (child === node) found = true;
    if (found) length += child.nodeValue?.length ?? 0;
    else offsetBeforeNode += child.nodeValue?.length ?? 0;
  }
  if (!found) {
    throw new Error('Character-data node does not belong to its parent.');
  }

  length += offsetBeforeNode;
  return { index: elementsBefore * 2 + 1, offsetBeforeNode, length };
}

function resolveCharacterChunkPoint(
  parent: Element,
  oddIndex: number,
  offset: number,
): DomPoint {
  if (oddIndex < 1 || oddIndex % 2 === 0) {
    throw new RangeError(
      'CFI character-data step must be a positive odd integer.',
    );
  }

  const targetChunk = (oddIndex - 1) / 2;
  let elementCount = 0;
  const nodes: Node[] = [];
  let length = 0;
  let insertionOffset = parent.childNodes.length;

  for (
    let childIndex = 0;
    childIndex < parent.childNodes.length;
    childIndex += 1
  ) {
    const child = parent.childNodes[childIndex]!;
    if (child.nodeType === ELEMENT_NODE) {
      if (elementCount === targetChunk && nodes.length === 0) {
        insertionOffset = childIndex;
      }
      elementCount += 1;
      continue;
    }
    if (!isCharacterData(child) || elementCount !== targetChunk) continue;
    if (nodes.length === 0) insertionOffset = childIndex;
    nodes.push(child);
    length += child.nodeValue?.length ?? 0;
  }

  if (offset > length) {
    throw new RangeError(
      'CFI character offset exceeds the referenced character-data chunk.',
    );
  }
  if (nodes.length === 0) return { node: parent, offset: insertionOffset };

  let remaining = offset;
  for (const node of nodes) {
    const nodeLength = node.nodeValue?.length ?? 0;
    if (remaining <= nodeLength) return { node, offset: remaining };
    remaining -= nodeLength;
  }
  const last = nodes.at(-1)!;
  return { node: last, offset: last.nodeValue?.length ?? 0 };
}

interface RawTextEntry {
  readonly node: Node;
  readonly start: number;
  readonly end: number;
}

interface RawTextIndex {
  readonly text: string;
  readonly entries: readonly RawTextEntry[];
}

function rawTextIndex(document: Document): RawTextIndex {
  const root = document.body ?? document.documentElement;
  if (!root) return { text: '', entries: [] };

  const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const entries: RawTextEntry[] = [];
  let text = '';
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.nodeValue ?? '';
    const start = text.length;
    text += value;
    entries.push({ node, start, end: text.length });
  }
  return { text, entries };
}

function rawOffsetForPoint(
  index: RawTextIndex,
  point: DomPoint,
): number | null {
  if (isCharacterData(point.node)) {
    const entry = index.entries.find(
      (candidate) => candidate.node === point.node,
    );
    return entry
      ? entry.start + clamp(point.offset, 0, entry.end - entry.start)
      : null;
  }

  if (!isElement(point.node)) return null;
  const child =
    point.node.childNodes[
      Math.min(point.offset, Math.max(0, point.node.childNodes.length - 1))
    ];
  if (!child) return 0;
  const entry = index.entries.find(
    (candidate) =>
      candidate.node === child ||
      (isElement(child) && child.contains(candidate.node)),
  );
  return entry?.start ?? null;
}

function normalizedTextStream(document: Document): {
  text: string;
  points: DomPoint[];
} {
  const raw = rawTextIndex(document);
  let text = '';
  const points: DomPoint[] = [];
  let inWhitespace = false;

  for (const entry of raw.entries) {
    const value = entry.node.nodeValue ?? '';
    for (let offset = 0; offset < value.length; offset += 1) {
      const character = value[offset]!;
      if (/\s/u.test(character)) {
        if (inWhitespace) continue;
        inWhitespace = true;
        points.push({ node: entry.node, offset });
        text += ' ';
      } else {
        inWhitespace = false;
        points.push({ node: entry.node, offset });
        text += character;
      }
    }
  }

  const last = raw.entries.at(-1);
  points.push(
    last
      ? { node: last.node, offset: last.end - last.start }
      : { node: document.documentElement, offset: 0 },
  );
  return { text, points };
}

function normalizeCfiText(value: string): string {
  return value.replace(/\s+/gu, ' ');
}

function isElement(node: Node | null): node is Element {
  return node?.nodeType === ELEMENT_NODE;
}

function isCharacterData(node: Node): boolean {
  return node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
