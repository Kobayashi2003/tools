import type { ReaderThemeDefinition } from '../../appearance';
import type { RenditionPlan } from '../../rendition';
import type { ReflowableRendererPolicy } from './model';

export const READER_LAYOUT_STYLE_ID = 'epub-reader-layout-style';
export const READER_PREFERENCES_STYLE_ID = 'epub-reader-preferences-style';

/**
 * Block-axis padding for vertical pages, in `em` so it tracks the reader's font
 * size. It sits on the multicol container, so every column gets it.
 *
 * `ruby-position: over` puts an annotation on the block-start side of its base,
 * which in `vertical-rl` is the right-hand edge of the page. With no room
 * reserved there the first column of each page paints its furigana outside the
 * page box and it is cropped — measured at 1.5px of overflow for 16px text, so
 * 1em covers the whole 70%–300% font-size range the reader offers.
 */
const VERTICAL_BLOCK_SLACK = '1em';

/**
 * Inline margin of a vertical page: the top and bottom of the page as a reader
 * sees it, which is exactly what the settings panel labels the page-margin
 * preference for vertical books.
 *
 * It is spent twice — once shrinking each column and once as the gap between
 * columns — so that a column plus its gap advances by exactly one viewport and
 * the margin lands on both edges of every page instead of only at the two ends
 * of the document.
 */
function verticalInlineMargin(plan: RenditionPlan): number {
  return Math.max(
    0,
    (plan.viewport.height * plan.preferences.pageMarginPercent) / 100,
  );
}

/**
 * Top and bottom breathing room of a horizontal page, proportional to the
 * page-margin preference so zero still means zero. Without it the first and
 * last lines of every page touch the viewport edge.
 */
function blockMargin(plan: RenditionPlan, extent: number): number {
  return Math.round(
    Math.max(0, (extent * plan.preferences.pageMarginPercent * 0.6) / 100),
  );
}

function verticalColumnInlineSize(plan: RenditionPlan): number {
  return Math.max(1, plan.viewport.height - verticalInlineMargin(plan) * 2);
}

