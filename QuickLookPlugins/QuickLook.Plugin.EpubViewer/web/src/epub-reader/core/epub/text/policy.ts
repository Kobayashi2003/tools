export const SEMANTIC_BLOCK_ELEMENT_NAMES = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'caption',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

export const SEMANTIC_EXCLUDED_ELEMENT_NAMES = new Set([
  'head',
  'script',
  'style',
  'template',
  'noscript',
  'title',
  'rt',
  'rp',
]);

export function isSemanticBlockElementName(name: string): boolean {
  return SEMANTIC_BLOCK_ELEMENT_NAMES.has(name.toLowerCase());
}

export function isSemanticExcludedElementName(name: string): boolean {
  return SEMANTIC_EXCLUDED_ELEMENT_NAMES.has(name.toLowerCase());
}
