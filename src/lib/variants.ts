import {
  matchByStrategy,
  type AccumulateOptions,
  type GdpItem,
  type MatchResult,
  type MatchStrategy
} from './match';

/**
 * 「熟脸国家」池：编辑精选，不是客观排名。
 *
 * 选的是中文读者大概率听过、且体量覆盖从小到大的国家——
 * 只用 G20 的话，河南这个量级根本凑不出来，只能又回到一堆微型国家。
 */
const KNOWN_COUNTRY_IDS = new Set([
  'USA', 'CHN', 'DEU', 'JPN', 'IND', 'GBR', 'FRA', 'ITA', 'CAN', 'BRA',
  'RUS', 'KOR', 'AUS', 'ESP', 'MEX', 'IDN', 'NLD', 'SAU', 'TUR', 'CHE',
  'POL', 'ARG', 'SWE', 'BEL', 'THA', 'NOR', 'ARE', 'ISR', 'SGP', 'IRL',
  'DNK', 'ZAF', 'EGY', 'NGA', 'VNM', 'PHL', 'MYS', 'PAK', 'BGD', 'IRN',
  'COL', 'CHL', 'PRT', 'GRC', 'FIN', 'NZL', 'AUT', 'CZE', 'ROU', 'HUN',
  'QAT', 'KWT', 'MAR', 'ETH', 'KEN', 'PER', 'SVK', 'SVN', 'HRV', 'URY',
  'CRI', 'PAN', 'LUX', 'ISL', 'TUN', 'JOR', 'GHA', 'SEN', 'BGR', 'SRB',
  'LTU', 'EST', 'LVA', 'ECU', 'GTM', 'DOM', 'BOL', 'PRY', 'NPL', 'KHM',
  'LAO', 'MMR', 'MNG', 'GEO', 'ARM', 'AZE', 'UZB', 'KAZ'
]);

const MAX_GROUP = 6;
const MIN_GROUP = 3;
const MAX_ERROR = 0.1;
const BEAM_WIDTH = 220;
const MAX_OVER = 1.4;

export type VariantKey = 'original' | 'known-a' | 'known-b' | 'random';

export interface MatchVariant {
  key: VariantKey;
  label: string;
  match: MatchResult;
}

function prepare(pool: GdpItem[], options: AccumulateOptions): GdpItem[] {
  const excluded = new Set(options.exclude ?? []);
  return pool.filter((x) => !excluded.has(x.id) && x.value > 0);
}

function resultOf(target: number, items: GdpItem[]): MatchResult {
  // 熟脸组合按体量从大到小排，避免又变成「图瓦卢、瑙鲁、…」的小到大顺序。
  const sorted = [...items].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  let sum = 0;
  const withCumulative = sorted.map((item) => {
    sum += item.value;
    return { ...item, cumulative: sum };
  });
  return { items: withCumulative, sum, target, gap: sum - target, count: withCumulative.length };
}

function errorOf(result: MatchResult): number {
  return result.target ? Math.abs(result.gap) / result.target : 0;
}

function keyOf(items: GdpItem[]): string {
  return items.map((x) => x.id).sort().join(',');
}

function knownPool(pool: GdpItem[], options: AccumulateOptions): GdpItem[] {
  return prepare(pool, options).filter((x) => KNOWN_COUNTRY_IDS.has(x.id));
}

/**
 * 在熟脸池里做 beam search：宽度有限，但不要求整个大池收敛。
 * 只收 3–6 个、误差 ≤ 10% 的组合；候选按误差排序。
 */
