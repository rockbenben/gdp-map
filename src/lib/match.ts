/**
 * 核心算法：把一个「经济体量」翻译成一组可数的国家（或省份）。
 *
 * 两种方向：
 *   - accumulateAscending  ：目标 → 一堆小国（由小到大累加），答「≈ 多少个国家」
 *   - accumulateDescending ：目标 → 一堆大地区（由大到小累加），答「≈ 哪几个省加起来」
 *
 * 两条都取「绝对差最小」的那一组，所以既不会明显超调，也不会差太远。
 */

export interface GdpItem {
  id: string;
  zh: string;
  gdp: number;
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

export interface AccumulateOptions {
  /** 需要排除的 id（例如把自己排除在外） */
  exclude?: string[];
}

function sortByGdp(pool: GdpItem[], direction: 'asc' | 'desc'): GdpItem[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...pool].sort((a, b) => sign * (a.gdp - b.gdp) || a.id.localeCompare(b.id));
}

/**
 * 由小到大累加：用于「一个省 ≈ 多少个国家」。
 * 逐项累加并记录绝对差最小的前缀；越过目标后停止（再往下只会更远）。
 */
export function accumulateAscending(target: number, pool: GdpItem[], options: AccumulateOptions = {}): MatchResult {
  const excluded = new Set(options.exclude ?? []);
  const sorted = sortByGdp(
    pool.filter((x) => !excluded.has(x.id) && x.gdp > 0),
    'asc'
  );

  let best: MatchResult = { items: [], sum: 0, target, gap: -target, count: 0 };
  let sum = 0;
  const acc: MatchItem[] = [];

  for (const item of sorted) {
    sum += item.gdp;
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
      items: [{ ...first, cumulative: first.gdp }],
      sum: first.gdp,
      target,
      gap: first.gdp - target,
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
  const excluded = new Set(options.exclude ?? []);
  const sorted = sortByGdp(
    pool.filter((x) => !excluded.has(x.id) && x.gdp > 0),
    'desc'
  );

  let best: MatchResult = { items: [], sum: 0, target, gap: -target, count: 0 };
  let sum = 0;
  const acc: MatchItem[] = [];

  for (const item of sorted) {
    sum += item.gdp;
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
  const excluded = new Set(options.exclude ?? []);
  let best: GdpItem | null = null;
  let bestDiff = Infinity;
  for (const item of pool) {
    if (excluded.has(item.id) || item.gdp <= 0) continue;
    const diff = Math.abs(item.gdp - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = item;
    }
  }
  return best;
}

/** 相对误差（|sum - target| / target），用于 UI 上的「误差」标注 */
export function relativeError(result: MatchResult): number {
  if (!result.target) return 0;
  return Math.abs(result.gap) / result.target;
}
