import {
  DEFAULT_READER_COMPATIBILITY_PREFERENCES,
  type Locator,
  type Publication,
  type PublicationDiagnostic,
  type ReaderPreferences,
} from './model';
import { cloneAndFreezePlainData } from '../../shared/immutable';

export function validatePublicationModel(
  publication: Publication,
): PublicationDiagnostic[] {
  const diagnostics: PublicationDiagnostic[] = [];
  const manifestIds = new Set<string>();
  const manifestHrefs = new Set<string>();

  for (const item of publication.manifest) {
    if (manifestIds.has(item.id)) {
      diagnostics.push({
        code: 'MODEL_DUPLICATE_MANIFEST_ID',
        severity: 'error',
        phase: 'package',
        message: `Duplicate manifest id: ${item.id}`,
        path: item.href,
      });
    }
    manifestIds.add(item.id);
    manifestHrefs.add(item.href);
  }

  publication.spine.forEach((item, expectedIndex) => {
    if (item.index !== expectedIndex) {
      diagnostics.push({
        code: 'MODEL_NON_CONTIGUOUS_SPINE_INDEX',
        severity: 'error',
        phase: 'package',
        message: `Spine item ${item.idref} has index ${item.index}; expected ${expectedIndex}.`,
        path: item.href,
        spineIndex: item.index,
      });
    }

    if (!manifestIds.has(item.idref) || !manifestHrefs.has(item.href)) {
      diagnostics.push({
        code: 'MODEL_SPINE_MANIFEST_MISMATCH',
        severity: 'error',
        phase: 'package',
        message: `Spine item ${item.idref} does not resolve cleanly to the manifest.`,
        path: item.href,
        spineIndex: item.index,
      });
    }
  });

  return diagnostics;
}

export function normalizeProgression(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function normalizeReaderPreferences(
  value: ReaderPreferences,
): ReaderPreferences {
  const compatibility =
    value.compatibility ?? DEFAULT_READER_COMPATIBILITY_PREFERENCES;
  return cloneAndFreezePlainData({
    ...value,
    fontSizePercent: clamp(value.fontSizePercent, 50, 300),
    lineHeight:
      value.lineHeight == null ? null : clamp(value.lineHeight, 0.8, 3),
    pageMarginPercent: clamp(value.pageMarginPercent, 0, 18),
    fixedLayoutFit: ['contain', 'width', 'height', 'original'].includes(
      value.fixedLayoutFit,
    )
      ? value.fixedLayoutFit
      : 'contain',
    fixedLayoutGutter: ['none', 'normal'].includes(value.fixedLayoutGutter)
      ? value.fixedLayoutGutter
      : 'none',
    touchNavigation: ['both', 'tap', 'swipe', 'off'].includes(
      value.touchNavigation,
    )
      ? value.touchNavigation
      : 'both',
    pageTurnZonePercent: clamp(value.pageTurnZonePercent, 10, 40),
    compatibility: {
      recoverContainerStructure:
        compatibility.recoverContainerStructure !== false,
      selectPreferredRootfile: compatibility.selectPreferredRootfile !== false,
      recoverMalformedXhtml: compatibility.recoverMalformedXhtml !== false,
      useLegacyNavigationFallback:
        compatibility.useLegacyNavigationFallback !== false,
      normalizeLegacyCss: compatibility.normalizeLegacyCss !== false,
      fitSingleImagePages: compatibility.fitSingleImagePages !== false,
      deobfuscateIdpfFonts: compatibility.deobfuscateIdpfFonts !== false,
    },
  });
}

export function isLocatorForPublication(
  locator: Locator,
  publication: Publication,
): boolean {
  const item = publication.spine[locator.spineIndex];
  return item !== undefined && item.href === locator.href;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
