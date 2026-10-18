import { ReaderToolIcon } from '../chrome/reader-icons';
import { EpubKeyboardHelp } from '../overlays/EpubKeyboardHelp';
import { EpubCompatibilityPanel } from '../panels/EpubCompatibilityPanel';
import { EpubContents } from '../panels/EpubContents';
import { EpubMarksPanel } from '../panels/EpubMarksPanel';
import { EpubSearchPanel } from '../panels/EpubSearchPanel';
import { EpubSettingsPanel } from '../panels/EpubSettingsPanel';
import type { ReaderToolModule } from './model';
import { BUILT_IN_READER_TOOL_MANIFEST } from './built-in-reader-tool-manifest';

/** Built-ins use the same public module contract as product-contributed tools. */
const BUILT_IN_RENDERERS: Record<
  (typeof BUILT_IN_READER_TOOL_MANIFEST)[number]['id'],
  Pick<ReaderToolModule, 'renderIcon' | 'render'>
> = {
  contents: {
    renderIcon: () => <ReaderToolIcon id="contents" />,
    render: ({ reader }) => <EpubContents reader={reader} />,
  },
  search: {
    renderIcon: () => <ReaderToolIcon id="search" />,
    render: ({ reader }) => <EpubSearchPanel reader={reader} />,
  },
  marks: {
    renderIcon: () => <ReaderToolIcon id="marks" />,
    render: ({ reader }) => <EpubMarksPanel reader={reader} />,
  },
  settings: {
    renderIcon: () => <ReaderToolIcon id="settings" />,
    render: ({ reader }) => <EpubSettingsPanel reader={reader} />,
  },
  compatibility: {
    renderIcon: () => <ReaderToolIcon id="compatibility" />,
    render: ({ reader }) => <EpubCompatibilityPanel reader={reader} />,
  },
  help: {
    renderIcon: () => <ReaderToolIcon id="help" />,
    render: ({ shortcutGroups }) => (
      <EpubKeyboardHelp groups={shortcutGroups} />
    ),
  },
};

export const BUILT_IN_READER_TOOLS: readonly ReaderToolModule[] = Object.freeze(
  BUILT_IN_READER_TOOL_MANIFEST.map((metadata) =>
    Object.freeze({
      ...metadata,
      ...BUILT_IN_RENDERERS[metadata.id],
    }),
  ),
);
