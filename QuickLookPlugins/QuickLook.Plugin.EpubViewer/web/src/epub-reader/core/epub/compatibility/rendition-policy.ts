import type {
  ContentPresentationHints,
  Publication,
  PublicationDiagnostic,
  ReaderPreferences,
  SpineItem,
} from '../publication';
import {
  compatibilityModuleFailureDiagnostic,
  type CompatibilityModuleDescriptor,
  type CompatibilityRuleResult,
  type CompatibilityRunResult,
} from './model';

export interface RenditionCompatibilityContext {
  readonly publication: Publication;
  readonly spineItem: SpineItem;
  readonly contentHints?: ContentPresentationHints;
  readonly preferences: ReaderPreferences;
}

/** Closed directives consumed by the fixed rendition planner/renderer path. */
export interface RenditionCompatibilityDirectives {
  readonly fitSingleImagePage: boolean;
}

export interface RenditionCompatibilityPolicy extends CompatibilityModuleDescriptor {
  readonly family: 'rendition';
  readonly stage: 'rendition.policy';
  apply(
    context: RenditionCompatibilityContext,
    directives: RenditionCompatibilityDirectives,
  ): CompatibilityRuleResult<RenditionCompatibilityDirectives>;
}

export function runRenditionCompatibilityPolicies(
  policies: readonly RenditionCompatibilityPolicy[],
  context: RenditionCompatibilityContext,
  initial: RenditionCompatibilityDirectives,
): CompatibilityRunResult<RenditionCompatibilityDirectives> {
  let value = Object.freeze({ ...initial });
  const diagnostics: PublicationDiagnostic[] = [];
  for (const policy of policies) {
    try {
      const result = policy.apply(context, value);
      if (typeof result.value.fitSingleImagePage !== 'boolean') {
        throw new TypeError(
          'Rendition compatibility fitSingleImagePage directive must be boolean.',
        );
      }
      value = Object.freeze({ ...result.value });
      diagnostics.push(...(result.diagnostics ?? []));
    } catch (error) {
      diagnostics.push(
        compatibilityModuleFailureDiagnostic(policy, error, {
          path: context.spineItem.path,
          spineIndex: context.spineItem.index,
        }),
      );
    }
  }
  return Object.freeze({ value, diagnostics: Object.freeze(diagnostics) });
}
