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

/** 年鉴的网页是 GB2312 编码的，Node 自带 gbk 解码器 */
const gbk = new TextDecoder('gbk');

/**
 * 中国省级：历年的地区生产总值（国家统计局年鉴的 HTML 表）。
 *
 * ⚠️ `data.stats.gov.cn` 的「分省年度数据」接口被 WAF 按 **IP** 挡了
 *    （403，reason: UrlACL）——真浏览器、CDP 都过不去，别再试了。
 *    但年鉴的网页版（`www.stats.gov.cn/sj/ndsj/`）是通的 ✓。
 * ⚠️ **2015 年及以后的版本，表是图片**（`C03-09.jpg`，得靠人眼读）；
 *    2014 及以前是 HTML（`C0214C.HTM` 这类），每版覆盖 5 年。
 *    所以程序能拿的是 **2000–2013**；2014–2024 那个缺口得另外补。
 */
const YB_EDITIONS = ['2005', '2006', '2007', '2008', '2009', '2010', '2011', '2012', '2013', '2014'];

/** 抓一张年鉴的表：目录里找标题含关键字的那张，返回解析好的行 */
async function fetchYearbookTable(edition, keyword) {
  const tocUrl = `https://www.stats.gov.cn/sj/ndsj/${edition}/left.htm`;
  let toc;
  try {
    const r = await fetch(tocUrl, { headers: { 'User-Agent': 'gdp-map/1.0' } });
    if (!r.ok) return null;
    toc = gbk.decode(await r.arrayBuffer());
  } catch {
    return null;
  }
  const hit = [...toc.matchAll(/<a[^>]*href\s*=\s*["']?([^"' >]+)[^>]*>([\s\S]{0,200}?)<\/a>/gi)]
    .map((m) => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() }))
    .find((x) => x.text.includes(keyword) && /\.htm/i.test(x.href));
  if (!hit) return null;
  const href = hit.href.replace(/^\/?/, '').replace(/\\/g, '/');
  const url = `https://www.stats.gov.cn/sj/ndsj/${edition}/${href}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'gdp-map/1.0' } });
    if (!r.ok) return null;
    const html = gbk.decode(await r.arrayBuffer());
    // 表格行：单元格文字
    const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) =>
      m[0]
        .split(/<\/?t[dh][^>]*>/i)
        .join('\x01')
        .split('\x01')
        .map((s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
        .filter((s) => s.length)
    );
    // 年份表头：像 ["2005","2006",...] 的那一行。
    // ⚠️ 人口表的表头前面还带一个「地 区」标签格（["地 区","2000",...]），
    //    所以不能要求整行都是年份，放宽成「绝大多数格子是年份」。
    const head = rows.find((r) => {
      const ys = r.filter((c) => /^\d{4}$/.test(c));
      return ys.length >= 2 && ys.length >= r.length - 1;
    });
    if (!head) return null;
    // ⚠️ 「绝对数 + 指数」两张表并排放，年份会出现**两遍**（[2005..2009, 2005..2009]）。
    //    两半一样时，绝对数的那一半在前——不切一半的话，后面的指数会覆盖前面的数
    //    （河南 2005 会变成 114 亿，正确值是 1,059 亿）。
    let years = head.filter((c) => /^\d{4}$/.test(c)).map(Number);
    if (years.length % 2 === 0) {
      const half = years.length / 2;
      if (years.slice(0, half).join(',') === years.slice(half).join(',')) {
        years = years.slice(0, half);
      }
    }
    return { url, years, rows };
  } catch {
    return null;
  }
}

/** 把一张「地区生产总值」表拆成 { 省名: { 年: 值 } }（只取绝对数那一半） */
function parseYearbookProvinceRows(table, nameToAdcode) {
  const n = table.years.length;
  const out = {};
  for (const row of table.rows) {
    const name = (row[0] ?? '').replace(/\s+/g, '');
    const adcode = nameToAdcode.get(name);
    if (!adcode) continue;
    const values = row.slice(1).map(Number);
    // 表头里年份出现两遍时，years 已经切成一半；这里取前 n 个（绝对数），
    // 后半段的「指数」不要。只有绝对数的表 values.length 也是 n，结果一样。
    const absolute = values.slice(0, n);
    const series = {};
    table.years.forEach((y, i) => {
      const v = absolute[i];
      if (Number.isFinite(v)) series[String(y)] = v;
    });
    if (Object.keys(series).length) out[adcode] = series;
  }
  return out;
}

// ---------- 数值收口 ----------
// 源数据给的是「十亿美元」「百万人」这类带小数的量，乘/除之后会留下浮点尾巴：
// 8577.549999999999 × 1e9 = 8577549999999.999。这串尾巴不是数据，却会：
//   1. 让 regions.json 里出现一堆假精度（"1997": 8577549999999.999）；
//   2. 把 JSON 撑大（每个数多几个字符，几千个值就是几十 KB）。
// 发布前按「这个量本来是什么单位」收口：钱到元、人到人、人均到分。
const money = (v) => Math.round(v);
const people = (v) => Math.round(v);
const perCapita = (v) => Math.round(v * 100) / 100;

// ---------- 汇率（人民币 → 美元年均汇率）----------
async function fetchExchangeRate(year) {
  const cache = resolve(RAW, `fx-usd-cny-${year}.json`);
  try {
    const cached = JSON.parse(await readFile(cache, 'utf8'));
    // 旧版本在接口失败时会把 null 写进缓存；坏缓存不能当数据用
    if (typeof cached?.cnyPerUsd === 'number' && Number.isFinite(cached.cnyPerUsd)) return cached;
  } catch {
    /* 未缓存则去取 */
  }
  const url = `https://api.worldbank.org/v2/country/CHN/indicator/PA.NUS.FCRF?format=json&date=${year}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'gdp-map/1.0' } });
  if (!r.ok) throw new Error(`汇率接口 HTTP ${r.status}：${url}`);
  const j = await r.json();
  const value = j?.[1]?.[0]?.value ?? null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`汇率接口没有有效值：${url}`);
  }
  const payload = { year: Number(year), cnyPerUsd: value, source: 'World Bank PA.NUS.FCRF (official exchange rate, annual average)' };
  await writeFile(cache, JSON.stringify(payload, null, 1), 'utf8');
  return payload;
}

