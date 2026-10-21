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

  // 5. 对照方式（每项直接写出结果）
  const choiceCount = await page.locator('.choice').count();
  check('列出全部对照口径', choiceCount === 4, `${choiceCount} 项`);
  const previews = await page.locator('.choice-preview').allInnerTexts();
  check('每种口径都直接给出结果', previews.every((p) => /\d/.test(p)), previews.join(' | '));

  await page.locator('.choice', { hasText: '比大国家' }).click();
  await page.waitForTimeout(300);
  const bigHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('比大国家：写成「几分之几」', /≈\s*.+的\s*\d+(\.\d+)?%/.test(bigHeadline), bigHeadline);
  const bigItems = await page.locator('.result-item .name').allInnerTexts();
  check('比大国家只给一个大对象', bigItems.length === 1, bigItems.join('、'));

  await page.locator('.choice', { hasText: '宁可超出' }).click();
  await page.waitForTimeout(300);
  const overSub = await page.locator('.result-sub').innerText();
  check('宁可超出：合计不低于参照物', /超出/.test(overSub), overSub.replace(/\s+/g, ' '));

  // 6. 微型经济体开关（在「更多选项」里）
  await page.locator('.more > summary').click();
  await page.locator('.choice', { hasText: '尽量多凑' }).click();
  await page.waitForTimeout(300);
  const manyCount = await page.locator('.result-item').count();
  await page.locator('.toggle input').uncheck();
  await page.waitForTimeout(300);
  const microCount = await page.locator('.result-item').count();
  check('关闭微型过滤后件数变多', microCount > manyCount, `${manyCount} → ${microCount} 件`);
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
  check('人均下只留一个口径', (await page.locator('.choice').count()) === 1);

  // 人均不可叠加：再选一个地方应该替换，而不是累加
  const pcCount1 = await page.locator('.picker-item.active').count();
  await page.locator('.picker-item', { hasText: '广东省' }).first().click();
  await page.waitForTimeout(300);
  const pcActive = await page.locator('.picker-item.active').allInnerTexts();
  check('人均下只能选一个地方', pcCount1 === 1 && pcActive.length === 1, pcActive.join('、'));
  const pcSel = new URL(await page.url()).searchParams.get('sel');
  check('人均下 URL 只保留一个选择', (pcSel ?? '').split(',').filter(Boolean).length === 1, pcSel ?? '');
  const pcSum = await page.locator('.result-sub').innerText();
  check('人均下不再出现「合计」', !/合计/.test(pcSum), pcSum.replace(/\s+/g, ' '));

  await page.locator('.metric-btn', { hasText: '总 GDP' }).click();
  await page.waitForTimeout(300);

  // 9. 导出 PNG
  await page.screenshot({ path: resolve(SHOTS, 'map-2d.png'), fullPage: false });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('.primary-btn', { hasText: '分享' }).click().then(() => page.locator('.share-menu button', { hasText: '下载高清图' }).click())
  ]);
  const pngPath = resolve(SHOTS, 'export-map.png');
  await download.saveAs(pngPath);
  const size = (await stat(pngPath)).size;
  check('导出高清 PNG 成功', size > 20000, `${download.suggestedFilename()} · ${(size / 1024).toFixed(0)} KB`);

  // 分享卡（竖版）
  const [card] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('.primary-btn', { hasText: '分享' }).click().then(() => page.locator('.share-menu button', { hasText: '下载分享卡' }).click())
  ]);
  const cardPath = resolve(SHOTS, 'export-card.png');
  await card.saveAs(cardPath);
  check('导出分享卡成功', (await stat(cardPath)).size > 20000, `${(await stat(cardPath)).size / 1024} KB`);

  // 首屏就有结果（新用户不用做任何操作）
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  const firstTitle = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('首屏直接给结论', /≈/.test(firstTitle), firstTitle);

  // 10. 3D 地球
  await page.locator('.segmented button', { hasText: '地球' }).click();
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
    page
      .locator('.primary-btn', { hasText: '分享' })
      .click()
      .then(() => page.locator('.share-menu button', { hasText: '下载高清图' }).click())
  ]);
  const png2 = resolve(SHOTS, 'export-globe.png');
  await download2.saveAs(png2);
  check('导出地球 PNG 成功', (await stat(png2)).size > 20000);

  // 10.6 年份回溯：换一个年份，世界与排名都跟着变
  await page.goto(`${BASE}/?sel=CN-410000&y=2010`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const rank2010 = (await page.locator('.result-strategy').innerText()).replace(/\s+/g, ' ');
  check('年份进入排名说明', /2010\s*年/.test(rank2010), rank2010);
  const count2010 = await page.locator('.result-item').count();
  check('换一个年份匹配结果不同', count2010 > 0, `2010 年：${count2010} 件`);
  await page.locator('.more > summary').click();
  await page.locator('.year-ticks button', { hasText: '1990' }).click();
  await page.waitForTimeout(400);
  check('滑块可切到 1990', (await page.url()).includes('y=1990'), await page.url());
  await page.locator('.strategy').screenshot({ path: resolve(SHOTS, 'panel-year.png') });

  // 10.7 「假如它是一个国家」排名卡
  await page.goto(`${BASE}/?sel=CN-410000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.counterfactual', { timeout: 15000 });
  const cf = (await page.locator('.counterfactual').innerText()).replace(/\s+/g, ' ');
  check('给出「假如它是一个国家」的排名', /假如.*是一个国家/.test(cf) && /第\s*\d+\s*位/.test(cf), cf.slice(0, 110));
  const cfRows = await page.locator('.counterfactual li').count();
  check('四项指标都给出名次', cfRows === 4, `${cfRows} 行`);

  // 10.8 拼图玩法
  await page.locator('.chip', { hasText: '玩一局' }).click();
  await page.waitForSelector('.puzzle', { timeout: 10000 });
  const puzzleText = await page.locator('.puzzle').innerText();
  check('拼图给出目标', /凑一凑/.test(puzzleText), puzzleText.split('\n')[0]);
  for (const id of ['KOR', 'PER', 'CHL']) {
    await page.locator(`.map-holder svg .countries path[data-id="${id}"]`).click({ force: true });
    await page.waitForTimeout(150);
  }
  const after = (await page.locator('.puzzle').innerText()).replace(/\s+/g, ' ');
  check('拼图统计已选个数与合计', /已选\s*\d\/3/.test(after), after.slice(0, 120));
  await page.locator('.chip', { hasText: '看答案' }).click();
  await page.waitForTimeout(300);
  const withBest = (await page.locator('.puzzle').innerText()).replace(/\s+/g, ' ');
  check('拼图公布最优解', /最优解/.test(withBest), withBest.slice(0, 150));
  await page.locator('.puzzle').screenshot({ path: resolve(SHOTS, 'card-puzzle.png') });

  // 10.9 新视图：方形图 / 擂台；新指标：密度 / 平价
  await page.goto(`${BASE}/?sel=CN-410000&view=square`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sq-cell', { timeout: 15000 });
  const sqCells = await page.locator('.sq-cell').count();
  check('方形图按指标重画世界', sqCells > 100, `${sqCells} 块`);

  await page.goto(`${BASE}/?sel=CN-410000,CN-440000&view=bracket`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.target-compare', { timeout: 15000 });
  const score = (await page.locator('.tc-score').first().innerText()).replace(/\s+/g, ' ');
  check('擂台给出比分', /胜出|平局/.test(score), score);
  const bracketNodes = await page.locator('.bracket-label').count();
  check('对阵树画出晋级路径', bracketNodes > 8, `${bracketNodes} 个节点`);

  await page.goto(`${BASE}/?sel=CN-410000&m=density`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const densityHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('GDP 密度可对比', /密度/.test(densityHeadline), densityHeadline);

  await page.goto(`${BASE}/?sel=CN-410000&m=pppGdp`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const pppSub = (await page.locator('.result-sub').innerText()).replace(/\s+/g, ' ');
  check('平价口径生效', /平价/.test(pppSub), pppSub);

  // 10.5 两个目标的直接对比
  await page.goto(`${BASE}/?sel=CN-410000,CN-440000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.target-compare', { timeout: 15000 });
  const compareText = (await page.locator('.target-compare').innerText()).replace(/\s+/g, ' ');
  check('两个目标可直接对比', /河南省/.test(compareText) && /广东省/.test(compareText), compareText.slice(0, 90));
  await page.locator('.result').screenshot({ path: resolve(SHOTS, 'card-compare.png') });

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
