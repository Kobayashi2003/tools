import { configureReaderExtensions } from '../../core';
import { BUILT_IN_READER_TOOL_MANIFEST } from '../tools/built-in-reader-tool-manifest';
import { createReaderToolRegistry } from '../tools/reader-tool-registry';
import { createReaderSurfaceRendererRegistry } from '../surfaces/reader-surface-renderer-registry';
import type {
  ReaderUiConfiguration,
  ReaderUiConfigurationOptions,
} from './model';
import {
  DEFAULT_READER_UI_APPEARANCE,
  DEFAULT_READER_UI_LAYOUT,
  DEFAULT_READER_UI_MESSAGES,
} from './reader-ui-configuration/defaults';
import {
  assertFiniteRange,
  assertKnownKeys,
  validateMessages,
} from './reader-ui-configuration/validation';

export {
  DEFAULT_READER_UI_APPEARANCE,
  DEFAULT_READER_UI_LAYOUT,
  DEFAULT_READER_UI_MESSAGES,
} from './reader-ui-configuration/defaults';

/** Validates UI settings and composes Core extensions through their existing registries. */
export function configureReaderUi(
  options: ReaderUiConfigurationOptions = {},
): ReaderUiConfiguration {
  assertKnownKeys(
    options,
    {
      compatibilityModules: undefined,
      inputBindings: undefined,
      themes: undefined,
      tools: undefined,
      surfaceRenderers: undefined,
      messages: undefined,
      layout: undefined,
      appearance: undefined,
    },
    'Reader UI configuration',
  );
  assertKnownKeys(
    options.messages,
    DEFAULT_READER_UI_MESSAGES,
    'Reader UI messages',
  );
  assertKnownKeys(options.layout, DEFAULT_READER_UI_LAYOUT, 'Reader UI layout');
  assertKnownKeys(
    options.appearance,
    DEFAULT_READER_UI_APPEARANCE,
    'Reader UI appearance',
  );

  const messages = Object.freeze({
    ...DEFAULT_READER_UI_MESSAGES,
    ...options.messages,
  });
  validateMessages(messages);

  const layout = Object.freeze({
    ...DEFAULT_READER_UI_LAYOUT,
    ...options.layout,
  });
  assertFiniteRange(
    layout.compactBreakpointPx,
    320,
    1600,
    'compactBreakpointPx',
  );
  assertFiniteRange(layout.panelWidthPx, 280, 720, 'panelWidthPx');

  const appearance = Object.freeze({
    ...DEFAULT_READER_UI_APPEARANCE,
    ...options.appearance,
  });
  if (!['comfortable', 'compact'].includes(appearance.density)) {
    throw new TypeError(
      `Unsupported Reader UI density: ${String(appearance.density)}.`,
    );
  }
  if (!['system', 'reduced'].includes(appearance.motion)) {
    throw new TypeError(
      `Unsupported Reader UI motion policy: ${String(appearance.motion)}.`,
    );
  }

  const toolModules = createReaderToolRegistry(options.tools ?? []).modules;
  const surfaceRenderers = createReaderSurfaceRendererRegistry(
    [],
    options.surfaceRenderers ?? [],
  ).renderers;
  for (const module of toolModules) {
    if (
      BUILT_IN_READER_TOOL_MANIFEST.some((builtIn) => builtIn.id === module.id)
    ) {
      throw new TypeError(
        `Reader tool id ${module.id} is reserved by a built-in tool.`,
      );
    }
    if (
      module.command &&
      BUILT_IN_READER_TOOL_MANIFEST.some(
        (builtIn) => 'command' in builtIn && builtIn.command === module.command,
      )
    ) {
      throw new TypeError(
        `Reader command ${module.command} is reserved by a built-in tool.`,
      );
    }
  }

  return Object.freeze({
    extensions: configureReaderExtensions({
      compatibilityModules: options.compatibilityModules,
      inputBindings: options.inputBindings,
      themes: options.themes,
    }),
    toolModules,
    surfaceRenderers,
    messages,
    layout,
    appearance,
  });
}

export const DEFAULT_READER_UI_CONFIGURATION = configureReaderUi();
