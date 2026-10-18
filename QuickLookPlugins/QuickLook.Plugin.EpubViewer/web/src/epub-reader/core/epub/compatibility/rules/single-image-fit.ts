import type { RenditionCompatibilityPolicy } from '../rendition-policy';

export const SINGLE_IMAGE_FIT_COMPATIBILITY_ID =
  'epub.rendition.single-image-fit';

export const singleImageFitCompatibilityPolicy: RenditionCompatibilityPolicy = {
  id: SINGLE_IMAGE_FIT_COMPATIBILITY_ID,
  family: 'rendition',
  stage: 'rendition.policy',
  revision: '2',
  enabledByDefault: true,
  apply(context, directives) {
    const page = context.contentHints?.page;
    const fit =
      (page?.kind === 'single-image-page' ||
        page?.kind === 'single-svg-page') &&
      page.pageLike &&
      page.replacedElementCount === 1 &&
      page.semanticTextLength === 0 &&
      page.intrinsicViewport != null;
    return { value: { ...directives, fitSingleImagePage: Boolean(fit) } };
  },
};
