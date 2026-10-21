import type { CompareMode, ViewMode } from './types';
import type { MatchStrategy } from './match';

export interface AppState {
  mode: CompareMode;
  view: ViewMode;
  selected: string[];
  /** 对照策略 */
  strategy: MatchStrategy;
  /** 忽略人口不足 100 万的微型经济体 */
  ignoreMicro: boolean;
}

const DEFAULTS: AppState = {
  mode: 'region-to-country',
  view: 'map',
  selected: [],
  strategy: 'over',
  ignoreMicro: true
};

const STRATEGIES: MatchStrategy[] = ['many', 'over', 'big', 'nearest'];

function readState(): AppState {
  if (typeof window === 'undefined') return DEFAULTS;
  const p = new URLSearchParams(window.location.search);
  const mode = p.get('mode');
  const view = p.get('view');
  const strategy = p.get('st') as MatchStrategy | null;
  const selected = (p.get('sel') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    mode: mode === 'country-to-region' ? 'country-to-region' : 'region-to-country',
    view: view === 'globe' ? 'globe' : 'map',
    selected,
    strategy: strategy && STRATEGIES.includes(strategy) ? strategy : DEFAULTS.strategy,
    ignoreMicro: p.get('micro') === '0' ? false : DEFAULTS.ignoreMicro
  };
}

export function loadState(): AppState {
  return readState();
}

function buildQuery(state: AppState): string {
  const p = new URLSearchParams();
  if (state.mode !== DEFAULTS.mode) p.set('mode', state.mode);
  if (state.view !== DEFAULTS.view) p.set('view', state.view);
  if (state.selected.length) p.set('sel', state.selected.join(','));
  if (state.strategy !== DEFAULTS.strategy) p.set('st', state.strategy);
  if (state.ignoreMicro !== DEFAULTS.ignoreMicro) p.set('micro', state.ignoreMicro ? '0' : '1');
  return p.toString();
}

export function writeState(state: AppState): void {
  const query = buildQuery(state);
  const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', url);
}

export function shareUrl(state: AppState): string {
  const query = buildQuery(state);
  return `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ''}`;
}