function beamCandidates(target: number, pool: GdpItem[], order: 'asc' | 'desc'): MatchResult[] {
  const sorted = [...pool].sort((a, b) =>
    order === 'desc' ? b.value - a.value || a.id.localeCompare(b.id) : a.value - b.value || a.id.localeCompare(b.id)
  );
  let beams: Array<{ sum: number; items: GdpItem[]; ids: Set<string> }> = [
    { sum: 0, items: [], ids: new Set() }
  ];
  const found = new Map<string, MatchResult>();

  for (let depth = 1; depth <= MAX_GROUP; depth += 1) {
    const next: typeof beams = [];
    for (const beam of beams) {
      for (const item of sorted) {
        if (beam.ids.has(item.id)) continue;
        const sum = beam.sum + item.value;
        if (sum > target * MAX_OVER) continue;
        next.push({
          sum,
          items: [...beam.items, item],
          ids: new Set([...beam.ids, item.id])
        });
      }
    }
    next.sort((a, b) => Math.abs(a.sum - target) - Math.abs(b.sum - target) || a.items.length - b.items.length);
    beams = next.slice(0, BEAM_WIDTH);

    if (depth >= MIN_GROUP) {
      for (const beam of beams.slice(0, 40)) {
        const result = resultOf(target, beam.items);
        if (errorOf(result) > MAX_ERROR) continue;
        const key = keyOf(result.items);
        const old = found.get(key);
        if (!old || errorOf(result) < errorOf(old)) found.set(key, result);
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => errorOf(a) - errorOf(b) || a.count - b.count || keyOf(a.items).localeCompare(keyOf(b.items))
  );
}

function hashString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function randomKnown(target: number, pool: GdpItem[], seed: string, avoid: Set<string>): MatchResult | null {
  const rng = mulberry32(hashString(seed));
  let best: MatchResult | null = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const shuffled = shuffle(pool, rng);
    const wanted = MIN_GROUP + Math.floor(rng() * (MAX_GROUP - MIN_GROUP + 1));
    const items: GdpItem[] = [];
    let sum = 0;
    for (const item of shuffled) {
      if (items.length >= wanted) break;
      if (sum + item.value > target * MAX_OVER) continue;
      items.push(item);
      sum += item.value;
    }
    if (items.length < MIN_GROUP) continue;
    const result = resultOf(target, items);
    if (errorOf(result) > MAX_ERROR) continue;
    if (avoid.has(keyOf(result.items))) continue;
    if (!best || errorOf(result) < errorOf(best)) best = result;
  }
  return best;
}

/**
 * 生成结果卡上的组合：
 * 0 原版（当前对照口径），1/2 熟脸 A/B，最后一个随机熟脸组合。
 * 随机组合只在同一个目标/年份/指标下稳定（seed 来自这些字段），分享链接用 v 复现。
 */
export function buildMatchVariants(
  target: number,
  pool: GdpItem[],
  strategy: MatchStrategy,
  options: AccumulateOptions = {},
  seed = ''
): MatchVariant[] {
  if (!target) return [];
  const original = matchByStrategy(target, pool, strategy, options);
  const variants: MatchVariant[] = [{ key: 'original', label: '原版组合', match: original }];
  if (strategy !== 'many' && strategy !== 'over') return variants;

  const known = knownPool(pool, options);
  if (known.length < MIN_GROUP) return variants;

  const candidates = [
    ...beamCandidates(target, known, 'desc'),
    ...beamCandidates(target, known, 'asc')
  ].sort((a, b) => errorOf(a) - errorOf(b) || a.count - b.count);

  const seen = new Set<string>();
  const unique: MatchResult[] = [];
  for (const candidate of candidates) {
    const key = keyOf(candidate.items);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  const a = unique[0];
  if (a) variants.push({ key: 'known-a', label: '熟脸组合 A', match: a });
  const b = unique.find((candidate) => keyOf(candidate.items) !== (a ? keyOf(a.items) : ''));
  if (b) variants.push({ key: 'known-b', label: '熟脸组合 B', match: b });

  const avoid = new Set(unique.slice(0, 2).map((x) => keyOf(x.items)));
  const random = randomKnown(target, known, seed, avoid);
  if (random) variants.push({ key: 'random', label: '随机组合', match: random });

  // 只有原版时不出现「换个组合」；有 A/B/随机时才返回多个。
  return variants;
}
