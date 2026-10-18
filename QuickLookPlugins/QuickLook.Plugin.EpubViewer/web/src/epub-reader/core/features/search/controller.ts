import type { ReaderNavigator } from '../../interaction/navigation';
import type {
  ReaderSearchState,
  SearchHit,
  SearchOptions,
  SearchResultSet,
} from './model';
import { PublicationSearch } from './search';
import { cloneAndFreezePlainData } from '../../shared/immutable';

type SearchListener = (state: ReaderSearchState) => void;

export interface ReaderSearchNavigationResult {
  readonly hit: SearchHit;
  readonly locator: import('../../epub/publication').Locator;
}

export class ReaderSearchController {
  private active: AbortController | null = null;
  private readonly listeners = new Set<SearchListener>();
  private stateValue: ReaderSearchState = cloneAndFreezePlainData({
    query: '',
    hits: [],
    index: -1,
    searching: false,
    truncated: false,
    diagnostics: [],
    error: null,
  });
  private disposed = false;

  constructor(
    private readonly searchEngine: PublicationSearch,
    private readonly navigator: Pick<ReaderNavigator, 'goToLocator'>,
  ) {}

  get state(): ReaderSearchState {
    return this.stateValue;
  }

  onChange(listener: SearchListener): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => this.listeners.delete(listener);
  }

  async run(
    query: string,
    options: Partial<SearchOptions> = {},
  ): Promise<SearchResultSet> {
    this.assertAlive();
    this.active?.abort(new DOMException('Superseded search.', 'AbortError'));
    const controller = new AbortController();
    this.active = controller;
    this.setState({
      query,
      hits: [],
      index: -1,
      searching: true,
      truncated: false,
      diagnostics: [],
      error: null,
    });
    try {
      const result = await this.searchEngine.search(
        query,
        options,
        controller.signal,
      );
      if (this.active === controller) {
        this.setState({
          query: result.query,
          hits: result.hits,
          index: -1,
          searching: false,
          truncated: result.truncated,
          diagnostics: result.diagnostics,
          error: null,
        });
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          query: query.trim(),
          hits: [],
          truncated: false,
          diagnostics: [],
        };
      }
      if (this.active === controller)
        this.setState({ ...this.stateValue, searching: false, error });
      throw error;
    } finally {
      if (this.active === controller) this.active = null;
    }
  }

  async goToHit(index: number): Promise<ReaderSearchNavigationResult | null> {
    this.assertAlive();
    const hits = this.stateValue.hits;
    if (hits.length === 0) return null;
    const normalized = modulo(index, hits.length);
    const hit = hits[normalized]!;
    const locator = await this.navigator.goToLocator(hit.range.start);
    // A clear or a newer query may complete while navigation is queued. Only
    // select the hit if this is still the result set that initiated the move.
    if (this.stateValue.hits !== hits) return null;
    this.setState({ ...this.stateValue, index: normalized });
    return { hit, locator: locator ?? hit.range.start };
  }

  next(): Promise<ReaderSearchNavigationResult | null> {
    return this.goToHit(
      this.stateValue.index < 0 ? 0 : this.stateValue.index + 1,
    );
  }

  previous(): Promise<ReaderSearchNavigationResult | null> {
    return this.goToHit(
      this.stateValue.index < 0
        ? this.stateValue.hits.length - 1
        : this.stateValue.index - 1,
    );
  }

  clear(): void {
    this.assertAlive();
    this.active?.abort(new DOMException('Search cleared.', 'AbortError'));
    this.active = null;
    this.setState({
      query: '',
      hits: [],
      index: -1,
      searching: false,
      truncated: false,
      diagnostics: [],
      error: null,
    });
  }

  /** Release indexes independently from the visible search result set. */
  clearCache(): void {
    this.assertAlive();
    this.active?.abort(new DOMException('Search cache cleared.', 'AbortError'));
    this.active = null;
    this.searchEngine.clearCache();
    if (this.stateValue.searching)
      this.setState({ ...this.stateValue, searching: false, error: null });
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.searchEngine.clearCache();
    this.listeners.clear();
    this.disposed = true;
  }

  private setState(state: ReaderSearchState): void {
    this.stateValue = cloneAndFreezePlainData(state);
    for (const listener of this.listeners) listener(this.stateValue);
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new Error('ReaderSearchController has been disposed.');
  }
}

function modulo(value: number, length: number): number {
  return ((value % length) + length) % length;
}
