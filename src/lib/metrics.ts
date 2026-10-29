/**
 * 指标体系：同一个「地方」，可以跟世界比总量、比购买力平价、比人均、比密度、比面积、比人口。
 *
 * additive 决定这个指标能不能累加：
 *   总 GDP / 平价 GDP / 面积 / 人口 —— 能，几个国家加起来是有意义的
 *   人均 GDP / GDP 密度 —— 不能，人均和密度没有「加起来」这回事，只能跟单个对象比
 */

export type MetricId = 'gdp' | 'pppGdp' | 'gdpPc' | 'density' | 'area' | 'pop';

/**
 * 标题拆成几段。
 *
 * 为什么要拆：结论里那个数字（52 个国家、41%）是要会滚动的，
 * 混在一整串文字里就没法单独驱动它。拆开之后各段各司其职：
 * before 是主语，eq 是「≈」，value 是会动的数字，suffix 是数字的单位，
 * after 是收尾。
 */
export interface MetricTitle {
  /** 主语，例如「河南省」 */
  before: string;
  /** 等号，'≈' 或 '' */
  eq: string;
  /** 会动的数字；这句话里没有数字时为 null */
  value: number | null;
  /** 数字怎么写（滚动过程中每一帧都用它） */
  format: (v: number) => string;
  /** 数字后面直接跟的字，例如 '%'、' 倍' */
  suffix: string;
  /** 收尾，例如「个国家之和」 */
  after: string;
}

/** 把拆开的标题还原成一句话（导出、分享卡用得上） */
export function titleText(t: MetricTitle): string {
  const mid = t.value == null ? '' : t.format(t.value) + t.suffix;
  return `${t.before}${t.eq}${mid}${t.after}`;
}

/**
 * 只要结论那半句，主体已经写在别处时把它去掉。
 *
 * 分享卡的版面是「标题说『是谁』→ 结论说『等于多少』」，
 * 所以这里把开头的主体名（河南省）去掉，只留结论：
 * 「河南省 ≈ 52 个国家之和」→「≈ 52 个国家之和」。
 *
 * ⚠️ **只在结论真的以主体名开头时才去掉**：
 * 「河南省 ≈ 巴西的 41%」去掉主体后还剩「≈ 巴西的 41%」——「41%」单独看是没有意义的；
 * 「河南省的人均 GDP ≈ 格鲁吉亚」不以主体名开头，整句保留。
 */
export function titleValueText(t: MetricTitle, subject?: string): string {
  const full = titleText(t);
  if (subject && full.startsWith(subject)) {
    return full.slice(subject.length).trim();
  }
  return full;
}

const intFormat = (v: number) => String(Math.round(v));

export interface Metric {
  id: MetricId;
  /** 按钮上的名字 */
  label: string;
  /** 结果卡片里的小标签 */
  valueLabel: string;
  /** 能不能累加 */
  additive: boolean;
  /**
   * 这个指标会不会随年份变。
   *
   * 面积是唯一不变的：国土面积不随年份变，所以面积口径的年份控件固定为默认年，
   * 标题与图注都不写年份（否则会写出「广东省的面积 ≈ 2000 年的柬埔寨」这种话）。
   *
   * ⚠️ 「这个指标有没有年份」这件事只在这里定义一次。
   *    以前散在 App.tsx 里比 `metric === 'area'`：每日挑战的卡片就会跟地图对不上
   *    （卡片写「2023 年」，地图上停在 2024 年），「今日一地」和「每日挑战」
   *    看上去像两道题。加指标时也在这里补上，别再写死指标 id。
   */
  variesByYear: boolean;
  /** 这个指标的自然比较单位 */
  unitName: string;
  /** 数值格式化 */
  format: (value: number) => string;
  /** 列表里每一项的简短写法 */
  short: (value: number) => string;
  /** 标题：src 参照地区，n 件数，name 唯一对象的名字，unit 是「国家」或「省份」 */
  title: (src: string, n: number, name: string, unit: string) => MetricTitle;
}

const fmtInt = (v: number) => Math.round(v).toLocaleString('zh-CN');

/**
 * 金额按「亿」显示。
 *
 * 以前不足 1 亿时也 Math.round，图瓦卢 2000 年的 0.15 亿会显示成「0 亿」；
 * 在「忽略微型经济体」关掉时，列表看起来像有一堆 0 美元的国家。
 */
