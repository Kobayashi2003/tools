/**
 * Publication-scoped reading progress.
 *
 * `sectionProgression` is how far the reader is through the current spine item.
 * This continuous model reserves one interval for every spine item, including
 * the final one, so a last reflowable chapter can advance from its start to
 * 100%. Pure fixed-layout publications use the discrete model below.
 */
export function publicationProgress(
  spineIndex: number,
  spineCount: number,
  sectionProgression = 0,
): number {
  if (!Number.isInteger(spineCount) || spineCount <= 0) return 0;
  const index = clamp(spineIndex, 0, spineCount - 1);
  const within = clamp(sectionProgression, 0, 1);
  return (index + within) / spineCount;
}

/** Discrete position for publications where every spine item is one page. */
export function fixedLayoutPublicationProgress(
  spineIndex: number,
  spineCount: number,
): number {
  if (!Number.isInteger(spineCount) || spineCount <= 1) return 0;
  return clamp(spineIndex, 0, spineCount - 1) / (spineCount - 1);
}

/** Inverse of {@link fixedLayoutPublicationProgress}. */
export function spineIndexForPublicationProgress(
  progress: number,
  spineCount: number,
): number {
  if (!Number.isInteger(spineCount) || spineCount <= 1) return 0;
  return Math.round(clamp(progress, 0, 1) * (spineCount - 1));
}

/** Inverse of {@link publicationProgress}, recovering the position within the section too. */
export function locationForPublicationProgress(
  progress: number,
  spineCount: number,
): { readonly spineIndex: number; readonly progression: number } {
  if (!Number.isInteger(spineCount) || spineCount <= 0)
    return { spineIndex: 0, progression: 0 };
  const scaled = clamp(progress, 0, 1) * spineCount;
  const spineIndex = Math.min(spineCount - 1, Math.floor(scaled));
  return { spineIndex, progression: clamp(scaled - spineIndex, 0, 1) };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
