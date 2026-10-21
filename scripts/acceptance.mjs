// 浏览器级验收：真实点一遍，确认地图、指标、对照方式、剪影对照、导出、URL 都能用。
// 用法：node scripts/acceptance.mjs [baseUrl]
import { chromium } from 'playwright';
import { mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] ?? 'http://localhost:5183';
const SHOTS = resolve(ROOT, 'tmp/acceptance');
await mkdir(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

try {
  // 1. 首屏 + 数据加载
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.picker-item', { timeout: 20000 });
  const groups = await page.locator('.picker-group-title').allInnerTexts();
  check('地区池按国家分组', groups.length >= 2, groups.join(' / '));
  const mapPaths = await page.locator('.map-holder svg .countries path').count();
  check('世界地图渲染国家多边形', mapPaths > 100, `${mapPaths} 条路径`);
  const subPaths = await page.locator('.map-holder svg .subdivisions path').count();
  check('世界地图带省/州细分层', subPaths > 80, `${subPaths} 条边界`);

  // 2. 选一个省 → 出结果
  await page.locator('.picker-item', { hasText: '河南省' }).first().click();
  await page.waitForSelector('.result-headline h1', { timeout: 8000 });
  const headline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('选择地区后给出等价国家数', /≈\s*\d+\s*个国家/.test(headline), headline);

  // 3. URL 同步
  await page.waitForTimeout(300);
  check('选择状态写入 URL', (await page.url()).includes('sel=CN-410000'), await page.url());

  // 4. 拼音搜索 + 美国州
  await page.locator('.search').fill('texas');
  await page.waitForTimeout(250);
  const tx = await page.locator('.picker-item').allInnerTexts();
  check('可搜到美国各州', tx.some((t) => t.includes('得克萨斯州')), tx.join(' | '));
  await page.locator('.search').fill('henan');
  await page.waitForTimeout(200);
  check('拼音搜索可用', (await page.locator('.picker-item').count()) === 1);
  await page.locator('.search').fill('');

  // 5. 对照方式
  await page.locator('.strategy-btn', { hasText: '大件优先' }).click();
  await page.waitForTimeout(300);
  const headlineBig = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('切换对照方式后结果变化', headline !== headlineBig, `${headline} → ${headlineBig}`);
  const bigCount = await page.locator('.result-item').count();
  check('大件优先的件数明显更少', bigCount > 0 && bigCount < 20, `${bigCount} 件`);

  await page.locator('.strategy-btn', { hasText: '尽量打过' }).click();
  await page.waitForTimeout(300);
  const overSub = await page.locator('.result-sub').innerText();
  check('尽量打过：合计不低于参照物', /超出/.test(overSub), overSub.replace(/\s+/g, ' '));

  // 6. 微型经济体开关
  await page.locator('.toggle input').uncheck();
  await page.waitForTimeout(300);
  const microCount = await page.locator('.result-item').count();
  check('关闭微型过滤后件数变多', microCount > bigCount, `${bigCount} → ${microCount} 件`);
  await page.locator('.toggle input').check();
  await page.waitForTimeout(200);

  // 7. 面积指标 + 剪影对照
  await page.locator('.metric-btn', { hasText: '面积' }).click();
  await page.waitForTimeout(500);
  const areaHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('切换到面积指标', /面积/.test(areaHeadline), areaHeadline);
  const areaRank = await page.locator('.result-strategy').innerText();
  check('给出世界排名', /排第/.test(areaRank), areaRank.replace(/\s+/g, ' '));
  const silhouettePaths = await page.locator('.silhouette svg path').count();
  check('面积剪影对照（同比例尺）', silhouettePaths === 2, `${silhouettePaths} 个剪影`);
  await page.screenshot({ path: resolve(SHOTS, 'map-area.png'), fullPage: false });

  // 8. 人均指标：只能跟单个比
  await page.locator('.metric-btn', { hasText: '人均 GDP' }).click();
  await page.waitForTimeout(400);
  const pcHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('切换到人均指标', /人均/.test(pcHeadline), pcHeadline);
  check('人均下只有「最接近」可用', (await page.locator('.strategy-btn:disabled').count()) === 3);

  await page.locator('.metric-btn', { hasText: '总 GDP' }).click();
  await page.waitForTimeout(300);

  // 9. 导出 PNG
  await page.screenshot({ path: resolve(SHOTS, 'map-2d.png'), fullPage: false });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('.primary-btn').click()
  ]);
  const pngPath = resolve(SHOTS, 'export-map.png');
  await download.saveAs(pngPath);
  const size = (await stat(pngPath)).size;
  check('导出 PNG 成功', size > 20000, `${download.suggestedFilename()} · ${(size / 1024).toFixed(0)} KB`);

  // 10. 3D 地球
  await page.locator('.segmented button', { hasText: '3D 地球' }).click();
  await page.waitForSelector('.globe-wrap svg .globe-country', { timeout: 15000 });
  await page.waitForTimeout(900);
  const globePaths = await page.locator('.globe-wrap svg .globe-country').count();
  check('3D 地球渲染多边形', globePaths > 200, `${globePaths} 条路径`);
  const globeLabels = await page.locator('.globe-wrap svg .globe-labels text').count();
  check('3D 地球标注国家名', globeLabels > 0, `${globeLabels} 个标注`);
  const arcD = await page.locator('.globe-wrap svg .globe-arcs path').first().getAttribute('d');
  const pts = (arcD ?? '').split(/[ML]/).filter(Boolean).map((p) => p.split(',').map(Number));
  let maxJump = 0;
  for (let i = 1; i < pts.length; i += 1) {
    maxJump = Math.max(maxJump, Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  check('3D 弧线不横穿球体', maxJump < 120, `最大跨度 ${maxJump.toFixed(0)}px`);
  await page.screenshot({ path: resolve(SHOTS, 'globe-3d.png'), fullPage: false });

  const [download2] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('.primary-btn').click()
  ]);
  const png2 = resolve(SHOTS, 'export-globe.png');
  await download2.saveAs(png2);
  check('导出地球 PNG 成功', (await stat(png2)).size > 20000);

  // 11. 反向模式：国家 → 省/州
  await page.goto(`${BASE}/?mode=world-to-region&sel=JPN`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const headline2 = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('反向模式给出等价省/州', /≈\s*\d+\s*个/.test(headline2), headline2);
  const subHighlights = await page.locator('.map-holder svg .subdivisions path[fill]:not([fill="none"])').count();
  check('世界地图高亮匹配的省/州', subHighlights > 0, `${subHighlights} 个`);
  const seaBox = await page.locator('.sea-label').count();
  check('附南海诸岛小图', seaBox > 0, `${seaBox} 个标注`);
  await page.screenshot({ path: resolve(SHOTS, 'map-china.png'), fullPage: false });

  // 12. 美国州也能当参照物
  await page.goto(`${BASE}/?sel=US-48`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const txHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('美国州可作参照物', /得克萨斯州/.test(txHeadline), txHeadline);

  check('无运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('验收脚本执行', false, String(e).slice(0, 200));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过；截图与导出文件在 ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
