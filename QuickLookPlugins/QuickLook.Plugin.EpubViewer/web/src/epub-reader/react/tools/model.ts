import type {
  Annotation,
  Highlight,
  ReaderHostCommand,
  ReaderShortcutGroup,
} from '../../core';
import type { ReactNode } from 'react';
import type { EpubReaderHandle } from '../state/model';

/** Stable identity shared by toolbar controls and the Shell's panel surface. */
export type ReaderToolId = string;

/** Shell-owned toolbar regions. Modules choose a region, not an arbitrary slot. */
export type ReaderToolPlacement = 'navigation' | 'primary' | 'secondary';

/** Only Core host commands with an existing Shell meaning may open a tool. */
export type ReaderToolCommand = Extract<
  ReaderHostCommand['type'],
  'open-search' | 'open-help'
>;

export interface ReaderToolContext {
  readonly reader: EpubReaderHandle;
  readonly shortcutGroups?: readonly ReaderShortcutGroup[];
  readonly openMarkEditor: (
    mark: Highlight | Annotation,
    trigger: HTMLButtonElement,
  ) => void;
}

/** A peer reading tool. The Shell still owns its wrapper, focus and lifecycle. */
export interface ReaderToolModule {
  readonly id: ReaderToolId;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly placement: ReaderToolPlacement;
  readonly ariaKeyShortcuts?: string;
  readonly command?: ReaderToolCommand;
  readonly isAvailable?: (
    context: Pick<ReaderToolContext, 'reader'>,
  ) => boolean;
  readonly renderIcon: () => ReactNode;
  readonly render: (context: ReaderToolContext) => ReactNode;
}

export interface ReaderToolRegistry {
  /** All validated modules in deterministic registration order. */
  readonly modules: readonly ReaderToolModule[];
  resolve(id: ReaderToolId): ReaderToolModule | undefined;
  forCommand(command: ReaderToolCommand): ReaderToolModule | undefined;
  available(
    context: Pick<ReaderToolContext, 'reader'>,
  ): readonly ReaderToolModule[];
}