export function buildReflowableLayoutCss(
  plan: RenditionPlan,
  policy: ReflowableRendererPolicy,
  writingMode = plan.writingMode.value,
): string {
  const width = cssPixels(plan.viewport.width);
  const height = cssPixels(plan.viewport.height);
  const pageGap = reflowablePageGap(plan, policy, writingMode);
  const pageWidthValue = reflowablePageWidth(plan, policy, writingMode);
  const pageWidth = cssPixels(pageWidthValue);
  const pageInset =
    writingMode === 'horizontal-tb'
      ? cssPixels(reflowablePageInset(plan, policy, writingMode))
      : '0px';
  const inlinePadding = `${plan.preferences.pageMarginPercent}%`;
  // A leading blank only means something where a spread really is two side by
  // side fragmentainers, which is horizontal two-up. A vertical spread is one
  // fragmentainer running right-to-left across both leaves, so there is no slot
  // inside it to align a chapter to: a blank column there does not move the
  // opening onto the correct leaf, it just spends a whole spread on nothing and
  // makes the first page turn of the chapter land on an empty page.
  const leadingBlank =
    writingMode === 'horizontal-tb' && reflowableNeedsLeadingBlankPage(plan);

  if (plan.renderer === 'reflowable-paginated') {
    if (usesSingleImagePageLayout(plan)) {
      return buildSingleImagePageLayoutCss(plan);
    }

    // Both writing modes fragment through CSS multicol, and the reader never
    // decides a page boundary itself. A boundary computed as `index * pageSize`
    // bears no relation to where the line boxes actually fall, so it slices
    // through whichever line happens to be sitting there — and the offender is
    // then cut in half across two pages, legible on neither. A multicol
    // fragmentation break falls between line boxes by construction.
    //
    // The axes swap between the modes. In vertical writing the inline axis is
    // vertical, so column boxes stack down the page, each column is a whole
    // page, and paging is an ordinary positive `scrollTop`.
    if (writingMode !== 'horizontal-tb') {
      const inlineMargin = verticalInlineMargin(plan);
      return `
html {
  box-sizing: border-box !important;
  width: ${width} !important;
  height: ${height} !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow-x: hidden !important;
  overflow-y: auto !important;
  scrollbar-width: none !important;
  scroll-behavior: auto !important;
}

html, body { scrollbar-width: none !important; }
html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
body {
  box-sizing: border-box !important;
  width: ${width} !important;
  height: ${height} !important;
  min-width: ${width} !important;
  margin: 0 !important;
  padding: 0 !important;
  padding-inline: ${cssLength(inlineMargin)} !important;
  padding-block: ${VERTICAL_BLOCK_SLACK} !important;
  column-width: ${cssPixels(verticalColumnInlineSize(plan))} !important;
  column-count: auto !important;
  column-gap: ${cssLength(inlineMargin * 2)} !important;
  column-fill: auto !important;
  column-rule: none !important;
  overflow: visible !important;
}
${leadingBlank ? leadingBlankColumnCss() : ''}
${
  policy.containReplacedElements
    ? replacedElementContainmentCss(
        cssPixels(verticalColumnInlineSize(plan)),
        `calc(${width} - 2 * ${VERTICAL_BLOCK_SLACK})`,
      )
    : ''
}
`;
    }

    const gap = cssPixels(pageGap);
    const topBottom = blockMargin(plan, plan.viewport.height);
    return `
html {
  box-sizing: border-box !important;
  width: ${width} !important;
  height: ${height} !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow-x: auto !important;
  overflow-y: hidden !important;
  scrollbar-width: none !important;
  scroll-behavior: auto !important;
}
html, body { scrollbar-width: none !important; }
html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
body {
  box-sizing: border-box !important;
  position: relative !important;
  inset-inline-start: ${pageInset} !important;
  width: ${pageWidth} !important;
  height: ${height} !important;
  min-width: ${pageWidth} !important;
  min-height: ${height} !important;
  margin: 0 !important;
  padding: 0 !important;
  padding-block: ${cssLength(topBottom)} !important;
  column-width: ${pageWidth} !important;
  column-gap: ${gap} !important;
  column-fill: auto !important;
  column-rule: none !important;
  overflow: visible !important;
}
${leadingBlank ? leadingBlankColumnCss() : ''}
${
  policy.containReplacedElements
    ? replacedElementContainmentCss(
        pageWidth,
        cssPixels(plan.viewport.height - topBottom * 2),
      )
    : ''
}
`;
  }

  return `
html {
  box-sizing: border-box !important;
  width: 100% !important;
  min-width: 100% !important;
  min-height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: auto !important;
  scroll-behavior: auto !important;
}
html, body {
  scrollbar-width: thin;
  scrollbar-color: rgba(96, 98, 94, 0.58) transparent;
}
html::-webkit-scrollbar, body::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
html::-webkit-scrollbar-track, body::-webkit-scrollbar-track {
  background: transparent;
}
html::-webkit-scrollbar-thumb, body::-webkit-scrollbar-thumb {
  min-height: 32px;
  border: 3px solid transparent;
  border-radius: 999px;
  background: rgba(96, 98, 94, 0.58);
  background-clip: padding-box;
}
html::-webkit-scrollbar-thumb:hover, body::-webkit-scrollbar-thumb:hover {
  background-color: rgba(74, 77, 72, 0.78);
}
html::-webkit-scrollbar-button, body::-webkit-scrollbar-button,
html::-webkit-scrollbar-corner, body::-webkit-scrollbar-corner {
  display: none;
  background: transparent;
}
body {
  box-sizing: border-box !important;
  min-width: 100% !important;
  min-height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  padding-inline: ${inlinePadding} !important;
  column-width: auto !important;
  column-count: auto !important;
  column-gap: normal !important;
  column-fill: balance !important;
  overflow: visible !important;
}
${policy.containReplacedElements ? replacedElementContainmentCss('100%', 'none') : ''}
`;
}

/**
 * A pure image document is page-like content carried by a reflowable spine
 * item, not flowing prose. It needs a definite viewport containing block, but
 * it must not be relabelled as fixed-layout: doing that would change authored
 * rendition semantics, navigation capabilities and spread composition.
 *
 * Keep the recovery deliberately narrower than preflight's broader
 * `pageLike` hint. A short caption is real flow content and must not be hidden
 * behind a viewport-positioned image.
 */
function usesSingleImagePageLayout(plan: RenditionPlan): boolean {
  const page = plan.contentPage;
  return (
    plan.compatibility.fitSingleImagePage &&
    (page?.kind === 'single-image-page' || page?.kind === 'single-svg-page') &&
    page.pageLike &&
    page.replacedElementCount === 1 &&
    page.semanticTextLength === 0 &&
    page.intrinsicViewport != null
  );
}

/**
 * Fit the sole image against the iframe viewport itself. Percentage max-height
 * on publisher wrapper chains such as `div > p > img.fit` resolves against an
 * auto-height containing block and therefore does not constrain the image to a
 * fragmentainer. Fixed positioning removes the replaced element from that
 * indefinite chain while preserving its XHTML node, intrinsic ratio, links and
 * accessibility metadata.
 */
