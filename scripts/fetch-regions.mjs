/**
 * 抓「省/州之外」的一级行政区数据：欧洲 NUTS-1、日本都道府县，以及美国各州的官方序列。
 *
 * 为什么单独一个脚本：`fetch-sources.mjs` 管的是国家底图、中国省界与面积表，
 * 这里管的是另外几套完全不同的源（欧盟统计局 + 日本内阁府 + Natural Earth + 美国 BEA），
 * 混在一起会让那个文件没法读。
 *
 * 产出：
 *   data/raw/nuts1.geojson            欧洲 NUTS-1 边界
 *   data/raw/ne_10m_admin_1.geo.json   Natural Earth 的一级行政区（取日本 47 都道府县）
 *   data/raw/jp-huhyo2023.xlsx         日本府县民经济计算 概況（2023 年度）
 *   data/raw/jp-soukatu9.xlsx          同上的「総人口」
 *   data/raw/eurostat-nuts1-years-2000-2024.json  NUTS-1 的 GDP 与人口（逐年取，缓存名带起止年）
 *   data/raw/bea-sagdp.zip             BEA 的州级 GDP（SAGDP2）
 *   data/raw/bea-sainc.zip             BEA 的州级人口（SAINC4）
 *   data/us-states-series.json         美国 51 州 1997–2025 的 GDP 与人口（提交进仓库）
 *   data/regions-eu-jp.json            归一化后的结果（提交进仓库）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = resolve(ROOT, 'data/raw');
const UA = { 'User-Agent': 'gdp-map/1.0 (+data pipeline)' };

const NUTS_GEO =
  // 10M 分辨率：世界地图上欧洲一个 NUTS-1 只有十几像素，1:10M 足够；
  // 面积算下来也准（巴伐利亚 7.04 万 km²，真值 7.05 万）。
  // 01M 的文件有 12.8 MB，放进前端太重。
  'https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_10M_2024_4326_LEVL_1.geojson';
const NE_ADMIN1 =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';
const EUROSTAT = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/';
const JP_BASE = 'https://www.esri.cao.go.jp/jp/sna/data/data_list/kenmin/files/contents/tables/';
/**
 * 日本府县民经济计算：2023 年度（令和5年度）。
 * 内阁府的「概況」表覆盖 47 个都道府县，但有 5 个（石川、奈良、德岛、香川、宫崎）
 * 在汇总时还没报上来，显示为「-」——那 5 个从各府县自己公布的结果里读，
 * 存在 data/jp-prefecture-gdp-2023.json（中国省级那份读数是同一个做法）。
 */
const JP_YEAR = 2023;

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function getText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

/** 缓存优先：抓到就存进 data/raw/，下次直接读 */
async function cached(name, produce) {
  const path = resolve(RAW, name);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    /* 没缓存就去抓 */
  }
  const value = await produce();
  await writeFile(path, JSON.stringify(value), 'utf8');
  return value;
}

async function cachedBinary(name, produce) {
  const path = resolve(RAW, name);
  try {
    return await readFile(path);
  } catch {
    /* 没缓存就去抓 */
  }
  const buf = await produce();
  await writeFile(path, buf);
  return buf;
}

// ---------- 汇率（欧元 / 日元 → 美元）----------
async function exchangeRate(country, year) {
  const d = await getJson(
    `https://api.worldbank.org/v2/country/${country}/indicator/PA.NUS.FCRF?format=json&date=${year}`
  );
  const v = d?.[1]?.[0]?.value;
  if (!v) throw new Error(`拿不到 ${country} ${year} 年的汇率`);
  return { year, perUsd: v, source: 'World Bank PA.NUS.FCRF (official exchange rate, annual average)' };
}

/**
 * 一整段年份的汇率（一次请求拿到多年）。
 *
 * 跨年比较要用**每一年的**汇率：省/州的 GDP 记的是它自己那年的现价，
 * 换算成美元时也得用那一年的价。
 */
async function exchangeRates(country, from, to) {
  const d = await getJson(
    `https://api.worldbank.org/v2/country/${country}/indicator/PA.NUS.FCRF?format=json&date=${from}:${to}`
  );
  const out = new Map();
  for (const row of d?.[1] ?? []) {
    const y = Number(row.date);
    if (Number.isFinite(y) && row.value) out.set(y, row.value);
  }
  if (!out.size) throw new Error(`拿不到 ${country} ${from}–${to} 的汇率`);
  return out;
}

