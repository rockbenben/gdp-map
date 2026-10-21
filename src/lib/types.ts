export interface MetricSeries {
  [year: string]: number;
}

/** 统一对象模型里的一个条目：国家，或某个国家/地区的省州 */
export interface RegionObject {
  id: string;
  kind: 'country' | 'region';
  /** 所属国家（省州才有） */
  parentId: string | null;
  zh: string;
  en: string;
  /** 地图高亮用的几何 id */
  geoId: string;
  hasGeometry: boolean;
  /**
   * 这个对象的数据是哪一年的。
   * 省州侧各地区数据年份不一定相同（日本府县民经济计算能拿全的最近年份是 2021，
   * 中国省级与美国州是 2024），所以年份跟着对象走，而不是全池统一。
   */
  year?: string;
  metrics: {
    gdp: { nominal: MetricSeries };
    /** 购买力平价 GDP（现价国际元） */
    ppp?: MetricSeries;
    gdpPc?: MetricSeries;
    pop?: MetricSeries;
    area?: number | null;
  };
  source?: string;
  search: string;
}

export interface DatasetMeta {
  defaultYear: string;
  years: string[];
  provinceYear: string;
  countrySource: string;
  provinceSource: string;
  provinceSourceUrl: string;
  usStateSource?: string;
  /** 欧洲 NUTS-1 与日本都道府县的来源 */
  extraRegionSource?: string;
  exchangeRate: Record<string, { year: number; cnyPerUsd: number | null; source: string }>;
  generatedAt: string;
  note: string;
}

export interface Dataset {
  meta: DatasetMeta;
  objects: RegionObject[];
}

export type RegionKind = 'country' | 'region';

export interface Region {
  id: string;
  kind: RegionKind;
  zh: string;
  en: string;
  /** 所属国家（省州才有），用于选择器分组 */
  parentId: string | null;
  parentName?: string;
  gdpUsd: number;
  /** 购买力平价 GDP（现价国际元） */
  pppUsd?: number;
  /** 人均 GDP（美元） */
  gdpPerCapitaUsd?: number;
  /** 人口（人） */
  pop?: number;
  /** 面积（平方公里） */
  areaKm2?: number;
  /** 地图高亮时使用的几何 id（世界地图用 ISO3 / FIPS，中国地图用 adcode） */
  geometryId: string;
  hasGeometry: boolean;
  search: string;
}

export interface GeoGeometry {
  type: 'Polygon' | 'MultiPolygon' | 'LineString' | 'MultiLineString';
  coordinates: unknown;
}

export interface GeoFeature {
  type: 'Feature';
  id: string;
  properties: {
    id?: string;
    name?: string;
    zh?: string;
    adcode?: number | string;
    fips?: string;
    center?: [number, number];
    centroid?: [number, number];
    isSouthSea?: boolean;
    /** 只在被高亮时才画（欧洲 NUTS-1 与日本都道府县：数量多，全画会糊） */
    drawOnlyWhenHighlighted?: boolean;
  };
  geometry: GeoGeometry;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

export type ViewMode = 'map' | 'globe' | 'square' | 'bracket' | 'rank';
export type CompareMode = 'region-to-world' | 'world-to-region';
