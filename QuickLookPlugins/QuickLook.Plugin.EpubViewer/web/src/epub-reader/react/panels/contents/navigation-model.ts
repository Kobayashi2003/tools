import type { Landmark } from '../../../core';

export function landmarkLabel(landmark: Landmark): string {
  return (
    landmark.types.map((type) => type.replace(/[-_]+/gu, ' ')).join(', ') ||
    'Landmark'
  );
}