function buildSingleImagePageLayoutCss(plan: RenditionPlan): string {
  const width = cssPixels(plan.viewport.width);
  const height = cssPixels(plan.viewport.height);
  const svg = plan.contentPage?.kind === 'single-svg-page';
  const intrinsic = plan.contentPage!.intrinsicViewport!;
  const scale = Math.min(
    plan.viewport.width / intrinsic.width,
    plan.viewport.height / intrinsic.height,
  );
  return `
html {
  box-sizing: border-box !important;
  width: ${width} !important;
  height: ${height} !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  scrollbar-width: none !important;
}
body {
  box-sizing: border-box !important;
  position: relative !important;
  width: ${width} !important;
  height: ${height} !important;
  min-width: ${width} !important;
  min-height: ${height} !important;
  margin: 0 !important;
  padding: 0 !important;
  column-width: auto !important;
  column-count: auto !important;
  column-gap: 0 !important;
  overflow: hidden !important;
}
body ${svg ? 'svg' : 'img'} {
  position: fixed !important;
  inset: 0 !important;
  display: block !important;
  box-sizing: border-box !important;
  width: auto !important;
  height: auto !important;
  min-width: 0 !important;
  min-height: 0 !important;
  max-width: ${width} !important;
  max-height: ${height} !important;
  margin: auto !important;
  object-fit: contain !important;
  break-inside: avoid !important;
}
${
  svg
    ? `
/* Scale the canvas itself: an SVG without viewBox must scale its children too. */
body svg {
  inset: 50% auto auto 50% !important;
  width: ${cssPixels(intrinsic.width)} !important;
  height: ${cssPixels(intrinsic.height)} !important;
  max-width: none !important;
  max-height: none !important;
  margin: 0 !important;
  transform-origin: center !important;
  transform: translate(-50%, -50%) scale(${scale}) !important;
}`
    : ''
}
`;
}

/**
 * Gap between one page's fragmentainer and the next, along the paging axis.
 *
 * Vertical columns stack on the inline (vertical) axis, so the gap there is the
 * pair of page margins that meet between two pages. Column size plus gap is a
 * page advance of exactly one viewport in both writing modes.
 */
export function reflowablePageGap(
  plan: RenditionPlan,
  policy: ReflowableRendererPolicy,
  writingMode = plan.writingMode.value,
): number {
  if (writingMode !== 'horizontal-tb') return verticalInlineMargin(plan) * 2;
  const baseGap = baseReflowablePageGap(plan, policy);
  return baseGap + reflowablePageInset(plan, policy, writingMode) * 2;
}

/**
 * Size of one page's fragmentainer along the paging axis: a column's width for
 * horizontal writing, a column's height for vertical writing.
 */
export function reflowablePageWidth(
  plan: RenditionPlan,
  policy: ReflowableRendererPolicy,
  writingMode = plan.writingMode.value,
): number {
  if (writingMode !== 'horizontal-tb') return verticalColumnInlineSize(plan);
  const slotWidth = physicalPageSlotWidth(plan, policy, writingMode);
  return Math.max(
    1,
    slotWidth - reflowablePageInset(plan, policy, writingMode) * 2,
  );
}

export function reflowablePageInset(
  plan: RenditionPlan,
  policy: ReflowableRendererPolicy,
  writingMode = plan.writingMode.value,
): number {
  if (
    writingMode !== 'horizontal-tb' ||
    plan.renderer !== 'reflowable-paginated'
  )
    return 0;
  const slotWidth = physicalPageSlotWidth(plan, policy, writingMode);
  return Math.max(0, slotWidth * (plan.preferences.pageMarginPercent / 100));
}

function physicalPageSlotWidth(
  plan: RenditionPlan,
  policy: ReflowableRendererPolicy,
  writingMode: RenditionPlan['writingMode']['value'],
): number {
  const visible = plan.spread.execution === 'intra-document' ? 2 : 1;
  if (writingMode !== 'horizontal-tb')
    return Math.max(1, plan.viewport.width / visible);
  const gap = baseReflowablePageGap(plan, policy);
  return visible === 2
    ? Math.max(1, (plan.viewport.width - gap) / 2)
    : plan.viewport.width;
}

function baseReflowablePageGap(
  plan: RenditionPlan,
  policy: ReflowableRendererPolicy,
): number {
  return plan.spread.mode === 'double' && plan.spread.gap === 'none'
    ? 0
    : policy.pageGap;
}

export function reflowableNeedsLeadingBlankPage(plan: RenditionPlan): boolean {
  if (
    plan.spread.execution !== 'intra-document' ||
    plan.spread.mode !== 'double'
  )
    return false;
  const placement = plan.spread.placement;
  if (placement !== 'left' && placement !== 'right') return false;
  const defaultFirst = plan.pageProgression.value === 'rtl' ? 'right' : 'left';
  return placement !== defaultFirst;
}

