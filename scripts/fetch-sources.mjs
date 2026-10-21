// 抓取原始数据源到 data/raw/（幂等：已存在则跳过）
// 用法：node scripts/fetch-sources.mjs
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = resolve(ROOT, 'data/raw');
const WEO_VINTAGE = '2025-04';

const SOURCES = {
  // 自然地球派生，properties.id = ISO3
  'world.geo.json': 'https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson',
  // 阿里云 DataV.GeoAtlas：中国省级（合规底图，含南海诸岛线）
  'china-provinces.geo.json': 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json',
  'china-outline.geo.json': 'https://geo.datav.aliyun.com/areas_v3/bound/100000.json',
  // 国家统计局《中国统计年鉴2025》表 3-9 地区生产总值(2024年)
  'nbs-yearbook-2025-C03-09.jpg': 'https://www.stats.gov.cn/sj/ndsj/2025/html/C03-09.jpg',
  // 国家面积表（Natural Earth 口径 + 修正），用于「面积对比」
  'countries-area.json': 'https://raw.githubusercontent.com/mledoze/countries/master/countries.json',
  // 美国各州边界（TopoJSON，us-atlas）
  'us-states-10m.json': 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json',
  // 美国各州 GDP / 人均 / 人口（BEA + Census 口径，经维基百科转录）
  'us-states-gdp.wiki.json':
    'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&titles=List_of_U.S._states_and_territories_by_GDP&format=json&formatversion=2'
};

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126' };

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function download(name, url) {
  const dest = resolve(RAW, name);
  if (await exists(dest)) {
    console.log(`skip  ${name} (已存在)`);
    return;
  }
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`saved ${name} (${(buf.length / 1024).toFixed(0)} KB) <- ${url}`);
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'gdp-map/1.0' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ---- IMF WEO（经 DBnomics 镜像）----
const INDICATORS = ['NGDPD', 'PPPGDP', 'LP'];

