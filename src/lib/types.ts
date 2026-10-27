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
   * 省州侧各地区数据年份不一定相同（日本府县民经济计算是 2023 年度，
   * 中国省级与美国州是 2024），所以年份跟着对象走，而不是全池统一。
   */
  year?: string;
  /**
   * 这个对象**有数据的那些年**。
   *
   * 基础文件只带默认年的数值（历史数据另存一个文件懒加载），
   * 所以这份清单得单独存着——否则年份控件会塌成只剩一年。
   */
  years?: string[];
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
  /** 国家侧数据覆盖的年份范围（前端年份滑块按它来） */
  yearRange?: [string, string];
  provinceYear: string;
  /** 各侧数据实际覆盖的年份区间（页脚显示） */
  coverage?: {
    countries: string;
    chinaProvinces: string | null;
    hkMacaoTaiwan?: string | null;
    usStates: string | null;
    euNuts: string | null;
    japanPrefectures: string | null;
  };
  countrySource: string;
  provinceSource: string;
  provinceSourceUrl: string;
  /** 中国省级历史读数的落库文件（年鉴表格图片的读数那部分） */
  provinceHistorySource?: string;
  usStateSource?: string;
  /** 欧洲 NUTS-1 与日本都道府县的来源 */
  extraRegionSource?: string;
  /** 跨年比较用的价格基准：把两个年份的钱折成同一个价 */
  priceBasis?: PriceBasis;
  exchangeRate: Record<string, { year: number; cnyPerUsd: number | null; source: string }>;
  generatedAt: string;
  note: string;
}

/**
 * 价格基准：数据年份不一致时把两边折到同一个价。
 *
 * 正常路径上省/州与对照池都取滑块那一年，折算系数是 1；
 * 这份指数是数据源给出不同年份时的兜底。
 * 不折算直接相比，等于把两个年份之间的物价差算进结论。
 */
export interface PriceBasis {
  /** 数据集的基准年（滑块停在这一年时两边不用折算） */
  baseYear: string;
  source: string;
  note: string;
  /** 美国 GDP 平减指数：年份 → 指数值（只有比率有意义） */
  deflator: Record<string, number>;
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
  /** 这个对象的数据是哪一年的（省/州各自不同，国家跟着滑块走） */
  year: string;
  /**
   * 这个对象**有数据的那些年**。
   *
   * 省/州的数据年份不一样（欧盟一级区 2000–2024、中国省级 2000–2024、
   * 日本府县 2023、美国州 1997–2025）——年份控件只能选「两边都有数据」的年份，
   * 靠的就是这份清单。
   */
  years: string[];
  gdpUsd: number;
  /** 购买力平价 GDP（现价国际元） */
  pppUsd?: number;
  /** 人均 GDP（美元） */
  gdpPerCapitaUsd?: number;
  /** 人口（人） */
  pop?: number;
  /**
   * 用于合计展示的人口：当年缺值时取最近有记录的一年。
   *
   * “这 N 个国家加起来住着 X”不能把缺人口的国家当成 0——
   * 得克萨斯州 2000 年的结果包含伊拉克，而伊拉克 2000 年没有人口记录。
   * 单独的 `pop` 仍然只表示当年值，避免把回退值用到人均/排名等精确口径里。
   */
  popForAggregate?: number;
  /**
   * 是否算微型经济体（人口不足 100 万）。
   *
   * 不能直接看当年的 `pop`：有些国家/年份没有人口统计（图瓦卢 2000），
   * 那时 `pop` 是 undefined，按 `pop ?? Infinity` 会把它当成非微型放进来。
   * 所以这里在数据层用「当年 → 最近有记录的一年」定下来。
   */
  isMicro?: boolean;
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

export type ViewMode = 'map' | 'globe' | 'square' | 'bracket' | 'rank' | 'play';
export type CompareMode = 'region-to-world' | 'world-to-region';
