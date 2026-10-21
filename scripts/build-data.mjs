// 构建前端数据：public/data/regions.json + public/geo/*.json
// 用法：node scripts/build-data.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import countries from 'i18n-iso-countries';
import { pinyin } from 'pinyin-pro';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = resolve(ROOT, 'data/raw');
const OUT = resolve(ROOT, 'public');
const YEARS = ['2024', '2025'];
const DEFAULT_YEAR = '2024';

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

// ---------- 汇率（人民币 → 美元年均汇率）----------
async function fetchExchangeRate(year) {
  const cache = resolve(RAW, `fx-usd-cny-${year}.json`);
  try {
    return JSON.parse(await readFile(cache, 'utf8'));
  } catch {
    /* 未缓存则去取 */
  }
  const url = `https://api.worldbank.org/v2/country/CHN/indicator/PA.NUS.FCRF?format=json&date=${year}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'gdp-map/1.0' } });
  const j = await r.json();
  const value = j?.[1]?.[0]?.value ?? null;
  const payload = { year: Number(year), cnyPerUsd: value, source: 'World Bank PA.NUS.FCRF (official exchange rate, annual average)' };
  await writeFile(cache, JSON.stringify(payload, null, 1), 'utf8');
  return payload;
}

// ---------- 中文国名 ----------
function zhCountryName(iso3) {
  const zh = countries.getName(iso3, 'zh-Hans', { select: 'official' }) ?? countries.getName(iso3, 'zh', { select: 'official' });
  return zh || null;
}

// ---------- 搜索关键字 ----------
function searchKey(zh, en) {
  const full = pinyin(zh ?? '', { toneType: 'none', type: 'array' }).join('');
  const initials = pinyin(zh ?? '', { pattern: 'first', toneType: 'none', type: 'array' }).join('');
  return [zh, en, full, initials].filter(Boolean).join(' ').toLowerCase();
}

// ---------- 读取原始数据 ----------
const weo = await readJson(resolve(RAW, 'weo-2025-04.json'));
const worldGeo = await readJson(resolve(RAW, 'world.geo.json'));
const chinaGeo = await readJson(resolve(RAW, 'china-provinces.geo.json'));
const provYear = await readJson(resolve(ROOT, 'data/provincial-gdp-2024.json'));

const fx = {};
for (const y of YEARS) fx[y] = await fetchExchangeRate(y);

// ---------- 国家 ----------
// 港澳台按中国境内一级行政区处理（进入省级池），不重复出现在国家池
const CN_INTERNAL = new Set(['TWN', 'HKG', 'MAC']);
const worldIds = new Set(worldGeo.features.map((f) => f.id));
let countryList = [];
for (const [iso3, rec] of Object.entries(weo.data)) {
  const nominal = {};
  for (const y of YEARS) {
    const v = rec.NGDPD?.[y];
    if (v != null) nominal[y] = v * 1e9; // WEO 单位：十亿美元 → 美元
  }
  if (!nominal[DEFAULT_YEAR]) continue;
  const en = weo.labels?.[iso3] ?? iso3;
  const zh = zhCountryName(iso3);
  countryList.push({
    id: iso3,
    zh: zh ?? en,
    en,
    hasGeometry: worldIds.has(iso3),
    gdp: { nominal },
    search: searchKey(zh ?? en, en)
  });
}
const cnInternal = countryList.filter((c) => CN_INTERNAL.has(c.id));
countryList = countryList.filter((c) => !CN_INTERNAL.has(c.id));
countryList.sort((a, b) => b.gdp.nominal[DEFAULT_YEAR] - a.gdp.nominal[DEFAULT_YEAR]);

// ---------- 中国省级 ----------
const adcodeToName = new Map(chinaGeo.features.map((f) => [String(f.properties.adcode), f.properties.name]));
const provinceList = provYear.provinces.map((p) => {
  const rate = fx[provYear.meta.year].cnyPerUsd;
  return {
    id: `CN-${p.adcode}`,
    adcode: p.adcode,
    zh: p.name,
    en: p.name,
    gdp: {
      nominal: {
        [provYear.meta.year]: (p.gdp * 1e8) / rate // 亿元人民币 → 美元
      }
    },
    gdpPerCapita: p.gdpPerCapita,
    search: searchKey(p.name, p.name)
  };
});
provinceList.sort((a, b) => b.gdp.nominal[provYear.meta.year] - a.gdp.nominal[provYear.meta.year]);

// 港澳台：年鉴不列，用 IMF WEO 的经济体数据补齐（已是美元）
const CN_EXTRA = [
  { id: 'CN-810000', adcode: 810000, zh: '香港特别行政区', en: 'Hong Kong SAR', iso3: 'HKG' },
  { id: 'CN-820000', adcode: 820000, zh: '澳门特别行政区', en: 'Macao SAR', iso3: 'MAC' },
  { id: 'CN-710000', adcode: 710000, zh: '台湾省', en: 'Taiwan', iso3: 'TWN' }
];
for (const x of CN_EXTRA) {
  const c = cnInternal.find((k) => k.id === x.iso3);
  if (!c) continue;
  const nominal = {};
  for (const y of YEARS) if (c.gdp.nominal[y] != null) nominal[y] = c.gdp.nominal[y];
  provinceList.push({
    id: x.id,
    adcode: x.adcode,
    zh: x.zh,
    en: x.en,
    gdp: { nominal },
    gdpPerCapita: undefined,
    source: `${weo.source}（非年鉴口径，年鉴不单列港澳台）`,
    search: searchKey(x.zh, x.en)
  });
}
provinceList.sort((a, b) => (b.gdp.nominal[provYear.meta.year] ?? 0) - (a.gdp.nominal[provYear.meta.year] ?? 0));

// ---------- 世界边界：把 TWN 并入 CHN（国内发布惯例）----------
const worldFeatures = [];
for (const f of worldGeo.features) {
  if (f.id === 'TWN') continue; // 并入 CHN
  worldFeatures.push({
    type: 'Feature',
    id: f.id,
    properties: { id: f.id, name: f.properties?.name ?? f.id },
    geometry: f.geometry
  });
}
const chn = worldGeo.features.find((f) => f.id === 'CHN');
const twn = worldGeo.features.find((f) => f.id === 'TWN');
if (chn && twn) {
  const polys = [];
  if (chn.geometry.type === 'Polygon') polys.push(chn.geometry.coordinates);
  else polys.push(...chn.geometry.coordinates);
  if (twn.geometry.type === 'Polygon') polys.push(twn.geometry.coordinates);
  else polys.push(...twn.geometry.coordinates);
  const target = worldFeatures.find((f) => f.id === 'CHN');
  target.geometry = { type: 'MultiPolygon', coordinates: polys };
}

// ---------- 中国省级边界 ----------
// DataV 的多边形环绕向与 d3-geo 的球面约定相反，直接渲染会被当成「球面补集」，
// 所以这里统一反转每个环（外环/内环一起反转，绕向相对关系不变）。
function reverseRings(geometry) {
  const flip = (ring) => [...ring].reverse();
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map(flip) };
  }
  if (geometry.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((poly) => poly.map(flip)) };
  }
  return geometry;
}

const chinaFeatures = chinaGeo.features.map((f) => ({
  type: 'Feature',
  id: String(f.properties.adcode),
  properties: {
    adcode: f.properties.adcode,
    name: f.properties.name,
    center: f.properties.center,
    centroid: f.properties.centroid,
    isSouthSea: String(f.properties.adcode).endsWith('_JD')
  },
  geometry: reverseRings(f.geometry)
}));

// ---------- 输出 ----------
await mkdir(resolve(OUT, 'data'), { recursive: true });
await mkdir(resolve(OUT, 'geo'), { recursive: true });

const meta = {
  defaultYear: DEFAULT_YEAR,
  years: YEARS,
  provinceYear: provYear.meta.year,
  countrySource: `${weo.source}（名义 GDP，现价美元；${DEFAULT_YEAR} 为实际值，2025 为该版预测值）`,
  provinceSource: `${provYear.meta.source}（名义 GDP，现价人民币，按当年年均汇率折美元）`,
  provinceSourceUrl: provYear.meta.sourceUrl,
  exchangeRate: Object.fromEntries(YEARS.map((y) => [y, fx[y]])),
  units: { country: 'USD', province: 'USD（由亿元人民币按年均汇率折算）' },
  generatedAt: new Date().toISOString(),
  note: '不同来源的统计口径与修订时间不同；跨年比较请注意各国统计口径差异。'
};

await writeFile(resolve(OUT, 'data/regions.json'), JSON.stringify({ meta, countries: countryList, provinces: provinceList }), 'utf8');
await writeFile(resolve(OUT, 'geo/world.json'), JSON.stringify({ type: 'FeatureCollection', features: worldFeatures }), 'utf8');
await writeFile(resolve(OUT, 'geo/china.json'), JSON.stringify({ type: 'FeatureCollection', features: chinaFeatures }), 'utf8');

// ---------- 自检 ----------
const sumProv = provinceList
  .filter((p) => !p.source) // 港澳台不在年鉴 31 省口径内
  .reduce((s, p) => s + p.gdp.nominal[provYear.meta.year], 0);
const nationalUsd = (1349084 * 1e8) / fx[provYear.meta.year].cnyPerUsd; // 2024 全国 GDP（统计公报）
console.log(`国家：${countryList.length} 个经济体（其中 ${countryList.filter((c) => c.hasGeometry).length} 个有边界）`);
console.log(`省份：${provinceList.length} 个`);
console.log(`31 省合计 = ${(sumProv / 1e12).toFixed(4)} 万亿美元；全国 ${(nationalUsd / 1e12).toFixed(4)} 万亿美元；差 ${(((sumProv - nationalUsd) / nationalUsd) * 100).toFixed(2)}%`);
console.log(`汇率：${YEARS.map((y) => `${y}=${fx[y].cnyPerUsd}`).join('  ')}`);
const show = (zh) => {
  const c = countryList.find((x) => x.zh === zh || x.zh.includes(zh));
  const p = provinceList.find((x) => x.zh.includes(zh));
  console.log(`  ${zh}: 省 ${p ? (p.gdp.nominal['2024'] / 1e12).toFixed(3) + ' 万亿美元' : '-'} | 国 ${c ? (c.gdp.nominal['2024'] / 1e12).toFixed(3) + ' 万亿美元' : '-'}`);
};
console.log('抽样：');
['广东省', '河南省', '西藏', '上海'].forEach(show);
['韩国', '日本', '英国', '印度'].forEach(show);
console.log('\n已写入 public/data/regions.json, public/geo/world.json, public/geo/china.json');
