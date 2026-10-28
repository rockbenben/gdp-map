/**
 * 核对文档里的数字：AGENTS.md / README 里对外的每个数，都从代码与数据现算一遍。
 *
 * 为什么要有它：文档里的数字最容易悄悄过期——数据更新了、代码重构了、算法改了，
 * 文档还写着旧值。这条命令把「数」和「出处」摆在一起，���掉的数一眼能看出来。
 *
 * 它只打印、不判定（没有硬门槛）：判定标准是「人对着 AGENTS.md 看一眼对不对」。
 * 改了判据或换了数据源，改完记得把 AGENTS.md 里记的数字一起更新。
 *
 * 用法：npm run audit:docs
 */
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const pct = (a, b) => (((a - b) / b) * 100).toFixed(2) + '%';

// ---------- 数据池：基础文件 + 历史文件按 id 合并 ----------
const base = JSON.parse(read('public/data/regions.json'));
const hist = JSON.parse(read('public/data/regions-history.json'));
const pool = new Map();
for (const o of base.objects) pool.set(o.id, { ...o });
for (const o of hist.objects ?? []) {
  const cur = pool.get(o.id) ?? { ...o };
  cur.metrics = cur.metrics ?? {};
  for (const [k, v] of Object.entries(o.metrics ?? {})) {
    const merged = { ...(cur.metrics[k] ?? {}) };
    for (const [k2, v2] of Object.entries(v ?? {})) {
      merged[k2] = typeof v2 === 'object' && v2 !== null ? { ...(merged[k2] ?? {}), ...v2 } : v2;
    }
    cur.metrics[k] = merged;
  }
  pool.set(o.id, cur);
}
const all = [...pool.values()];
const gdp = (o, y = '2024') => o?.metrics?.gdp?.nominal?.[y];
const pop = (o, y = '2024') => o?.metrics?.pop?.[y];
const gdpPc = (o, y = '2024') => o?.metrics?.gdpPc?.[y];
const areaKm2 = (o) => o?.metrics?.area?.value ?? o?.metrics?.area;
const isCountry = (o) => o.kind === 'country';
const isCn31 = (o) => o.kind === 'region' && o.id.startsWith('CN-') && !['CN-810000', 'CN-820000', 'CN-710000'].includes(o.id);
const isHmt = (o) => ['CN-810000', 'CN-820000', 'CN-710000'].includes(o.id);
const isUs = (o) => o.kind === 'region' && o.id.startsWith('US-');
const isEu = (o) => o.kind === 'region' && o.id.startsWith('EU-');
const isJp = (o) => o.kind === 'region' && o.id.startsWith('JP-');
const sum = (list, y) => list.reduce((s, o) => s + (gdp(o, y) ?? 0), 0);

console.log('════ 1. 对象池 ════');
const byKind = all.reduce((m, o) => ((m[o.kind] = (m[o.kind] ?? 0) + 1), m), {});
console.log(` 合计 ${all.length}（国家 ${byKind.country} + 省/州 ${byKind.region}）`);
console.log(` 中国 ${all.filter(isCn31).length} 省 + 港澳台 ${all.filter(isHmt).length}｜美国 ${all.filter(isUs).length} 州｜欧洲 ${all.filter(isEu).length} 区｜日本 ${all.filter(isJp).length} 县`);
console.log(` 护照分组：中国 ${all.filter((o) => isCn31(o) || isHmt(o)).length}｜美国 ${all.filter(isUs).length}｜欧洲 ${all.filter(isEu).length}｜日本 ${all.filter(isJp).length}｜国家 ${all.filter(isCountry).length}`);

console.log('\n════ 2. 交叉校验 ════');
const s31 = sum(all.filter(isCn31), '2024');
const rate = base.meta.exchangeRate['2024'].cnyPerUsd;
const gongbao = (1_349_084 * 1e8) / rate;
console.log(` 31 省合计 ${(s31 / 1e12).toFixed(4)} 万亿｜统计公报口径全国 ${(gongbao / 1e12).toFixed(4)} → 差 ${pct(s31, gongbao)}`);
console.log(` 31 省合计 vs WEO 口径 CHN ${(gdp(pool.get('CHN'), '2024') / 1e12).toFixed(4)} → 差 ${pct(s31, gdp(pool.get('CHN'), '2024'))}`);
const sus = sum(all.filter(isUs), '2024');
console.log(` 美国 51 州 ${(sus / 1e12).toFixed(4)} 万亿｜全美 ${(gdp(pool.get('USA'), '2024') / 1e12).toFixed(4)} → 差 ${pct(sus, gdp(pool.get('USA'), '2024'))}`);
console.log(` 欧洲 NUTS-1 合计 ${(sum(all.filter(isEu), '2024') / 1e12).toFixed(4)} 万亿`);
const sjp = sum(all.filter(isJp), '2023');
const jpn23 = gdp(pool.get('JPN'), '2023');
console.log(` 日本 47 县(2023) ${(sjp / 1e12).toFixed(4)} 万亿｜WEO 日本 ${(jpn23 / 1e12).toFixed(4)} → 差 ${pct(sjp, jpn23)}`);
console.log(` 折成日元（140.4911 円/美元）：47 县 ${((sjp * 140.4911) / 1e12).toFixed(1)} 兆円｜WEO 日本 ${((jpn23 * 140.4911) / 1e12).toFixed(1)} 兆円`);

