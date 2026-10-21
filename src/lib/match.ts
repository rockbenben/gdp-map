/**
 * 核心算法：把一个「量」翻译成一组可数的对象（国家或省份）。
 *
 * 之所以做成「多种对照方式」，是因为单一策略的结果太单一：
 * 纯贪心从小到大累加，永远是图瓦卢、瑙鲁、马绍尔群岛这一串微型国家，
 * 看上去热闹但没什么信息量。所以提供四种口径，用户按想要的「说法」挑：
 *
 *   many   尽量多件：优先用小件，件数最多，合计不超过目标
 *   over   尽量打过：沿自然顺序累加，装不下的那一个也算进去，合计 ≥ 目标
 *   big    大件优先：优先用大件（可辨识的经济体），合计不超过目标
 *   nearest 最接近  ：只看单个最接近的对象（河南 ≈ 波兰）
 *
 * 注意：这些口径对「可累加」的量（总量、面积、人口）才有意义。
 * 人均 GDP 不可加，只能取单个最接近的对象 —— 见 metrics.ts 的 additive 标记。
 */

export interface GdpItem {
  id: string;
  zh: string;
  /** 待比较的量（单位随指标而定） */
  value: number;
}

export interface MatchItem extends GdpItem {
  /** 累加到这一项时的累计值 */
  cumulative: number;
}

export interface MatchResult {
  items: MatchItem[];
  /** 已选集合合计 */
  sum: number;
  /** 目标值 */
  target: number;
  /** sum - target，正数表示超出 */
  gap: number;
  /** 选中的个数 */
  count: number;
}

export type MatchStrategy = 'many' | 'over' | 'big' | 'nearest';

/** 「大国」的口径：按当前指标排名前 10 的对象 */
export const BIG_POOL_SIZE = 10;

export const STRATEGY_LABEL: Record<MatchStrategy, string> = {
  many: '尽量多凑',
  over: '宁可超出',
  big: '比大国家',
  nearest: '最像的一个'
};

export const STRATEGY_HINT: Record<MatchStrategy, string> = {
  many: '从最小的国家往上加，能加多少个算多少个 —— 件数最多，但多是些小国。',
  over: '同样从小往大加，只是装不下的那一个也算进去 —— 保证总量至少这么大。',
  big: '只跟体量最大的 10 个对象比，看它是其中哪一个的几分之几。',
  nearest: '不凑，只挑最接近的那一个。'
};

export interface AccumulateOptions {
  /** 需要排除的 id（例如把自己排除在外） */
  exclude?: string[];
}

function sortByValue(pool: GdpItem[], direction: 'asc' | 'desc'): GdpItem[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...pool].sort((a, b) => sign * (a.value - b.value) || a.id.localeCompare(b.id));
}

function prepare(pool: GdpItem[], options: AccumulateOptions): GdpItem[] {
  const excluded = new Set(options.exclude ?? []);
  return pool.filter((x) => !excluded.has(x.id) && x.value > 0);
}

function toResult(target: number, items: MatchItem[]): MatchResult {
  const sum = items.length ? items[items.length - 1].cumulative : 0;
  return { items, sum, target, gap: sum - target, count: items.length };
}

/**
 * 通用累加。
 *
 * @param order   'asc' 小件优先 / 'desc' 大件优先
 * @param rule    'skip' 装得下就加（合计 ≤ 目标）
 *                 'over' 装不下的那一个也算进去并停止（合计 ≥ 目标）
 */
export function accumulate(
  target: number,
  pool: GdpItem[],
  options: AccumulateOptions & { order?: 'asc' | 'desc'; rule?: 'skip' | 'over' } = {}
): MatchResult {
  const order = options.order ?? 'asc';
  const rule = options.rule ?? 'skip';
  const sorted = sortByValue(prepare(pool, options), order);

  const acc: MatchItem[] = [];
  let sum = 0;

  for (const item of sorted) {
    if (rule === 'over' && sum > 0 && sum + item.value > target) {
      // 把装不下的这一个也算进去，然后收工 —— 合计 ≥ 目标
      acc.push({ ...item, cumulative: sum + item.value });
      return toResult(target, acc);
    }
    if (sum + item.value > target) continue; // 装不下就跳过
    sum += item.value;
    acc.push({ ...item, cumulative: sum });
  }

  return toResult(target, acc);
}

