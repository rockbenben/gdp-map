import type { Dataset, FeatureCollection, MetricSeries, Region, RegionObject } from './types';
import type { MetricId } from './metrics';

const base = import.meta.env.BASE_URL ?? './';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`加载 ${path} 失败：${res.status}`);
  return (await res.json()) as T;
}

let datasetPromise: Promise<Dataset> | null = null;
let historyPromise: Promise<HistoryDataset> | null = null;
let worldPromise: Promise<FeatureCollection> | null = null;
let chinaPromise: Promise<FeatureCollection> | null = null;
let usStatesPromise: Promise<FeatureCollection> | null = null;
let extraRegionsPromise: Promise<FeatureCollection> | null = null;

/** 历史数据文件：对象 id → 除默认年之外的逐年指标 */
export interface HistoryDataset {
  objects: {
    id: string;
    metrics: {
      gdp?: { nominal?: MetricSeries };
      ppp?: MetricSeries;
      gdpPc?: MetricSeries;
      pop?: MetricSeries;
    };
  }[];
}

export function loadDataset(): Promise<Dataset> {
  datasetPromise ??= getJson<Dataset>('data/regions.json');
  return datasetPromise;
}

/**
 * 历史数据：默认年之外的年份（美国州 1997–2025、欧盟 2000–2024、中国省 2000–2024…）。
 *
 * ⚠️ **它是懒加载的**：基础文件（约 36 KB gzip）先到，页面立刻有结论；
 *    历史文件（约 342 KB gzip）随后到，到齐后年份回溯才可用。
 *    拨年份前先 `await loadHistory()`，不然那一年是空值。
 */
export function loadHistory(): Promise<HistoryDataset> {
  historyPromise ??= getJson<HistoryDataset>('data/regions-history.json');
  return historyPromise;
}

/** 把历史数据合并进基础数据（合并后结构跟合并前完全一样，调用方无感） */
export function mergeHistory(baseDataset: Dataset, history: HistoryDataset): Dataset {
  const byId = new Map(history.objects.map((o) => [o.id, o]));
  return {
    meta: baseDataset.meta,
    objects: baseDataset.objects.map((o) => {
      const h = byId.get(o.id);
      if (!h) return o;
      const metrics: RegionObject['metrics'] = { ...o.metrics };
      const hn = h.metrics.gdp?.nominal;
      if (hn && Object.keys(hn).length) {
        metrics.gdp = { nominal: { ...(o.metrics.gdp?.nominal ?? {}), ...hn } };
      }
      if (h.metrics.ppp) metrics.ppp = { ...(o.metrics.ppp ?? {}), ...h.metrics.ppp };
      if (h.metrics.gdpPc) metrics.gdpPc = { ...(o.metrics.gdpPc ?? {}), ...h.metrics.gdpPc };
      if (h.metrics.pop) metrics.pop = { ...(o.metrics.pop ?? {}), ...h.metrics.pop };
      return { ...o, metrics };
    })
  };
}

export function loadWorld(): Promise<FeatureCollection> {
  worldPromise ??= getJson<FeatureCollection>('geo/world.json');
  return worldPromise;
}

export function loadChina(): Promise<FeatureCollection> {
  chinaPromise ??= getJson<FeatureCollection>('geo/china.json');
  return chinaPromise;
}

export function loadUsStates(): Promise<FeatureCollection> {
  usStatesPromise ??= getJson<FeatureCollection>('geo/us-states.json');
  return usStatesPromise;
}

/** 欧洲 NUTS-1 与日本都道府县的边界 */
export function loadExtraRegions(): Promise<FeatureCollection> {
  extraRegionsPromise ??= getJson<FeatureCollection>('geo/extra-regions.json');
  return extraRegionsPromise;
}


/**
 * 取「当年 → 最近有记录的一年」的人口。
 *
 * 用于两处：微型经济体判定和「这 N 个国家加起来住着 X」的合计。
 * 图瓦卢 2000–2001 年都缺人口，最近有记录的是 2002 年（1 万人）与 2003 年（9,000 人）；
 * 伊拉克 2000 年缺、2003 年有 2,596 万——
 * 不能因为缺值就把它们分别当成非微型 / 0 人。
 */