// ---------- 最小 xlsx 读取器 ----------
// 只想读一两个数，不想为此引入 exceljs：xlsx 就是个 zip + XML。
// ⚠️ 单元格的位置由 r 属性（如 "E17"）决定，**不能按出现顺序取值**——
// 有些行缺单元格，按顺序读会整行串位（石川、奈良那 5 个县就是这么读成 0 的）。
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? raw : inflateRawSync(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) ?? [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * 读一张表，返回 { rows, sheets }；rows 按行号索引，每行按单元格引用索引。
 * ⚠️ **必须按表名选表**：概況那个工作簿有 27 张表（按行业分的），
 * GDP 在「合計」那张里；拿第一张会读到「農林水産業」的数字。
 */
function readSheet(buf, sheetName) {
  const files = readZip(buf);
  const ssXml = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')
  );
  const wb = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relMap = new Map([...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({
    name: m[1],
    file: 'xl/' + (relMap.get(m[2]) ?? '')
  }));
  const target = sheetName ? sheets.find((s) => s.name === sheetName) : sheets[0];
  if (!target) throw new Error(`工作簿里没有叫「${sheetName}」的表`);
  const xml = files.get(target.file)?.toString('utf8') ?? '';
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[2].matchAll(/<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      let val = '';
      if (type === 's') val = shared[Number(/<v>([^<]*)<\/v>/.exec(body)?.[1] ?? -1)] ?? '';
      else if (type === 'inlineStr') {
        val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('');
      } else val = /<v>([^<]*)<\/v>/.exec(body)?.[1] ?? '';
      cells[ref ? colIndex(ref) : cells.length] = val;
    }
    rows[Number(rm[1])] = cells;
  }
  return { rows, sheets };
}

/** 年份表头：返回 年份 → 真实列号（过滤会丢位置，所以这里记索引） */
function yearColumns(rows) {
  for (const r of rows) {
    if (!r) continue;
    const years = r.map((c, i) => [c, i]).filter(([c]) => typeof c === 'string' && /^(20\d\d)$/.test(c));
    if (years.length >= 8) return new Map(years.map(([c, i]) => [c, i]));
  }
  return new Map();
}

const isPrefecture = (r) =>
  r && /^\d\d$/.test(r[0] ?? '') && r[1] && /[一-龥ぁ-んァ-ヶ]/.test(r[1]);

// ---------- 开始 ----------
await mkdir(RAW, { recursive: true });

// ---------- 美国各州：GDP 与人口的历史（BEA）----------
// SAGDP2 = 现价美元 GDP（Millions of current dollars），1997–2025
// SAINC4 = 人口（Population, persons），1929–2025
// ⚠️ zip 里有 570+ / 1000+ 个 CSV，只取各州那两张。
// ⚠️ 2024 年那一列不用维基百科的转录了：BEA 的是官方数，用它更准
//（维基的值只当兜底，个别州缺数据时用）。
const BEA_SAGDP = 'https://apps.bea.gov/regional/zip/SAGDP.zip';
const BEA_SAINC = 'https://apps.bea.gov/regional/zip/SAINC.zip';

/** 最小 CSV 读取：带引号的字段里可以有逗号（描述文字里就有） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(cur.replace(/^"([\s\S]*)"$/, '$1'));
      cur = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur.replace(/^"([\s\S]*)"$/, '$1'));
      if (row.length > 1) rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  return rows;
}

/** 从 BEA 的 CSV 里挑出某一行指标，返回 { 年份: 数值 } */
function beaSeries(csvText, matchDesc, matchUnit) {
  const rows = parseCsv(csvText);
  const head = rows[0] ?? [];
  const y0 = head.indexOf('1997');
  if (y0 < 0) return null;
  for (const r of rows.slice(1)) {
    const desc = (r[6] ?? '').trim();
    const unit = (r[7] ?? '').trim();
    // ⚠️ 描述后面常跟着行号（「Population (persons) 3/ (Number of persons)」），用前缀比
    if (!desc.startsWith(matchDesc) || !unit.includes(matchUnit)) continue;
    const out = {};
    for (let i = y0; i < head.length; i++) {
      const y = Number(head[i]);
      const v = Number(r[i]);
      if (Number.isFinite(y) && Number.isFinite(v)) out[String(y)] = v;
    }
    return out;
  }
  return null;
}

