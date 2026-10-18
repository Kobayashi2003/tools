import type { ChangeEvent } from 'react';
import {
  DEFAULT_READER_COMPATIBILITY_PREFERENCES,
  type ReaderCompatibilityPreferences,
} from '../../../core';
import type { EpubReaderHandle } from '../../state/model';

const COMPATIBILITY_GROUPS = [
  {
    title: 'Document parsing',
    items: [
      {
        key: 'recoverContainerStructure',
        label: 'Recover container structure',
        description:
          'Recoverable OCF/ZIP deviations → readable EPUB container.',
      },
      {
        key: 'selectPreferredRootfile',
        label: 'Select preferred package',
        description: 'Several rootfiles → the first standard OPF package.',
      },
      {
        key: 'recoverMalformedXhtml',
        label: 'Recover malformed XHTML',
        description: 'Non-well-formed XHTML → browser HTML parsing.',
      },
    ],
  },
  {
    title: 'Navigation',
    items: [
      {
        key: 'useLegacyNavigationFallback',
        label: 'Use legacy navigation',
        description: 'Missing EPUB 3 navigation → EPUB 2 NCX and Guide.',
      },
    ],
  },
  {
    title: 'Layout',
    items: [
      {
        key: 'normalizeLegacyCss',
        label: 'Normalize legacy CSS',
        description: 'Legacy -epub/-webkit declarations → standard CSS.',
      },
      {
        key: 'fitSingleImagePages',
        label: 'Fit single-image pages',
        description: 'Image-only reflowable documents → one contained page.',
      },
    ],
  },
  {
    title: 'Resources',
    items: [
      {
        key: 'deobfuscateIdpfFonts',
        label: 'Decode IDPF fonts',
        description: 'IDPF-obfuscated fonts → browser-loadable fonts.',
      },
    ],
  },
] as const satisfies readonly {
  readonly title: string;
  readonly items: readonly {
    readonly key: keyof ReaderCompatibilityPreferences;
    readonly label: string;
    readonly description: string;
  }[];
}[];

export function CompatibilitySettings({
  reader,
  preferences,
}: {
  readonly reader: EpubReaderHandle;
  readonly preferences: ReaderCompatibilityPreferences;
}) {
  const setCompatibility = (
    key: keyof ReaderCompatibilityPreferences,
    enabled: boolean,
  ) =>
    void reader.setPreferences({
      compatibility: { [key]: enabled },
    });
  return (
    <>
      <div className="epub-settings-panel__advanced-intro">
        <div>
          <span>Compatibility</span>
          <strong>Publication recovery</strong>
        </div>
        <button
          type="button"
          onClick={() =>
            void reader.setPreferences({
              compatibility: DEFAULT_READER_COMPATIBILITY_PREFERENCES,
            })
          }
        >
          Restore defaults
        </button>
        <p>
          These options are intended for diagnosing unusual EPUB files. Changes
          take effect after reopening the book.
        </p>
      </div>
      {COMPATIBILITY_GROUPS.map((group) => (
        <div
          key={group.title}
          className="epub-settings-panel__section epub-settings-panel__compatibility-group"
        >
          <h3>{group.title}</h3>
          {group.items.map((item) => (
            <label
              key={item.key}
              className="epub-settings-panel__compatibility-option"
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={preferences[item.key]}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setCompatibility(item.key, event.currentTarget.checked)
                }
              />
            </label>
          ))}
        </div>
      ))}
      <div className="epub-settings-panel__section epub-settings-panel__compatibility-group">
        <h3>Core safeguards</h3>
        <p>
          These rules preserve a valid internal publication model and cannot be
          disabled.
        </p>
        <CompatibilitySafeguard
          label="Rendition declarations"
          description="Missing or conflicting values → specification defaults or the first valid declaration."
        />
        <CompatibilitySafeguard
          label="Publication resource paths"
          description="base/xml:base, CSS URLs, srcset and SVG references → isolated reader URLs."
        />
        <CompatibilitySafeguard
          label="Remote navigation"
          description="Remote TOC, page-list and landmark targets → readable labels without unsafe internal navigation."
        />
      </div>
    </>
  );
}

function CompatibilitySafeguard({
  label,
  description,
}: {
  readonly label: string;
  readonly description: string;
}) {
  return (
    <div className="epub-settings-panel__compatibility-option is-required">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span>Required</span>
    </div>
  );
}
