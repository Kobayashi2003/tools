/**
 * EPUB support contract.
 *
 * "core" means the architecture must model the feature correctly from day one.
 * "renderer" means support is provided by the rendition and renderer layers.
 * "deferred" means the model/parser must preserve the data but v1 rendering may
 * degrade gracefully.
 * "blocked" means intentionally not executed for security/product reasons.
 */
export type SupportLevel = 'core' | 'renderer' | 'deferred' | 'blocked';

export interface SupportCapability {
  readonly level: SupportLevel;
  readonly notes: string;
}

export interface EpubSupportProfile {
  readonly id: string;
  readonly target: string;
  readonly capabilities: Readonly<Record<string, SupportCapability>>;
}

export const EPUB_READER_SUPPORT_PROFILE = {
  id: 'component-atlas-epub-reader-v1',
  target: 'EPUB 3.3-first reading system with EPUB 2 compatibility parsing',
  capabilities: {
    'epub3-package': {
      level: 'core',
      notes:
        'Parse container.xml, OPF metadata/manifest/spine and EPUB Navigation Document.',
    },
    'epub2-compatibility': {
      level: 'core',
      notes:
        'Parse common EPUB 2 OPF differences, NCX navigation and guide landmarks; rendering remains governed by the rendition plan.',
    },
    'reflowable-horizontal': {
      level: 'renderer',
      notes: 'Dedicated paginated and scrolled renderer paths.',
    },
    'reflowable-vertical': {
      level: 'renderer',
      notes:
        'Writing mode is modeled separately from page progression and text bidi direction.',
    },
    'fixed-layout': {
      level: 'renderer',
      notes:
        'Exactly one rendered page per effective pre-paginated spine item.',
    },
    'mixed-layout': {
      level: 'core',
      notes:
        'Per-spine rendition overrides are preserved; never flatten to a global isFixedLayout flag.',
    },
    'synthetic-spreads': {
      level: 'renderer',
      notes: 'Honor spread policy plus explicit left/right/center placement.',
    },
    'page-progression-ltr-rtl': {
      level: 'core',
      notes: 'Modeled independently from CSS writing-mode and bidi direction.',
    },
    'epub-cfi-point-locators': {
      level: 'core',
      notes:
        'Use EPUB CFI point locations as the primary durable anchor, including ID/text assertion correction; ranges are reduced to their start in point-reading contexts while full range/media-fragment support remains deferred.',
    },
    'svg-content': {
      level: 'renderer',
      notes:
        'Render SVG content/resources inside the isolated content surface.',
    },
    mathml: {
      level: 'deferred',
      notes:
        'Preserve and render when the browser can do so safely; conformance hardening comes later.',
    },
    'media-overlays': {
      level: 'deferred',
      notes:
        'Manifest relationships are preserved now; synchronized audio playback is a later feature.',
    },
    'scripted-content': {
      level: 'blocked',
      notes:
        'Publisher scripts are not executed by default; browser content surfaces sandbox without allow-scripts. Any future opt-in requires a separate security design.',
    },
    'remote-resources': {
      level: 'deferred',
      notes:
        'Model and diagnose them first; networking/security policy is intentionally separate.',
    },
    search: {
      level: 'core',
      notes:
        'Publication-wide search yields durable LocatorRange results without mutating publication DOM.',
    },
    annotations: {
      level: 'core',
      notes:
        'Bookmarks, highlights and annotations persist composite locators; visual decorations remain non-invasive.',
    },
    'compatibility-diagnostics': {
      level: 'core',
      notes:
        'Known malformed-publication recoveries are explicit repairs summarized as clean/repaired/degraded/blocked rather than silent monkey patches.',
    },
    'malformed-xhtml-recovery': {
      level: 'core',
      notes:
        'Non-well-formed XHTML may be recovered with browser HTML parsing; scripts remain disabled and the repair is reported explicitly.',
    },
    'html-xml-base': {
      level: 'core',
      notes:
        'Honor HTML base and inherited nested xml:base semantics before rewriting publication resources into isolated URLs.',
    },
    'archive-hardening': {
      level: 'core',
      notes:
        'OCF parsing enforces configurable compressed/uncompressed size, entry-count, central-directory and compression-ratio budgets before expansion.',
    },
  },
} as const satisfies EpubSupportProfile;