const usStatesSeries = await (async () => {
  console.log('· 抓 BEA 的美国各州 GDP 与人口历史');
  const [sagdpBuf, saincBuf] = await Promise.all([
    cachedBinary('bea-sagdp.zip', async () => {
      const r = await fetch(BEA_SAGDP, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    }),
    cachedBinary('bea-sainc.zip', async () => {
      const r = await fetch(BEA_SAINC, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    })
  ]);
  const sagdp = readZip(sagdpBuf);
  const sainc = readZip(saincBuf);
  const out = {};
  for (const [name, buf] of sagdp) {
    const m = /^SAGDP2_([A-Z]{2})_\d{4}_\d{4}\.csv$/.exec(name);
    if (!m) continue;
    const text = buf.toString('utf8');
    const rows = parseCsv(text);
    const geoName = (rows[1]?.[1] ?? '').trim();
    if (!geoName) continue;
    const gdp = beaSeries(text, 'All industry total', 'current dollars');
    if (!gdp) continue;
    // 人口在同一 zip 的另一个表族里（SAINC4_<州>_<起>_<止>.csv）
    const popFile = [...sainc.keys()].find((n) => n.startsWith(`SAINC4_${m[1]}_`));
    const pop = popFile
      ? beaSeries(sainc.get(popFile).toString('utf8'), 'Population (persons)', 'Number of persons')
      : null;
    if (!pop) continue;
    out[geoName] = { gdp, pop };
  }
  console.log(`  · 取到 ${Object.keys(out).length} 个州`);
  // 结果要进仓库（build-data.mjs 读它），所以落在 data/ 而不是 raw/
  await writeFile(resolve(ROOT, 'data/us-states-series.json'), JSON.stringify(out), 'utf8');
  return out;
})();


const names = JSON.parse(await readFile(resolve(ROOT, 'data/region-names.json'), 'utf8'));

// 1. 欧洲 NUTS-1 边界
const nutsGeo = await cached('nuts1.geojson', async () => {
  console.log('· 抓 NUTS-1 边界');
  return getJson(NUTS_GEO);
});
const nutsAll = nutsGeo.features.map((f) => ({
  id: f.properties.NUTS_ID,
  country: f.properties.CNTR_CODE,
  iso3: f.properties.ISO3_CODE,
  name: f.properties.NAME_LATN,
  // 「整个国家算一个 NUTS-1」（捷克、丹麦…）跟国家池重复，不要
  wholeCountry: /^[A-Z]{2}0$/.test(f.properties.NUTS_ID)
}));
const nutsList = nutsAll.filter((x) => !x.wholeCountry && names.nuts[x.id]);
console.log(`· NUTS-1：${nutsAll.length} 个，其中 ${nutsList.length} 个是真一级行政区`);

// 2. NUTS-1 的 GDP 与人口（Eurostat）
//    ⚠️ **一次只能取一年**：多 geo + 时间段（sinceTimePeriod/untilTimePeriod）的
//    查询会返回空数组（试过），所以逐年取。
//    ⚠️ 这里的起止年**以 Eurostat 实际有的数据为准**：nama_10r_3gdp 一直回到 2000 年
//    （94 个区 2000 年合计 7.46 万亿欧元 ≈ 当时欧盟 GDP，逐年可查）。
//    以前这里写 2008，注释说「NUTS-1 口径从 2008 年起才有」——那是错的，
//    白扔了 8 年。要改起止年，**先删掉下面的缓存文件**（缓存名里带了起止年，
//    改了年份就是另一个文件，不会误用旧缓存）。
const EU_FROM = 2000;
const EU_TO = 2024;
const nutsIds = nutsList.map((x) => 'geo=' + x.id).join('&');
const eurostatYears = await cached(`eurostat-nuts1-years-${EU_FROM}-${EU_TO}.json`, async () => {
  console.log(`· 抓 Eurostat 的 NUTS-1 GDP 与人口（${EU_FROM}–${EU_TO}，逐年）`);
  const years = [];
  for (let y = EU_FROM; y <= EU_TO; y++) {
    const [gdp, pop] = await Promise.all([
      getJson(`${EUROSTAT}nama_10r_3gdp?${nutsIds}&time=${y}&unit=MIO_EUR`),
      getJson(`${EUROSTAT}nama_10r_3popgdp?${nutsIds}&time=${y}&unit=THS`)
    ]);
    years.push({ year: y, gdp, pop });
  }
  return { from: EU_FROM, to: EU_TO, years };
});

/** 某一年各地区的 GDP / 人口（Eurostat 的 JSON-stat 数组，按维度下标取值） */
function euSlice(year) {
  const gdpIdx = year.gdp.dimension.geo.category.index;
  const popIdx = year.pop.dimension.geo.category.index;
  return {
    gdp: (id) => Number(year.gdp.value?.[gdpIdx[id]]),
    pop: (id) => Number(year.pop.value?.[popIdx[id]])
  };
}

// 3. 汇率（每一年都要用那一年的价换算成美元）
const eurRates = await exchangeRates('EMU', EU_FROM, EU_TO);
const jpyRate = await exchangeRate('JPN', JP_YEAR);
console.log(
  `· 汇率：1 美元 = ${eurRates.get(EU_TO).toFixed(4)} 欧元（${EU_TO}）= ${jpyRate.perUsd.toFixed(2)} 日元`
);

// 4. Natural Earth 的日本都道府县边界
//    源文件有 4596 个要素、39.7 MB，但只用得上日本的 47 个——
//    所以抓下来立刻切出日本那块再缓存，别把 39 MB 留在磁盘上。
const neAdmin1 = await cached('ne_10m_admin_1.geo.json', async () => {
  console.log('· 抓 Natural Earth admin-1（只留日本）');
  const all = await getJson(NE_ADMIN1);
  const jp = all.features.filter((f) => f.properties.adm0_a3 === 'JPN');
  console.log(`  · Natural Earth 共 ${all.features.length} 个一级行政区，日本 ${jp.length} 个`);
  return { type: 'FeatureCollection', features: jp };
});
const jpFeatures = neAdmin1.features;
console.log(`· Natural Earth 里日本 ${jpFeatures.length} 个一级行政区`);

// 5. 日本的 GDP（府县民经济计算 概況）与人口（総括表 総人口）
const jpGdpBuf = await cachedBinary(`jp-huhyo${JP_YEAR}.xlsx`, async () => {
  console.log('· 抓日本府县民经济计算（概況）');
  const r = await fetch(`${JP_BASE}${JP_YEAR}/huhyo${JP_YEAR}.xlsx`, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
});
const jpPopBuf = await cachedBinary('jp-soukatu9.xlsx', async () => {
  console.log('· 抓日本总人口（総括表）');
  const r = await fetch(`${JP_BASE}2023/soukatu9.xlsx`, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
});
// 内阁府汇总里缺的那 5 个县，从各府县自己公布的结果里读
const jpManual = JSON.parse(await readFile(resolve(ROOT, 'data/jp-prefecture-gdp-2023.json'), 'utf8'));

const jpGdp = readSheet(jpGdpBuf, '合計');
const jpPop = readSheet(jpPopBuf, '実数');
// 概況表的 F 列是「③ 県内総生産（生産者価格表示）」——
// 位置由表头定：E=②中間投入、F=③県内総生産、G=④固定資本減耗
const GDP_COL = 5;
const popYears = yearColumns(jpPop.rows);
const popCol = popYears.get(String(JP_YEAR));
if (popCol == null) throw new Error(`人口表里找不到 ${JP_YEAR} 年`);
const jpPopRows = jpPop.rows.filter(isPrefecture);
const jpGdpRows = jpGdp.rows.filter(isPrefecture);
console.log(`· 日本：GDP ${jpGdpRows.length} 个县、人口 ${jpPopRows.length} 个县`);

// 6. 归一化
const out = { euFrom: EU_FROM, euTo: EU_TO, jpYear: JP_YEAR, regions: [] };

for (const n of nutsList) {
  // 逐年一组：省/州在**哪一年**的数据也要跟着年份走，
  // 「拿哪一年的世界来比」时，参照物得是那一年的大小。
  const series = {};
  for (const y of eurostatYears.years) {
    const slice = euSlice(y);
    const g = slice.gdp(n.id);
    const p = slice.pop(n.id);
    const rate = eurRates.get(y.year);
    if (!Number.isFinite(g) || !Number.isFinite(p) || !rate) continue;
    series[String(y.year)] = {
      gdpUsd: Math.round((g / rate) * 1e6), // 百万欧元 → 美元（用那一年的汇率）
      pop: Math.round(p * 1000) // 千人 → 人
    };
  }
  const years = Object.keys(series);
  if (!years.length) {
    console.warn(`  ! ${n.id} ${n.name} 缺数据，跳过`);
    continue;
  }
  out.regions.push({
    id: `EU-${n.id}`,
    set: 'nuts',
    code: n.id,
    parentId: n.iso3,
    zh: names.nuts[n.id],
    en: n.name,
    series,
    source: `Eurostat nama_10r_3gdp / nama_10r_3popgdp（${EU_FROM}–${EU_TO}，NUTS-1）`
  });
}

for (const row of jpGdpRows) {
  const code = row[0];
  const zh = names.jp[code];
  if (!zh) continue;
  const popRow = jpPopRows.find((r) => r[0] === code);
  const p = Number(popRow?.[popCol]);
  const manual = jpManual.regions.find((r) => r.code === code);
  // 内阁府汇总里有数就用汇总的，没有（那 5 个县）就用府县自己公布的
  const g = Number.isFinite(Number(row[GDP_COL])) ? Number(row[GDP_COL]) : manual?.gdpOku * 100;
  // ⚠️ **年度 ≠ 日历年**：内阁府的「2023 年度」是 2023/4–2024/3，
  //    而世界侧（IMF WEO）的日本 2023 是**日历年**。两者差约 5%
  //    （47 县合计 621.9 兆円 vs 日本日历年 591.9 兆円，
  //    按世界银行 2023 年均汇率 140.4911 円/美元折算），
  //    在「世界 → 地方」模式里拿日本的 47 个县跟日本自己比，会显得偏大 5%。
  //    不做跨口径推算（推算就得拿季度数据），只把口径差写在来源里。
  const source = manual
    ? `${manual.source}（${JP_YEAR} 年度）`
    : `日本内阁府《府县民经济计算》（${JP_YEAR} 年度）与总人口（${JP_YEAR} 年；年度口径与世界侧的日历年差约 5%）`;
  if (!Number.isFinite(g) || !Number.isFinite(p)) {
    console.warn(`  ! ${row[1]} 缺数据，跳过`);
    continue;
  }
  out.regions.push({
    id: `JP-${code}`,
    set: 'jp',
    code,
    parentId: 'JPN',
    zh,
    en: row[1],
    // 日本内阁府的历史文件只拿到 2023 年度（更早的年份 URL 全部 404），
    // 所以日本各府县只有这一年——年份控件到这儿就到底了。
    series: {
      [String(JP_YEAR)]: {
        gdpUsd: Math.round((g * 1e6) / jpyRate.perUsd), // 百万日元 → 美元
        pop: Math.round(p)
      }
    },
    source
  });
}

await writeFile(resolve(ROOT, 'data/regions-eu-jp.json'), JSON.stringify(out, null, 1), 'utf8');

const eu = out.regions.filter((r) => r.set === 'nuts');
const jp = out.regions.filter((r) => r.set === 'jp');
/** 某一年各地区的 GDP 合计（美元） */
const sumAt = (list, year) =>
  list.reduce((s, r) => s + (r.series?.[year]?.gdpUsd ?? 0), 0);
console.log(
  `\n已写入 data/regions-eu-jp.json：欧洲 NUTS-1 ${eu.length} 个、日本都道府县 ${jp.length} 个`
);
console.log(
  `  欧洲 ${EU_TO} 年合计 ${(sumAt(eu, String(EU_TO)) / 1e12).toFixed(2)} 万亿美元；` +
    `日本合计 ${(sumAt(jp, String(JP_YEAR)) / 1e12).toFixed(2)} 万亿美元`
);

// ---------- 自检：47 个都道府县的产出加起来，应该等于日本全国 ----------
// 这是个很强的校验：任何一个县读错、漏掉，单位搞错，总数都会对不上。
const jpOku = jp.reduce(
  (s, r) => s + ((r.series?.[String(JP_YEAR)]?.gdpUsd ?? 0) * jpyRate.perUsd) / 1e8,
  0
); // 億円
const NATIONAL_2023_OKU = 6_219_000; // 内阁府《2023年度国民経済計算》：全国 621.9 兆円 = 6,219,000 億円
const diff = ((jpOku - NATIONAL_2023_OKU) / NATIONAL_2023_OKU) * 100;
console.log(
  `  日本 47 县合计 ${(jpOku / 1e4).toFixed(1)} 兆円，全国 ${(NATIONAL_2023_OKU / 1e4).toFixed(1)} 兆円，差 ${diff.toFixed(2)}%`
);
if (Math.abs(diff) > 1) {
  console.warn('  ! 47 县合计与全国差超过 1%，有读数或单位出错');
} else {
  console.log('  ✓ 与全国总量对得上');
}
