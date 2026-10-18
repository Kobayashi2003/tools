import type { NavigationModel } from '../../publication';
import type { NavigationFallbackCompatibilityRule } from '../publication-runner';

export const LEGACY_NAVIGATION_COMPATIBILITY_ID =
  'epub.publication.legacy-navigation';

export const legacyNavigationCompatibilityRule: NavigationFallbackCompatibilityRule =
  {
    id: LEGACY_NAVIGATION_COMPATIBILITY_ID,
    family: 'publication',
    stage: 'publication.navigation-fallback',
    revision: '1',
    enabledByDefault: true,
    apply(context, navigation) {
      if (navigation.toc.length > 0) return { value: navigation };
      const legacy = context.legacyNavigation;
      if (legacy) {
        const value: NavigationModel = {
          ...legacy,
          landmarks:
            legacy.landmarks.length > 0
              ? legacy.landmarks
              : context.legacyLandmarks,
        };
        const diagnostics = context.publication.version.startsWith('3')
          ? [
              {
                code: 'NAV_COMPATIBILITY_NCX_FALLBACK',
                severity: 'warning' as const,
                phase: 'compatibility' as const,
                message:
                  'EPUB 3 Navigation Document did not provide a usable table of contents; using legacy NCX navigation.',
                path: context.publication.packagePath,
                repair: {
                  strategy: 'use-ncx-navigation-fallback',
                  description:
                    'Use declared NCX navigation when EPUB 3 navigation is missing or unusable.',
                  confidence: 0.7,
                  resolvesCodes: [
                    'PACKAGE_NAV_ITEM_MISSING',
                    'NAV_DOCUMENT_MISSING',
                    'NAV_DOCUMENT_READ_FAILED',
                  ],
                },
              },
            ]
          : [];
        return { value, diagnostics };
      }
      if (navigation.source === 'none' && context.legacyLandmarks.length > 0) {
        return { value: { ...navigation, landmarks: context.legacyLandmarks } };
      }
      return { value: navigation };
    },
  };
