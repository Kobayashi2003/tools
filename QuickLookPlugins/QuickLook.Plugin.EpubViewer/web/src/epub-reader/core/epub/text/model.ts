export interface SemanticTextSegment {
  readonly start: number;
  readonly end: number;
  readonly node: Text;
  /** Maps each normalized text boundary back to the source Text.data offset. */
  readonly sourceBoundaries: readonly number[];
}

export interface SemanticTextProjection {
  readonly text: string;
  readonly segments: readonly SemanticTextSegment[];
}
