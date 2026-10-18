import type { ReaderCompatibilityPreferences } from '../publication';
import { CompatibilityRegistry } from './registry';
import type { CompatibilityModule, CompatibilityProfile } from './profile';
import {
  idpfFontCompatibilityRule,
  IDPF_FONT_COMPATIBILITY_ID,
} from './rules/idpf-font';
import {
  legacyInlineStyleCompatibilityRule,
  LEGACY_INLINE_STYLE_COMPATIBILITY_ID,
  legacyStylesheetCompatibilityRule,
  LEGACY_STYLESHEET_COMPATIBILITY_ID,
} from './rules/legacy-css';
import {
  legacyNavigationCompatibilityRule,
  LEGACY_NAVIGATION_COMPATIBILITY_ID,
} from './rules/legacy-navigation';
import { legacyWritingModeCompatibilityRule } from './rules/legacy-writing-mode';
import {
  malformedXhtmlCompatibilityRule,
  MALFORMED_XHTML_COMPATIBILITY_ID,
} from './rules/malformed-xhtml';
import {
  preferredRootfileCompatibilityRule,
  PREFERRED_ROOTFILE_COMPATIBILITY_ID,
} from './rules/preferred-rootfile';
import {
  singleImageFitCompatibilityPolicy,
  SINGLE_IMAGE_FIT_COMPATIBILITY_ID,
} from './rules/single-image-fit';

export const BUILT_IN_COMPATIBILITY_MODULES: readonly CompatibilityModule[] =
  Object.freeze([
    preferredRootfileCompatibilityRule,
    legacyNavigationCompatibilityRule,
    malformedXhtmlCompatibilityRule,
    legacyWritingModeCompatibilityRule,
    idpfFontCompatibilityRule,
    legacyStylesheetCompatibilityRule,
    legacyInlineStyleCompatibilityRule,
    singleImageFitCompatibilityPolicy,
  ]);

export function createBuiltInCompatibilityProfile(
  preferences: ReaderCompatibilityPreferences,
): CompatibilityProfile {
  return createReaderCompatibilityProfile(
    preferences,
    BUILT_IN_COMPATIBILITY_MODULES,
  );
}

/** Resolves one session profile from built-in and host-contributed EPUB modules. */
export function createReaderCompatibilityProfile(
  preferences: ReaderCompatibilityPreferences,
  modules: readonly CompatibilityModule[],
): CompatibilityProfile {
  const disable = [
    ...(!preferences.selectPreferredRootfile
      ? [PREFERRED_ROOTFILE_COMPATIBILITY_ID]
      : []),
    ...(!preferences.useLegacyNavigationFallback
      ? [LEGACY_NAVIGATION_COMPATIBILITY_ID]
      : []),
    ...(!preferences.recoverMalformedXhtml
      ? [MALFORMED_XHTML_COMPATIBILITY_ID]
      : []),
    ...(!preferences.normalizeLegacyCss
      ? [
          LEGACY_STYLESHEET_COMPATIBILITY_ID,
          LEGACY_INLINE_STYLE_COMPATIBILITY_ID,
        ]
      : []),
    ...(!preferences.deobfuscateIdpfFonts ? [IDPF_FONT_COMPATIBILITY_ID] : []),
    ...(!preferences.fitSingleImagePages
      ? [SINGLE_IMAGE_FIT_COMPATIBILITY_ID]
      : []),
  ];
  return new CompatibilityRegistry(modules).createProfile({ disable });
}

export {
  IDPF_FONT_COMPATIBILITY_ID,
  LEGACY_INLINE_STYLE_COMPATIBILITY_ID,
  LEGACY_NAVIGATION_COMPATIBILITY_ID,
  LEGACY_STYLESHEET_COMPATIBILITY_ID,
  MALFORMED_XHTML_COMPATIBILITY_ID,
  PREFERRED_ROOTFILE_COMPATIBILITY_ID,
  SINGLE_IMAGE_FIT_COMPATIBILITY_ID,
};
