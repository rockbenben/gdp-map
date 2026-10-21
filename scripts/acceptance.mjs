// 浏览器级验收：真实点一遍，确认地图渲染、搜索、导出 PNG、URL 分享都能用。
// 用法：node scripts/acceptance.mjs [baseUrl]
// 依赖 dev server 已经跑起来（默认 http://127.0.0.1:5183）
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

// 用本机已安装的 Chrome，省掉下载 Playwright 自带内核
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
  await page.waitForSelector('.picker-item', { timeout: 15000 });
  const provinceCount = await page.locator('.picker-item').count();
  check('首屏加载并渲染地区列表', provinceCount >= 30, `${provinceCount} 个地区`);
  const mapPaths = await page.locator('.map-holder svg .countries path').count();
  check('世界地图渲染国家多边形', mapPaths > 100, `${mapPaths} 条路径`);

  // 2. 选一个省 → 出结果
  await page.locator('.picker-item', { hasText: '河南省' }).first().click();
  await page.waitForSelector('.result-headline h1', { timeout: 5000 });
  const headline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('选择地区后给出等价国家数', /≈\s*\d+\s*个国家/.test(headline), headline);

  // 3. URL 同步（分享）
  await page.waitForTimeout(300);
  const url = page.url();
  check('选择状态写入 URL', url.includes('sel=CN-410000'), url);

  // 4. 拼音搜索
  await page.locator('.search').fill('henan');
  await page.waitForTimeout(200);
  const searchHit = await page.locator('.picker-item').count();
  check('拼音搜索可用', searchHit >= 1 && searchHit < 10, `"henan" → ${searchHit} 条`);
  await page.locator('.search').fill('');

  // 5. 2D 地图截图 + 导出 PNG
  await page.screenshot({ path: resolve(SHOTS, 'map-2d.png'), fullPage: false });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('.primary-btn').click()
  ]);
  const pngPath = resolve(SHOTS, 'export-map.png');
  await download.saveAs(pngPath);
  const size = (await stat(pngPath)).size;
  check('导出 PNG 成功', size > 20000, `${download.suggestedFilename()} · ${(size / 1024).toFixed(0)} KB`);

  // 6. 3D 地球视图
  await page.locator('.segmented button', { hasText: '3D 地球' }).click();
  await page.waitForSelector('.globe-wrap svg .globe-country', { timeout: 15000 });
  await page.waitForTimeout(900);
  const globePaths = await page.locator('.globe-wrap svg .globe-country').count();
  check('3D 地球渲染国家多边形', globePaths > 100, `${globePaths} 条路径`);
  const globeLabels = await page.locator('.globe-wrap svg .globe-labels text').count();
  check('3D 地球标注国家名', globeLabels > 0, `${globeLabels} 个标注`);
  await page.screenshot({ path: resolve(SHOTS, 'globe-3d.png'), fullPage: false });

  const [download2] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('.primary-btn').click()
  ]);
  const png2 = resolve(SHOTS, 'export-globe.png');
  await download2.saveAs(png2);
  const size2 = (await stat(png2)).size;
  check('导出地球 PNG 成功', size2 > 20000, `${(size2 / 1024).toFixed(0)} KB`);

  // 7. 反向模式：国家 → 省份
  await page.goto(`${BASE}/?mode=country-to-region&sel=JPN`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.map-holder svg .countries path', { timeout: 15000 });
  await page.waitForSelector('.result-headline h1', { timeout: 5000 });
  const headline2 = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('反向模式给出等价省份', /≈\s*\d+\s*个省份/.test(headline2), headline2);
  const seaBox = await page.locator('.sea-label').count();
  check('中国地图附南海诸岛', seaBox > 0, `${seaBox} 个标注`);
  await page.screenshot({ path: resolve(SHOTS, 'map-china.png'), fullPage: false });

  check('无运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('验收脚本执行', false, String(e).slice(0, 200));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过；截图与导出文件在 ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
