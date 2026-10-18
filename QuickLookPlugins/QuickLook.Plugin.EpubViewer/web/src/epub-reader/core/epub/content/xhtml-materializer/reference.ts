import { resolvePublicationDocumentReference } from '../../publication';

export function referenceHrefWithFragment(
  resolved: ReturnType<typeof resolvePublicationDocumentReference>,
): string {
  if (!resolved.remote || !resolved.fragment) return resolved.href;
  const url = new URL(resolved.href);
  url.hash = resolved.fragment;
  return url.href;
}
