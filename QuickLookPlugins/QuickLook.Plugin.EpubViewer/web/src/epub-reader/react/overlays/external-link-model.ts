import type { ExternalLinkKind, ExternalLinkTarget } from '../../core';

export interface ExternalLinkDetails {
  readonly kind: ExternalLinkKind;
  readonly href: string;
  readonly title: string;
  readonly actionLabel: string;
  /** A human-readable destination that never includes URL credentials. */
  readonly destination: string;
}

const LABELS: Record<
  ExternalLinkKind,
  Pick<ExternalLinkDetails, 'title' | 'actionLabel'>
> = {
  website: { title: 'Open external website?', actionLabel: 'Open website' },
  email: { title: 'Open email app?', actionLabel: 'Continue to email' },
  phone: { title: 'Open phone app?', actionLabel: 'Continue to phone' },
};

/**
 * Creates the deliberately small presentation model for a link that has
 * already passed the engine allowlist. Keeping the allowlist check here too
 * makes the overlay safe to reuse without accidentally widening that policy.
 */
export function externalLinkDetails(
  target: ExternalLinkTarget,
): ExternalLinkDetails {
  const { kind, href } = target;
  const destination =
    kind === 'website'
      ? websiteDestination(href)
      : schemeDestination(href, kind === 'email' ? 'mailto' : 'tel');
  return { kind, href, ...LABELS[kind], destination };
}

function websiteDestination(href: string): string {
  try {
    const url = new URL(href);
    const path = `${url.pathname}${url.search}${url.hash}`;
    return `${url.protocol}//${url.host}${path === '/' ? '' : path}`;
  } catch {
    return href;
  }
}

function schemeDestination(href: string, scheme: 'mailto' | 'tel'): string {
  const raw = href.slice(scheme.length + 1).split('?')[0] ?? '';
  try {
    return decodeURIComponent(raw) || href;
  } catch {
    return raw || href;
  }
}