const fmtYi = (v: number, suffix = '', tail = '') => {
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(2)} 万亿${suffix}${tail}`;
  const yi = v / 1e8;
  if (Math.abs(yi) >= 1) return `${fmtInt(yi)} 亿${suffix}${tail}`;
  if (Math.abs(yi) >= 0.1) return `${yi.toFixed(1)} 亿${suffix}${tail}`;
  if (Math.abs(yi) > 0) return `<0.1 亿${suffix}${tail}`;
  return `0 亿${suffix}${tail}`;
};

export const METRICS: Record<MetricId, Metric> = {
  gdp: {
    id: 'gdp',
    label: '总 GDP',
    valueLabel: '名义 GDP（现价美元）',
    additive: true,
    variesByYear: true,
    unitName: '经济体量',
    format: (v) => fmtYi(v, '美元'),
    short: (v) => fmtYi(v),
    title: (src, n, name, unit) =>
      n === 1
        ? { before: src, eq: ' ≈ ', value: null, format: intFormat, suffix: '', after: name }
        : {
            before: src,
            eq: ' ≈ ',
            value: n,
            format: intFormat,
            suffix: '',
            after: ` 个${unit}之和`
          }
  },
  pppGdp: {
    id: 'pppGdp',
    label: '平价 GDP',
    valueLabel: '购买力平价 GDP（现价国际元）',
    additive: true,
    variesByYear: true,
    unitName: '平价经济体量',
    format: (v) => fmtYi(v, '美元', '（平价）'),
    short: (v) => fmtYi(v),
    title: (src, n, name, unit) =>
      n === 1
        ? { before: `${src}（平价）`, eq: ' ≈ ', value: null, format: intFormat, suffix: '', after: name }
        : {
            before: `${src}（平价）`,
            eq: ' ≈ ',
            value: n,
            format: intFormat,
            suffix: '',
            after: ` 个${unit}之和`
          }
  },
  gdpPc: {
    id: 'gdpPc',
    label: '人均 GDP',
    valueLabel: '人均 GDP（现价美元）',
    additive: false,
    variesByYear: true,
    unitName: '人均水平',
    format: (v) => `${fmtInt(v)} 美元/人`,
    short: (v) => `${fmtInt(v)} 美元`,
    title: (src, _n, name) => ({
      before: `${src}的人均 GDP`,
      eq: ' ≈ ',
      value: null,
      format: intFormat,
      suffix: '',
      after: name
    })
  },
  density: {
    id: 'density',
    label: 'GDP 密度',
    valueLabel: '每平方公里产出（现价美元）',
    additive: false,
    variesByYear: true,
    unitName: '产出密度',
    format: (v) =>
      Math.abs(v) >= 1e4 ? `${(v / 1e4).toFixed(1)} 万美元/km²` : `${fmtInt(v)} 美元/km²`,
    short: (v) => (Math.abs(v) >= 1e4 ? `${(v / 1e4).toFixed(1)} 万/km²` : `${fmtInt(v)}/km²`),
    title: (src, _n, name) => ({
      before: `${src}的产出密度`,
      eq: ' ≈ ',
      value: null,
      format: intFormat,
      suffix: '',
      after: name
    })
  },
  area: {
    id: 'area',
    label: '面积',
    valueLabel: '面积（平方公里）',
    additive: true,
    /** ⚠️ 面积不随年份变：这里是唯一写 false 的指标 */
    variesByYear: false,
    unitName: '国土面积',
    format: (v) => (Math.abs(v) >= 1e4 ? `${(v / 1e4).toFixed(1)} 万 km²` : `${fmtInt(v)} km²`),
    short: (v) => (Math.abs(v) >= 1e4 ? `${(v / 1e4).toFixed(1)} 万` : fmtInt(v)),
    title: (src, n, name, unit) =>
      n === 1
        ? { before: `${src}的面积`, eq: ' ≈ ', value: null, format: intFormat, suffix: '', after: name }
        : {
            before: `${src}的面积`,
            eq: ' ≈ ',
            value: n,
            format: intFormat,
            suffix: '',
            after: ` 个${unit}加起来`
          }
  },
  pop: {
    id: 'pop',
    label: '人口',
    valueLabel: '人口',
    additive: true,
    variesByYear: true,
    unitName: '人口',
    format: (v) => (Math.abs(v) >= 1e8 ? `${(v / 1e8).toFixed(2)} 亿人` : `${fmtInt(v / 1e4)} 万人`),
    short: (v) => (Math.abs(v) >= 1e8 ? `${(v / 1e8).toFixed(2)} 亿` : `${fmtInt(v / 1e4)} 万`),
    title: (src, n, name, unit) =>
      n === 1
        ? { before: `${src}的人口`, eq: ' ≈ ', value: null, format: intFormat, suffix: '', after: name }
        : {
            before: `${src}的人口`,
            eq: ' ≈ ',
            value: n,
            format: intFormat,
            suffix: '',
            after: ` 个${unit}的人口总和`
          }
  }
};

export const METRIC_ORDER: MetricId[] = ['gdp', 'pppGdp', 'gdpPc', 'density', 'area', 'pop'];

/**
 * 每个指标默认的对照方式。
 *
 * 人均与密度只能取单个（additive 为 false，UI 里也只留「最像的一个」）；
 * 面积与人口**默认**也取单个，但它们能累加，UI 里可以切别的口径；
 * 总量类（总 GDP / 平价 GDP）默认「宁可超出」——那个结论最像一句话。
 */
export const METRIC_DEFAULT_STRATEGY: Record<MetricId, 'many' | 'over' | 'big' | 'nearest'> = {
  gdp: 'over',
  pppGdp: 'over',
  gdpPc: 'nearest',
  density: 'nearest',
  area: 'nearest',
  pop: 'nearest'
};

export const METRIC_HINT: Record<MetricId, string> = {
  gdp: '看总量：几个国家加起来能赶上它。',
  pppGdp: '看购买力平价：按当地物价折算，结论常和名义 GDP 不一样。',
  gdpPc: '看人均：人均不能相加，只能找生活水平最接近的那一个。',
  density: '看密度：每平方公里的产出，衡量的是效率而不是体量。',
  area: '看面积：谁的底盘跟它差不多大。',
  pop: '看人口：几个国家的人口加起来有它这么多人。'
};

/** 「世界 → 地方」拿省/州来凑时，别再说「几个国家加起来」。 */
export const METRIC_HINT_REVERSE: Partial<Record<MetricId, string>> = {
  gdp: '看总量：几个省/州加起来能赶上它。',
  pop: '看人口：几个省/州的人口加起来有它这么多人。'
};
