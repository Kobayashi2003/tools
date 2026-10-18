import type { AnnotationColor } from '../../core';

/**
 * Every colour the engine can store, in the order the interface offers them.
 * Typed as the engine's own union, so a colour added there fails to compile
 * here until the interface can show it.
 */
export const ANNOTATION_COLORS: readonly AnnotationColor[] = [
  'yellow',
  'orange',
  'pink',
  'green',
  'blue',
  'purple',
];

/**
 * The shorter set the selection toolbar offers.
 *
 * Highlighting happens mid-sentence with the toolbar floating over the text, so
 * it stays a quick pick; the mark popover is where a saved mark gets the full
 * palette. Deliberately a subset of {@link ANNOTATION_COLORS} rather than an
 * independent list.
 */
export const QUICK_ANNOTATION_COLORS: readonly AnnotationColor[] =
  ANNOTATION_COLORS.filter((color) => color !== 'orange' && color !== 'purple');
