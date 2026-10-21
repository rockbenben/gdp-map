import type { CompareMode, ViewMode } from './types';
import type { MatchStrategy } from './match';
import type { MetricId } from './metrics';
import { METRIC_DEFAULT_STRATEGY, METRIC_ORDER, METRICS as METRIC_DEF } from './metrics';

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
  /** 拿哪一年的世界来比（国家侧） */
  worldYear: number;
}

const DEFAULTS: AppState = {
  mode: 'region-to-world',
  view: 'map',
  selected: [],
  strategy: 'over',
  metric: 'gdp',
  ignoreMicro: true,
  worldYear: 2024
};

const STRATEGIES: MatchStrategy[] = ['many', 'over', 'big', 'nearest'];
const METRICS: MetricId[] = METRIC_ORDER;

const VIEWS: ViewMode[] = ['map', 'globe', 'square', 'bracket', 'rank'];

function readState(): AppState {
  if (typeof window === 'undefined') return DEFAULTS;
  const p = new URLSearchParams(window.location.search);
  const mode = p.get('mode');
  const view = p.get('view') as ViewMode | null;
  const strategy = p.get('st') as MatchStrategy | null;
  const metric = p.get('m') as MetricId | null;
  const yRaw = Number(p.get('y'));
  const worldYear = Number.isFinite(yRaw) && yRaw >= 1990 && yRaw <= 2025 ? yRaw : DEFAULTS.worldYear;
  let selected = (p.get('sel') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const resolvedMetric = metric && METRICS.includes(metric) ? metric : DEFAULTS.metric;
  const additive = METRIC_DEF[resolvedMetric].additive;
  const resolvedView = view && VIEWS.includes(view) ? view : DEFAULTS.view;
  if (!additive) {
    // 人均、密度这类不可叠加的指标：口径锁死「最接近」，选择也只留一个
    selected = selected.slice(0, 1);
    return {
      mode: mode === 'world-to-region' ? 'world-to-region' : 'region-to-world',
      view: resolvedView,
      selected,
      strategy: 'nearest',
      metric: resolvedMetric,
      ignoreMicro: p.get('micro') === '0' ? false : DEFAULTS.ignoreMicro,
      worldYear
    };
  }
  return {
    mode: mode === 'world-to-region' ? 'world-to-region' : 'region-to-world',
    view: resolvedView,
    selected,
    // URL 里给了指标但没给对照方式时，跟随该指标的默认口径
    strategy:
      strategy && STRATEGIES.includes(strategy)
        ? strategy
        : metric
          ? METRIC_DEFAULT_STRATEGY[resolvedMetric]
          : DEFAULTS.strategy,
    metric: resolvedMetric,
    ignoreMicro: p.get('micro') === '0' ? false : DEFAULTS.ignoreMicro,
    worldYear
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
  if (state.worldYear !== DEFAULTS.worldYear) p.set('y', String(state.worldYear));
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