/** 一整段年份的汇率（一次请求拿到多年） */
async function fetchExchangeRates(from, to) {
  const cache = resolve(RAW, `fx-usd-cny-${from}-${to}.json`);
  try {
    const cached = JSON.parse(await readFile(cache, 'utf8'));
    // 一个空对象是「上次接口失败」留下的：重新抓，别让省级历史整段消失
    if (cached && typeof cached === 'object' && Object.keys(cached).length) return cached;
  } catch {
    /* 未缓存则去取 */
  }
  const url = `https://api.worldbank.org/v2/country/CHN/indicator/PA.NUS.FCRF?format=json&date=${from}:${to}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'gdp-map/1.0' } });
  if (!r.ok) throw new Error(`汇率接口 HTTP ${r.status}：${url}`);
  const j = await r.json();
  if (!Array.isArray(j?.[1]) || !j[1].length) {
    throw new Error(`汇率接口没有返回数据：${url}`);
  }
  const out = {};
  for (const row of j[1]) {
    const y = Number(row.date);
    if (Number.isFinite(y) && typeof row.value === 'number') out[y] = row.value;
  }
  if (!Object.keys(out).length) throw new Error(`汇率接口没有有效年份：${url}`);
  await writeFile(cache, JSON.stringify(out, null, 1), 'utf8');
  return out;
}

// ---------- 中文国名 ----------
// ⚠️ 有几个经济体的代码不是标准 ISO 3166-1（IMF 用 UVK 表示科索沃），
// i18n-iso-countries 里查不到，只能手写；不改的话界面上会露出英文名。
const ZH_OVERRIDES = {
  UVK: '科索沃'
};

function zhCountryName(iso3) {
  if (ZH_OVERRIDES[iso3]) return ZH_OVERRIDES[iso3];
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
// 主源是 BEA 的官方数：各州 1997–2025 的现价美元 GDP 与人口
// （scripts/fetch-regions.mjs 抓的，写在 data/us-states-series.json）。
// 维基百科转录的 BEA 表（2024 年）只当兜底：它有人均，人口由「GDP ÷ 人均」反推。
// 面积按 us-atlas 的州界几何算。
const usStatesRaw = await readJson(resolve(RAW, 'us-states-gdp.wiki.json'));
const usTopo = await readJson(resolve(RAW, 'us-states-10m.json'));
const usStatesZh = await readJson(resolve(ROOT, 'data/us-states.json'));
// BEA 的官方数：各州 1997–2025 的现价美元 GDP 与人口
// （scripts/fetch-regions.mjs 抓的，写在 data/us-states-series.json）
const usStatesSeries = await readJson(resolve(ROOT, 'data/us-states-series.json'));
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
    // BEA 的官方数（现价美元 GDP + 人口，1997–2025），维基的转录只当兜底
    const bea = usStatesSeries[f.properties.name] ?? null;
    const row = usByName.get(f.properties.name) ?? usByName.get('Washington, D.C.');
    if (!row && !bea) continue;
    const area = Math.round(geometryAreaKm2(f.geometry));
    const nominal = {};
    const popMap = {};
    for (const [y, v] of Object.entries(bea?.gdp ?? {})) {
      if (!Number.isFinite(v)) continue;
      nominal[y] = money(v * 1e6); // 百万美元 → 美元
      const p = bea.pop[y];
      if (Number.isFinite(p)) popMap[y] = people(p);
    }
    // 缺 2024（或某个州整段缺失）时用维基百科转录的值补上
    if (!nominal[DEFAULT_YEAR] && row) {
      nominal[DEFAULT_YEAR] = row.gdp;
      popMap[DEFAULT_YEAR] = row.gdpPc ? people(row.gdp / row.gdpPc) : null;
    }
    const gdpPcMap = {};
    for (const [y, g] of Object.entries(nominal)) {
      const p = popMap[y];
      if (p) gdpPcMap[y] = Math.round((g / p) * 100) / 100;
    }
    usStates.push({
      id: `US-${fips}`,
      adcode: fips,
      zh: zh.zh,
      en: zh.en,
      gdp: { nominal },
      gdpPc: gdpPcMap,
      pop: popMap,
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

// ---------- 坐标精度 ----------
// 源几何给到 14~15 位小数（约 0.1 毫米），而地图上一个像素约等于 8 公里——
// 细了三个数量级，纯属白下载。5 位小数 ≈ 1.1 米，比像素细两个数量级，够用。
// ⚠️ **只裁「写到前端的那一份」**：面积仍然用原始几何算（geometryAreaKm2 拿到的是
// 未裁的），所以已经校验过的面积数字不会因为这次改动而漂移。
const GEO_PRECISION = 5;
function roundCoords(value) {
  if (Array.isArray(value)) return value.map(roundCoords);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = roundCoords(value[k]);
    return out;
  }
  if (typeof value === 'number') return Number(value.toFixed(GEO_PRECISION));
  return value;
}
/** 只裁 geometry，id 与 properties 原样保留（id 有的是数字，别去动它） */
function roundGeometry(fc) {
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => ({ ...f, geometry: roundCoords(f.geometry) }))
  };
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
for (const y of YEARS) {
  const raw = await fetchExchangeRate(y);
  // 汇率也要收口：World Bank 给的是 7.19749110789916 这种 14 位小数，
  // 6 位小数（万分之六）已经远细于任何一年的年均汇率精度。
  fx[y] = { ...raw, cnyPerUsd: Number(raw.cnyPerUsd?.toFixed(6)) };
}
// 分省历史要用 2000–2024 的汇率：一次请求拿多年（逐年请求太慢）
const fxHistory = await fetchExchangeRates('2000', '2024');
for (const [y, v] of Object.entries(fxHistory)) {
  if (fx[y]) continue;
  fx[y] = { year: Number(y), cnyPerUsd: v, source: 'World Bank PA.NUS.FCRF (official exchange rate, annual average)' };
}

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

// ---------- 1960–1989：世界银行口径，把国家侧的历史往前延 ----------
// IMF WEO 从 1990 起。1960–1989 用世界银行（GDP 现价美元 + 人口），
// 没抓过这个文件就只用 WEO 的 1990 起（不影响其它部分）。
let wb = null;
try {
  wb = await readJson(resolve(RAW, 'wb-gdp-pop-1960-1989.json'));
} catch {
  wb = null;
}

let countryList = [];
for (const [iso3, rec] of Object.entries(weo.data)) {
  const nominal = {};
  // ⚠️ WEO 的缺失值是字符串 "NA"，`v != null` 拦不住它：
  //    "NA" * 1e9 是 NaN，JSON 里会落成 null，年份清单却还留着这一年。
  for (const [y, v] of Object.entries(rec.NGDPD ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n)) nominal[y] = money(n * 1e9); // WEO 单位：十亿美元 → 美元
  }
  if (!nominal[DEFAULT_YEAR]) continue;
  const pop = {};
  for (const [y, v] of Object.entries(rec.LP ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n)) pop[y] = people(n * 1e6); // WEO 单位：百万人 → 人
  }
  // 1990 之前：世界银行口径（只补 WEO 没有的年份，两段不打架）
  const wbRec = wb?.data?.[iso3];
  if (wbRec) {
    for (const [y, v] of Object.entries(wbRec.gdp ?? {})) {
      if (v != null && nominal[y] == null) nominal[y] = money(v);
    }
    for (const [y, v] of Object.entries(wbRec.pop ?? {})) {
      if (v != null && pop[y] == null) pop[y] = people(v);
    }
  }
  const en = weo.labels?.[iso3] ?? iso3;
  const zh = zhCountryName(iso3);
  const area = countryArea.get(iso3) ?? null;
  const gdpPc = {};
  for (const y of Object.keys(nominal)) {
    if (pop[y]) gdpPc[y] = perCapita(nominal[y] / pop[y]);
  }
  const ppp = {};
  for (const [y, v] of Object.entries(rec.PPPGDP ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n)) ppp[y] = money(n * 1e9); // 十亿美元 → 美元
  }
  // 1990 年前没有官方 PPP：用该国 1990 年的换算因子近似（PPP 因子变化很慢）
  const f1990 = pppFactor.get(iso3)?.['1990'];
  if (f1990) {
    for (const y of Object.keys(nominal)) {
      if (y < '1990' && ppp[y] == null) ppp[y] = money(nominal[y] * f1990);
    }
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
/**
 * 中国省级：历年的地区生产总值与人口。
 *
 * 两个来源，合起来才是完整的一条序列：
 * ① 2000–2011：年鉴**网页版**的 HTML 表（程序解析，见 fetchYearbookTable）。
 * ② 2010–2024：年鉴的**表格图片**（人工读数，落在 data/provincial-gdp-history.json）。
 *    —— 2015 版起表就是图片（`C03-09.jpg`），解析不了；2013/2014 版只有 BIFF 的 .xls。
 * 重叠的年份以 ② 为准（版本更新）：两边对同一年的数是一致的（2010、2011–2014 都逐个核对过）。
 *
 * ⚠️ `data.stats.gov.cn` 的「分省年度数据」接口被 WAF 按 **IP** 挡了
 *    （403，reason: UrlACL）——真浏览器、CDP 都过不去，别再试了。
 *    但年鉴的网页版（`www.stats.gov.cn/sj/ndsj/`）是通的 ✓。
 */
const cnNameToAdcode = new Map(
  provYear.provinces.map((p) => [p.name.replace(/(省|市|自治区|维吾尔|壮族|回族)/g, ''), p.adcode])
);
const cnHistory = {};
{
  // ① HTML 表
  const gdpTables = {};
  const popTables = {};
  for (const ed of YB_EDITIONS) {
    const gdpTable = await fetchYearbookTable(ed, '地区生产总值和指数');
    if (gdpTable) {
      for (const [adcode, series] of Object.entries(parseYearbookProvinceRows(gdpTable, cnNameToAdcode))) {
        gdpTables[adcode] = { ...(gdpTables[adcode] ?? {}), ...series };
      }
    }
    // 人口：「各地区年末人口数」（单位万人）
    const popTable =
      (await fetchYearbookTable(ed, '各地区年末人口数')) ?? (await fetchYearbookTable(ed, '分地区年末人口数'));
    if (popTable) {
      for (const [adcode, series] of Object.entries(parseYearbookProvinceRows(popTable, cnNameToAdcode))) {
        popTables[adcode] = { ...(popTables[adcode] ?? {}), ...series };
      }
    }
  }
  const years = new Set();
  for (const s of Object.values(gdpTables)) for (const y of Object.keys(s)) years.add(y);
  for (const y of years) {
    const rows = {};
    for (const [adcode, series] of Object.entries(gdpTables)) {
      const v = series[y];
      const p = popTables[adcode]?.[y];
      // GDP 与人口**都有**的年份才发布：少一项的话「人均 GDP」会是 0，
      // 那比没有这个年份更糟
      if (v == null || p == null) continue;
      rows[adcode] = { gdp: v, pop: p * 1e4 }; // 亿元 / 万人 → 元 / 人
    }
    if (Object.keys(rows).length) cnHistory[y] = rows;
  }
  // ② 图片读数（更新的版本，覆盖同一年份的 HTML 值）
  const cnImg = await readJson(resolve(ROOT, 'data/provincial-gdp-history.json'));
  for (const [year, v] of Object.entries(cnImg.years)) {
    const pop = cnImg.population[year] ?? {};
    const rows = {};
    for (const [code, p] of Object.entries(v.provinces)) {
      const popWan = pop[code];
      if (popWan == null) continue;
      rows[code] = { gdp: p.gdp, pop: popWan * 1e4 };
    }
    if (Object.keys(rows).length) cnHistory[year] = { ...(cnHistory[year] ?? {}), ...rows };
  }
  // 2024 有两处读数（仓库里的 provincial-gdp-2024.json 与图片读数），对一下
  const y2024 = cnHistory[String(provYear.meta.year)] ?? {};
  const drift = provYear.provinces.filter((p) => y2024[p.adcode] && y2024[p.adcode].gdp !== p.gdp);
  if (drift.length) {
    console.warn(
      `  ! 2024 的两处读数对不上：${drift
        .map((p) => `${p.name} ${p.gdp} vs ${y2024[p.adcode].gdp}`)
        .join('；')}`
    );
  }
  const got = Object.keys(cnHistory).sort();
  console.log(
    `  · 中国省级历史：${got.length} 个年份（${got[0]}–${got[got.length - 1]}），` +
      `${Object.keys(gdpTables).length} 个省` +
      (got.length ? `（${got.join('、')}）` : '')
  );
}

const provinceList = provYear.provinces.map((p) => {
  const geometry = provinceGeometry.get(String(p.adcode));
  // 逐年：年鉴的 GDP（亿元）与人口（人），按当年年均汇率折美元
  const nominal = {};
  const popMap = {};
  const gdpPcMap = {};
  for (const [y, rows] of Object.entries(cnHistory)) {
    const h = rows[p.adcode];
    const r = fx[y]?.cnyPerUsd;
    if (!h || !r) continue;
    nominal[y] = money((h.gdp * 1e8) / r); // 亿元人民币 → 美元
    popMap[y] = people(h.pop);
    // ⚠️ **人均一律按「GDP ÷ 人口」算**，不直接用年鉴公布的人均：
    //    公布的人均用的是当年的**年均**人口，我们发布的是**年末**人口。
    //    旧年份（七普后人口被上修、广东/浙江/天津这些能差 9%）两者对不上，
    //    而页面上「GDP ÷ 人口 = 人均」必须成立，否则三个指标自相矛盾。
    gdpPcMap[y] = perCapita(nominal[y] / popMap[y]);
  }
  return {
    id: `CN-${p.adcode}`,
    adcode: p.adcode,
    zh: p.name,
    en: p.name,
    gdp: { nominal },
    gdpPc: gdpPcMap,
    pop: popMap,
    // 面积：按 DataV 边界估算
    area: geometry ? Math.round(geometryAreaKm2(geometry)) : null,
    // 省级没有官方 PPP 口径：用全国 PPP 换算因子估算
    ppp: pppForRegion('CHN', nominal),
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
  // ⚠️ **用整条序列，不只 2024/2025**：国家池那边已经用世界银行把历史延到 1960
  //    （香港 1960–1989 有、澳门 1982 起有、台湾世界银行不发布统计所以 1990 起），
  //    这里只取两年的话，香港/台湾/澳门在年份控件里就只剩两年可拨。
  // ⚠️ 只收有 GDP 的年份，人口与人均也只跟这些年份对齐：
  //    澳门 1990–2000 在 WEO 里是 "NA"，不能变成「有年份、没值」。
  const nominal = {};
  for (const [y, v] of Object.entries(c.gdp.nominal)) if (v != null) nominal[y] = v;
  const pop = {};
  for (const [y, v] of Object.entries(c.pop)) if (nominal[y] != null && v != null) pop[y] = v;
  const gdpPc = {};
  for (const [y, v] of Object.entries(c.gdpPc)) if (nominal[y] != null && v != null) gdpPc[y] = v;
  const geometry = provinceGeometry.get(String(x.adcode));
  const wbYears = Object.keys(wb?.data?.[x.iso3]?.gdp ?? {});
  provinceList.push({
    id: x.id,
    adcode: x.adcode,
    zh: x.zh,
    en: x.en,
    gdp: { nominal },
    gdpPc,
    pop,
    area: geometry ? Math.round(geometryAreaKm2(geometry)) : c.area,
    // 港澳台在 WEO 里是独立经济体，用各自的 PPP 换算因子，别套中国的
    ppp: pppForRegion(x.iso3, nominal),
    gdpPerCapita: undefined,
    source:
      `${weo.source}（非年鉴口径，年鉴不单列港澳台）` +
      (wbYears.length ? `；1960–1989 用 World Bank NY.GDP.MKTP.CD + SP.POP.TOTL` : ''),
    search: searchKey(x.zh, x.en)
  });
}
provinceList.sort((a, b) => (b.gdp.nominal[provYear.meta.year] ?? 0) - (a.gdp.nominal[provYear.meta.year] ?? 0));

// ---------- 欧洲 NUTS-1 与日本都道府县 ----------
// 另一套源（Eurostat + 日本内阁府 + Natural Earth），由 scripts/fetch-regions.mjs 抓，
// 归一化后的结果放在 data/regions-eu-jp.json。
const euJp = await readJson(resolve(ROOT, 'data/regions-eu-jp.json'));
const nutsGeoRaw = await readJson(resolve(RAW, 'nuts1.geojson'));
const neAdmin1 = await readJson(resolve(RAW, 'ne_10m_admin_1.geo.json'));

/** NUTS-1 与日本都道府县的几何。面积从这里算，跟中美两省一个口径。
 *  ⚠️ **这两个源不要反转绕向**：Natural Earth 和 Eurostat 的绕向本来就是对的
 *  （反转后京都的面积会变成 5.1 亿 km²——球面补集）。要反转的只有 DataV 的中国边界。 */
const extraGeometry = new Map();
for (const f of nutsGeoRaw.features) {
  const id = String(f.properties.NUTS_ID);
  if (!euJp.regions.some((r) => r.set === 'nuts' && r.code === id)) continue;
  extraGeometry.set(`EU-${id}`, f.geometry);
}
for (const f of neAdmin1.features) {
  if (f.properties.adm0_a3 !== 'JPN') continue;
  // Natural Earth 的 admin-1 没有两位代码，用日文名反查——日本 47 个都道府县的名字是唯一的
  const jaName = f.properties.name_ja ?? f.properties.name;
  const hit = euJp.regions.find((r) => r.set === 'jp' && r.en === jaName);
  if (!hit) continue;
  extraGeometry.set(hit.id, f.geometry);
}

const extraRegions = euJp.regions.map((r) => {
  const geometry = extraGeometry.get(r.id);
  return {
    id: r.id,
    set: r.set,
    parentId: r.parentId,
    zh: r.zh,
    en: r.en,
    series: r.series,
    area: geometry ? Math.round(geometryAreaKm2(geometry)) : null,
    source: r.source
  };
});
// 面积算完再看有没有漏掉几何的
const noGeometry = extraRegions.filter((r) => r.area == null);
if (noGeometry.length) {
  console.warn(`  ! ${noGeometry.length} 个新地区没找到边界：${noGeometry.map((r) => r.id).join(', ')}`);
}
const latestGdp = (r) => {
  const years = Object.keys(r.series ?? {}).sort();
  return r.series?.[years[years.length - 1]]?.gdpUsd ?? 0;
};
extraRegions.sort((a, b) => latestGdp(b) - latestGdp(a));

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
    if (f) out[y] = money(v * f);
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
      ppp: p.ppp
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
    source: 'BEA 州级名义 GDP（1997–2025）与人口；维基百科转录只作缺值兜底；面积按 us-atlas 州界几何算',
    search: s.search
  })),
  // 欧洲 NUTS-1 与日本都道府县：欧洲有 2000–2024 的多年数据，日本只有 2023
  ...extraRegions.map((r) => {
    const series = r.series ?? {};
    const years = Object.keys(series).sort();
    const year = years[years.length - 1];
    const nominal = {};
    const gdpPc = {};
    const pop = {};
    for (const y of years) {
      const s = series[y];
      nominal[y] = s.gdpUsd;
      pop[y] = s.pop;
      if (s.pop) gdpPc[y] = Math.round((s.gdpUsd / s.pop) * 100) / 100;
    }
    return {
      id: r.id,
      kind: 'region',
      parentId: r.parentId,
      zh: r.zh,
      en: r.en,
      geoId: r.id,
      hasGeometry: true,
      year,
      metrics: {
        gdp: { nominal },
        gdpPc,
        pop,
        area: r.area,
        // 同样没有官方 PPP 口径：用所属国家的 PPP 换算因子估算（跟中国省、美国州一样）。
        // 不给的话「平价 GDP」这个指标下这 141 个地区全是 0，选中就是一片空白。
        ppp: pppForRegion(r.parentId, nominal)
      },
      source: r.source,
      search: searchKey(r.zh, r.en)
    };
  })
];

// 数据实际覆盖的年份范围：前端滑块按这个来，别写死在代码里
// ⚠️ **只统计有正式统计的年份**：1960 年起是世界银行 / IMF WEO 的官方口径。
// 更早的年份只有麦迪逊项目的「估算」，而省/州在那些年份根本没有统计——
// 拿 2024 年的省去比 1700 年的猜测，结论是拼出来的，所以那些年份不发布。
const coveredYears = new Set();
for (const c of countryList) {
  for (const y of Object.keys(c.gdp.nominal)) coveredYears.add(Number(y));
}
const yearNums = [...coveredYears].filter((y) => Number.isFinite(y));
const yearRange = [String(Math.min(...yearNums)), String(Math.max(...yearNums))];

/**
 * 各侧数据实际覆盖的年份区间（页脚要写清楚，别写死一个「2024」）。
 *
 * 省/州侧现在逐年不同：中国省级 2000–2024、美国各州 1997–2025、
 * 欧洲 NUTS-1 2000–2024、日本府县只有 2023。
 */
const yearSpanOf = (list) => {
  const ys = new Set();
  for (const o of list) {
    for (const [y, v] of Object.entries(o.metrics?.gdp?.nominal ?? {})) {
      if (v != null) ys.add(Number(y));
    }
  }
  const s = [...ys].filter((y) => Number.isFinite(y)).sort((a, b) => a - b);
  if (!s.length) return null;
  // 只有一年就写那一年，别写成「2023–2023」
  return s[0] === s[s.length - 1] ? `${s[0]}` : `${s[0]}–${s[s.length - 1]}`;
};
const coverage = {
  countries: yearRange.join('–'),
  chinaProvinces: yearSpanOf(
    objects.filter((o) => o.kind === 'region' && o.parentId === 'CHN' && !/CN-(71|81|82)0000$/.test(o.id))
  ),
  hkMacaoTaiwan: yearSpanOf(objects.filter((o) => /CN-(71|81|82)0000$/.test(o.id))),
  usStates: yearSpanOf(objects.filter((o) => o.parentId === 'USA')),
  euNuts: yearSpanOf(objects.filter((o) => o.id.startsWith('EU-'))),
  japanPrefectures: yearSpanOf(objects.filter((o) => o.id.startsWith('JP-')))
};

// ---------- 价格基准：数据年份不一致时把两边的钱折到同一个价 ----------
// 正常路径上省/州与对照池都取滑块那一年，折算系数是 1；
// 这份指数是数据源给出不同年份时的兜底（例如只有单年数据的对象）。
// 不折算直接相比，等于把两个年份之间的物价差算进结论里（1960→2024 差八倍多）。
// 所以把美国 GDP 平减指数随数据一起发布，前端按它把两边折到同一个价。
let usDeflator = null;
try {
  usDeflator = await readJson(resolve(RAW, 'us-deflator.json'));
} catch {
  usDeflator = null;
}
const deflator = {};
if (usDeflator?.data) {
  for (const [y, v] of Object.entries(usDeflator.data)) {
    const n = Number(v);
    // 收口：三位小数足够（比率的精度到万分之一就过剩了）
    if (Number.isFinite(n) && n > 0) deflator[y] = Math.round(n * 1000) / 1000;
  }
}

const meta = {
  defaultYear: DEFAULT_YEAR,
  years: YEARS,
  /** 国家侧数据覆盖的年份范围（前端年份滑块用） */
  yearRange,
  provinceYear: provYear.meta.year,
  /** 各侧数据实际覆盖的年份（页脚写着，别让页脚说「数据年份 2024」误导） */
  coverage,
  countrySource:
    `${weo.source}（名义 GDP，现价美元；${DEFAULT_YEAR} 为实际值，2025 为该版预测值）` +
    (wb ? `；${yearRange[0]}–1989 用 ${wb.source}` : ''),
  provinceSource:
    '国家统计局《中国统计年鉴》表 3-9 地区生产总值（2000–2011 取年鉴网页版 HTML 表，' +
    '2010–2024 取年鉴表格图片的读数；人口取表 2-5/2-6 分地区年末人口数）：' +
    '名义 GDP，现价人民币，按当年年均汇率折美元；人均 = GDP ÷ 人口',
  provinceSourceUrl: provYear.meta.sourceUrl,
  /** 中国省级历史读数的落库文件（图片读数那部分） */
  provinceHistorySource: 'data/provincial-gdp-history.json',
  usStateSource:
    'BEA 州级名义 GDP（1997–2025）与人口；维基百科转录只作缺值兜底；面积按 us-atlas 州界几何算',
  extraRegionSource:
    `欧洲 NUTS-1（${euJp.euFrom}–${euJp.euTo}，Eurostat nama_10r_3gdp / nama_10r_3popgdp，边界 Eurostat GISCO）；` +
    `日本都道府县（${euJp.jpYear} 年度，内阁府《府县民经济计算》与总人口，边界 Natural Earth）`,
  // 省/州现在有多年的数据，汇率也一并发布（前端用不上，但查证时方便）
  exchangeRate: Object.fromEntries(Object.keys(fx).sort().map((y) => [y, fx[y]])),
  units: { country: 'USD', region: 'USD（由亿元人民币按年均汇率折算）' },
  /** 价格基准：数据年份不一致时把两边的钱折到同一个价（正常路径系数为 1） */
  priceBasis: {
    baseYear: String(DEFAULT_YEAR),
    source: usDeflator?.source ?? '',
    note:
      '正常路径上省/州与对照池都取滑块那一年，折算系数是 1；' +
      '这份美国 GDP 平减指数是数据源给出不同年份时的兜底，' +
      '不折算直接相比，等于把两个年份之间的物价差算进结论里。',
    deflator
  },
  generatedAt: new Date().toISOString(),
  note: '不同来源的统计口径与修订时间不同；跨年比较请注意各国统计口径差异。'
};

/**
 * 拆成两个文件：**基础文件**先到（首屏用），**历史文件**随后（年份回溯用）。
 *
 * ⚠️ 为什么要拆：省/州侧现在有 20~30 年数据（美国州 29 年、欧盟 25 年、中国省 25 年、
 *    世界 66 年），全放在一个文件里是 356 KB（gzip）——手机上首屏光等数据就一两秒。
 *    拆开后基础文件只有约 36 KB（gzip），首屏先出结论，历史数据到了再合并，
 *    年份控件随之可用。实测：首屏字节 733 KB → 125 KB（基础文件 + 世界底图）。
 *
 * 基础文件里每个对象放的是**它自己的默认年**（国家与省/州是 2024，日本府县是 2023），
 * 其余年份全进历史文件——所以「打开就有结论」这件事不依赖历史文件。
 */
const BASE_OBJECTS = [];
const HISTORY_OBJECTS = [];
for (const o of objects) {
  const defaultYear = o.year ?? DEFAULT_YEAR;
  // 年份清单只收有值的年份：WEO 的 "NA" 已经在国家构造时过滤，
  // 这里再兜一道，避免「年份控件能选、拨过去是 0」。
  const gdpYears = Object.keys(o.metrics.gdp.nominal)
    .filter((y) => o.metrics.gdp.nominal[y] != null)
    .sort();
  const base = { ...o, metrics: {}, years: gdpYears };
  const hist = { id: o.id, metrics: {} };
  for (const [k, v] of Object.entries(o.metrics)) {
    if (k === 'area') {
      base.metrics[k] = v; // 面积与年份无关，跟着基础文件走
      continue;
    }
    // ⚠️ `gdp` 的结构是 { nominal: { 年份: 值 } }，跟别的指标不一样，
    //    当成普通序列处理会拿到 undefined（基础文件里 GDP 全空）。
    const series = k === 'gdp' ? (v?.nominal ?? {}) : (v ?? {});
    const years = Object.keys(series);
    const rest = {};
    for (const y of years) if (y !== defaultYear) rest[y] = series[y];
    const cur = series[defaultYear];
    if (k === 'gdp') {
      base.metrics.gdp = { nominal: cur != null ? { [defaultYear]: cur } : {} };
      if (Object.keys(rest).length) hist.metrics.gdp = { nominal: rest };
      continue;
    }
    if (cur != null) base.metrics[k] = { [defaultYear]: cur };
    if (Object.keys(rest).length) hist.metrics[k] = rest;
  }
  BASE_OBJECTS.push(base);
  HISTORY_OBJECTS.push(hist);
}

await writeFile(resolve(OUT, 'data/regions.json'), JSON.stringify({ meta, objects: BASE_OBJECTS }), 'utf8');
await writeFile(resolve(OUT, 'data/regions-history.json'), JSON.stringify({ objects: HISTORY_OBJECTS }), 'utf8');
await writeFile(resolve(OUT, 'geo/world.json'), JSON.stringify(roundGeometry({ type: 'FeatureCollection', features: worldFeatures })), 'utf8');
await writeFile(resolve(OUT, 'geo/china.json'), JSON.stringify(roundGeometry({ type: 'FeatureCollection', features: chinaFeatures })), 'utf8');
await writeFile(
  resolve(OUT, 'geo/us-states.json'),
  JSON.stringify(roundGeometry({ type: 'FeatureCollection', features: usFeatures })),
  'utf8'
);

// 欧洲 NUTS-1 与日本都道府县：单独一个文件。
// ⚠️ 这些地区的数量多（141 个），画在世界地图上会把欧洲糊成一片——
// 所以标了 drawOnlyWhenHighlighted，只在被高亮时才描边。
const extraFeatures = [];
for (const r of extraRegions) {
  const geometry = extraGeometry.get(r.id);
  if (!geometry) continue;
  extraFeatures.push({
    type: 'Feature',
    id: r.id,
    properties: {
      name: r.en,
      zh: r.zh,
      drawOnlyWhenHighlighted: true
    },
    geometry
  });
}
await writeFile(
  resolve(OUT, 'geo/extra-regions.json'),
  JSON.stringify(roundGeometry({ type: 'FeatureCollection', features: extraFeatures })),
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
console.log('\n已写入 public/data/regions.json, public/geo/{world,china,us-states,extra-regions}.json');
