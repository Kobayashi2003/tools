import { assertExtensionId, orderExtensions } from '../../extension/model';
import {
  COMPATIBILITY_MODULE_STAGE_ORDER,
  type CompatibilityModuleFamily,
  type CompatibilityModuleStage,
} from './model';
import {
  createCompatibilityProfile,
  type CompatibilityModule,
  type CompatibilityProfile,
} from './profile';

export interface CompatibilityProfileOptions {
  readonly enable?: readonly string[];
  readonly disable?: readonly string[];
}

export class DuplicateCompatibilityModuleError extends Error {
  constructor(readonly moduleId: string) {
    super(`Duplicate compatibility module id: ${moduleId}.`);
    this.name = 'DuplicateCompatibilityModuleError';
  }
}

export class UnknownCompatibilityModuleError extends Error {
  constructor(readonly moduleId: string) {
    super(`Unknown compatibility module id: ${moduleId}.`);
    this.name = 'UnknownCompatibilityModuleError';
  }
}

export class MissingCompatibilityDependencyError extends Error {
  constructor(
    readonly moduleId: string,
    readonly dependencyId: string,
  ) {
    super(
      `Compatibility module ${moduleId} requires unregistered module ${dependencyId}.`,
    );
    this.name = 'MissingCompatibilityDependencyError';
  }
}

export class ConflictingCompatibilitySelectionError extends Error {
  constructor(readonly moduleId: string) {
    super(
      `Compatibility module ${moduleId} cannot be both enabled and disabled.`,
    );
    this.name = 'ConflictingCompatibilitySelectionError';
  }
}

export class DisabledCompatibilityDependencyError extends Error {
  constructor(
    readonly moduleId: string,
    readonly dependencyId: string,
  ) {
    super(
      `Compatibility module ${moduleId} requires explicitly disabled module ${dependencyId}.`,
    );
    this.name = 'DisabledCompatibilityDependencyError';
  }
}

export class CrossStageCompatibilityDependencyError extends Error {
  constructor(
    readonly moduleId: string,
    readonly dependencyId: string,
  ) {
    super(
      `Compatibility module ${moduleId} cannot depend on ${dependencyId} from another execution stage.`,
    );
    this.name = 'CrossStageCompatibilityDependencyError';
  }
}

export class CompatibilityRegistry {
  private readonly registered = new Map<string, CompatibilityModule>();

  constructor(modules: readonly CompatibilityModule[] = []) {
    for (const module of modules) this.register(module);
  }

  get size(): number {
    return this.registered.size;
  }

  register(module: CompatibilityModule): () => void {
    validateModule(module);
    if (this.registered.has(module.id))
      throw new DuplicateCompatibilityModuleError(module.id);
    const stored = freezeModule(module);
    this.registered.set(stored.id, stored);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.registered.get(stored.id) === stored)
        this.registered.delete(stored.id);
    };
  }

  createProfile(
    options: CompatibilityProfileOptions = {},
  ): CompatibilityProfile {
    const enabled = new Set(options.enable ?? []);
    const disabled = new Set(options.disable ?? []);
    for (const id of [...enabled, ...disabled]) {
      assertExtensionId(id, 'Compatibility profile module id');
      if (!this.registered.has(id))
        throw new UnknownCompatibilityModuleError(id);
    }
    for (const id of enabled) {
      if (disabled.has(id))
        throw new ConflictingCompatibilitySelectionError(id);
    }

    const selected = new Set<string>(enabled);
    for (const module of this.registered.values()) {
      if (module.enabledByDefault && !disabled.has(module.id))
        selected.add(module.id);
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...selected]) {
        const module = this.registered.get(id)!;
        for (const dependencyId of module.dependencies ?? []) {
          const dependency = this.registered.get(dependencyId);
          if (!dependency)
            throw new MissingCompatibilityDependencyError(
              module.id,
              dependencyId,
            );
          if (
            dependency.family !== module.family ||
            dependency.stage !== module.stage
          ) {
            throw new CrossStageCompatibilityDependencyError(
              module.id,
              dependencyId,
            );
          }
          if (disabled.has(dependencyId)) {
            throw new DisabledCompatibilityDependencyError(
              module.id,
              dependencyId,
            );
          }
          if (!selected.has(dependencyId)) {
            selected.add(dependencyId);
            changed = true;
          }
        }
      }
    }

    const selectedModules = [...this.registered.values()].filter((module) =>
      selected.has(module.id),
    );
    const ordered = COMPATIBILITY_MODULE_STAGE_ORDER.flatMap((stage) =>
      orderExtensions(
        selectedModules.filter((module) => module.stage === stage),
      ),
    );
    return createCompatibilityProfile(ordered);
  }

  modules(): readonly CompatibilityModule[] {
    return Object.freeze([...this.registered.values()]);
  }
}

function validateModule(module: CompatibilityModule): void {
  assertExtensionId(module.id, 'Compatibility module id');
  if (!COMPATIBILITY_MODULE_STAGE_ORDER.includes(module.stage)) {
    throw new TypeError(
      `Compatibility module ${module.id} declares an unknown execution stage.`,
    );
  }
  if (module.family !== familyForStage(module.stage)) {
    throw new TypeError(
      `Compatibility module ${module.id} family does not match stage ${module.stage}.`,
    );
  }
  if (typeof module.apply !== 'function') {
    throw new TypeError(
      `Compatibility module ${module.id} must provide an apply function.`,
    );
  }
  if (
    typeof module.revision !== 'string' ||
    module.revision.length === 0 ||
    module.revision.trim() !== module.revision
  ) {
    throw new TypeError(
      `Compatibility module ${module.id} must declare a non-empty, trimmed revision.`,
    );
  }
  if (typeof module.enabledByDefault !== 'boolean') {
    throw new TypeError(
      `Compatibility module ${module.id} must declare enabledByDefault explicitly.`,
    );
  }
  for (const dependency of module.dependencies ?? []) {
    assertExtensionId(
      dependency,
      `Compatibility dependency id for ${module.id}`,
    );
  }
}

function familyForStage(
  stage: CompatibilityModuleStage,
): CompatibilityModuleFamily {
  switch (stage) {
    case 'publication.rootfile-selection':
    case 'publication.navigation-fallback':
      return 'publication';
    case 'content-document.processing':
      return 'content-document';
    case 'resource.binary':
    case 'resource.stylesheet':
    case 'resource.inline-style':
      return 'resource';
    case 'rendition.policy':
      return 'rendition';
  }
}

function freezeModule<T extends CompatibilityModule>(module: T): T {
  if (module.dependencies) Object.freeze(module.dependencies);
  return Object.freeze(module);
}