function populationNear(pop: MetricSeries | undefined, year: string): number | undefined {
  const exact = pop?.[year];
  if (exact != null && exact > 0) return exact;
  const target = Number(year);
  if (!pop || !Number.isFinite(target)) return undefined;
  let bestYear = Infinity;
  let bestValue: number | undefined;
  for (const [key, value] of Object.entries(pop)) {
    const y = Number(key);
    if (!Number.isFinite(y) || value == null || value <= 0) continue;
    if (Math.abs(y - target) < Math.abs(bestYear - target)) {
      bestYear = y;
      bestValue = value;
    }
  }
  return bestValue;
}

/** 把数据集中的统一对象转成应用用的 Region */
export function toRegion(obj: RegionObject, year: string): Region {
  // 省/州的**值跟着要比较的那一年走**：欧盟一级区有 2000–2024 的数据，
  // 拨到 2010 年，巴伐利亚就该是 2010 年的大小，而不是 2024 年的。
  // 国家侧本来就是按滑块那一年取的。
  const y = obj.kind === 'region' ? year : (obj.year ?? year);
  const nominal = obj.metrics.gdp.nominal;
  const popNear = populationNear(obj.metrics.pop, y);
  return {
    id: obj.id,
    kind: obj.kind,
    zh: obj.zh,
    en: obj.en,
    parentId: obj.parentId,
    year: y,
    /**
     * 有数据的那些年（省/州的年份不一样，年份控件按它来）。
     * ⚠️ 再按名义 GDP 过滤一次：历史文件没到、或数据源给了 "NA" 时，
     *    年份清单里不能出现没有值的那一年，否则拨过去就是空结论。
     */
    years: (obj.years ?? Object.keys(nominal).sort()).filter((yy) => nominal[yy] != null),
    gdpUsd: nominal[y] ?? 0,
    pppUsd: obj.metrics.ppp?.[y],
    gdpPerCapitaUsd: obj.metrics.gdpPc?.[y],
    pop: obj.metrics.pop?.[y],
    popForAggregate: popNear,
    isMicro: popNear != null && popNear < 1e6,
    areaKm2: obj.metrics.area ?? undefined,
    geometryId: obj.geoId,
    hasGeometry: obj.hasGeometry,
    search: obj.search
  };
}

/** 把数据集拆成国家池与省/州池。两侧年份可以不同：国家侧可回溯，省/州固定在年鉴年份。 */
export function splitDataset(
  data: Dataset,
  countryYear: string,
  regionYear?: string
): { countries: Region[]; regions: Region[] } {
  const year = regionYear ?? data.meta.provinceYear;
  const all = data.objects.map((o) => toRegion(o, o.kind === 'country' ? countryYear : year));
  const countries = all.filter((r) => r.kind === 'country');
  const regions = all.filter((r) => r.kind === 'region');
  // 给省/州补上所属国家名，选择器里按国家分组显示
  const nameById = new Map(countries.map((c) => [c.id, c.zh]));
  for (const r of regions) {
    r.parentName = r.parentId ? nameById.get(r.parentId) : undefined;
    // 搜「德国」要能搜到巴伐利亚：把所属国家的名字也塞进搜索键
    if (r.parentName) r.search = `${r.search} ${r.parentName.toLowerCase()}`;
  }
  return { countries, regions };
}

/** 取某个地区在某个指标上的数值 */
export function metricValue(region: Region, metric: MetricId): number {
  switch (metric) {
    case 'gdp':
      return region.gdpUsd;
    case 'pppGdp':
      return region.pppUsd ?? 0;
    case 'gdpPc':
      return region.gdpPerCapitaUsd ?? 0;
    case 'density':
      return region.areaKm2 ? region.gdpUsd / region.areaKm2 : 0;
    case 'area':
      return region.areaKm2 ?? 0;
    case 'pop':
      return region.pop ?? 0;
  }
}
