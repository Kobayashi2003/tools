export interface LegacyCssNormalizationResult {
  readonly css: string;
  readonly normalizedProperties: readonly string[];
}

const PROPERTY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '-epub-writing-mode': 'writing-mode',
  '-webkit-writing-mode': 'writing-mode',
  '-epub-text-orientation': 'text-orientation',
  '-webkit-text-orientation': 'text-orientation',
  '-epub-text-emphasis-style': 'text-emphasis-style',
  '-webkit-text-emphasis-style': 'text-emphasis-style',
  '-epub-text-emphasis-color': 'text-emphasis-color',
  '-webkit-text-emphasis-color': 'text-emphasis-color',
  '-epub-text-underline-position': 'text-underline-position',
  '-webkit-text-underline-position': 'text-underline-position',
  '-epub-line-break': 'line-break',
  '-webkit-line-break': 'line-break',
  '-epub-word-break': 'word-break',
  '-webkit-word-break': 'word-break',
  '-epub-hyphens': 'hyphens',
  '-webkit-hyphens': 'hyphens',
  '-webkit-text-combine-upright': 'text-combine-upright',
  '-webkit-text-combine': 'text-combine-upright',
  '-epub-text-combine': 'text-combine-upright',
});

/**
 * Add standards-based declarations next to legacy EPUB/WebKit aliases without
 * deleting publisher CSS. Modern browsers therefore receive the standard
 * property while older engines can still use the authored declaration.
 */
export function normalizeLegacyEpubCss(
  css: string,
): LegacyCssNormalizationResult {
  const normalized = new Set<string>();
  const output = css.replace(/\{([^{}]*)\}/gu, (whole, body: string) => {
    const declarations = parseDeclarationNames(body);
    const additions: string[] = [];
    for (const [legacy, standard] of Object.entries(PROPERTY_ALIASES)) {
      if (declarations.has(standard)) continue;
      const value = lastDeclarationValue(body, legacy);
      if (value == null) continue;
      const mapped = mapLegacyValue(standard, value);
      if (mapped == null) continue;
      additions.push(`${standard}: ${mapped};`);
      normalized.add(legacy);
      declarations.add(standard);
    }
    if (additions.length === 0) return whole;
    return `{${body}${body.trimEnd().endsWith(';') || !body.trim() ? '' : ';'}\n  ${additions.join('\n  ')}\n}`;
  });
  return { css: output, normalizedProperties: [...normalized].sort() };
}

/** Inline style attributes have no braces, so use a synthetic declaration block. */
export function normalizeLegacyInlineCss(
  css: string,
): LegacyCssNormalizationResult {
  const wrapped = normalizeLegacyEpubCss(`x{${css}}`);
  const start = wrapped.css.indexOf('{');
  const end = wrapped.css.lastIndexOf('}');
  return {
    css: wrapped.css.slice(start + 1, end),
    normalizedProperties: wrapped.normalizedProperties,
  };
}

function parseDeclarationNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(/(?:^|;)\s*([\w-]+)\s*:/gu))
    names.add(match[1]!.toLowerCase());
  return names;
}

function lastDeclarationValue(body: string, property: string): string | null {
  const pattern = new RegExp(
    `(?:^|;)\\s*${escapeRegExp(property)}\\s*:\\s*([^;}]*)`,
    'giu',
  );
  let value: string | null = null;
  for (const match of body.matchAll(pattern)) value = match[1]?.trim() ?? null;
  return value;
}

function mapLegacyValue(standard: string, value: string): string | null {
  if (standard !== 'text-combine-upright') return value;
  const normalized = value
    .replace(/!important\s*$/iu, '')
    .trim()
    .toLowerCase();
  const important = /!important\s*$/iu.test(value) ? ' !important' : '';
  if (normalized === 'horizontal' || normalized === 'all')
    return `all${important}`;
  if (normalized === 'none') return `none${important}`;
  const digits = /^digits\s+(\d+)$/u.exec(normalized)?.[1];
  if (digits) return `digits ${digits}${important}`;
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
