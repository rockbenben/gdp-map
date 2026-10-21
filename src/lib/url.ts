import type { CompareMode, ViewMode } from './types';
import type { MatchStrategy } from './match';
import type { MetricId } from './metrics';

export interface AppState {
  mode: CompareMode;
  view: ViewMode;
  selected: string[];
  /** 对照策略 */
  strategy: MatchStrategy;
  /** 对比指标 */
  metric: MetricId;
  /** 忽略人口不足 100 万的微型经济体 */
  ignoreMicro: boolean;
}

const DEFAULTS: AppState = {
  mode: 'region-to-country',
  view: 'map',
  selected: [],
  strategy: 'over',
  metric: 'gdp',
  ignoreMicro: true
};

const STRATEGIES: MatchStrategy[] = ['many', 'over', 'big', 'nearest'];
const METRICS: MetricId[] = ['gdp', 'gdpPc', 'area', 'pop'];

function readState(): AppState {
  if (typeof window === 'undefined') return DEFAULTS;
  const p = new URLSearchParams(window.location.search);
  const mode = p.get('mode');
  const view = p.get('view');
  const strategy = p.get('st') as MatchStrategy | null;
  const metric = p.get('m') as MetricId | null;
  const selected = (p.get('sel') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    mode: mode === 'country-to-region' ? 'country-to-region' : 'region-to-country',
    view: view === 'globe' ? 'globe' : 'map',
    selected,
    strategy: strategy && STRATEGIES.includes(strategy) ? strategy : DEFAULTS.strategy,
    metric: metric && METRICS.includes(metric) ? metric : DEFAULTS.metric,
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
  if (state.metric !== DEFAULTS.metric) p.set('m', state.metric);
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