/**
 * 由小到大累加：用于「一个省 ≈ 多少个国家」。
 * 逐项累加并记录绝对差最小的前缀；越过目标后停止（再往下只会更远）。
 */
export function accumulateAscending(target: number, pool: GdpItem[], options: AccumulateOptions = {}): MatchResult {
  const sorted = sortByValue(prepare(pool, options), 'asc');

  let best: MatchResult = { items: [], sum: 0, target, gap: -target, count: 0 };
  let sum = 0;
  const acc: MatchItem[] = [];

  for (const item of sorted) {
    sum += item.value;
    acc.push({ ...item, cumulative: sum });
    const diff = Math.abs(sum - target);
    if (diff < Math.abs(best.gap)) {
      best = { items: [...acc], sum, target, gap: sum - target, count: acc.length };
    }
    if (sum >= target) break;
  }

  // 目标比最小的国家还小：仍然给出最接近的那一个，而不是空集
  if (best.items.length === 0 && sorted.length) {
    const first = sorted[0];
    best = {
      items: [{ ...first, cumulative: first.value }],
      sum: first.value,
      target,
      gap: first.value - target,
      count: 1
    };
  }

  return best;
}

/**
 * 由大到小累加：用于「一个国家 ≈ 哪几个省加起来」。
 * 逐项累加并记录绝对差最小的前缀；达到目标后停止。
 */
export function accumulateDescending(target: number, pool: GdpItem[], options: AccumulateOptions = {}): MatchResult {
  const sorted = sortByValue(prepare(pool, options), 'desc');

  let best: MatchResult = { items: [], sum: 0, target, gap: -target, count: 0 };
  let sum = 0;
  const acc: MatchItem[] = [];

  for (const item of sorted) {
    sum += item.value;
    acc.push({ ...item, cumulative: sum });
    const diff = Math.abs(sum - target);
    if (diff < Math.abs(best.gap)) {
      best = { items: [...acc], sum, target, gap: sum - target, count: acc.length };
    }
    if (sum >= target) break;
  }

  return best;
}

/** 单个最接近目标的对象（例：广东 ≈ 韩国） */
export function closestSingle(target: number, pool: GdpItem[], options: AccumulateOptions = {}): GdpItem | null {
  let best: GdpItem | null = null;
  let bestDiff = Infinity;
  for (const item of prepare(pool, options)) {
    const diff = Math.abs(item.value - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = item;
    }
  }
  return best;
}

/**
 * 按策略匹配。三种累加口径与方向无关，两个方向用同一套语义：
 *   many   小件优先，件最多，合计不超过目标
 *   over   小件优先，装不下的那一个也算进去，合计 ≥ 目标
 *   big    只在「大件池」里找最接近的一个（由调用方把池收窄到前 10）
 *   nearest  单个最接近
 */
export function matchByStrategy(
  target: number,
  pool: GdpItem[],
  strategy: MatchStrategy,
  options: AccumulateOptions = {}
): MatchResult {
  if (!target) return { items: [], sum: 0, target, gap: -target, count: 0 };

  if (strategy === 'nearest' || strategy === 'big') {
    const one = closestSingle(target, pool, options);
    if (!one) return { items: [], sum: 0, target, gap: -target, count: 0 };
    return { items: [{ ...one, cumulative: one.value }], sum: one.value, target, gap: one.value - target, count: 1 };
  }

  if (strategy === 'many') {
    // 件数最多：小件优先，装得下就加
    return accumulate(target, pool, { ...options, order: 'asc', rule: 'skip' });
  }

  // over：合计 ≥ 目标，装不下的那一个也算进去
  return accumulate(target, pool, { ...options, order: 'asc', rule: 'over' });
}

/** 按指标取前 N 个「大件」 */
export function topByValue(pool: GdpItem[], n: number): GdpItem[] {
  return [...pool].sort((a, b) => b.value - a.value).slice(0, n);
}

/** 相对误差（|sum - target| / target），用于 UI 上的「误差」标注 */
export function relativeError(result: MatchResult): number {
  if (!result.target) return 0;
  return Math.abs(result.gap) / result.target;
}
