import type { RootfileSelectionCompatibilityRule } from '../publication-runner';

const PACKAGE_MEDIA_TYPE = 'application/oebps-package+xml';

export const PREFERRED_ROOTFILE_COMPATIBILITY_ID =
  'epub.publication.preferred-rootfile';

export const preferredRootfileCompatibilityRule: RootfileSelectionCompatibilityRule =
  {
    id: PREFERRED_ROOTFILE_COMPATIBILITY_ID,
    family: 'publication',
    stage: 'publication.rootfile-selection',
    revision: '1',
    enabledByDefault: true,
    apply(context, selected) {
      const preferred =
        context.rootfiles.find(
          (rootfile) => rootfile.mediaType === PACKAGE_MEDIA_TYPE,
        ) ?? selected;
      if (!preferred || preferred === selected) return { value: selected };
      return {
        value: preferred,
        diagnostics: [
          {
            code: 'OCF_PREFERRED_ROOTFILE_SELECTED',
            severity: 'info',
            phase: 'compatibility',
            path: context.containerPath,
            message: `Selected standard EPUB package document ${preferred.fullPath} from multiple rootfiles.`,
            repair: {
              strategy: 'select-preferred-rootfile',
              description:
                'Prefer the first application/oebps-package+xml rootfile over a non-package candidate.',
              confidence: 0.8,
            },
          },
        ],
      };
    },
  };
