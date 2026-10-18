import type { ContentDocumentCompatibilityRule } from '../content-runner';

export const LEGACY_WRITING_MODE_COMPATIBILITY_ID =
  'epub.content.legacy-writing-mode';

export const legacyWritingModeCompatibilityRule: ContentDocumentCompatibilityRule =
  {
    id: LEGACY_WRITING_MODE_COMPATIBILITY_ID,
    family: 'content-document',
    stage: 'content-document.processing',
    revision: '1',
    enabledByDefault: true,
    apply(context, state) {
      const candidate = context.presentationCandidate;
      if (candidate?.writingModeSource !== 'legacy' || !candidate.writingMode)
        return { value: state };
      return {
        value: {
          ...state,
          hints: {
            ...state.hints,
            writingMode: candidate.writingMode,
            ...(candidate.direction ? { direction: candidate.direction } : {}),
          },
        },
        diagnostics: [
          {
            code: 'CONTENT_PREFLIGHT_LEGACY_WRITING_MODE',
            severity: 'info',
            phase: 'compatibility',
            path: context.path,
            spineIndex: context.spineItem.index,
            message: `Resolved ${candidate.writingMode} from a legacy -epub/-webkit writing-mode declaration before rendering.`,
            repair: {
              strategy: 'interpret-legacy-epub-writing-mode',
              description:
                'Treat legacy EPUB/WebKit writing-mode declarations as their standard CSS writing-mode equivalent.',
              confidence: 0.99,
            },
          },
        ],
      };
    },
  };
