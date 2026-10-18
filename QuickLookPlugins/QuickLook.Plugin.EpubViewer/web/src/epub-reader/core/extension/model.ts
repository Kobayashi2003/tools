export type ExtensionFailureMode = 'required' | 'optional';

/** Internal ordering contract shared by controlled extension registries. */
export interface OrderedExtension {
  readonly id: string;
  readonly dependencies?: readonly string[];
  /** Required extensions fail the host startup; optional ones are isolated. */
  readonly failureMode?: ExtensionFailureMode;
}

export class DuplicateExtensionIdError extends Error {
  constructor(readonly extensionId: string) {
    super(`Duplicate extension id: ${extensionId}.`);
    this.name = 'DuplicateExtensionIdError';
  }
}

export class CircularExtensionDependencyError extends Error {
  constructor(readonly dependencyPath: readonly string[]) {
    super(`Circular extension dependency: ${dependencyPath.join(' -> ')}.`);
    this.name = 'CircularExtensionDependencyError';
  }
}

export class ExtensionDependencyUnavailableError extends Error {
  constructor(
    readonly extensionId: string,
    readonly dependencyIds: readonly string[],
  ) {
    super(
      `Extension ${extensionId} requires unavailable dependencies: ${dependencyIds.join(', ')}.`,
    );
    this.name = 'ExtensionDependencyUnavailableError';
  }
}

export class RequiredExtensionStartError extends Error {
  constructor(
    readonly extensionId: string,
    readonly cause: unknown,
  ) {
    super(`Required extension ${extensionId} failed to start.`);
    this.name = 'RequiredExtensionStartError';
  }
}

export function assertExtensionId(value: string, label = 'Extension id'): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    /\s/.test(value)
  ) {
    throw new TypeError(
      `${label} must be a non-empty string without whitespace.`,
    );
  }
}

/**
 * Stable topological ordering. Registration order breaks ties between otherwise
 * independent extensions, while dependencies always precede their consumers.
 */
export function orderExtensions<T extends OrderedExtension>(
  extensions: readonly T[],
): readonly T[] {
  const byId = new Map<string, T>();
  for (const extension of extensions) {
    assertExtensionId(extension.id);
    if (byId.has(extension.id))
      throw new DuplicateExtensionIdError(extension.id);
    byId.set(extension.id, extension);
    for (const dependency of extension.dependencies ?? []) {
      assertExtensionId(dependency, `Dependency id for ${extension.id}`);
    }
  }

  const ordered: T[] = [];
  const states = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];

  const visit = (extension: T): void => {
    const state = states.get(extension.id);
    if (state === 'visited') return;
    if (state === 'visiting') {
      const cycleStart = stack.indexOf(extension.id);
      throw new CircularExtensionDependencyError([
        ...stack.slice(Math.max(0, cycleStart)),
        extension.id,
      ]);
    }

    states.set(extension.id, 'visiting');
    stack.push(extension.id);
    for (const dependencyId of extension.dependencies ?? []) {
      const dependency = byId.get(dependencyId);
      if (dependency) visit(dependency);
    }
    stack.pop();
    states.set(extension.id, 'visited');
    ordered.push(extension);
  };

  for (const extension of extensions) visit(extension);
  return Object.freeze(ordered);
}