function leadingBlankColumnCss(): string {
  return `
body::before {
  content: "" !important;
  display: block !important;
  inline-size: 100% !important;
  block-size: 100% !important;
  break-after: column !important;
}
`;
}

export function buildReaderPreferenceCss(
  plan: RenditionPlan,
  resolvedTheme?: ReaderThemeDefinition | null,
): string {
  const preferences = plan.preferences;
  const rules: string[] = [
    `font-size: ${preferences.fontSizePercent}% !important`,
  ];

  if (preferences.fontFamily) {
    rules.push(
      `font-family: ${safeFontFamily(preferences.fontFamily)} !important`,
    );
  }
  const extra: string[] = [];
  if (preferences.lineHeight != null) {
    rules.push(`line-height: ${preferences.lineHeight} !important`);
    // A reader-chosen line height must not squeeze ruby. An <rt> is laid out
    // against its base's line box, so a compressed line height crops the
    // furigana or overlaps it into the neighbouring line — and the reader's
    // range goes down to 0.9. Ruby keeps the font's own metrics. Zero
    // specificity, so publisher rules still win where they exist.
    extra.push(`:where(ruby, rb, rt, rtc) { line-height: normal; }`);
  }
  const theme = themeDeclarations(resolvedTheme);
  if (theme?.body) rules.push(...theme.body);
  if (theme?.link)
    extra.push(`a, a:link, a:visited { color: ${theme.link} !important; }`);
  if (theme?.forceTextColor) {
    // Everything but links, rather than an enumerated tag list. The list this
    // replaces omitted section, article, dt/dd, caption, label and every ruby
    // element, so on a dark theme those kept their authored near-black colour
    // and went invisible. Links are excluded because the rule above gives them
    // the theme's own link colour.
    extra.push(`:where(body *:not(a, a *)) { color: inherit !important; }`);
  }

  return `
body {
  ${rules.join(';\n  ')};
}
${extra.join('\n')}
`;
}

export function upsertReaderStyle(
  document: Document,
  id: string,
  css: string,
): HTMLStyleElement {
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElementNS(
      'http://www.w3.org/1999/xhtml',
      'style',
    ) as HTMLStyleElement;
    style.id = id;
    (document.head ?? document.documentElement).appendChild(style);
  }
  style.textContent = css;
  return style;
}

/**
 * Keep replaced content inside one page. The limits are the page's own
 * extents: a percentage `max-block-size` resolves against the auto-height
 * wrapper publishers put around illustrations, which never constrains it, so
 * a tall illustration would overflow its page and be cut off.
 */
function replacedElementContainmentCss(
  maxInlineSize: string,
  maxBlockSize: string,
): string {
  return `
img, svg, video, canvas, object, embed, iframe {
  max-inline-size: min(100%, ${maxInlineSize}) !important;
  max-block-size: ${maxBlockSize} !important;
  object-fit: contain;
  break-inside: avoid;
}
`;
}

function themeDeclarations(
  resolved?: ReaderThemeDefinition | null,
): { body: string[]; link?: string; forceTextColor: boolean } | null {
  const value = resolved;
  if (!value || value.id === 'publisher') return null;
  const body: string[] = [];
  const foreground = safeCssValue(value.foreground);
  const background = safeCssValue(value.background);
  const link = safeCssValue(value.link);
  if (foreground) body.push(`color: ${foreground} !important`);
  if (background) body.push(`background: ${background} !important`);
  if (value.colorScheme && value.colorScheme !== 'normal')
    body.push(`color-scheme: ${value.colorScheme}`);
  return {
    body,
    ...(link ? { link } : {}),
    forceTextColor: value.forceTextColor ?? false,
  };
}

function safeCssValue(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || /[;{}\r\n\f]/u.test(trimmed) || /url\s*\(/iu.test(trimmed))
    return null;
  return trimmed;
}

function quoteCssString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\n\r\f]/g, ' ')}"`;
}

function safeFontFamily(value: string): string {
  const genericFamilies = new Set([
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'ui-serif',
    'ui-sans-serif',
    'ui-monospace',
  ]);
  const families = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (families.length === 0) return 'serif';
  return families
    .map((family) =>
      genericFamilies.has(family.toLowerCase())
        ? family.toLowerCase()
        : quoteCssString(family),
    )
    .join(', ');
}

/** Extents that must never collapse to nothing: a page, a column. */
function cssPixels(value: number): string {
  return `${Math.max(1, value)}px`;
}

/** Lengths where zero is a legitimate value: a margin, a gap. */
function cssLength(value: number): string {
  return `${Math.max(0, value)}px`;
}
