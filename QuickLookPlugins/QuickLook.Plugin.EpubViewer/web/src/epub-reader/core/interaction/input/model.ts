import type { PageProgressionDirection } from '../../epub/publication';

export type ReaderHostCommand =
  | { readonly type: 'open-search'; readonly source: InputSource }
  | { readonly type: 'open-help'; readonly source: InputSource }
  | { readonly type: 'toggle-chrome'; readonly source: InputSource }
  | { readonly type: 'escape'; readonly source: InputSource };

export type ReaderCommand =
  | {
      readonly type: 'navigate';
      readonly direction: 'forward' | 'backward';
      readonly source: InputSource;
    }
  | ReaderHostCommand
  | { readonly type: 'history-back'; readonly source: InputSource }
  | { readonly type: 'history-forward'; readonly source: InputSource }
  | {
      readonly type: 'font-step';
      readonly delta: 1 | -1;
      readonly source: InputSource;
    };

export type InputSource =
  'keyboard' | 'wheel' | 'click-zone' | 'center-tap' | 'swipe';

export interface ReaderInputPolicy {
  readonly keyboard: boolean;
  readonly wheel: 'none' | 'page';
  readonly ctrlWheelFontSize: boolean;
  readonly clickZones: boolean;
  readonly clickZoneRatio: number;
  readonly swipe: boolean;
  readonly swipeThresholdPx: number;
  readonly wheelThreshold: number;
  readonly wheelCooldownMs: number;
}

export const DEFAULT_READER_INPUT_POLICY: ReaderInputPolicy = Object.freeze({
  keyboard: true,
  wheel: 'page',
  ctrlWheelFontSize: true,
  clickZones: true,
  clickZoneRatio: 0.24,
  swipe: true,
  swipeThresholdPx: 56,
  wheelThreshold: 18,
  wheelCooldownMs: 240,
});

export interface ReaderInputState {
  readonly pageProgression: PageProgressionDirection;
  readonly enabled: boolean;
  readonly contentKind: 'reflowable' | 'fixed-layout';
  readonly presentation: 'paginated' | 'scrolled';
  /** Fixed-layout overflow may scroll within a page and turn at its edges. */
  readonly wheelBoundaryNavigation: boolean;
  readonly touchNavigation?: import('../../epub/publication').TouchNavigationPreference;
  readonly pageTurnZonePercent?: number;
}

export interface ReaderInputDispatcher {
  dispatch(command: ReaderCommand): void | Promise<void>;
}

export type ReaderInputSignal =
  | ({ readonly kind: 'keyboard' } & import('./commands').KeyLike)
  | {
      readonly kind: 'wheel';
      readonly deltaY: number;
      readonly modified: boolean;
    }
  | {
      readonly kind: 'page-click';
      readonly clientX: number;
      readonly width: number;
      readonly ratio: number;
      readonly edgeNavigation: boolean;
    }
  | {
      readonly kind: 'swipe';
      readonly deltaX: number;
      readonly threshold: number;
    };

export interface ReaderShortcutItem {
  readonly keys: readonly string[];
  readonly action: string;
}

export interface ReaderShortcutGroup {
  readonly label: string;
  readonly items: readonly ReaderShortcutItem[];
}

export interface ReaderInputMapDescription {
  readonly bindingIds: readonly string[];
  readonly shortcutGroups: readonly ReaderShortcutGroup[];
}

export interface ReaderInputBinding {
  readonly id: string;
  readonly priority?: number;
  readonly kinds: readonly ReaderInputSignal['kind'][];
  readonly shortcuts?: readonly ReaderShortcutGroup[];
  map(signal: ReaderInputSignal, state: ReaderInputState): ReaderCommand | null;
}

export interface ReaderInputResolution {
  readonly command: ReaderCommand | null;
  readonly failures: readonly {
    readonly bindingId: string;
    readonly error: unknown;
  }[];
}

export interface ReaderInputMap {
  readonly description: ReaderInputMapDescription;
  resolve(
    signal: ReaderInputSignal,
    state: ReaderInputState,
  ): ReaderInputResolution;
}
