export interface GdpSeries {
  /** 现价美元，按年份索引 */
  nominal: Record<string, number>;
}

export interface Country {
  id: string;
  zh: string;
  en: string;
  hasGeometry: boolean;
  gdp: GdpSeries;
  /** 人口（人），按年份索引 */
  pop?: Record<string, number>;
  /** 人均 GDP（美元），按年份索引 */
  gdpPc?: Record<string, number>;
  /** 面积（平方公里） */
  area?: number | null;
  search: string;
}

export interface Province {
  id: string;
  adcode: number;
  zh: string;
  en: string;
  gdp: GdpSeries;
  /** 人均 GDP（美元），按年份索引 */
  gdpPc?: Record<string, number>;
  /** 人口（人），按年份索引 */
  pop?: Record<string, number>;
  /** 面积（平方公里） */
  area?: number | null;
  gdpPerCapita?: number;
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
  exchangeRate: Record<string, { year: number; cnyPerUsd: number | null; source: string }>;
  generatedAt: string;
  note: string;
}

export interface Dataset {
  meta: DatasetMeta;
  countries: Country[];
  provinces: Province[];
}

export type RegionKind = 'country' | 'province';

export interface Region {
  id: string;
  kind: RegionKind;
  zh: string;
  en: string;
  gdpUsd: number;
  /** 人均 GDP（美元） */
  gdpPerCapitaUsd?: number;
  /** 人口（人） */
  pop?: number;
  /** 面积（平方公里） */
  areaKm2?: number;
  /** 地图高亮时使用的几何 id（世界地图用 ISO3，中国地图用 adcode） */
  geometryId: string;
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
    adcode?: number | string;
    center?: [number, number];
    centroid?: [number, number];
    isSouthSea?: boolean;
  };
  geometry: GeoGeometry;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

export type ViewMode = 'map' | 'globe';
export type CompareMode = 'region-to-country' | 'country-to-region';
