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
  'nbs-yearbook-2025-C03-09.jpg': 'https://www.stats.gov.cn/sj/ndsj/2025/html/C03-09.jpg'
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
          rec[ind] = { 2024: at(2024), 2025: at(2025) };
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

await mkdir(RAW, { recursive: true });
for (const [name, url] of Object.entries(SOURCES)) {
  await download(name, url);
}
await fetchWeo();
console.log('\n原始数据就绪：', RAW);
