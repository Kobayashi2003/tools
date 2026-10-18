import type { CompatibilityModule } from '../../epub/compatibility';
import type {
  ReaderInputBinding,
  ReaderInputMap,
} from '../../interaction/input';
import type {
  ReaderThemeCatalog,
  ReaderThemeDefinition,
} from '../../presentation/appearance';

/** Typed, authority-limited contributions supplied by one host application. */
export interface ReaderExtensionContributions {
  /** EPUB-authored-content adaptations; these never migrate application data or APIs. */
  readonly compatibilityModules?: readonly CompatibilityModule[];
  /** Pure normalized-input to closed-command mappings. */
  readonly inputBindings?: readonly ReaderInputBinding[];
  /** Validated publication and optional closed host-UI color definitions. */
  readonly themes?: readonly ReaderThemeDefinition[];
}

/**
 * Validated configuration consumed by a reader session.
 *
 * It deliberately has typed buckets instead of a generic plugin collection so
 * each contribution keeps the authority and failure policy of its own phase.
 */
export interface ReaderExtensionConfiguration {
  readonly compatibilityModules: readonly CompatibilityModule[];
  readonly inputMap: ReaderInputMap;
  readonly themeCatalog: ReaderThemeCatalog;
}
