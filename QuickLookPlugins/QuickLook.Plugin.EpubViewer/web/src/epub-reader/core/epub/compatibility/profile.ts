import type { ContentDocumentCompatibilityRule } from './content-runner';
import type { CompatibilityModuleDescriptor } from './model';
import type { PublicationCompatibilityRule } from './publication-runner';
import type { RenditionCompatibilityPolicy } from './rendition-policy';
import type { ResourceCompatibilityRule } from './resource-runner';

export type CompatibilityModule =
  | PublicationCompatibilityRule
  | ContentDocumentCompatibilityRule
  | ResourceCompatibilityRule
  | RenditionCompatibilityPolicy;

export interface CompatibilityProfile {
  readonly modules: readonly CompatibilityModule[];
  readonly publicationRules: readonly PublicationCompatibilityRule[];
  readonly contentDocumentRules: readonly ContentDocumentCompatibilityRule[];
  readonly resourceRules: readonly ResourceCompatibilityRule[];
  readonly renditionPolicies: readonly RenditionCompatibilityPolicy[];
  readonly signature: string;
  has(moduleId: string): boolean;
}

/** Registry-only construction keeps every Profile validated and resolved. */
export function createCompatibilityProfile(
  modules: readonly CompatibilityModule[],
): CompatibilityProfile {
  const frozenModules = Object.freeze([...modules]);
  return Object.freeze({
    modules: frozenModules,
    publicationRules: Object.freeze(modules.filter(isPublicationRule)),
    contentDocumentRules: Object.freeze(modules.filter(isContentDocumentRule)),
    resourceRules: Object.freeze(modules.filter(isResourceRule)),
    renditionPolicies: Object.freeze(modules.filter(isRenditionPolicy)),
    signature: compatibilityProfileSignature(modules),
    has(moduleId: string): boolean {
      return frozenModules.some((module) => module.id === moduleId);
    },
  });
}

export function compatibilityProfileSignature(
  modules: readonly CompatibilityModuleDescriptor[],
): string {
  const entries = modules.map((module) =>
    [
      encodeURIComponent(module.family),
      encodeURIComponent(module.stage),
      encodeURIComponent(module.id),
      encodeURIComponent(module.revision),
    ].join(':'),
  );
  return `epub-compat/v1${entries.length > 0 ? `;${entries.join(';')}` : ''}`;
}

function isPublicationRule(
  module: CompatibilityModule,
): module is PublicationCompatibilityRule {
  return module.family === 'publication';
}

function isContentDocumentRule(
  module: CompatibilityModule,
): module is ContentDocumentCompatibilityRule {
  return module.family === 'content-document';
}

function isResourceRule(
  module: CompatibilityModule,
): module is ResourceCompatibilityRule {
  return module.family === 'resource';
}

function isRenditionPolicy(
  module: CompatibilityModule,
): module is RenditionCompatibilityPolicy {
  return module.family === 'rendition';
}
