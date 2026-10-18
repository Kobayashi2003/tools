import type {
  CompatibilityRepair,
  PublicationDiagnostic,
} from '../publication';
export type CompatibilityModuleFamily =
  'publication' | 'content-document' | 'resource' | 'rendition';

export type CompatibilityModuleStage =
  | 'publication.rootfile-selection'
  | 'publication.navigation-fallback'
  | 'content-document.processing'
  | 'resource.binary'
  | 'resource.stylesheet'
  | 'resource.inline-style'
  | 'rendition.policy';

/** Fixed kernel order; registration order matters only within one stage. */
export const COMPATIBILITY_MODULE_STAGE_ORDER: readonly CompatibilityModuleStage[] =
  Object.freeze([
    'publication.rootfile-selection',
    'publication.navigation-fallback',
    'content-document.processing',
    'resource.binary',
    'resource.stylesheet',
    'resource.inline-style',
    'rendition.policy',
  ]);

/** Metadata shared by every phase-specific EPUB compatibility contract. */
export interface CompatibilityModuleDescriptor {
  readonly id: string;
  readonly dependencies?: readonly string[];
  readonly family: CompatibilityModuleFamily;
  readonly stage: CompatibilityModuleStage;
  /** Changes whenever the module can produce a different cache-visible result. */
  readonly revision: string;
  readonly enabledByDefault: boolean;
}

export interface CompatibilityRuleResult<T> {
  readonly value: T;
  readonly diagnostics?: readonly PublicationDiagnostic[];
}

export interface CompatibilityRunResult<T> {
  readonly value: T;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export type CompatibilityStatus = 'clean' | 'repaired' | 'degraded' | 'blocked';

export interface AppliedCompatibilityRepair {
  readonly code: string;
  readonly strategy: CompatibilityRepair['strategy'];
  readonly description: CompatibilityRepair['description'];
  readonly confidence?: number;
  readonly resolvesCodes?: readonly string[];
  readonly diagnostic: PublicationDiagnostic;
}

export interface CompatibilityReport {
  readonly status: CompatibilityStatus;
  readonly repairs: readonly AppliedCompatibilityRepair[];
  readonly unresolved: readonly PublicationDiagnostic[];
  readonly warnings: readonly PublicationDiagnostic[];
  readonly infos: readonly PublicationDiagnostic[];
}

export function compatibilityModuleFailureDiagnostic(
  module: CompatibilityModuleDescriptor,
  error: unknown,
  location: {
    readonly path?: import('../publication').PublicationPath;
    readonly spineIndex?: number;
  } = {},
): PublicationDiagnostic {
  return {
    code: 'COMPATIBILITY_MODULE_FAILED',
    severity: 'warning',
    phase: 'compatibility',
    message: `Compatibility module ${module.id} failed during ${module.stage}; its changes were not applied.`,
    ...location,
    cause: error,
  };
}
