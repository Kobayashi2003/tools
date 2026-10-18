import {
  BUILT_IN_COMPATIBILITY_MODULES,
  CompatibilityRegistry,
} from '../../epub/compatibility';
import {
  BUILT_IN_READER_INPUT_BINDINGS,
  ReaderInputBindingRegistry,
} from '../../interaction/input';
import {
  BUILTIN_READER_THEMES,
  ReaderThemeRegistry,
} from '../../presentation/appearance';
import type {
  ReaderExtensionConfiguration,
  ReaderExtensionContributions,
} from './model';

/**
 * Validates and combines host contributions with the reader's built-ins.
 * Call this at application composition time and pass the result to `extensions`.
 */
export function configureReaderExtensions(
  contributions: ReaderExtensionContributions = {},
): ReaderExtensionConfiguration {
  const compatibility = new CompatibilityRegistry([
    ...BUILT_IN_COMPATIBILITY_MODULES,
    ...(contributions.compatibilityModules ?? []),
  ]);
  const inputMap = new ReaderInputBindingRegistry([
    ...BUILT_IN_READER_INPUT_BINDINGS,
    ...(contributions.inputBindings ?? []),
  ]).createMap();
  const themeRegistry = new ReaderThemeRegistry([
    ...BUILTIN_READER_THEMES,
    ...(contributions.themes ?? []),
  ]);
  const themeCatalog = Object.freeze({
    resolve: themeRegistry.resolve.bind(themeRegistry),
    list: themeRegistry.list.bind(themeRegistry),
  });

  return Object.freeze({
    compatibilityModules: compatibility.modules(),
    inputMap,
    themeCatalog,
  });
}
