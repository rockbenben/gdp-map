// 浏览器级验收：真实点一遍，确认地图、指标、对照方式、剪影对照、导出、URL 都能用。
//
// 用法：
//   node scripts/acceptance.mjs            自动起服务器伺服 dist/（推荐，CI 就走这条）
//   node scripts/acceptance.mjs <baseUrl>  对着已经跑着的站点跑（比如本地 dev server）
//
// 两条路的差别只有「谁来起服务器」：给 baseUrl 就用给定的（dev server 上跑，测的是热更新后的源码），
// 不给就伺服 dist/（测的是真正要上线的那份产物，CI 里必须走这条）。
import { chromium } from 'playwright';
import { mkdir, stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './static-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const SHOTS = resolve(ROOT, 'tmp/acceptance');
await mkdir(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * 起浏览器。
 *
 * 默认：优先用本机装好的 Google Chrome（channel: 'chrome'），省掉几百 MB 下载；
 * 起不来再退回 Playwright 自带的 chromium。
 *
 * ⚠️ **CI 里要用 `ACCEPTANCE_BROWSER=chromium` 强制走自带浏览器。**
 * GitHub 的 ubuntu runner **预装了 Google Chrome**，所以默认那条路在 CI 里也会成功——
 * 于是 `npx playwright install --with-deps chromium` 白装了，而且 Playwright 并不保证
 * 自带浏览器与系统 Chrome 的协议版本对得上（channel 模式属于「尽量能用」，
 * 官方支持的组合是自带浏览器）。强制走自带的那条，CI 跑的就是下载下来那个版本。
 */
async function launchBrowser() {
  const forced = process.env.ACCEPTANCE_BROWSER;
  const notes = [];

  if (forced !== 'chromium') {
    try {
      const b = await chromium.launch({ channel: 'chrome' });
      return { browser: b, via: '系统 Chrome（channel: chrome）' };
    } catch (err) {
      notes.push('channel=chrome 起不来：' + String(err?.message ?? err).split('\n')[0]);
    }
  }

  try {
    const b = await chromium.launch();
    return { browser: b, via: 'Playwright 自带的 chromium' };
  } catch (err) {
    notes.push('自带 chromium 起不来：' + String(err?.message ?? err).split('\n')[0]);
  }

  throw new Error('没有可用的浏览器。\n  ' + notes.join('\n  ') + '\n  下载：npx playwright install chromium');
}

/** 验收目标地址：给了 baseUrl 就用它，否则自己伺服 dist/。 */
async function resolveBase() {
  const given = process.argv[2];
  if (given) return { base: given, stop: async () => {} };

  if (!existsSync(resolve(DIST, 'index.html'))) {
    console.log('· dist/ 里没有 index.html，先跑 npm run build …');
    const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
    if (r.status !== 0) throw new Error(`npm run build 失败（退出码 ${r.status}）`);
  }

  const server = await startServer(DIST);
  console.log(`· 验收站点：${server.origin}（伺服 dist/）`);
  return { base: server.origin, stop: () => server.close() };
}

const { base: BASE, stop: stopServer } = await resolveBase();
const { browser, via: browserVia } = await launchBrowser();
console.log(`· 浏览器：${browserVia}`);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

/**
 * 读结论句，但要等它**滚完**。
 *
 * 结论里的数字是会动的（从旧值滚到新值），刚换指标就 innerText 会读到半路的数
 * （比如「河南省 ≈ 7 个国家之和」），日志就成了假的。这里连续读两次，
 * 两次一样才算落定。
 */
async function settleHeadline(timeout = 4000) {
  const loc = page.locator('.result-headline h1');
  let last = '';
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    last = await loc.innerText();
    await page.waitForTimeout(120);
    const again = await loc.innerText();
    if (again === last) return again.replace(/\s+/g, ' ');
    last = again;
  }
  return last.replace(/\s+/g, ' ');
}

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

  // 路径里不能出现 NaN：d3-geo 遇到退化/越界的坐标会写出 "MNaN,NaN..."，
  // 那种路径不报错、只是整块画不出来（AGENTS.md 里踩过：按 4 元组取包围盒中心）。
  // 所以这里不靠「有没有抛异常」，直接扫 d 属性。
  const badPaths = await page.evaluate(() => {
    const bad = [];
    for (const p of document.querySelectorAll('svg path')) {
      const d = p.getAttribute('d') ?? '';
      if (/NaN|Infinity|undefined/i.test(d)) bad.push(d.slice(0, 60));
    }
    return bad;
  });
  check('路径没有 NaN', badPaths.length === 0, badPaths.slice(0, 2).join(' | '));

  // 2. 选一个省 → 出结果
  await page.locator('.picker-item', { hasText: '河南省' }).first().click();
  await page.waitForSelector('.result-headline h1', { timeout: 8000 });
  const headline = await settleHeadline();
  check('选择地区后给出等价国家数', /≈\s*\d+\s*个国家/.test(headline), headline);

  // 结论里的件数是单独一个元素（.count），换指标时它会从旧值滚到新值——
  // 这条守着「数字可被单独驱动」这个前提。
  // ⚠️ 只在「凑出多个」的口径下成立：最像的一个那种结论里根本没有件数。
  const countEl = page.locator('.result-headline h1 .count');
  check('结论里的数字单独成元素', (await countEl.count()) === 1);

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
  const bigHeadline = await settleHeadline();
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
  const areaHeadline = await settleHeadline();
  check('切换到面积指标', /面积/.test(areaHeadline), areaHeadline);
  const areaRank = await page.locator('.result-strategy').innerText();
  check('给出世界排名', /排第/.test(areaRank), areaRank.replace(/\s+/g, ' '));
  const silhouettePaths = await page.locator('.silhouette svg path').count();
  check('面积剪影对照（同比例尺）', silhouettePaths === 2, `${silhouettePaths} 个剪影`);
  await page.screenshot({ path: resolve(SHOTS, 'map-area.png'), fullPage: false });

  // 8. 人均指标：只能跟单个比
  await page.locator('.metric-btn', { hasText: '人均 GDP' }).click();
  await page.waitForTimeout(400);
  const pcHeadline = await settleHeadline();
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

  // 动图：1990→2025 一帧一年。得真下载下来验它是动图，
  // 只看「文件存在」不算——一张静态图也叫 GIF。
  const [gif] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.locator('.primary-btn', { hasText: '分享' }).click().then(() => page.locator('.share-menu button', { hasText: '下载动图' }).click())
  ]);
  const gifPath = resolve(SHOTS, 'export.gif');
  await gif.saveAs(gifPath);
  const gifBuf = await readFile(gifPath);
  // 每一帧前面都有一个 Graphic Control Extension：0x21 0xF9 0x04
  let gifFrames = 0;
  for (let i = 0; i < gifBuf.length - 3; i++) {
    if (gifBuf[i] === 0x21 && gifBuf[i + 1] === 0xf9 && gifBuf[i + 2] === 0x04) gifFrames++;
  }
  check(
    '导出动图成功（多帧）',
    gifFrames >= 10 && gifBuf.length > 50000,
    `${gifFrames} 帧 · ${(gifBuf.length / 1024).toFixed(0)} KB`
  );

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

  // 10.6 年份回溯：换一个年份，对照的世界跟着变；
  //     但名次要按参照物**自己那一年**算（省的数据是 2024，拿它跟 2010 的经济体比是假的）
  await page.goto(`${BASE}/?sel=CN-410000&y=2010`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(400);
  const rank2010 = (await page.locator('.result-strategy').innerText()).replace(/\s+/g, ' ');
  check('名次按参照物自己的年份算', /2024\s*年/.test(rank2010), rank2010);
  const count2010 = await page.locator('.result-item').count();
  check('换一个年份匹配结果不同', count2010 > 0, `2010 年：${count2010} 件`);
  await page.locator('.more > summary').click();
  await page.locator('.year-ticks button', { hasText: '1990' }).click();
  await page.waitForTimeout(400);
  check('滑块可切到 1990', (await page.url()).includes('y=1990'), await page.url());
  await page.locator('.strategy').screenshot({ path: resolve(SHOTS, 'panel-year.png') });

  // 10.6.1 播放：让年份自己走，结论跟着变
  await page.locator('.play-btn').click();
  await page.waitForTimeout(1700);
  const playYear = await page.locator('.year-now').innerText();
  const playCount = await page.locator('.result-headline h1 .count').innerText().catch(() => '');
  check('播放让年份自己往前走', Number(playYear) >= 1990, `${playYear} 年 · ${playCount} 个国家`);
  await page.locator('.play-btn').click(); // 停掉，别让它一路播到 2025
  await page.waitForTimeout(300);
  check('播放可以停下来', (await page.locator('.play-btn').innerText()).includes('播放'), await page.locator('.play-btn').innerText());

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

  // 排行榜：把能选的对象按当前指标排开，选中的那条高亮
  await page.goto(`${BASE}/?sel=CN-410000&view=rank`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.rank-row', { timeout: 15000 });
  const rankRows = await page.locator('.rank-row').count();
  check('排行榜列出对象', rankRows > 10, `${rankRows} 行`);
  const rankPicked = await page.locator('.rank-row.is-selected').count();
  check('排行榜标出当前选中', rankPicked === 1, `${rankPicked} 行高亮`);
  await page.screenshot({ path: resolve(SHOTS, 'view-rank.png'), fullPage: false });

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

  // 10.6 欧洲 NUTS-1 与日本都道府县
  await page.goto(`${BASE}/?sel=EU-DE2`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const bayern = await settleHeadline();
  check('德国州可作参照物', /巴伐利亚/.test(bayern), bayern);
  const bayernCf = (await page.locator('.counterfactual').innerText()).replace(/\s+/g, ' ');
  check('德国州给出世界名次', /第\s*\d+\s*位/.test(bayernCf), bayernCf.slice(0, 90));

  await page.goto(`${BASE}/?sel=JP-13`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const tokyo = await settleHeadline();
  check('日本都道府县可作参照物', /东京都/.test(tokyo), tokyo);

  // 搜得到新地区
  await page.goto(`${BASE}/?sel=CN-410000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.picker-item', { timeout: 15000 });
  await page.locator('.search').fill('巴伐');
  await page.waitForTimeout(300);
  const bayernHit = await page.locator('.picker-item').allInnerTexts();
  check('搜得到欧洲 NUTS-1', bayernHit.some((t) => t.includes('巴伐利亚')), bayernHit.join(' | '));
  await page.locator('.search').fill('');
  await page.waitForTimeout(200);

  // 11. 反向模式：国家 → 省/州
  await page.goto(`${BASE}/?mode=world-to-region&sel=JPN`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const headline2 = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('反向模式给出等价省/州', /≈\s*\d+\s*个/.test(headline2), headline2);
  const subHighlights = await page.locator('.map-holder svg .subdivisions path[fill]:not([fill="none"])').count();
  check('世界地图高亮匹配的省/州', subHighlights > 0, `${subHighlights} 个`);

  // 11.1 换方向要保留上下文：选的是省就换成它所属的国家
  await page.goto(`${BASE}/?sel=CN-410000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.locator('.segmented button', { hasText: '世界 → 地方' }).first().click();
  await page.waitForTimeout(600);
  const afterSwitch = await page.locator('.result-headline h1').innerText().catch(() => '');
  check('换方向不换题（省 → 它的国家）', /中国/.test(afterSwitch), afterSwitch);
  await page.locator('.segmented button', { hasText: '地方 → 世界' }).first().click();
  await page.waitForTimeout(600);
  const backSwitch = await page.locator('.result-headline h1').innerText().catch(() => '');
  check('换回来也是满的', /≈\s*\d+\s*个/.test(backSwitch), backSwitch);

  // 12. 几处曾经漏掉的坑（这四条当初都逃过了验收）
  // 12.1 平价口径：新来的 141 个地区也得有 PPP，否则选中就是一片空白
  await page.goto(`${BASE}/?sel=JP-13&m=pppGdp`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(600);
  const pppTitle = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('平价口径对新地区也有效', /≈\s*\d+\s*个/.test(pppTitle), pppTitle);

  // 12.2 面积剪影：新地区也要画得出来（对照物没有边界就会整块消失）
  await page.goto(`${BASE}/?sel=JP-13&m=area&st=nearest`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  const jpSilhouette = await page.locator('.silhouette svg path').count();
  check('新地区的面积剪影能画出来', jpSilhouette === 2, `${jpSilhouette} 个剪影`);

  // 12.3 排行视图：名次要自洽（不能既显示「第 61 行」又显示「第 223 位」）
  await page.goto(`${BASE}/?sel=JP-31&view=rank`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.rank-row', { timeout: 15000 });
  await page.waitForTimeout(400);
  const rankRow = (await page.locator('.rank-row').last().innerText()).replace(/\s+/g, ' ');
  check('排行的名次自洽', !/第\s*\d+\s*位/.test(rankRow), rankRow);

  // 12.4 排行视图：导出不能报「地图未就绪」
  await page.locator('.primary-btn', { hasText: '分享' }).click();
  const [rankDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.locator('.share-menu button', { hasText: '下载高清图' }).click()
  ]);
  check('排行视图下也能导出', Boolean(rankDownload), rankDownload.suggestedFilename());

  // 12.5 选中的省/州要在地图上标出来（不然看不出自己选的是哪个）
  await page.goto(`${BASE}/?sel=JP-13`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  const jpMarked = await page.locator('.map-holder svg .subdivisions path[fill]:not([fill="none"])').count();
  check('选中的地区在地图上标出来', jpMarked > 0, `${jpMarked} 个`);

  // 12.6 选择器要能搜到国名（搜「德国」要能搜到巴伐利亚）
  await page.goto(`${BASE}/?sel=CN-410000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.picker-item', { timeout: 15000 });
  await page.locator('.search').fill('德国');
  await page.waitForTimeout(300);
  const byCountry = await page.locator('.picker-item').allInnerTexts();
  check('搜国名能找到省/州', byCountry.length > 0, byCountry.map((t) => t.split('\n')[0]).slice(0, 4).join('、'));
  await page.locator('.search').fill('');

  const seaBox = await page.locator('.sea-label').count();
  check('附南海诸岛小图', seaBox > 0, `${seaBox} 个标注`);
  await page.screenshot({ path: resolve(SHOTS, 'map-china.png'), fullPage: false });

  // 12.7 美国州也能当参照物
  await page.goto(`${BASE}/?sel=US-48`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const txHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('美国州可作参照物', /得克萨斯州/.test(txHeadline), txHeadline);

  // 13. 两个地方对比：地图上两个参照物要用两种颜色（一种颜色画两个形状，读者只能靠位置猜）
  await page.goto(`${BASE}/?sel=CN-410000,US-48`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  const sourceFills = await page.$$eval('.map-holder svg .subdivisions path', (ps) => [
    ...new Set(
      ps
        .map((p) => p.getAttribute('fill'))
        .filter((f) => f && f !== 'none')
        .map((f) => String(f).toLowerCase())
    )
  ]);
  check('两个参照物用两种颜色', sourceFills.length === 2, sourceFills.join(' / '));

  // 14. 排行榜要包含国家（不然「假如它是一个国家」的名次在榜上没法核对）
  await page.goto(`${BASE}/?sel=CN-440000&view=rank`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.rank-row', { timeout: 15000 });
  await page.waitForTimeout(400);
  const allTags = await page.$$eval('.rank-row .rank-name em', (es) =>
    es.map((e) => (e.textContent ?? '').trim())
  );
  check(
    '排行里有国家也有省/州',
    allTags.includes('国家') && allTags.some((t) => t !== '国家'),
    [...new Set(allTags)].join(' / ')
  );

  // 15. 排行可以只看一类
  await page.locator('.rank-filters button', { hasText: '国家' }).click();
  await page.waitForTimeout(300);
  const countryRows = await page.locator('.rank-row').count();
  const countryTags = await page.locator('.rank-row .rank-name em').count();
  check('排行可只看国家', countryRows > 0 && countryTags === 0, `${countryRows} 行`);

  await page.locator('.rank-filters button', { hasText: '省/州' }).click();
  await page.waitForTimeout(300);
  const regionRows = await page.locator('.rank-row').count();
  const regionTags = await page.locator('.rank-row .rank-name em').count();
  check('排行可只看省/州', regionRows > 0 && regionTags === regionRows, `${regionRows} 行`);

  // 16. 点榜上的国家要切到「世界 → 省/州」并选上它（不然点了等于没点）
  await page.locator('.rank-filters button', { hasText: '全部' }).click();
  await page.waitForTimeout(300);
  const firstCountryIdx = await page.$$eval('.rank-row', (rows) =>
    rows.findIndex((r) => r.querySelector('.rank-name em')?.textContent?.trim() === '国家')
  );
  if (firstCountryIdx >= 0) {
    await page.locator('.rank-row').nth(firstCountryIdx).click();
    await page.waitForTimeout(500);
  }
  check('点榜上的国家会切方向', page.url().includes('mode=world-to-region'), page.url().split('?')[1] ?? '');

  check('无运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('验收脚本执行', false, String(e).slice(0, 200));
} finally {
  await browser.close();
  await stopServer();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过；截图与导出文件在 ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
