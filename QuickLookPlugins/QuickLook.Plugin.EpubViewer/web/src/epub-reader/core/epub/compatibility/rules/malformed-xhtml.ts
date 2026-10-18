import type { ContentDocumentCompatibilityRule } from '../content-runner';

export const MALFORMED_XHTML_COMPATIBILITY_ID = 'epub.content.malformed-xhtml';

export const malformedXhtmlCompatibilityRule: ContentDocumentCompatibilityRule =
  {
    id: MALFORMED_XHTML_COMPATIBILITY_ID,
    family: 'content-document',
    stage: 'content-document.processing',
    revision: '1',
    enabledByDefault: true,
    apply(context, state) {
      if (!context.standardParseError || state.parseMode !== 'xml')
        return { value: state };
      return {
        value: { ...state, parseMode: 'html-recovery' },
        diagnostics: [
          {
            code: 'CONTENT_XHTML_PARSED_AS_HTML',
            severity: 'warning',
            phase: 'compatibility',
            message: `Recovered non-well-formed XHTML content ${context.path} with the browser HTML parser.`,
            path: context.path,
            spineIndex: context.spineItem.index,
            repair: {
              strategy: 'parse-malformed-xhtml-as-html',
              description:
                'Use browser HTML parsing as a compatibility fallback, then serialize deterministic script-disabled markup.',
              confidence: 0.9,
            },
          },
        ],
      };
    },
  };
