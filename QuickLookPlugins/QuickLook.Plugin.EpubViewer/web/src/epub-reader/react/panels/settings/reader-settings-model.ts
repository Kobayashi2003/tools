import type {
  PublicationLayoutProfile,
  RenditionCapabilities,
  WritingMode,
} from '../../../core';

export interface ReaderSettingsSectionProfile {
  readonly layout: PublicationLayoutProfile;
  readonly writingMode: WritingMode;
  readonly capabilities?: Pick<RenditionCapabilities, 'textCustomization'>;
}

export interface ReaderSettingsSectionVisibility {
  readonly showComic: boolean;
  readonly showText: boolean;
  readonly verticalWriting: boolean;
  readonly typographyEnabled: boolean;
  readonly lineHeightEnabled: boolean;
}

/** Publication-scoped section visibility must not change on an ordinary page turn. */
export function readerSettingsSectionVisibility(
  profile: ReaderSettingsSectionProfile,
): ReaderSettingsSectionVisibility {
  const showComic = profile.layout !== 'reflowable';
  const showText = profile.layout !== 'fixed-layout';
  return Object.freeze({
    showComic,
    showText,
    verticalWriting: profile.writingMode !== 'horizontal-tb',
    typographyEnabled:
      showText &&
      (profile.layout === 'mixed' ||
        profile.capabilities?.textCustomization.fontSize !== false),
    lineHeightEnabled:
      showText &&
      (profile.layout === 'mixed' ||
        profile.capabilities?.textCustomization.lineHeight !== false),
  });
}
