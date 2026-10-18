import type { TextDirection, WritingMode } from '../../publication';
import type { XmlElementNode } from '../../xml';

export interface PresentationInspection {
  readonly writingMode?: WritingMode;
  readonly direction?: TextDirection;
  readonly legacyWritingMode: boolean;
}

interface CascadeCandidate<T> {
  readonly value: T;
  readonly legacy: boolean;
  readonly rank: number;
  readonly specificity: number;
  readonly order: number;
}

interface Declaration {
  readonly value: string;
  readonly important: boolean;
}

interface ElementIdentity {
  readonly tag: string;
  readonly id?: string;
  readonly classes: ReadonlySet<string>;
}

const RANK_RULE = 0;
const RANK_INLINE = 1;
const RANK_IMPORTANT_RULE = 2;
const RANK_IMPORTANT_INLINE = 3;

/**
 * Resolve the small CSS subset needed before the first rendition plan. This is
 * intentionally limited to presentation declarations that reach html/body.
 */
export function inspectPresentation(
  html: XmlElementNode,
  body: XmlElementNode,
  stylesheets: readonly string[],
): PresentationInspection {
  let writingMode: CascadeCandidate<WritingMode> | undefined;
  let direction: CascadeCandidate<TextDirection> | undefined;
  let order = 0;

  const consider = (
    declarations: ReadonlyMap<string, Declaration>,
    rank: number,
    importantRank: number,
    specificity: number,
  ): void => {
    order += 1;
    const mode = writingModeFromDeclarations(declarations);
    if (mode.value) {
      writingMode = winningCandidate(writingMode, {
        value: mode.value,
        legacy: mode.legacy,
        rank: mode.important ? importantRank : rank,
        specificity,
        order,
      });
    }

    const declaration = declarations.get('direction');
    const value = declaration?.value.trim().toLowerCase();
    if (value === 'ltr' || value === 'rtl') {
      direction = winningCandidate(direction, {
        value,
        legacy: false,
        rank: declaration?.important ? importantRank : rank,
        specificity,
        order,
      });
    }
  };

  // A dir attribute is a presentational hint and loses to every CSS declaration.
  for (const element of [html, body]) {
    const value = element.attributes.dir?.trim().toLowerCase();
    if (value !== 'ltr' && value !== 'rtl') continue;
    order += 1;
    direction = winningCandidate(direction, {
      value,
      legacy: false,
      rank: -1,
      specificity: 0,
      order,
    });
  }

  const htmlIdentity = elementIdentity(html, 'html');
  const elementChains: readonly (readonly ElementIdentity[])[] = [
    [htmlIdentity],
    [htmlIdentity, elementIdentity(body, 'body')],
  ];

  for (const css of stylesheets) {
    for (const rule of cssRules(css)) {
      let specificity = -1;
      for (const selector of rule.selectors) {
        if (!elementChains.some((chain) => selectorMatches(selector, chain)))
          continue;
        specificity = Math.max(specificity, selectorSpecificity(selector));
      }
      if (specificity >= 0) {
        consider(
          parseDeclarations(rule.block),
          RANK_RULE,
          RANK_IMPORTANT_RULE,
          specificity,
        );
      }
    }
  }

  // Inline styles are considered last so source order resolves equal precedence.
  for (const element of [html, body]) {
    consider(
      parseDeclarations(element.attributes.style ?? ''),
      RANK_INLINE,
      RANK_IMPORTANT_INLINE,
      0,
    );
  }

  return {
    ...(writingMode ? { writingMode: writingMode.value } : {}),
    ...(direction ? { direction: direction.value } : {}),
    legacyWritingMode: writingMode?.legacy ?? false,
  };
}

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '');
}

function winningCandidate<T>(
  current: CascadeCandidate<T> | undefined,
  next: CascadeCandidate<T>,
): CascadeCandidate<T> {
  if (!current) return next;
  if (next.rank !== current.rank)
    return next.rank > current.rank ? next : current;
  if (next.specificity !== current.specificity) {
    return next.specificity > current.specificity ? next : current;
  }
  return next.order >= current.order ? next : current;
}

function selectorSpecificity(selector: string): number {
  const source = selector.trim();
  const ids = source.match(/#[\w-]+/gu)?.length ?? 0;
  const classes =
    source.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/gu)?.length ?? 0;
  const types =
    (source.match(/(?:^|[\s>+~])[A-Za-z][\w-]*/gu)?.length ?? 0) +
    (source.match(/::[\w-]+/gu)?.length ?? 0);
  return ids * 10_000 + classes * 100 + types;
}

function elementIdentity(
  element: XmlElementNode,
  tag: string,
): ElementIdentity {
  return {
    tag,
    ...(element.attributes.id ? { id: element.attributes.id } : {}),
    classes: new Set(
      (element.attributes.class ?? '').split(/\s+/u).filter(Boolean),
    ),
  };
}

