import type { Dataset, FeatureCollection, Region, RegionObject } from './types';
import type { MetricId } from './metrics';

const base = import.meta.env.BASE_URL ?? './';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`加载 ${path} 失败：${res.status}`);
  return (await res.json()) as T;
}

let datasetPromise: Promise<Dataset> | null = null;
let worldPromise: Promise<FeatureCollection> | null = null;
let chinaPromise: Promise<FeatureCollection> | null = null;
let usStatesPromise: Promise<FeatureCollection> | null = null;
let extraRegionsPromise: Promise<FeatureCollection> | null = null;

export function loadDataset(): Promise<Dataset> {
  datasetPromise ??= getJson<Dataset>('data/regions.json');
  return datasetPromise;
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

/** 长周期历史（1650–1950）：只有估算，单独一个文件，拖到 1960 以前才加载 */
export interface HistorySeries {
  gdp: number;
  gdpPc: number;
  pop: number;
  ppp: number;
}

export interface HistoryData {
  meta: { source: string; years: string[]; note: string };
  data: Record<string, Record<string, HistorySeries>>;
}

let historyPromise: Promise<HistoryData | null> | null = null;

export function loadHistory(): Promise<HistoryData | null> {
  historyPromise ??= getJson<HistoryData>('data/history.json').catch(() => null);
  return historyPromise;
}

/**
 * 把长周期历史并进数据集。
 *
 * 麦迪逊口径的单位（2011 年国际元）跟现价美元不是一回事，
 * 管线里已经按各国 1960 年的水平折算过了（见 build-data.mjs），
 * 所以这里直接补进序列即可。
 */
export function mergeHistory(dataset: Dataset, history: HistoryData): Dataset {
  const objects = dataset.objects.map((o) => {
    const h = history.data?.[o.id];
    if (!h) return o;
    const nominal = { ...o.metrics.gdp.nominal };
    const gdpPc = { ...(o.metrics.gdpPc ?? {}) };
    const pop = { ...(o.metrics.pop ?? {}) };
    const ppp = { ...(o.metrics.ppp ?? {}) };
    // 平价口径：历史年份没有官方 PPP，用该国 1990 年的换算因子近似
    const factor = nominal['1990'] && ppp['1990'] ? ppp['1990'] / nominal['1990'] : 1;
    for (const [y, v] of Object.entries(h)) {
      if (nominal[y] == null) nominal[y] = v.gdp;
      if (gdpPc[y] == null) gdpPc[y] = v.gdpPc;
      if (pop[y] == null) pop[y] = v.pop;
      if (ppp[y] == null) ppp[y] = Math.round(v.gdp * factor);
    }
    return {
      ...o,
      metrics: { ...o.metrics, gdp: { ...o.metrics.gdp, nominal }, gdpPc, pop, ppp }
    };
  });
  return { ...dataset, objects };
}

/** 把数据集中的统一对象转成应用用的 Region */
export function toRegion(obj: RegionObject, year: string): Region {
  // 对象自带年份的用它自己的（日本的府县数据是 2023），没有才用池子的默认年份
  const y = obj.year ?? year;
  return {
    id: obj.id,
    kind: obj.kind,
    zh: obj.zh,
    en: obj.en,
    parentId: obj.parentId,
    year: y,
    gdpUsd: obj.metrics.gdp.nominal[y] ?? 0,
    pppUsd: obj.metrics.ppp?.[y],
    gdpPerCapitaUsd: obj.metrics.gdpPc?.[y],
    pop: obj.metrics.pop?.[y],
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