console.log('\n════ 3. 各年有值的国家数（年份控件与「池子用光」的判据）════');
for (const y of ['1960', '1989', '1990', '2000', '2010', '2024', '2025']) {
  const n = all.filter((o) => isCountry(o) && gdp(o, y) > 0).length;
  console.log(` ${y}: ${n} / ${all.filter(isCountry).length} 个国家有 GDP`);
}

console.log('\n════ 4. 口径常量 ════');
const app = read('src/App.tsx');
const variants = read('src/lib/variants.ts');
for (const [name, re] of [
  ['BIG_POOL_SIZE', /const\s+BIG_POOL_SIZE\s*=\s*([0-9_]+)/],
  ['MIN_POOL_SIZE', /const\s+MIN_POOL_SIZE\s*=\s*([0-9_]+)/],
  ['PUZZLE_MAX', /const\s+PUZZLE_MAX\s*=\s*([0-9_]+)/],
  ['MIN_GROUP', /const\s+MIN_GROUP\s*=\s*([0-9_]+)/],
  ['MAX_GROUP', /const\s+MAX_GROUP\s*=\s*([0-9_]+)/]
]) {
  const src = name === 'BIG_POOL_SIZE' ? read('src/lib/match.ts') : name === 'MIN_GROUP' || name === 'MAX_GROUP' ? variants : app;
  console.log(` ${name} = ${src.match(re)?.[1] ?? '?'}`);
}
const known = variants.match(/KNOWN_COUNTRY_IDS = new Set\(\[([\s\S]*?)\]\)/);
console.log(` 熟脸池 KNOWN_COUNTRY_IDS = ${known ? [...known[1].matchAll(/'[A-Z]{3}'/g)].length : '?'} 个`);

console.log('\n════ 5. 动效四档（styles.css 的 CSS 变量）════');
const css = read('src/styles.css');
for (const v of ['--dur', '--dur-fast', '--dur-mid', '--dur-loop']) {
  console.log(` ${v} = ${css.match(new RegExp(v + ':\\s*([0-9.]+m?s)'))?.[1] ?? '?'}`);
}

console.log('\n════ 6. 盲猜可选对象 ════');
const noGeo = all.filter((o) => isCountry(o) && !o.hasGeometry);
const micro = noGeo.filter((o) => (pop(o, '2024') ?? Infinity) < 1_000_000);
console.log(` 没边界的国家 ${noGeo.length} 个，其中人口不足 100 万的 ${micro.length} 个`);

console.log('\n════ 7. 产物体积（gzip）════');
const size = (p) => {
  const b = readFileSync(resolve(ROOT, p));
  return { raw: b.length, gz: gzipSync(b, { level: 9 }).length };
};
const dataBase = size('public/data/regions.json');
const dataHist = size('public/data/regions-history.json');
console.log(` public/data/regions.json          raw ${kb(dataBase.raw).padStart(8)}  gzip ${kb(dataBase.gz).padStart(8)}`);
console.log(` public/data/regions-history.json  raw ${kb(dataHist.raw).padStart(8)}  gzip ${kb(dataHist.gz).padStart(8)}`);
console.log(` 两个数据文件合起来                raw ${kb(dataBase.raw + dataHist.raw).padStart(8)}  gzip ${kb(dataBase.gz + dataHist.gz).padStart(8)}`);
const geo = ['world', 'china', 'us-states', 'extra-regions'].map((n) => size(`public/geo/${n}.json`));
console.log(` 地理文件（第二波）                raw ${kb(geo.reduce((a, s) => a + s.raw, 0)).padStart(8)}  gzip ${kb(geo.reduce((a, s) => a + s.gz, 0)).padStart(8)}`);
const assets = readFileSync(resolve(ROOT, 'dist/index.html'), 'utf8').match(/assets\/(index-[^"]+\.(?:js|css))/g) ?? [];
let first = size('dist/index.html');
for (const a of assets) {
  const s = size(`dist/${a.replace('assets/', 'assets/')}`);
  first = { raw: first.raw + s.raw, gz: first.gz + s.gz };
}
first = { raw: first.raw + dataBase.raw, gz: first.gz + dataBase.gz };
console.log(` 首屏（html+css+js+基础数据）      raw ${kb(first.raw).padStart(8)}  gzip ${kb(first.gz).padStart(8)}`);

console.log('\n════ 8. 文档里的路径 ════');
const docs = ['AGENTS.md', 'README.md'];
let bad = 0;
for (const d of docs) {
  const text = read(d);
  for (const m of text.matchAll(/`([\w./-]+\.[a-z0-9]+)`/g)) {
    const t = m[1];
    if (!/^(src|scripts|public|data|docs|\.github)\//.test(t)) continue;
    const probe = t.includes('{') ? t.slice(0, t.indexOf('{')) : t;
    try {
      statSync(resolve(ROOT, probe));
    } catch {
      console.log(` ✗ ${d}: ${t}`);
      bad++;
    }
  }
}
console.log(bad ? ` ${bad} 条路径对不上` : ' 全部路径都存在');
