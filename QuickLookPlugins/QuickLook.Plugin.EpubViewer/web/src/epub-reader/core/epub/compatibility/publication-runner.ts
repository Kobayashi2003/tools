import type {
  ContainerRootfile,
  NavigationModel,
  Publication,
  PublicationPath,
} from '../publication';
import {
  compatibilityModuleFailureDiagnostic,
  type CompatibilityModuleDescriptor,
  type CompatibilityRuleResult,
  type CompatibilityRunResult,
} from './model';

interface PublicationCompatibilityRuleBase extends CompatibilityModuleDescriptor {
  readonly family: 'publication';
}

export interface RootfileSelectionCompatibilityContext {
  readonly containerPath: PublicationPath;
  /** Candidates already parsed and path-normalized by the fixed OCF pipeline. */
  readonly rootfiles: readonly ContainerRootfile[];
}

export interface RootfileSelectionCompatibilityRule extends PublicationCompatibilityRuleBase {
  readonly stage: 'publication.rootfile-selection';
  apply(
    context: RootfileSelectionCompatibilityContext,
    selected: ContainerRootfile | null,
  ):
    | CompatibilityRuleResult<ContainerRootfile | null>
    | Promise<CompatibilityRuleResult<ContainerRootfile | null>>;
}

export interface NavigationFallbackCompatibilityContext {
  readonly publication: Publication;
  /** Authoritative navigation parsed by the fixed pipeline. */
  readonly primaryNavigation: NavigationModel;
  /** Optional legacy candidate parsed under the same fixed size/path limits. */
  readonly legacyNavigation?: NavigationModel;
  /** EPUB 2 Guide landmarks already normalized by the package parser. */
  readonly legacyLandmarks: NavigationModel['landmarks'];
}

export interface NavigationFallbackCompatibilityRule extends PublicationCompatibilityRuleBase {
  readonly stage: 'publication.navigation-fallback';
  apply(
    context: NavigationFallbackCompatibilityContext,
    navigation: NavigationModel,
  ):
    | CompatibilityRuleResult<NavigationModel>
    | Promise<CompatibilityRuleResult<NavigationModel>>;
}

export type PublicationCompatibilityRule =
  RootfileSelectionCompatibilityRule | NavigationFallbackCompatibilityRule;

export async function runRootfileSelectionCompatibility(
  rules: readonly PublicationCompatibilityRule[],
  context: RootfileSelectionCompatibilityContext,
  initial: ContainerRootfile | null,
): Promise<CompatibilityRunResult<ContainerRootfile | null>> {
  let value = initial;
  const diagnostics = [];
  for (const rule of rules) {
    if (rule.stage !== 'publication.rootfile-selection') continue;
    try {
      const result = await rule.apply(context, value);
      value = canonicalRootfile(context.rootfiles, result.value);
      diagnostics.push(...(result.diagnostics ?? []));
    } catch (error) {
      diagnostics.push(
        compatibilityModuleFailureDiagnostic(rule, error, {
          path: context.containerPath,
        }),
      );
    }
  }
  return freezeRunResult(value, diagnostics);
}

export async function runNavigationFallbackCompatibility(
  rules: readonly PublicationCompatibilityRule[],
  context: NavigationFallbackCompatibilityContext,
  initial: NavigationModel,
): Promise<CompatibilityRunResult<NavigationModel>> {
  let value = initial;
  const diagnostics = [];
  for (const rule of rules) {
    if (rule.stage !== 'publication.navigation-fallback') continue;
    try {
      const result = await rule.apply(context, value);
      assertNavigationModel(result.value);
      value = result.value;
      diagnostics.push(...(result.diagnostics ?? []));
    } catch (error) {
      diagnostics.push(
        compatibilityModuleFailureDiagnostic(rule, error, {
          path: context.publication.packagePath,
        }),
      );
    }
  }
  return freezeRunResult(value, diagnostics);
}

function canonicalRootfile(
  candidates: readonly ContainerRootfile[],
  selected: ContainerRootfile | null,
): ContainerRootfile | null {
  if (!selected) return null;
  const candidate = candidates.find(
    (rootfile) =>
      rootfile.fullPath === selected.fullPath &&
      rootfile.mediaType === selected.mediaType,
  );
  if (!candidate)
    throw new Error(
      `Selected rootfile ${selected.fullPath} is not one of the validated container candidates.`,
    );
  return candidate;
}

function assertNavigationModel(value: NavigationModel): void {
  if (!value || !['epub3-nav', 'ncx', 'none'].includes(value.source)) {
    throw new TypeError(
      'Compatibility navigation result must be a normalized NavigationModel.',
    );
  }
  if (
    !Array.isArray(value.toc) ||
    !Array.isArray(value.landmarks) ||
    !Array.isArray(value.pageList)
  ) {
    throw new TypeError(
      'Compatibility navigation result must contain normalized navigation collections.',
    );
  }
}

function freezeRunResult<T>(
  value: T,
  diagnostics: readonly import('../publication').PublicationDiagnostic[],
): CompatibilityRunResult<T> {
  return Object.freeze({ value, diagnostics: Object.freeze([...diagnostics]) });
}
