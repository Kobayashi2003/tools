/* eslint-disable react-refresh/only-export-components -- The provider and hooks intentionally share one private context. */
import { createContext, useContext, type ReactNode } from 'react';
import type { ReaderUiConfiguration } from './model';
import { DEFAULT_READER_UI_CONFIGURATION } from './reader-ui-configuration';
import type { ReaderToolRegistry } from '../tools/model';
import { createReaderToolRegistry } from '../tools/reader-tool-registry';
import { BUILT_IN_READER_TOOLS } from '../tools/built-in-reader-tools';
import type { ReaderSurfaceRendererRegistry } from '../surfaces/model';
import { createReaderSurfaceRendererRegistry } from '../surfaces/reader-surface-renderer-registry';
import { BUILT_IN_READER_SURFACE_RENDERERS } from '../surfaces/built-in-reader-surface-renderers';

export interface RuntimeReaderUiConfiguration extends ReaderUiConfiguration {
  readonly tools: ReaderToolRegistry;
  readonly surfaceRendererRegistry: ReaderSurfaceRendererRegistry;
}

export function resolveReaderUiConfiguration(
  configuration: ReaderUiConfiguration,
): RuntimeReaderUiConfiguration {
  return Object.freeze({
    ...configuration,
    tools: createReaderToolRegistry([
      ...BUILT_IN_READER_TOOLS,
      ...configuration.toolModules,
    ]),
    surfaceRendererRegistry: createReaderSurfaceRendererRegistry(
      BUILT_IN_READER_SURFACE_RENDERERS,
      configuration.surfaceRenderers,
    ),
  });
}

const ReaderUiConfigurationContext =
  createContext<RuntimeReaderUiConfiguration>(
    resolveReaderUiConfiguration(DEFAULT_READER_UI_CONFIGURATION),
  );

export function ReaderUiConfigurationProvider({
  configuration,
  children,
}: {
  readonly configuration: RuntimeReaderUiConfiguration;
  readonly children: ReactNode;
}) {
  return (
    <ReaderUiConfigurationContext.Provider value={configuration}>
      {children}
    </ReaderUiConfigurationContext.Provider>
  );
}

export function useReaderUiConfiguration(): RuntimeReaderUiConfiguration {
  return useContext(ReaderUiConfigurationContext);
}