async function fetchWeo() {
  const dest = resolve(RAW, `weo-${WEO_VINTAGE}.json`);
  if (await exists(dest)) {
    // 缓存里缺指标（例如后来才加上人口），就重新抓
    const cached = JSON.parse(await readFile(dest, 'utf8'));
    const missing = INDICATORS.filter((ind) => !Object.values(cached.data ?? {}).some((r) => r[ind]));
    if (!missing.length) {
      console.log(`skip  weo-${WEO_VINTAGE}.json (已存在)`);
      return;
    }
    console.log(`weo-${WEO_VINTAGE}.json 缺指标 ${missing.join(',')}，重新抓取`);
  }
  const base = 'https://api.db.nomics.world/v22';
  const meta = await fetchJson(`${base}/datasets/IMF/WEO:${WEO_VINTAGE}?limit=1`);
  const doc = meta.datasets.docs[0];
  const countries = Object.keys(doc.dimensions_values_labels['weo-country']);
  console.log(`WEO ${WEO_VINTAGE}: ${countries.length} 个经济体, ${doc.nb_series} 条序列`);

  const out = {};
  const CONCURRENCY = 8;
  let idx = 0;

  async function worker() {
    while (idx < countries.length) {
      const c = countries[idx++];
      const rec = {};
      for (const ind of INDICATORS) {
        const url = `${base}/series/IMF/WEO:${WEO_VINTAGE}/${c}.${ind}?observations=1`;
        try {
          const j = await fetchJson(url);
          const d = j.series?.docs?.[0];
          if (!d) continue;
          const at = (y) => {
            const i = d.period.indexOf(String(y));
            return i >= 0 ? d.value[i] : null;
          };
          // 整段年份序列都留着：后面要能选「拿哪一年的世界来比」
          const series = {};
          d.period.forEach((p, i) => {
            const y = Number(p);
            if (y >= 1990 && y <= 2025 && d.value[i] != null) series[y] = d.value[i];
          });
          rec[ind] = series;
        } catch (e) {
          rec[ind] = null;
        }
      }
      out[c] = rec;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const payload = {
    vintage: WEO_VINTAGE,
    source: `IMF World Economic Outlook ${WEO_VINTAGE} (via DBnomics)`,
    units: {
      NGDPD: 'billions of current USD',
      PPPGDP: 'billions of current international dollars',
      LP: 'millions of persons'
    },
    labels: doc.dimensions_values_labels['weo-country'],
    data: out
  };
  await writeFile(dest, JSON.stringify(payload, null, 1), 'utf8');
  const ok = Object.values(out).filter((r) => r.NGDPD?.['2024'] != null).length;
  console.log(`saved weo-${WEO_VINTAGE}.json  (2024 有值经济体: ${ok})`);
}

// ---- 世界银行：把国家侧的历史往前延到 1960 ----
// IMF WEO 从 1990 起，1960–1989 用世界银行的 NY.GDP.MKTP.CD（现价美元）与
// SP.POP.TOTL（人口）。两段衔接得上（美国 1989 = 5.64 万亿 → 1990 = 5.96 万亿），
// 所以滑块从 1990 往前拖是连续的。
// ⚠️ 苏联解体那批（POL/CZE/KAZ/SVK/HRV/SRB/LTU/AZE/SVN/BLR/LVA/EST）1960 年前
// 没有独立统计，本来就缺——不是这次引入的缺口。
const WB_RANGE = [1960, 1989];
const WB_INDICATORS = [
  { key: 'gdp', id: 'NY.GDP.MKTP.CD' },
  { key: 'pop', id: 'SP.POP.TOTL' }
];

async function fetchWorldBank() {
  const dest = resolve(RAW, `wb-gdp-pop-${WB_RANGE[0]}-${WB_RANGE[1]}.json`);
  if (await exists(dest)) {
    console.log(`skip  wb-gdp-pop-${WB_RANGE[0]}-${WB_RANGE[1]}.json (已存在)`);
    return;
  }
  const data = {};
  for (const ind of WB_INDICATORS) {
    const url =
      `https://api.worldbank.org/v2/country/all/indicator/${ind.id}` +
      `?date=${WB_RANGE[0]}:${WB_RANGE[1]}&format=json&per_page=20000`;
    const r = await fetch(url, { headers: { 'User-Agent': 'gdp-map/1.0' } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    const json = await r.json();
    for (const row of json?.[1] ?? []) {
      const iso = row.countryiso3code;
      if (!iso || row.value == null) continue;
      data[iso] ??= { gdp: {}, pop: {} };
      data[iso][ind.key][row.date] = row.value;
    }
  }
  await writeFile(
    dest,
    JSON.stringify(
      {
        source: 'World Bank, NY.GDP.MKTP.CD (GDP, current US$) + SP.POP.TOTL (population)',
        range: WB_RANGE,
        data
      },
      null,
      1
    ),
    'utf8'
  );
  console.log(
    `saved wb-gdp-pop-${WB_RANGE[0]}-${WB_RANGE[1]}.json  (${Object.keys(data).length} 个经济体)`
  );
}

// ---- 麦迪逊项目：1960 年之前的世界（长周期） ----
// IMF WEO 从 1990 起，世界银行从 1960 起；再往前只有「估算」：
// 麦迪逊项目（Our World in Data 镜像）提供 1650 年起的人均 GDP 与人口，
// 两者相乘得到 GDP 总量（2011 年国际元口径）。
// ⚠️ 单位与后面的现价美元不同，所以只能在 build 阶段按各国 1960 年的水平折算后接入。
const MADDISON_FROM = 1650;
const MADDISON_TO = 1960; // 含 1960：用它做各国折算的锚点
const OWID_CSV = {
  gdpPc: 'https://ourworldindata.org/grapher/gdp-per-capita-maddison-project-database.csv',
  pop: 'https://ourworldindata.org/grapher/population.csv'
};

async function fetchMaddison() {
  const dest = resolve(RAW, `maddison-${MADDISON_FROM}-${MADDISON_TO}.json`);
  if (await exists(dest)) {
    console.log(`skip  maddison-${MADDISON_FROM}-${MADDISON_TO}.json (已存在)`);
    return;
  }
  const out = {};
  for (const [key, url] of Object.entries(OWID_CSV)) {
    const r = await fetch(url, { headers: { 'User-Agent': 'gdp-map/1.0' } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    const text = await r.text();
    const lines = text.split('\n');
    const header = lines[0].split(',');
    const iCode = header.indexOf('Code');
    const iYear = header.indexOf('Year');
    const iValue = header.indexOf(key === 'gdpPc' ? 'GDP per capita' : 'Population');
    for (const line of lines.slice(1)) {
      const p = line.split(',');
      const iso = p[iCode];
      const year = Number(p[iYear]);
      const value = Number(p[iValue]);
      if (!iso || !Number.isFinite(year) || !Number.isFinite(value)) continue;
      if (year < MADDISON_FROM || year > MADDISON_TO) continue;
      out[iso] ??= {};
      out[iso][year] ??= {};
      out[iso][year][key] = value;
    }
  }
  await writeFile(
    dest,
    JSON.stringify(
      {
        source:
          'Maddison Project Database 2023（Our World in Data 镜像）：人均 GDP（2011 年国际元）+ 人口',
        range: [MADDISON_FROM, MADDISON_TO],
        data: out
      },
      null,
      1
    ),
    'utf8'
  );
  console.log(`saved maddison-${MADDISON_FROM}-${MADDISON_TO}.json  (${Object.keys(out).length} 个经济体)`);
}

await mkdir(RAW, { recursive: true });
for (const [name, url] of Object.entries(SOURCES)) {
  await download(name, url);
}
await fetchWeo();
await fetchWorldBank();
await fetchMaddison();
console.log('\n原始数据就绪：', RAW);
