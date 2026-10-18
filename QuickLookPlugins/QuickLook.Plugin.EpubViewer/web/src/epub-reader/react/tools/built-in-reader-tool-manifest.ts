import type { ReaderToolCommand, ReaderToolPlacement } from './model';

export interface BuiltInReaderToolMetadata {
  readonly id:
    'contents' | 'search' | 'marks' | 'settings' | 'compatibility' | 'help';
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly placement: ReaderToolPlacement;
  readonly ariaKeyShortcuts?: string;
  readonly command?: ReaderToolCommand;
}

/** Pure metadata: safe for configuration validation and non-React contract tests. */
export const BUILT_IN_READER_TOOL_MANIFEST = Object.freeze([
  {
    id: 'contents',
    label: 'Contents',
    shortLabel: 'Contents',
    description: 'Navigate the publication',
    placement: 'navigation',
  },
  {
    id: 'search',
    label: 'Search',
    shortLabel: 'Search',
    description: 'Find text in this book',
    placement: 'primary',
    command: 'open-search',
    ariaKeyShortcuts: 'Control+F Meta+F',
  },
  {
    id: 'marks',
    label: 'Marks',
    shortLabel: 'Marks',
    description: 'Bookmarks, highlights and notes',
    placement: 'primary',
  },
  {
    id: 'settings',
    label: 'Reader settings',
    shortLabel: 'Settings',
    description: 'Display, layout and controls',
    placement: 'primary',
  },
  {
    id: 'compatibility',
    label: 'Book information',
    shortLabel: 'Book info',
    description: 'Compatibility and repairs',
    placement: 'secondary',
  },
  {
    id: 'help',
    label: 'Keyboard shortcuts',
    shortLabel: 'Help',
    description: 'Reader keyboard commands',
    placement: 'secondary',
    command: 'open-help',
    ariaKeyShortcuts: '?',
  },
] as const satisfies readonly BuiltInReaderToolMetadata[]);
