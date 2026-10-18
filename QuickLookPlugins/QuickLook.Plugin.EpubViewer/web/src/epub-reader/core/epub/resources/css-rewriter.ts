export type CssReferenceKind = 'asset' | 'import';

export interface CssReference {
  readonly source: string;
  readonly kind: CssReferenceKind;
}

export interface CssRewriteResult {
  readonly css: string;
  readonly references: readonly CssReference[];
}

/**
 * Rewrites CSS url() and @import references without a regex-only parser.
 * Strings/comments are respected and url() payloads support quoted/unquoted
 * forms plus simple CSS escapes. Relative URL resolution is deliberately left
 * to the caller because CSS uses the stylesheet itself as its base URL.
 */
export async function rewriteCssReferences(
  css: string,
  rewrite: (
    source: string,
    kind: CssReferenceKind,
  ) => Promise<string | null> | string | null,
): Promise<CssRewriteResult> {
  const out: string[] = [];
  const references: CssReference[] = [];
  let i = 0;
  let importPending = false;

  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      const next = end < 0 ? css.length : end + 2;
      out.push(css.slice(i, next));
      i = next;
      continue;
    }

    const ch = css[i]!;
    if (ch === '"' || ch === "'") {
      const parsed = readCssString(css, i);
      if (importPending) {
        const source = unescapeCss(parsed.value);
        references.push({ source, kind: 'import' });
        const replacement = await rewrite(source, 'import');
        out.push(quoteCssString(replacement ?? source, ch));
        importPending = false;
      } else {
        out.push(parsed.raw);
      }
      i = parsed.end;
      continue;
    }

    if (isAtImport(css, i)) {
      out.push(css.slice(i, i + 7));
      i += 7;
      importPending = true;
      continue;
    }

    if (isUrlFunction(css, i)) {
      const parsed = readUrlFunction(css, i);
      const source = unescapeCss(parsed.value.trim());
      const kind: CssReferenceKind = importPending ? 'import' : 'asset';
      references.push({ source, kind });
      const replacement = await rewrite(source, kind);
      out.push(`url(${quoteCssString(replacement ?? source, '"')})`);
      importPending = false;
      i = parsed.end;
      continue;
    }

    if (importPending && (ch === ';' || ch === '{')) importPending = false;
    out.push(ch);
    i += 1;
  }

  return { css: out.join(''), references };
}

function isAtImport(css: string, index: number): boolean {
  if (css[index] !== '@') return false;
  const token = css.slice(index, index + 7);
  if (token.toLowerCase() !== '@import') return false;
  const next = css[index + 7];
  return next === undefined || !/[A-Za-z0-9_-]/.test(next);
}

function isUrlFunction(css: string, index: number): boolean {
  if (index > 0 && /[A-Za-z0-9_-]/.test(css[index - 1]!)) return false;
  if (css.slice(index, index + 3).toLowerCase() !== 'url') return false;
  let cursor = index + 3;
  while (/\s/.test(css[cursor] ?? '')) cursor += 1;
  return css[cursor] === '(';
}

function readUrlFunction(
  css: string,
  index: number,
): { value: string; end: number } {
  let cursor = index + 3;
  while (/\s/.test(css[cursor] ?? '')) cursor += 1;
  if (css[cursor] !== '(') return { value: '', end: index + 3 };
  cursor += 1;
  while (/\s/.test(css[cursor] ?? '')) cursor += 1;

  const quote = css[cursor];
  if (quote === '"' || quote === "'") {
    const parsed = readCssString(css, cursor);
    cursor = parsed.end;
    while (/\s/.test(css[cursor] ?? '')) cursor += 1;
    if (css[cursor] === ')') cursor += 1;
    return { value: parsed.value, end: cursor };
  }

  const start = cursor;
  let escaped = false;
  while (cursor < css.length) {
    const ch = css[cursor]!;
    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (ch === ')') {
      return { value: css.slice(start, cursor).trimEnd(), end: cursor + 1 };
    }
    cursor += 1;
  }
  return { value: css.slice(start).trimEnd(), end: css.length };
}

function readCssString(
  css: string,
  index: number,
): { raw: string; value: string; end: number } {
  const quote = css[index]!;
  let cursor = index + 1;
  let escaped = false;
  while (cursor < css.length) {
    const ch = css[cursor]!;
    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (ch === quote) {
      return {
        raw: css.slice(index, cursor + 1),
        value: css.slice(index + 1, cursor),
        end: cursor + 1,
      };
    }
    cursor += 1;
  }
  return {
    raw: css.slice(index),
    value: css.slice(index + 1),
    end: css.length,
  };
}

function quoteCssString(value: string, quote: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(escapeRegExp(quote), 'g'), `\\${quote}`)
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '');
  return `${quote}${escaped}${quote}`;
}

function unescapeCss(value: string): string {
  return value
    .replace(
      /\\([0-9a-fA-F]{1,6})(?:\r\n|[ \n\r\t\f])?/g,
      (_match, hex: string) => {
        const codePoint = Number.parseInt(hex, 16);
        if (
          !Number.isFinite(codePoint) ||
          codePoint === 0 ||
          codePoint > 0x10ffff
        )
          return '\uFFFD';
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return '\uFFFD';
        }
      },
    )
    .replace(/\\\r?\n/g, '')
    .replace(/\\([\s\S])/g, '$1');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
