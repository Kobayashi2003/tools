/* eslint-disable react-refresh/only-export-components -- Context provider and its hooks form one public module. */
import { createContext, useContext, type ReactNode } from 'react';
import type { EpubReaderHandle } from '../state/model';

const EpubReaderContext = createContext<EpubReaderHandle | null>(null);

export function EpubReaderProvider({
  reader,
  children,
}: {
  readonly reader: EpubReaderHandle;
  readonly children: ReactNode;
}) {
  return (
    <EpubReaderContext.Provider value={reader}>
      {children}
    </EpubReaderContext.Provider>
  );
}

export function useOptionalEpubReaderContext(): EpubReaderHandle | null {
  return useContext(EpubReaderContext);
}

export function useEpubReaderContext(): EpubReaderHandle {
  const reader = useOptionalEpubReaderContext();
  if (!reader)
    throw new Error(
      'useEpubReaderContext() must be used inside <EpubReaderProvider>.',
    );
  return reader;
}
