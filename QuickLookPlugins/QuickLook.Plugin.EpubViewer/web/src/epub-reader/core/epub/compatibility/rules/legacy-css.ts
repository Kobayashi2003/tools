import {
  normalizeLegacyEpubCss,
  normalizeLegacyInlineCss,
} from '../../resources/css-compat';
import type {
  InlineStyleResourceCompatibilityRule,
  StylesheetResourceCompatibilityRule,
} from '../resource-runner';

export const LEGACY_STYLESHEET_COMPATIBILITY_ID =
  'epub.resource.legacy-stylesheet';
export const LEGACY_INLINE_STYLE_COMPATIBILITY_ID =
  'epub.resource.legacy-inline-style';

export const legacyStylesheetCompatibilityRule: StylesheetResourceCompatibilityRule =
  {
    id: LEGACY_STYLESHEET_COMPATIBILITY_ID,
    family: 'resource',
    stage: 'resource.stylesheet',
    revision: '1',
    enabledByDefault: true,
    apply(context, css) {
      const normalized = normalizeLegacyEpubCss(css);
      return {
        value: normalized.css,
        diagnostics:
          normalized.normalizedProperties.length > 0
            ? [
                legacyCssDiagnostic(
                  context.path,
                  normalized.normalizedProperties,
                ),
              ]
            : [],
      };
    },
  };

export const legacyInlineStyleCompatibilityRule: InlineStyleResourceCompatibilityRule =
  {
    id: LEGACY_INLINE_STYLE_COMPATIBILITY_ID,
    family: 'resource',
    stage: 'resource.inline-style',
    revision: '1',
    enabledByDefault: true,
    apply(context, css) {
      const normalized = normalizeLegacyInlineCss(css);
      return {
        value: normalized.css,
        diagnostics:
          normalized.normalizedProperties.length > 0
            ? [
                legacyCssDiagnostic(
                  context.documentPath,
                  normalized.normalizedProperties,
                ),
              ]
            : [],
      };
    },
  };

function legacyCssDiagnostic(
  path: import('../../publication').PublicationPath,
  properties: readonly string[],
) {
  return {
    code: 'RESOURCE_LEGACY_EPUB_CSS_NORMALIZED',
    severity: 'info' as const,
    phase: 'compatibility' as const,
    path,
    message: `Added standard CSS equivalents for legacy EPUB/WebKit properties: ${properties.join(', ')}.`,
    repair: {
      strategy: 'add-standard-css-aliases',
      description:
        'Keep publisher-prefixed CSS and add equivalent standard declarations for cross-browser rendering.',
      confidence: 0.98,
    },
  };
}
