import type { CompareMode, ViewMode } from './types';
import type { MatchStrategy } from './match';
import type { MetricId } from './metrics';
import { METRIC_DEFAULT_STRATEGY, METRIC_ORDER, METRICS as METRIC_DEF } from './metrics';
import { clampScore } from './play';

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
  /** 结果卡上的组合版本：0 原版，1/2 熟脸，3 随机 */
  variant: number;
  /** 挑战链接：打开后按同一目标开一局（只读一次，不写回 URL） */
  challenge?: boolean;
  /** 发起挑战的人拿了多少分，只用于展示 */
  challengeScore?: number | null;
}

const DEFAULTS: AppState = {
  mode: 'region-to-world',
  view: 'map',
  selected: [],
  strategy: 'over',
  metric: 'gdp',
  ignoreMicro: true,
  worldYear: 2024,
  variant: 0,
  challenge: false,
  challengeScore: null
};

const STRATEGIES: MatchStrategy[] = ['many', 'over', 'big', 'nearest'];
const METRICS: MetricId[] = METRIC_ORDER;

const VIEWS: ViewMode[] = ['map', 'globe', 'square', 'bracket', 'rank', 'play'];

/** URL 里的微型经济体开关：0 = 不忽略，1 = 忽略；没写就跟随默认值 */
function readIgnoreMicro(p: URLSearchParams): boolean {
  const raw = p.get('micro');
  if (raw === '0') return false;
  if (raw === '1') return true;
  return DEFAULTS.ignoreMicro;
}

function readState(): AppState {
  if (typeof window === 'undefined') return DEFAULTS;
  const p = new URLSearchParams(window.location.search);
  const mode = p.get('mode');
  const view = p.get('view') as ViewMode | null;
  const strategy = p.get('st') as MatchStrategy | null;
  const metric = p.get('m') as MetricId | null;
  const yRaw = Number(p.get('y'));
  // 先接受任何合理年份；真正的范围在数据加载后由 App 夹到 meta.yearRange
  // 与 selectableYears 上（这里写死会和数据范围脱节，旧链接也会被误丢）。
  const worldYear =
    Number.isFinite(yRaw) && yRaw >= 1000 && yRaw <= 3000 ? Math.round(yRaw) : DEFAULTS.worldYear;
  const vRaw = Number(p.get('v'));
  const variant = Number.isInteger(vRaw) && vRaw >= 0 && vRaw <= 3 ? vRaw : DEFAULTS.variant;
  let selected = (p.get('sel') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const resolvedMetric = metric && METRICS.includes(metric) ? metric : DEFAULTS.metric;
  const additive = METRIC_DEF[resolvedMetric].additive;
  const resolvedView = view && VIEWS.includes(view) ? view : DEFAULTS.view;
  const challenge = p.get('challenge') === '1';
  const challengeScore = challenge ? clampScore(Number(p.get('score'))) : null;
  if (!additive) {
    // 人均、密度这类不可叠加的指标：口径锁死「最接近」，选择也只留一个
    selected = selected.slice(0, 1);
    return {
      mode: mode === 'world-to-region' ? 'world-to-region' : 'region-to-world',
      view: resolvedView,
      selected,
      strategy: 'nearest',
      metric: resolvedMetric,
      ignoreMicro: readIgnoreMicro(p),
      worldYear,
      variant: 0,
      challenge,
      challengeScore
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
    ignoreMicro: readIgnoreMicro(p),
    worldYear,
    variant,
    challenge,
    challengeScore
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
  if (state.ignoreMicro !== DEFAULTS.ignoreMicro) p.set('micro', state.ignoreMicro ? '1' : '0');
  if (state.worldYear !== DEFAULTS.worldYear) p.set('y', String(state.worldYear));
  if (state.variant !== DEFAULTS.variant) p.set('v', String(state.variant));
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