/** Match a selector against the html/body ancestor chain used by preflight. */
function selectorMatches(
  selectorSource: string,
  chain: readonly ElementIdentity[],
): boolean {
  const selector = selectorSource
    .trim()
    .replace(/:root\b/giu, 'html')
    .replace(/::?[\w-]+(?:\([^)]*\))?/gu, '');

  // html and body are never siblings.
  if (/[+~]/u.test(selector)) return false;

  const steps: { readonly compound: string; readonly child: boolean }[] = [];
  let child = false;
  for (const token of selector.split(/\s*(>)\s*|\s+/u)) {
    if (!token) continue;
    if (token === '>') {
      child = true;
      continue;
    }
    steps.push({ compound: token, child: steps.length > 0 && child });
    child = false;
  }
  if (steps.length === 0) return false;

  let chainIndex = chain.length - 1;
  if (!compoundMatches(steps.at(-1)!.compound, chain[chainIndex]!))
    return false;

  for (let stepIndex = steps.length - 1; stepIndex > 0; stepIndex -= 1) {
    const ancestor = steps[stepIndex - 1]!.compound;
    if (steps[stepIndex]!.child) {
      chainIndex -= 1;
      if (chainIndex < 0 || !compoundMatches(ancestor, chain[chainIndex]!))
        return false;
      continue;
    }

    let matchIndex = -1;
    for (
      let candidateIndex = chainIndex - 1;
      candidateIndex >= 0;
      candidateIndex -= 1
    ) {
      if (compoundMatches(ancestor, chain[candidateIndex]!)) {
        matchIndex = candidateIndex;
        break;
      }
    }
    if (matchIndex < 0) return false;
    chainIndex = matchIndex;
  }
  return true;
}

function compoundMatches(compound: string, target: ElementIdentity): boolean {
  const tag = /^([A-Za-z][\w-]*)/u.exec(compound)?.[1];
  if (tag && tag.toLowerCase() !== target.tag) return false;

  for (const classMatch of compound.matchAll(/\.([\w-]+)/gu)) {
    if (!target.classes.has(classMatch[1]!)) return false;
  }

  const id = /#([\w-]+)/u.exec(compound)?.[1];
  if (id && id !== target.id) return false;
  return Boolean(
    tag || compound.includes('.') || compound.includes('#') || compound === '*',
  );
}

/** Walk balanced blocks without promoting declarations from print-only at-rules. */
function cssRules(
  css: string,
): readonly { selectors: readonly string[]; block: string }[] {
  const rules: { selectors: string[]; block: string }[] = [];

  const visit = (source: string): void => {
    let cursor = 0;
    while (cursor < source.length) {
      const open = indexOfBrace(source, cursor);
      if (open < 0) break;
      const close = matchingBrace(source, open);
      if (close < 0) break;

      const preamble = source.slice(cursor, open);
      const head = preamble.slice(preamble.lastIndexOf(';') + 1).trim();
      const block = source.slice(open + 1, close);
      cursor = close + 1;
      if (!head) continue;

      if (head.startsWith('@')) {
        if (atRuleAppliesToScreen(head)) visit(block);
        continue;
      }

      rules.push({
        selectors: head
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        block,
      });
    }
  };

  visit(stripCssComments(css));
  return rules;
}

function atRuleAppliesToScreen(head: string): boolean {
  const name = /^@([\w-]+)/u.exec(head)?.[1]?.toLowerCase();
  if (
    name === 'supports' ||
    name === 'layer' ||
    name === 'container' ||
    name === 'scope'
  ) {
    return true;
  }
  if (name !== 'media') return false;

  const query = head.slice(name.length + 1).toLowerCase();
  if (/\bnot\s+(?:print|speech)\b/u.test(query)) return true;
  return (
    !/\b(?:print|speech)\b/u.test(query) || /\b(?:screen|all)\b/u.test(query)
  );
}

function indexOfBrace(source: string, from: number): number {
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'") {
      index = endOfString(source, index);
      continue;
    }
    if (char === '{') return index;
  }
  return -1;
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'") {
      index = endOfString(source, index);
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && (depth -= 1) === 0) return index;
  }
  return -1;
}

function endOfString(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index;
  }
  return source.length;
}

function parseDeclarations(block: string): Map<string, Declaration> {
  const declarations = new Map<string, Declaration>();
  for (const part of block.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;

    const name = part.slice(0, colon).trim().toLowerCase();
    const rawValue = part.slice(colon + 1);
    const important = /!important\s*$/iu.test(rawValue);
    const value = rawValue.replace(/!important\s*$/iu, '').trim();
    if (name && value) declarations.set(name, { value, important });
  }
  return declarations;
}

function writingModeFromDeclarations(
  declarations: ReadonlyMap<string, Declaration>,
): { value?: WritingMode; legacy: boolean; important: boolean } {
  const standard = declarations.get('writing-mode');
  const standardValue = normalizeWritingMode(standard?.value);
  if (standardValue) {
    return {
      value: standardValue,
      legacy: false,
      important: standard?.important ?? false,
    };
  }

  for (const name of ['-epub-writing-mode', '-webkit-writing-mode']) {
    const declaration = declarations.get(name);
    const value = normalizeWritingMode(declaration?.value);
    if (value)
      return { value, legacy: true, important: declaration!.important };
  }
  return { legacy: false, important: false };
}

function normalizeWritingMode(
  value: string | undefined,
): WritingMode | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'horizontal-tb' ||
    normalized === 'vertical-rl' ||
    normalized === 'vertical-lr'
    ? normalized
    : undefined;
}
