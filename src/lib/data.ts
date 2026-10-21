import type { Dataset, FeatureCollection, Region } from './types';

const base = import.meta.env.BASE_URL ?? './';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`加载 ${path} 失败：${res.status}`);
  return (await res.json()) as T;
}

let datasetPromise: Promise<Dataset> | null = null;
let worldPromise: Promise<FeatureCollection> | null = null;
let chinaPromise: Promise<FeatureCollection> | null = null;

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

/** 把数据集中的国家/省份统一成可比较的 Region 结构 */
export function toRegion(item: Dataset['countries'][number], year: string): Region {
  return {
    id: item.id,
    kind: 'country',
    zh: item.zh,
    en: item.en,
    gdpUsd: item.gdp.nominal[year] ?? 0,
    pop: item.pop?.[year],
    geometryId: item.id,
    search: item.search
  };
}

export function provinceToRegion(item: Dataset['provinces'][number], year: string): Region {
  return {
    id: item.id,
    kind: 'province',
    zh: item.zh,
    en: item.en,
    gdpUsd: item.gdp.nominal[year] ?? 0,
    gdpPerCapita: item.gdpPerCapita,
    geometryId: String(item.adcode),
    search: item.search
  };
}
