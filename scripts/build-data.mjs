// 构建前端数据：public/data/regions.json + public/geo/*.json
// 用法：node scripts/build-data.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { feature } from 'topojson-client';
const { geoArea } = await import('d3-geo');
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
const areaTable = await readJson(resolve(RAW, 'countries-area.json'));
const provYear = await readJson(resolve(ROOT, 'data/provincial-gdp-2024.json'));

// ---------- 美国各州 ----------
// GDP / 人均来自维基百科转录的 BEA 表（2024 年），人口由「GDP ÷ 人均」反推，
// 面积按 us-atlas 的州界几何算。
const usStatesRaw = await readJson(resolve(RAW, 'us-states-gdp.wiki.json'));
const usTopo = await readJson(resolve(RAW, 'us-states-10m.json'));
const usStatesZh = await readJson(resolve(ROOT, 'data/us-states.json'));
const usGeo = feature(usTopo, usTopo.objects.states);

function parseUsStateTable(text) {
  const chunks = text.split(/\n\{\|/).slice(1);
  const num = (s) => Number((s || '').replace(/[^0-9.]/g, ''));
  const strip = (c) =>
    c
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
      .replace(/<[^>]*>/g, '')
      .trim();
  let best = [];
  for (const chunk of chunks) {
    const rows = [];
    for (const row of chunk.split(/\n\|-/).slice(1)) {
      const raw = row.split(/\n\s*\|/).slice(1);
      if (raw.length < 9) continue;
      const flag = raw[0].match(/\{\{flagg\|[^|]*\|([^|]*)\|/);
      const name = (flag ? flag[1] : raw[0].replace(/\{\{.*?\}\}/g, ''))
        .replace(/\s*\(U\.S\. state\)/, '')
        .trim();
      if (!name || !Number.isFinite(num(strip(raw[1])))) continue;
      const c = raw.map(strip);
      rows.push({
        name,
        gdp: num(c[1]) * 1e6, // 百万美元 → 美元
        gdpPc: num(c[8]),
        pop2025: num(c[7])
      });
    }
    if (rows.length > best.length) best = rows;
  }
  return best;
}

const usText = usStatesRaw.query.pages[0].revisions[0].slots.main.content;
const usRows = parseUsStateTable(usText);
const usByName = new Map(usRows.map((r) => [r.name, r]));

// 面积要等 geometryAreaKm2 定义好之后再算，所以做成函数稍后调用
function buildUsStates() {
  const usStates = [];
  const usFeatures = [];
  for (const f of usGeo.features) {
    const fips = String(f.id).padStart(2, '0');
    const zh = usStatesZh[fips];
    if (!zh) continue; // 波多黎各等属地不进
    const row = usByName.get(f.properties.name) ?? usByName.get('Washington, D.C.');
    if (!row) continue;
    const area = Math.round(geometryAreaKm2(f.geometry));
    const pop = row.gdpPc ? row.gdp / row.gdpPc : null;
    usStates.push({
      id: `US-${fips}`,
      adcode: fips,
      zh: zh.zh,
      en: zh.en,
      gdp: { nominal: { [DEFAULT_YEAR]: row.gdp } },
      gdpPc: { [DEFAULT_YEAR]: row.gdpPc },
      pop: { [DEFAULT_YEAR]: pop },
      area,
      search: searchKey(zh.zh, zh.en)
    });
    usFeatures.push({
      type: 'Feature',
      id: fips,
      properties: { fips, name: zh.en, zh: zh.zh },
      geometry: f.geometry
    });
  }
  return { usStates, usFeatures };
}
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

// ---------- 面积：从几何算球面面积 ----------
// 省级用 DataV 的高精度边界直接算；国家用 mledoze/countries 的面积表（更准，保留小国）。
const EARTH_R = 6371.0088;
function geometryAreaKm2(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let total = 0;
  for (const poly of polys) {
    total += Math.abs(
      geoArea({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: poly } })
    );
  }
  return total * EARTH_R * EARTH_R;
}
const countryArea = new Map();
for (const c of areaTable) {
  const code = c.cca3 || c.ccn3;
  if (code && typeof c.area === 'number') countryArea.set(code, c.area);
}

const { usStates, usFeatures } = buildUsStates();

const fx = {};
for (const y of YEARS) fx[y] = await fetchExchangeRate(y);

// ---------- 国家 ----------
// 港澳台按中国境内一级行政区处理（进入省级池），不重复出现在国家池
const CN_INTERNAL = new Set(['TWN', 'HKG', 'MAC']);
const worldIds = new Set(worldGeo.features.map((f) => f.id));

// PPP 换算因子 = PPPGDP / NGDPD，用来把省/州的名义 GDP 折成购买力平价口径
const pppFactor = new Map();
for (const [iso3, rec] of Object.entries(weo.data)) {
  const f = {};
  for (const y of Object.keys(rec.NGDPD ?? {})) {
    const nominal = rec.NGDPD[y];
    const ppp = rec.PPPGDP?.[y];
    if (nominal && ppp) f[y] = ppp / nominal;
  }
  pppFactor.set(iso3, f);
}

let countryList = [];
for (const [iso3, rec] of Object.entries(weo.data)) {
  const nominal = {};
  for (const [y, v] of Object.entries(rec.NGDPD ?? {})) {
    if (v != null) nominal[y] = v * 1e9; // WEO 单位：十亿美元 → 美元
  }
  if (!nominal[DEFAULT_YEAR]) continue;
  const pop = {};
  for (const [y, v] of Object.entries(rec.LP ?? {})) {
    if (v != null) pop[y] = v * 1e6; // WEO 单位：百万人 → 人
  }
  const en = weo.labels?.[iso3] ?? iso3;
  const zh = zhCountryName(iso3);
  const area = countryArea.get(iso3) ?? null;
  const gdpPc = {};
  for (const y of Object.keys(nominal)) {
    if (pop[y]) gdpPc[y] = nominal[y] / pop[y];
  }
  const ppp = {};
  for (const [y, v] of Object.entries(rec.PPPGDP ?? {})) {
    if (v != null) ppp[y] = v * 1e9; // 十亿美元 → 美元
  }
  countryList.push({
    id: iso3,
    zh: zh ?? en,
    en,
    hasGeometry: worldIds.has(iso3),
    gdp: { nominal },
    pop,
    gdpPc,
    area,
    ppp,
    search: searchKey(zh ?? en, en)
  });
}
const cnInternal = countryList.filter((c) => CN_INTERNAL.has(c.id));
countryList = countryList.filter((c) => !CN_INTERNAL.has(c.id));
countryList.sort((a, b) => b.gdp.nominal[DEFAULT_YEAR] - a.gdp.nominal[DEFAULT_YEAR]);

// ---------- 中国省级 ----------
const adcodeToName = new Map(chinaGeo.features.map((f) => [String(f.properties.adcode), f.properties.name]));
// 面积要用「反转绕向后」的几何来算：原始绕向会被 d3-geo 当成球面补集，算出 5 亿 km²
const provinceGeometry = new Map(
  chinaGeo.features.map((f) => [String(f.properties.adcode), reverseRings(f.geometry)])
);
const provinceList = provYear.provinces.map((p) => {
  const rate = fx[provYear.meta.year].cnyPerUsd;
  const gdpUsd = (p.gdp * 1e8) / rate; // 亿元人民币 → 美元
  const geometry = provinceGeometry.get(String(p.adcode));
  return {
    id: `CN-${p.adcode}`,
    adcode: p.adcode,
    zh: p.name,
    en: p.name,
    gdp: {
      nominal: {
        [provYear.meta.year]: gdpUsd
      }
    },
    // 人均：年鉴直接给了人民币口径，除以年均汇率折美元
    gdpPc: {
      [provYear.meta.year]: p.gdpPerCapita / rate
    },
    // 人口由「总量 ÷ 人均」反推（年鉴未单列常住人口）
    pop: {
      [provYear.meta.year]: p.gdpPerCapita ? (p.gdp * 1e8) / p.gdpPerCapita : null
    },
    // 面积：按 DataV 边界估算
    area: geometry ? Math.round(geometryAreaKm2(geometry)) : null,
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
  const geometry = provinceGeometry.get(String(x.adcode));
  provinceList.push({
    id: x.id,
    adcode: x.adcode,
    zh: x.zh,
    en: x.en,
    gdp: { nominal },
    gdpPc: c.gdpPc,
    pop: c.pop,
    area: geometry ? Math.round(geometryAreaKm2(geometry)) : c.area,
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
/** 省/州的 PPP 估算：名义 GDP × 所属国家的 PPP 换算因子 */
function pppForRegion(countryIso3, nominalByYear) {
  const factor = pppFactor.get(countryIso3) ?? {};
  const out = {};
  for (const [y, v] of Object.entries(nominalByYear)) {
    const f = factor[y];
    if (f) out[y] = v * f;
  }
  return out;
}

await mkdir(resolve(OUT, 'data'), { recursive: true });
await mkdir(resolve(OUT, 'geo'), { recursive: true });

// 统一对象模型：国家与省/州放在同一个池子里，用 kind 区分
const objects = [
  ...countryList.map((c) => ({
    id: c.id,
    kind: 'country',
    parentId: null,
    zh: c.zh,
    en: c.en,
    geoId: c.id,
    hasGeometry: c.hasGeometry,
    metrics: {
      gdp: { nominal: c.gdp.nominal },
      gdpPc: c.gdpPc,
      pop: c.pop,
      area: c.area,
      ppp: c.ppp
    },
    search: c.search
  })),
  ...provinceList.map((p) => ({
    id: p.id,
    kind: 'region',
    parentId: 'CHN',
    zh: p.zh,
    en: p.en,
    geoId: String(p.adcode),
    hasGeometry: true,
    metrics: {
      gdp: { nominal: p.gdp.nominal },
      gdpPc: p.gdpPc,
      pop: p.pop,
      area: p.area,
      // 省级没有官方 PPP 口径：用全国 PPP 换算因子估算
      ppp: pppForRegion('CHN', p.gdp.nominal)
    },
    source: p.source,
    search: p.search
  })),
  ...usStates.map((s) => ({
    id: s.id,
    kind: 'region',
    parentId: 'USA',
    zh: s.zh,
    en: s.en,
    geoId: s.adcode,
    hasGeometry: true,
    metrics: {
      gdp: { nominal: s.gdp.nominal },
      gdpPc: s.gdpPc,
      pop: s.pop,
      area: s.area,
      ppp: pppForRegion('USA', s.gdp.nominal)
    },
    source: 'BEA 州级 GDP（2024）与人口（经维基百科转录），面积按 us-atlas 州界几何算',
    search: s.search
  }))
];

const meta = {
  defaultYear: DEFAULT_YEAR,
  years: YEARS,
  provinceYear: provYear.meta.year,
  countrySource: `${weo.source}（名义 GDP，现价美元；${DEFAULT_YEAR} 为实际值，2025 为该版预测值）`,
  provinceSource: `${provYear.meta.source}（名义 GDP，现价人民币，按当年年均汇率折美元）`,
  provinceSourceUrl: provYear.meta.sourceUrl,
  usStateSource:
    'BEA 州级名义 GDP（2024）与人口（维基百科转录，源引 BEA / Census）；面积按 us-atlas 州界几何算',
  exchangeRate: Object.fromEntries(YEARS.map((y) => [y, fx[y]])),
  units: { country: 'USD', region: 'USD（由亿元人民币按年均汇率折算）' },
  generatedAt: new Date().toISOString(),
  note: '不同来源的统计口径与修订时间不同；跨年比较请注意各国统计口径差异。'
};

await writeFile(resolve(OUT, 'data/regions.json'), JSON.stringify({ meta, objects }), 'utf8');
await writeFile(resolve(OUT, 'geo/world.json'), JSON.stringify({ type: 'FeatureCollection', features: worldFeatures }), 'utf8');
await writeFile(resolve(OUT, 'geo/china.json'), JSON.stringify({ type: 'FeatureCollection', features: chinaFeatures }), 'utf8');
await writeFile(
  resolve(OUT, 'geo/us-states.json'),
  JSON.stringify({ type: 'FeatureCollection', features: usFeatures }),
  'utf8'
);

// ---------- 自检 ----------
const sumProv = provinceList
  .filter((p) => !p.source) // 港澳台不在年鉴 31 省口径内
  .reduce((s, p) => s + p.gdp.nominal[provYear.meta.year], 0);
const nationalUsd = (1349084 * 1e8) / fx[provYear.meta.year].cnyPerUsd; // 2024 全国 GDP（统计公报）
console.log(`国家：${countryList.length} 个经济体（其中 ${countryList.filter((c) => c.hasGeometry).length} 个有边界）`);
console.log(`中国省级：${provinceList.length} 个；美国州：${usStates.length} 个`);
console.log(
  `31 省合计 = ${(sumProv / 1e12).toFixed(4)} 万亿美元；全国 ${(nationalUsd / 1e12).toFixed(4)} 万亿美元；差 ${(((sumProv - nationalUsd) / nationalUsd) * 100).toFixed(2)}%`
);
console.log(`汇率：${YEARS.map((y) => `${y}=${fx[y].cnyPerUsd}`).join('  ')}`);
const usSum = usStates.reduce((s, x) => s + x.gdp.nominal[DEFAULT_YEAR], 0);
const usOfficial = 29_184_000_000_000; // 美国 2024 名义 GDP（IMF WEO 口径）
console.log(`美国各州合计 = ${(usSum / 1e12).toFixed(3)} 万亿美元；全美 ${(usOfficial / 1e12).toFixed(3)} 万亿美元；差 ${(((usSum - usOfficial) / usOfficial) * 100).toFixed(2)}%`);
const show = (zh) => {
  const c = countryList.find((x) => x.zh === zh || x.zh.includes(zh));
  const p = provinceList.find((x) => x.zh.includes(zh));
  const u = usStates.find((x) => x.zh.includes(zh));
  console.log(
    `  ${zh}: 省 ${p ? (p.gdp.nominal['2024'] / 1e12).toFixed(3) + ' 万亿美元' : '-'} | 州 ${u ? (u.gdp.nominal['2024'] / 1e12).toFixed(3) + ' 万亿美元' : '-'} | 国 ${c ? (c.gdp.nominal['2024'] / 1e12).toFixed(3) + ' 万亿美元' : '-'}`
  );
};
console.log('抽样：');
['广东省', '河南省', '得克萨斯州', '加利福尼亚州'].forEach(show);
['韩国', '日本', '英国', '印度'].forEach(show);
console.log('\n已写入 public/data/regions.json, public/geo/{world,china,us-states}.json');
