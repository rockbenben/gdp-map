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

  // 2.1 地图上方那句「人话」图注：数字是结论，图注是这句话的意思
  const caption = (await page.locator('.stage-caption p').innerText()).replace(/\s+/g, ' ');
  check(
    '地图上方有人话图注',
    /加起来|有记录|最接近|顶得上/.test(caption) && !/^\s*$/.test(caption),
    caption
  );

  // 2.2 结论优先：结果卡排在指标面板前面（先看答案，再看调它的工具）
  const order = await page.evaluate(() => {
    const y = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : Infinity;
    };
    return { result: y('.result'), metric: y('.strategy') };
  });
  check('结论排在工具前面', order.result < order.metric, `结论 ${order.result}px · 指标 ${order.metric}px`);

  // 3. URL 同步
  await page.waitForTimeout(300);
  check('选择状态写入 URL', (await page.url()).includes('sel=CN-410000'), await page.url());

  // 3.1 点已经激活的模式按钮，不该把题换成别的省
  await page.locator('.segmented button', { hasText: '地方 → 世界' }).click();
  await page.waitForTimeout(500);
  const sameModeHeadline = await settleHeadline();
  check('点已激活的模式按钮不会换题', /河南省/.test(sameModeHeadline), sameModeHeadline);

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
  const bigPctHeadline = await settleHeadline();
  check('比大国家：写成「几分之几」', /≈\s*.+的\s*\d+(\.\d+)?%/.test(bigPctHeadline), bigPctHeadline);
  const bigItems = await page.locator('.result-item .name').allInnerTexts();
  check('比大国家只给一个大对象', bigItems.length === 1, bigItems.join('、'));

  await page.locator('.choice', { hasText: '宁可超出' }).click();
  await page.waitForTimeout(300);
  const overSub = await page.locator('.result-sub').innerText();
  check('宁可超出：合计不低于参照物', /超出/.test(overSub), overSub.replace(/\s+/g, ' '));

  // 6. 微型经济体开关（现在直接露在口径列表下面，不用展开什么）
  await page.locator('.choice', { hasText: '尽量多凑' }).click();
  await page.waitForTimeout(300);
  const manyCount = await page.locator('.result-item').count();
  await page.locator('.compare-panel .toggle input').uncheck();
  await page.waitForTimeout(300);
  const microCount = await page.locator('.result-item').count();
  check('关闭微型过滤后件数变多', microCount > manyCount, `${manyCount} → ${microCount} 件`);
  const microOff = await page.locator('.compare-panel .toggle input').isChecked();
  const microUrl = page.url();
  check(
    '微型过滤关闭状态写进 URL',
    !microOff && /(^|[?&])micro=0(&|$)/.test(microUrl),
    microUrl.split('?')[1] ?? ''
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(400);
  const microAfterReload = await page.locator('.compare-panel .toggle input').isChecked();
  check('微型过滤刷新后仍是关的', !microAfterReload);
  const microCountAfterReload = await page.locator('.result-item').count();
  check(
    '刷新后件数仍是关闭过滤的件数',
    microCountAfterReload === microCount,
    `${microCount} → ${microCountAfterReload}`
  );
  await page.locator('.compare-panel .toggle input').check();
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

  // 动图：目标有数据的年份一帧一年（此时选的是广东，2000→2024）。
  // 得真下载下来验它是动图，只看「文件存在」不算——一张静态图也叫 GIF。
  const [gif] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.locator('.primary-btn', { hasText: '分享' }).click().then(() => page.locator('.share-menu button', { hasText: '下载动图' }).click())
  ]);
  // 动图要从**目标有数据**的最早一年开始：广东是 2000，不是国家侧的 1960
  check(
    '动图从目标最早的年份开始',
    /gdp-map-2000-2024\.gif$/.test(gif.suggestedFilename()),
    gif.suggestedFilename()
  );
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

  // 10.6 年份回溯：**目标和对照的世界都按同一年比**
  //     （「拿哪一年的世界来比，选中目标的 GDP 也该变动」）
  //     中国省级有 2000–2024 的数据（年鉴逐年），欧盟一级区 2000–2024，
  //     日本府县只有 2023——每个地方能选哪几年，由它自己的数据决定。
  await page.goto(`${BASE}/?sel=CN-410000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(600);
  const cnRange = await page.locator('.year-slider').getAttribute('min');
  const cnMax = await page.locator('.year-slider').getAttribute('max');
  check('中国省级的年份控件覆盖它自己的全部年份', cnRange === '2000' && cnMax === '2024', `${cnRange}–${cnMax}`);
  const cnHint = (await page.locator('.year-panel .picker-hint').first().innerText()).replace(/\s+/g, ' ');
  check('说清楚年份为什么从 2000 年起', /河南省的数据是\s*2000–2024/.test(cnHint), cnHint.slice(0, 70));
  // 拨到 2010 年：目标的大小得跟着变（河南 2010 年 ≈ 3,400 亿美元，2024 年 ≈ 8,800 亿美元）
  const gdpCn2024 = (await page.locator('.result-sub').innerText()).replace(/\s+/g, ' ');
  await page.locator('.year-slider').fill('2010');
  await page.locator('.year-slider').dispatchEvent('change');
  await page.waitForTimeout(1400);
  const gdpCn2010 = (await page.locator('.result-sub').innerText()).replace(/\s+/g, ' ');
  check('省的目标大小跟着年份变', gdpCn2024 !== gdpCn2010, `${gdpCn2024} → ${gdpCn2010}`);
  check('结论写明是哪一年', /2010/.test(await settleHeadline()), await settleHeadline());

  // 只有一年数据的地区（日本府县）：控件就只剩那一年，而且要说清楚为什么
  await page.goto(`${BASE}/?sel=JP-13`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(600);
  const jpMin = await page.locator('.year-slider').getAttribute('min');
  const jpMax = await page.locator('.year-slider').getAttribute('max');
  check('只有一年数据的地区，年份控件就只剩那一年', jpMin === '2023' && jpMax === '2023', `${jpMin}–${jpMax}`);
  const jpHint = (await page.locator('.year-panel .picker-hint').first().innerText()).replace(/\s+/g, ' ');
  check('说清楚为什么只有一年', /只有 2023 年的数据/.test(jpHint), jpHint.slice(0, 60));
  check('只有一年数据时不说「往前拨」', !/往前拨/.test(jpHint), jpHint.slice(0, 80));
  check('只有一年数据时，播放按钮不可点', await page.locator('.play-btn').isDisabled());

  // 面积不跟年份走：不要出现「广东省的面积 ≈ 2000 年的柬埔寨」
  await page.goto(`${BASE}/?sel=CN-440000&m=area&y=2000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(600);
  const areaHeadlineFixed = await settleHeadline();
  const areaHint = await page.locator('.year-panel .picker-hint').first().innerText();
  const areaMin = await page.locator('.year-slider').getAttribute('min');
  const areaMax = await page.locator('.year-slider').getAttribute('max');
  check('面积口径不把年份写进结论', !/2000/.test(areaHeadlineFixed), areaHeadlineFixed);
  check('面积口径说明年份固定', /面积不随年份变化/.test(areaHint), areaHint.slice(0, 60));
  check('面积口径的年份控件只剩默认年', areaMin === '2024' && areaMax === '2024', `${areaMin}–${areaMax}`);

  // 2000 年有些国家没有人口记录，不能因此把微型国家放进「已忽略微型」的池子
  await page.goto(`${BASE}/?sel=CN-440000&y=2000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(600);
  const names2000 = await page.locator('.result-list .name').allInnerTexts();
  const strategy2000 = await page.locator('.result-strategy').innerText();
  check(
    '缺人口记录的微型国家不会漏进 2000 年的结果',
    !names2000.includes('图瓦卢') && /已忽略人口不足 100 万/.test(strategy2000),
    names2000.slice(0, 3).join('、')
  );

  // 伊拉克 2000 年没有人口记录，但它在得州的结果里；合计不能按 0 算
  await page.goto(`${BASE}/?sel=US-48&y=2000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(600);
  const texasNames = await page.locator('.result-list .name').allInnerTexts();
  const texasPop = (await page.locator('.result-single').allInnerTexts()).join(' ');
  const texasPopYi = Number((texasPop.match(/住着\s*([\d.]+)\s*亿人/) ?? [])[1]);
  check(
    '缺人口记录的国家不会按 0 计入合计',
    texasNames.includes('伊拉克') && texasPopYi > 8.5,
    texasPop.slice(0, 100)
  );

  // 世界 → 地方时，搜索框的例子得是国家，不是省
  await page.goto(`${BASE}/?mode=world-to-region`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(600);
  const countrySearchPlaceholder = await page.locator('.picker .search').getAttribute('placeholder');
  check(
    '选国家时搜索框举国家的例子',
    /美国/.test(countrySearchPlaceholder ?? '') && !/广东/.test(countrySearchPlaceholder ?? ''),
    countrySearchPlaceholder ?? ''
  );

  // 反向模式只能选一个国家，不能提示用户「多选几个地区」
  await page.goto(`${BASE}/?mode=world-to-region&sel=JPN&st=nearest`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const reverseHints = await page.$$eval('.result-hint', (es) => es.map((e) => e.textContent.trim()));
  check(
    '反向模式不提示「多选几个地区」',
    !reverseHints.some((t) => /多选/.test(t)),
    reverseHints.join(' / ') || '（没有这条提示）'
  );

  // 科索沃没有面积数据：不能显示成「挑一个地方」，也不能在选择器里让人白选
  await page.goto(`${BASE}/?mode=world-to-region&sel=UVK&m=area`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const kosovoPlaceholder = (await page.locator('.result').innerText()).replace(/\s+/g, ' ');
  const kosovoInPicker = (await page.locator('.picker').innerText()).includes('科索沃');
  check(
    '没有当前指标数据的地方会说明原因',
    /科索沃.*没有面积数据/.test(kosovoPlaceholder) && !kosovoInPicker,
    kosovoPlaceholder.slice(0, 80)
  );

  // 欧盟一级区：2000–2024 都能选，而且目标的大小跟着年份变
  await page.goto(`${BASE}/?sel=EU-DE2`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(800);
  const euMin = await page.locator('.year-slider').getAttribute('min');
  const euMax = await page.locator('.year-slider').getAttribute('max');
  check('多年数据的地区，年份控件覆盖它的全部年份', euMin === '2000' && euMax === '2024', `${euMin}–${euMax}`);
  const gdp2024 = (await page.locator('.result-sub').innerText()).replace(/\s+/g, ' ');
  // 用滑块改年份（刻度是随区间变的，点刻度会随数据更新失效）
  await page.locator('.year-slider').fill('2008');
  await page.locator('.year-slider').dispatchEvent('change');
  await page.waitForTimeout(1200);
  const gdp2008 = (await page.locator('.result-sub').innerText()).replace(/\s+/g, ' ');
  const headline2008 = await settleHeadline();
  check('目标的大小跟着年份变', gdp2024 !== gdp2008, `${gdp2024} → ${gdp2008}`);
  check('结论写明是哪一年', /2008/.test(headline2008), headline2008);
  const strategy2008 = await page.locator('.result-strategy').innerText();
  check('写明当年有多少个国家有数据', /有记录\s*\d+\s*个/.test(strategy2008), strategy2008);
  await page.locator('.strategy').screenshot({ path: resolve(SHOTS, 'panel-year.png') });

  // 10.6.1 播放：让年份自己走，结论跟着变
  //     （在有多年数据的地区上播：只有一年数据时播放本来就一步都走不了）
  await page.locator('.play-btn').click();  await page.waitForTimeout(1700);
  const playYear = await page.locator('.year-now').innerText();
  const playCount = await page.locator('.result-headline h1 .count').innerText().catch(() => '');
  check('播放让年份自己往前走', Number(playYear) >= 1960, `${playYear} 年 · ${playCount} 个国家`);
  await page.locator('.play-btn').click(); // 停掉，别让它一路播到 2025
  await page.waitForTimeout(300);
  check('播放可以停下来', (await page.locator('.play-btn').innerText()).includes('播放'), await page.locator('.play-btn').innerText());

  // 21. 估算年份（1960 以前）不进年份控件：目标没有那年的数据，比了也是拼出来的
  await page.goto(`${BASE}/?sel=CN-410000&y=1800`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const y1800 = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  const min1800 = await page.locator('.year-slider').getAttribute('min');
  const now1800 = (await page.locator('.year-now').innerText()).trim();
  check(
    '旧链接的 1800 被夹到目标最早年份',
    min1800 === '2000' && now1800 === '2000' && !/1800/.test(y1800),
    `${y1800}（${now1800} · 滑块起点 ${min1800}）`
  );

  // 21.2 数据有缺口/没有值的年份：不能停在空结论上
  await page.goto(`${BASE}/?sel=CN-820000&y=1995`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(800);
  const macaoYear = Number(await page.locator('.year-now').innerText());
  const macaoHint = (await page.locator('.year-panel .picker-hint').first().innerText()).replace(/\s+/g, ' ');
  check('澳门 1990–2000 的空档不提供年份', macaoYear !== 1995, `${macaoYear} 年 · ${macaoHint.slice(0, 80)}`);
  check(
    '澳门年份提示写出缺口',
    /1982–1989/.test(macaoHint) && /2001–2025/.test(macaoHint),
    macaoHint.slice(0, 110)
  );
  check('澳门在没有数据的请求年份仍有结论', /≈/.test(await settleHeadline()), await settleHeadline());

  // 21.3 世界 → 地方：国家在请求的年份没有值（WEO "NA"）时也要夹走
  await page.goto(`${BASE}/?sel=SOM&mode=world-to-region&y=2005`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(800);
  const somYear = Number(await page.locator('.year-now').innerText());
  const somHeadline = await settleHeadline();
  check(
    '目标没有值的年份会被夹走',
    somYear !== 2005 && /≈/.test(somHeadline),
    `${somYear} 年 · ${somHeadline}`
  );

  // 21.4 世界 → 地方：省/州那一侧最早只到 1997 年，年份控件不能给出更早的
  await page.goto(`${BASE}/?sel=USA&mode=world-to-region`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(1000);
  const wMin = await page.locator('.year-slider').getAttribute('min');
  const wMax = await page.locator('.year-slider').getAttribute('max');
  check('世界 → 地方的年份控件受省/州的数据约束', wMin === '1997' && wMax === '2025', `${wMin}–${wMax}`);

  // 21.5 名次分母 = 当年在当前指标上有记录的国家数，不是对象池长度
  //      （1990 年池子里有 189 个对象，但只有 149 个有 GDP）
  await page.goto(`${BASE}/?sel=CN-710000&y=1990`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.year-slider')?.disabled, { timeout: 15000 });
  await page.waitForTimeout(600);
  const rankText = (await page.locator('.result-strategy').innerText()).replace(/\s+/g, ' ');
  const rankTotal = rankText.match(/在\s*1990\s*年的\s*(\d+)\s*个经济体里排第\s*\d+\s*位/);
  const recorded = rankText.match(/当年有记录\s*(\d+)\s*个国家/);
  check(
    '名次分母等于当年有记录的国家数',
    rankTotal != null && recorded != null && rankTotal[1] === recorded[1],
    rankText
  );

  // 22. 首屏瘦身：基础数据先到、历史数据随后
  //     （数据文件拆成「默认年」+「历史」两个，首屏不再等 700 多 KB）
  await page.goto(`${BASE}/?sel=CN-410000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.year-slider')?.disabled, { timeout: 15000 });
  const loaded = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => e.name.split('/').pop())
  );
  check(
    '首屏只加载基础数据，历史数据是另一个文件',
    loaded.includes('regions.json') && loaded.includes('regions-history.json'),
    loaded.filter((f) => f.endsWith('.json')).join(' ')
  );
  // 22.1 先出结论，再等历史：把历史文件推迟 2.5 秒，结论仍要先到
  await page.route('**/data/regions-history.json', async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });
  await page.goto(`${BASE}/?sel=CN-410000`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.result-headline h1', { timeout: 2500 });
  const earlyDisabled = await page.locator('.year-slider').isDisabled();
  check('历史数据没到时先出结论', earlyDisabled, `滑块 disabled=${earlyDisabled}`);
  await page.waitForFunction(() => !document.querySelector('.year-slider')?.disabled, { timeout: 15000 });
  await page.unroute('**/data/regions-history.json');
  await page.locator('.year-slider').fill('2010');
  await page.locator('.year-slider').dispatchEvent('change');
  await page.waitForTimeout(1400);
  const headline2010 = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('历史数据到齐后，年份回溯可用', /2010/.test(headline2010), headline2010);
  // 分享链接带年份：打开就停在那一年（历史没到之前先停在默认年，到齐后跳过去）
  await page.goto(`${BASE}/?sel=CN-410000&y=2010`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.year-slider')?.disabled, { timeout: 15000 });
  await page.waitForTimeout(800);
  const linkYear = await page.locator('.year-now').innerText();
  const linkHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('带年份的分享链接打开就在那一年', linkYear.trim() === '2010' && /2010/.test(linkHeadline), `${linkYear}｜${linkHeadline}`);

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
  // 选满 3 个会自动提交；最优解与成绩直接出现
  const withBest = (await page.locator('.puzzle').innerText()).replace(/\s+/g, ' ');
  check('拼图公布最优解', /最优解/.test(withBest), withBest.slice(0, 150));
  check('拼图给出本局得分', /本局\s*\d+\s*分/.test(withBest), withBest.slice(0, 120));
  await page.locator('.puzzle').screenshot({ path: resolve(SHOTS, 'card-puzzle.png') });

  // 10.8.1 拼图中：年份固定；从排行进拼图要切回地图；没有数据的年份不开局
  check('拼图中年份滑块是禁用的', await page.locator('.year-slider').isDisabled());
  await page.locator('.puzzle .chip', { hasText: '结束' }).click();
  await page.waitForTimeout(300);

  await page.goto(`${BASE}/?sel=CN-440000&view=rank`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.rank-row', { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.locator('.chip', { hasText: '玩一局' }).click();
  await page.waitForTimeout(800);
  const stageHasMap = await page.locator('.stage-inner .map-holder svg').count();
  check(
    '从排行进拼图会切回地图',
    stageHasMap > 0 && (await page.locator('.puzzle').count()) === 1,
    `map svg=${stageHasMap}`
  );
  await page.locator('.puzzle .chip', { hasText: '结束' }).click();
  await page.waitForTimeout(300);

  await page.goto(`${BASE}/?sel=JPN&mode=world-to-region&y=1997`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.year-slider')?.disabled, { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.locator('.chip', { hasText: '玩一局' }).click();
  await page.waitForTimeout(600);
  const puzzleMissing = (await page.locator('.puzzle').count()) === 0;
  const toastText = (await page.locator('.toast').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('没有省/州数据的年份不会开一局', puzzleMissing && /没有省\/州数据/.test(toastText), toastText);

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
  const verdict = (await page.locator('.tc-verdict').first().innerText()).replace(/\s+/g, ' ');
  check('擂台给出比分', /胜出|平局/.test(verdict) && /\d/.test(score), `${score} · ${verdict}`);
  // 两边各是哪一列，得写出来
  const tcHead = (await page.locator('.tc-head').first().innerText()).replace(/\s+/g, ' ');
  check('擂台标出两边是谁', tcHead.includes('河南省') && tcHead.includes('广东省'), tcHead);
  const bracketNodes = await page.locator('.bracket-label').count();
  check('对阵树画出晋级路径', bracketNodes > 8, `${bracketNodes} 个节点`);

  await page.goto(`${BASE}/?sel=CN-410000&m=density`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const densityHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('GDP 密度可对比', /密度/.test(densityHeadline), densityHeadline);
  // 人均/密度锁死了对照方式、地区也只能单选——
  // 再提示「换个对照方式或多选几个地区」，是让新用户去撞墙
  await page.goto(`${BASE}/?sel=CN-410000&m=gdpPc`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  const pcHints = await page.$$eval('.result-hint', (es) => es.map((e) => e.textContent.trim()));
  check(
    '人均口径下不再提示「多选几个」',
    !pcHints.some((t) => /多选/.test(t)),
    pcHints.join(' / ') || '（没有这条提示）'
  );

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
  const reverseHint = (await page.locator('.strategy .picker-hint').innerText()).replace(/\s+/g, ' ');
  check('反向模式的提示说省/州，不再说「几个国家」', /省\/州/.test(reverseHint) && !/国家/.test(reverseHint), reverseHint);
  const reverseCf = (await page.locator('.counterfactual').innerText()).replace(/\s+/g, ' ');
  check(
    '反向模式的排名卡写世界名次，不说「假如它是一个国家」',
    /世界名次/.test(reverseCf) && !/假如/.test(reverseCf),
    reverseCf.slice(0, 90)
  );
  const reversePickerHint = (await page.locator('.picker .picker-hint').first().innerText()).replace(/\s+/g, ' ');
  check('反向模式说明省/州可以跨国混搭', /全世界|不限于本国/.test(reversePickerHint), reversePickerHint);
  const reverseCaption = (await page.locator('.stage-caption p').innerText()).replace(/\s+/g, ' ');
  check('反向模式图注说明省/州来自世界各地', /来自世界各地/.test(reverseCaption), reverseCaption.slice(0, 80));
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
  // 来回切一圈，回来的应该是刚才那个省，而不是这个国家里最大的那个
  check('来回切方向还是同一个省', /河南省/.test(backSwitch), backSwitch);

  // 12. 几处曾经漏掉的坑（这四条当初都逃过了验收）
  // 12.1 平价口径：新来的 141 个地区也得有 PPP，否则选中就是一片空白
  await page.goto(`${BASE}/?sel=JP-13&m=pppGdp`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(600);
  const pppTitle = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  // 结论里可能带年份（「≈ 2024 年的 38 个国家之和」——东京的数据是 2023 年，对照的是 2024 年的世界）
  check('平价口径对新地区也有效', /≈\s*(?:\d{4}\s*年的\s*)?\d+\s*个/.test(pppTitle), pppTitle);

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

  // 17. 窄屏下排行条形不能被挤没（榜就只剩一列数字，没意义了）
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/?sel=CN-440000&view=rank`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.rank-row', { timeout: 15000 });
  await page.waitForTimeout(500);
  const narrowBar = await page.evaluate(() => {
    const bar = document.querySelector('.rank-bar');
    return bar ? Math.round(bar.getBoundingClientRect().width) : 0;
  });
  check('窄屏下排行条形还在', narrowBar > 100, `${narrowBar}px`);

  // 17.1 手机上：手指按不准的小按钮要垫大，长名字不能被截断
  await page.goto(`${BASE}/?sel=CN-410000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-item', { timeout: 15000 });
  await page.waitForTimeout(800);
  const mobileUI = await page.evaluate(() => {
    const h = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().height) : 0;
    };
    const clipped = [...document.querySelectorAll('.result-item .name')]
      // 欧洲一级区那种十几个字的长名字在窄栏里放不下，会省略号截断（有 title 可看全名）——
      // 这里只查「本该放得下」的短名字
      .filter((n) => n.scrollWidth > n.clientWidth + 1 && (n.textContent ?? '').trim().length <= 8)
      .map((n) => (n.textContent ?? '').trim());
    return {
      tick: h('.year-ticks button'),
      chip: h('.quick-row .chip'),
      clipped: clipped.slice(0, 3),
      clippedCount: clipped.length
    };
  });
  check(
    '手机上可点区域够大（≥32px）',
    mobileUI.tick >= 32 && mobileUI.chip >= 32,
    `年份刻度 ${mobileUI.tick}px · 小圆片 ${mobileUI.chip}px`
  );
  check('结果列表的长名字不被截断', mobileUI.clippedCount === 0, mobileUI.clipped.join('、') || '没有截断');

  // 17.1 换地方之后，结论要滚到眼前——不然用户以为点了没反应
  await page.locator('.search').fill('云南');
  await page.waitForTimeout(400);
  await page.locator('.picker-item').first().click();
  await page.waitForTimeout(1000);
  const resultInView = await page.evaluate(() => {
    const el = document.querySelector('.result');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  check('换地方之后结论滚到眼前', resultInView);

  // 17.2 手机上拼图要点得中：地图只有 180px 高，国家小到 3px，改用清单点选
  await page.locator('.chip', { hasText: '玩一局' }).click();
  await page.waitForSelector('.puzzle-pick .picker-item', { timeout: 10000 });
  await page.waitForTimeout(400);
  const pickRows = await page.locator('.puzzle-pick .picker-item').count();
  await page.locator('.puzzle-pick .picker-item').first().click();
  await page.waitForTimeout(400);
  const pickedText = (await page.locator('.puzzle-nums').innerText()).replace(/\s+/g, ' ');
  check(
    '手机上拼图用清单点选',
    pickRows > 10 && /已选\s*1\/3/.test(pickedText),
    `${pickRows} 行 · ${pickedText}`
  );
  await page.locator('.chip', { hasText: '结束' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });

  // 18. 「比大国家」的分数不能超过 100%（「占日本的 115%」是句错话）
  await page.goto(`${BASE}/?sel=CN-410000,US-48&st=big`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 15000 });
  await page.waitForTimeout(600);
  const bigFractionHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  const bigPcts = [...bigFractionHeadline.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
  check(
    '比大国家的分数不过 100%',
    bigPcts.length > 0 && bigPcts.every((p) => p <= 100),
    bigFractionHeadline
  );

  // 19. 排行追逐：行按名次绝对定位，换指标后重新排序
  await page.goto(`${BASE}/?sel=CN-440000&view=rank`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.rank-row', { timeout: 15000 });
  await page.waitForTimeout(500);
  const readRows = () =>
    page.$$eval('.rank-row', (rows) =>
      rows.slice(0, 5).map((r) => ({
        name: r.querySelector('.rank-name')?.textContent?.trim() ?? '',
        pos: getComputedStyle(r).position,
        y: getComputedStyle(r).transform
      }))
    );
  const raceBefore = await readRows();
  await page.locator('.metric-options button', { hasText: '人均 GDP' }).click();
  await page.waitForTimeout(1200);
  const raceAfter = await readRows();
  check(
    '排行追逐：换指标时行滑到新位置',
    raceAfter.every((r) => r.pos === 'absolute') &&
      raceAfter[0].y !== raceAfter[1].y &&
      raceAfter[0].name !== raceBefore[0].name,
    `${raceBefore[0].name} → ${raceAfter[0].name}`
  );

  // 排行板要是「GDP 追赶」的样子：数值挂在条形末端，条形自己会长
  const rides = await page.$eval('.rank-fill', (el) => el.querySelector('.rank-value') !== null);
  const barTransition = await page.$eval('.rank-fill', (el) => getComputedStyle(el).transitionDuration);
  check(
    '数值挂在条形末端、条形会生长',
    rides && parseFloat(barTransition) > 0.1,
    `过渡 ${barTransition}`
  );

  // 20. 关键控件不用展开就能看见（以前「▶ 播放」藏在「更多选项」里，找不到）
  await page.goto(`${BASE}/?sel=CN-440000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.play-btn', { timeout: 15000 });
  const playVisible = await page.locator('.play-btn').isVisible();
  const sliderVisible = await page.locator('.year-slider').isVisible();
  check('播放与年份滑块直接可见', playVisible && sliderVisible);

  // 21. 排行板：省/州行标着「≈ N 国」，名次变了要有标记
  await page.goto(`${BASE}/?sel=CN-440000&view=rank`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.rank-row', { timeout: 15000 });
  await page.waitForTimeout(600);
  const equivText = await page.$$eval('.rank-equiv', (els) =>
    els.map((e) => (e.textContent ?? '').trim()).find((t) => t.length > 0) ?? ''
  );
  check('排行标着「≈ N 个国家」', /≈\s*\d+\s*国/.test(equivText), equivText);
  await page.locator('.metric-options button', { hasText: '面积' }).click();
  await page.waitForTimeout(1200);
  const deltaCount = await page.locator('.rank-delta').count();
  check('名次变化有标记', deltaCount > 0, `${deltaCount} 个标记`);

  // 22. 动效归用户选：页脚有开关，而且真能开、能关
  //     （系统关了动画的人，页面上还能自己打开——系统偏好是默认值，不是命令）
  const motionToggle = page.locator('.motion-item input');
  const hasToggle = (await motionToggle.count()) === 1;
  const durOn = await page.$eval('.rank-row', (el) => parseFloat(getComputedStyle(el).transitionDuration));
  await motionToggle.uncheck();
  await page.waitForTimeout(400);
  const durOff = await page.$eval('.rank-row', (el) => parseFloat(getComputedStyle(el).transitionDuration));
  await motionToggle.check();
  check(
    '动效开关能开能关',
    hasToggle && durOn > 0.1 && durOff < 0.05,
    `开 ${durOn}s / 关 ${durOff}s`
  );

  // 23. 系统关了动画时：要说明白，并且点一下就能打开
  //     （Windows 的「动画效果」关掉后浏览器报 reduce，用户会以为网站没做动效）
  const reducedCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce'
  });
  const reducedPage = await reducedCtx.newPage();
  await reducedPage.goto(`${BASE}/?sel=CN-440000&view=rank`, { waitUntil: 'networkidle' });
  await reducedPage.waitForSelector('.motion-toast', { timeout: 15000 });
  const hintText = (await reducedPage.locator('.motion-toast').innerText()).replace(/\s+/g, ' ');
  const clsBefore = await reducedPage.$eval('.app', (el) => el.className);
  await reducedPage.locator('.motion-toast').click();
  await reducedPage.waitForTimeout(400);
  const clsAfter = await reducedPage.$eval('.app', (el) => el.className);
  const reducedDur = await reducedPage.$eval('.rank-row', (el) =>
    parseFloat(getComputedStyle(el).transitionDuration)
  );
  check(
    '系统关动画时会提示、点一下能打开',
    /动画/.test(hintText) && clsBefore.includes('motion-off') && clsAfter.includes('motion-on') && reducedDur > 0.1,
    `${hintText} → ${reducedDur}s`
  );
  await reducedCtx.close();

  // 25. 玩法视图
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/?view=play`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.play-hub', { timeout: 20000 });
  await page.waitForTimeout(600);
  check('玩法大厅有四个入口', (await page.locator('.play-card').count()) === 4);
  check(
    '玩视图侧栏只留指标',
    (await page.locator('.play-sidebar .strategy').isVisible()) &&
      !(await page.locator('.play-sidebar .result').isVisible())
  );
  const dailyCard = (await page.locator('.play-card.daily').innerText()).replace(/\s+/g, ' ');
  check(
    '每日挑战给出目标与开始按钮',
    /每日挑战/.test(dailyCard) && /开始今日挑战/.test(dailyCard),
    dailyCard.slice(0, 100)
  );

  // 25.1 每日挑战：选一个不超过目标的选项，提交、得分、分享
  await page.locator('.play-card.daily .primary-btn').click();
  await page.waitForSelector('.puzzle', { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.locator('.puzzle-pick .picker-item').first().dispatchEvent('click');
  await page.waitForTimeout(300);
  await page.locator('.puzzle .primary-btn', { hasText: '提交' }).click();
  await page.waitForTimeout(500);
  const dailyPuzzle = (await page.locator('.puzzle').innerText()).replace(/\s+/g, ' ');
  const dailyScoreMatch = dailyPuzzle.match(/本局\s*(\d+)\s*分/);
  check(
    '每日挑战给出得分',
    dailyScoreMatch != null && Number(dailyScoreMatch[1]) > 0,
    dailyPuzzle.slice(0, 160)
  );
  check('每日挑战成功后连胜加一', /连胜\s*1/.test(dailyPuzzle), dailyPuzzle.slice(0, 160));
  await page.locator('.puzzle .chip', { hasText: '分享成绩' }).click();
  await page.waitForTimeout(300);
  const dailyShare = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  check(
    '每日成绩分享含色条与得分',
    /每日挑战/.test(dailyShare) && /🟩/.test(dailyShare) && /分/.test(dailyShare),
    dailyShare.slice(0, 80)
  );
  const dailyChallengeUrl = (dailyShare.match(/https?:\/\/\S+/) ?? [''])[0];
  check(
    '每日成绩分享带挑战链接',
    /challenge=1/.test(dailyChallengeUrl) && /score=/.test(dailyChallengeUrl),
    dailyChallengeUrl
  );
  await page.locator('.puzzle .chip', { hasText: '返回玩法' }).click();
  await page.waitForSelector('.play-hub', { timeout: 10000 });
  await page.waitForTimeout(400);
  const doneCard = (await page.locator('.play-card.daily').innerText()).replace(/\s+/g, ' ');
  check(
    '每日挑战完成后大厅显示成绩与连胜',
    /已完成/.test(doneCard) && /连胜\s*1/.test(doneCard),
    doneCard.slice(0, 120)
  );

  // 25.2 挑战链接在另一个页面复现同一题
  if (dailyChallengeUrl) {
    const challengePage = await page.context().newPage();
    const challengeErrors = [];
    challengePage.on('console', (m) => m.type() === 'error' && challengeErrors.push(m.text()));
    challengePage.on('pageerror', (e) => challengeErrors.push(String(e)));
    await challengePage.goto(dailyChallengeUrl, { waitUntil: 'networkidle' });
    await challengePage.waitForSelector('.puzzle', { timeout: 20000 });
    await challengePage.waitForTimeout(500);
    const challengeText = (await challengePage.locator('.puzzle').innerText()).replace(/\s+/g, ' ');
    check(
      '挑战链接复现同一题并显示对方分数',
      /好友的挑战/.test(challengeText) && /对方\s*\d+\s*分/.test(challengeText),
      challengeText.slice(0, 120)
    );
    check('挑战页无运行时错误', challengeErrors.length === 0, challengeErrors.slice(0, 2).join(' | '));
    await challengePage.close();
  }

  // 25.3 Higher / Lower
  await page.locator('.play-card', { hasText: 'Higher / Lower' }).locator('.primary-btn').click();
  await page.waitForSelector('.hl-card', { timeout: 10000 });
  check('Higher/Lower 给出两张卡', (await page.locator('.hl-card').count()) === 2);
  const hlOptions = await page.locator('.hl-year select option').allInnerTexts();
  const hlLastOption = hlOptions[hlOptions.length - 1] ?? '';
  check('Higher/Lower 的末年标出「预测」', /（预测）/.test(hlLastOption), hlLastOption);
  const hlLastValue = await page.locator('.hl-year select option').last().getAttribute('value');
  if (hlLastValue) {
    await page.selectOption('.hl-year select', hlLastValue);
    await page.waitForTimeout(400);
    const hlForecastText = (await page.locator('.play-game').innerText()).replace(/\s+/g, ' ');
    check('Higher/Lower 选预测年时提示口径', /预测值/.test(hlForecastText), hlForecastText.slice(0, 120));
  }
  await page.selectOption('.hl-year select', '2000');
  await page.waitForTimeout(400);
  const hlText = (await page.locator('.play-game').innerText()).replace(/\s+/g, ' ');
  check('Higher/Lower 可以换年份', /2000 年/.test(hlText) && !/预测值/.test(hlText), hlText.slice(0, 80));
  await page.locator('.hl-card').first().click();
  await page.waitForTimeout(300);
  const hlReveal = (await page.locator('.hl-cards').innerText()).replace(/\s+/g, ' ');
  check('Higher/Lower 揭晓数值', /更大|较小/.test(hlReveal), hlReveal.slice(0, 100));
  await page.locator('.play-actions .primary-btn', { hasText: '下一题' }).click();
  await page.waitForTimeout(300);
  await page.locator('.play-game-head .chip', { hasText: '返回玩法' }).click();
  await page.waitForTimeout(300);

  // 25.3.1 面积不随年份变：HL 的 2025 不能标预测
  await page.locator('.metric-btn', { hasText: '面积' }).click();
  await page.waitForTimeout(300);
  await page.locator('.play-card', { hasText: 'Higher / Lower' }).locator('.primary-btn').click();
  await page.waitForSelector('.hl-card', { timeout: 10000 });
  const areaLastOption = await page.locator('.hl-year select option').last().innerText();
  check('面积口径的末年不标预测', !/预测/.test(areaLastOption), areaLastOption);
  await page.locator('.play-game-head .chip', { hasText: '返回玩法' }).click();
  await page.waitForTimeout(300);
  await page.locator('.metric-btn', { hasText: '总 GDP' }).click();
  await page.waitForTimeout(300);

  // 25.4 盲猜轮廓：10 题一轮
  await page.locator('.play-card', { hasText: '盲猜轮廓' }).locator('.primary-btn').click();
  await page.waitForSelector('.blind-option', { timeout: 10000 });
  check(
    '盲猜给出剪影与四个选项',
    (await page.locator('.blind-option').count()) === 4 &&
      (await page.locator('.shape-silhouette').count()) === 1
  );
  for (let i = 0; i < 10; i += 1) {
    await page.locator('.blind-option').first().click();
    await page.waitForTimeout(150);
    await page.locator('.play-actions .primary-btn').click();
    await page.waitForTimeout(150);
  }
  const blindDone = (await page.locator('.play-game').innerText()).replace(/\s+/g, ' ');
  check('盲猜十题后给出成绩', /这一轮猜对了\s*\d+\/10/.test(blindDone), blindDone.slice(0, 100));
  await page.locator('.play-game-head .chip', { hasText: '返回玩法' }).click();
  await page.waitForTimeout(300);

  // 25.5 经济护照
  await page.locator('.play-card.passport-card .primary-btn').scrollIntoViewIfNeeded();
  await page.locator('.play-card.passport-card .primary-btn').click();
  await page.waitForSelector('.passport-grid', { timeout: 10000 });
  check('护照有五个分组', (await page.locator('.passport-tab').count()) === 5);
  const cnTiles = await page.locator('.passport-tile').count();
  check('护照按分组列出全部地区', cnTiles === 34, `${cnTiles} 个中国省级`);
  check('玩过的地方有印章', (await page.locator('.passport-tile.on').count()) >= 1);
  await page.locator('.passport-tab').nth(1).click();
  await page.waitForTimeout(200);
  check('护照可切到美国州', (await page.locator('.passport-tile').count()) === 51);
  await page.locator('.passport-tile').first().click();
  await page.waitForTimeout(700);
  check(
    '点护照印章回到地图',
    (await page.locator('.map-holder svg').count()) > 0 && (await page.locator('.puzzle').count()) === 0
  );

  // 25.6 进度落本地：刷新后每日成绩与护照还在
  await page.goto(`${BASE}/?view=play`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.play-hub', { timeout: 15000 });
  await page.waitForTimeout(600);
  const persistedCard = (await page.locator('.play-card.daily').innerText()).replace(/\s+/g, ' ');
  check(
    '刷新后每日成绩还在',
    /已完成/.test(persistedCard) && /连胜\s*1/.test(persistedCard),
    persistedCard.slice(0, 100)
  );
  const passportCardText = (await page.locator('.play-card.passport-card').innerText()).replace(/\s+/g, ' ');
  check('刷新后护照进度还在', /已收集\s*[1-9]/.test(passportCardText), passportCardText.slice(0, 100));

  // 25.7 玩视图里不提供地图导出，只留复制链接
  await page.locator('.primary-btn', { hasText: '分享' }).click();
  await page.waitForTimeout(200);
  const playShareItems = await page.locator('.share-menu button').allInnerTexts();
  check(
    '玩视图不导出地图',
    playShareItems.length === 1 && /复制链接/.test(playShareItems[0]),
    playShareItems.join(' / ')
  );
  await page.keyboard.press('Escape');

  // 25.8 手机上玩法单列
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/?view=play`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.play-hub', { timeout: 15000 });
  await page.waitForTimeout(500);
  const playCols = await page
    .locator('.play-cards')
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  check('手机上玩法卡片单列', playCols === 1, `${playCols} 列`);
  check('手机上能点到玩视图', await page.locator('.segmented button', { hasText: '玩' }).isVisible());

  // 25.8.1 手机上点第四张卡进游戏，不能停在名单中间（标题/进度/分组要看得到）
  await page.locator('.play-card.passport-card .primary-btn').click();
  await page.waitForSelector('.passport', { timeout: 15000 });
  await page.waitForTimeout(900);
  const mobileGameTop = await page.evaluate(() => {
    const header = document.querySelector('.topbar')?.getBoundingClientRect();
    const game = document.querySelector('.play-game')?.getBoundingClientRect();
    const tabs = document.querySelector('.passport-tabs')?.getBoundingClientRect();
    return {
      headerBottom: header ? Math.round(header.bottom) : 0,
      gameTop: game ? Math.round(game.top) : -1,
      tabsTop: tabs ? Math.round(tabs.top) : -1,
      vh: innerHeight
    };
  });
  check(
    '手机上进入游戏后标题和分组仍在视口里',
    mobileGameTop.gameTop >= mobileGameTop.headerBottom &&
      mobileGameTop.tabsTop >= mobileGameTop.headerBottom &&
      mobileGameTop.tabsTop < mobileGameTop.vh,
    JSON.stringify(mobileGameTop)
  );
  await page.locator('.play-game-head .chip', { hasText: '返回玩法' }).click();
  await page.waitForSelector('.play-hub', { timeout: 10000 });
  await page.waitForTimeout(800);
  const mobileHubTop = await page.evaluate(() => {
    const header = document.querySelector('.topbar')?.getBoundingClientRect();
    const hub = document.querySelector('.play-hub-head')?.getBoundingClientRect();
    return { headerBottom: Math.round(header?.bottom ?? 0), hubTop: Math.round(hub?.top ?? -1) };
  });
  check('手机上从游戏返回大厅时回到大厅顶部', mobileHubTop.hubTop >= mobileHubTop.headerBottom, JSON.stringify(mobileHubTop));

  // 25.9 新用户入口：选择器排在指标前，图注的「换个地方」真的把焦点送过去
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/?sel=CN-440000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(700);
  const pickerTop = await page.locator('.picker').evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const strategyTop = await page.locator('.strategy').evaluate((el) => Math.round(el.getBoundingClientRect().top));
  check('首屏能看到选地方的入口，且排在指标前面', pickerTop < 900 && pickerTop < strategyTop, `选择器 ${pickerTop}px / 指标 ${strategyTop}px`);

  const focusHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  await page.locator('.stage-caption button', { hasText: '换个地方' }).click();
  await page.waitForTimeout(700);
  const focusedSearch = await page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement && el.classList.contains('search');
  });
  const focusHeadlineAfter = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('图注「换个地方」只是把焦点送到搜索框，不偷偷换地方', focusedSearch && focusHeadline === focusHeadlineAfter, focusHeadlineAfter.slice(0, 50));

  const strategyText = (await page.locator('.result-strategy').innerText()).replace(/\s+/g, ' ');
  check(
    '「当年有记录」与「参与对照」不一致时写明原因',
    /参与对照\s*\d+\s*个/.test(strategyText) && /忽略人口不足 100 万的微型经济体/.test(strategyText),
    strategyText.slice(0, 120)
  );

  const mapClickHint = (await page.locator('.stage-caption p').innerText()).replace(/\s+/g, ' ');
  check('地图图注提示国家可以点', /点地图上的国家/.test(mapClickHint), mapClickHint.slice(0, 100));
  await page.locator('.map-holder svg .countries path[data-id="MNG"]').first().click({ force: true });
  await page.waitForTimeout(700);
  const mapClickToast = (await page.locator('.toast').innerText()).replace(/\s+/g, ' ');
  check('点地图上的国家会说明切换到了哪里', /已切换到蒙古/.test(mapClickToast), mapClickToast);
  await page.goto(`${BASE}/?sel=CN-440000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(700);

  // 25.9.1 换个组合：原版 → 熟脸 A，URL 可复现，列表不再只有小国
  const variantRow = (await page.locator('.result-variant').innerText()).replace(/\s+/g, ' ');
  check('结果卡提供「换个组合」', /换个组合/.test(variantRow) && /原版组合/.test(variantRow), variantRow);
  const originalItemCount = await page.locator('.result-item').count();
  await page.locator('.result-variant button', { hasText: '换个组合' }).click();
  await page.waitForTimeout(900);
  const knownRow = (await page.locator('.result-variant').innerText()).replace(/\s+/g, ' ');
  const knownItems = await page.locator('.result-item').count();
  const knownNames = (await page.locator('.result-item .name').allInnerTexts()).slice(0, 6);
  const knownStrategy = (await page.locator('.result-strategy').innerText()).replace(/\s+/g, ' ');
  const knownCaption = (await page.locator('.stage-caption p').innerText()).replace(/\s+/g, ' ');
  check(
    '换到熟脸组合：3–6 国、URL 带 v、标题/图注跟着换',
    /熟脸组合 A/.test(knownRow) &&
      knownItems >= 3 &&
      knownItems <= 6 &&
      knownItems < originalItemCount &&
      page.url().includes('v=1') &&
      /熟脸组合 A/.test(knownStrategy) &&
      /熟脸组合 A/.test(knownCaption),
    `${knownRow}｜${knownNames.join(' / ')}`
  );
  await page.goto(`${BASE}/?sel=CN-440000&v=1`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(900);
  const reloadedRow = (await page.locator('.result-variant').innerText()).replace(/\s+/g, ' ');
  check('带 v 的链接打开还是同一版', /熟脸组合 A/.test(reloadedRow), reloadedRow);
  const variantBarWidths = await page
    .locator('.result-item .bar-fill')
    .evaluateAll((els) => els.map((el) => parseFloat((el.getAttribute('style') ?? '').replace(/[^\d.]/g, ''))));
  check(
    '换个组合的条形按单项值画',
    variantBarWidths.length >= 2 && variantBarWidths[1] < 50,
    variantBarWidths.join(' / ')
  );
  // 往年 + v 一起分享：历史数据到齐前后年份会被临时夹到默认年，
  // 不能把这个「不是用户换的」年份变动算成换题、把 v 清掉
  await page.goto(`${BASE}/?sel=CN-410000&v=1&y=2010`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(1200);
  const oldYearRow = (await page.locator('.result-variant').innerText()).replace(/\s+/g, ' ');
  const oldYearHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check(
    'v 和往年一起分享时不丢版本',
    /熟脸组合 A/.test(oldYearRow) && /2010/.test(oldYearHeadline) && page.url().includes('v=1'),
    `${oldYearRow}｜${oldYearHeadline}`
  );

  await page.goto(`${BASE}/?mode=world-to-region&sel=JPN`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(600);
  check('世界 → 地方不出现换组合', (await page.locator('.result-variant').count()) === 0);
  await page.goto(`${BASE}/?sel=CN-440000&m=gdpPc`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(600);
  check('人均指标不出现换组合', (await page.locator('.result-variant').count()) === 0);
  await page.goto(`${BASE}/?sel=CN-440000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(700);

  // 25.10 日本府县：默认 2024 年没有数据，不能显示成 0 亿
  await page.locator('.picker .search').fill('岛根');
  await page.waitForTimeout(400);
  const jpItem = (await page.locator('.picker-item').first().innerText()).replace(/\s+/g, ' ');
  const jpNote = (await page.locator('.picker .picker-hint').last().innerText()).replace(/\s+/g, ' ');
  check('缺当年数据的地区显示「—」并点名年份差异', /—/.test(jpItem) && !/0\s*亿/.test(jpItem) && /没有数据/.test(jpNote) && /日本/.test(jpNote), `${jpItem}｜${jpNote.slice(0, 60)}`);
  await page.locator('.picker .link-btn', { hasText: '清空' }).click();
  await page.waitForTimeout(300);
  await page.locator('.picker-item', { hasText: '岛根县' }).first().click();
  await page.waitForTimeout(1000);
  const jpYear = (await page.locator('.year-now').innerText()).trim();
  const jpHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('选中日本府县会自动切到它有数据的年份', jpYear === '2023' && /岛根/.test(jpHeadline), `${jpYear}｜${jpHeadline.slice(0, 60)}`);

  // 25.11 今日一地与每日挑战是同一道题
  await page.goto(`${BASE}/?sel=CN-440000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(700);
  await page.locator('.quick-panel .chip', { hasText: '今日一地' }).click();
  await page.waitForTimeout(900);
  const quickHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  const quickYear = (await page.locator('.year-now').innerText()).trim();
  await page.locator('.segmented button', { hasText: '玩法' }).click();
  await page.waitForSelector('.play-hub', { timeout: 15000 });
  await page.waitForTimeout(500);
  const dailyQuestion = (await page.locator('.play-card.daily h3').innerText()).replace(/\s+/g, ' ');
  const dailySub = (await page.locator('.play-card.daily .play-card-sub').innerText()).replace(/\s+/g, ' ');
  const dailyRegion = dailyQuestion.split('的')[0];
  check('「今日一地」和每日挑战指向同一道题', quickHeadline.startsWith(dailyRegion) && quickYear === dailySub.split(' ')[0], `${quickHeadline.slice(0, 40)}｜${dailyQuestion}｜${dailySub}`);

  // 25.12 普通拼图结束 → 回到开玩前的地方；每日挑战返回玩法也不覆盖原对照
  await page.goto(`${BASE}/?sel=CN-410000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(800);
  const beforePuzzle = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  await page.locator('.quick-panel .chip', { hasText: '玩一局' }).click();
  await page.waitForSelector('.puzzle', { timeout: 10000 });
  await page.locator('.puzzle .chip', { hasText: '换一题' }).click();
  await page.waitForTimeout(700);
  await page.locator('.puzzle .chip', { hasText: '结束' }).click();
  await page.waitForTimeout(900);
  const afterPuzzle = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('普通拼图「结束」回到开玩前的地方，而不是停在随机题上', afterPuzzle === beforePuzzle && page.url().includes('sel=CN-410000'), `${afterPuzzle.slice(0, 50)}`);

  await page.locator('.segmented button', { hasText: '玩法' }).click();
  await page.waitForSelector('.play-hub', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page
    .locator('.play-card.daily .play-actions button')
    .filter({ hasText: /开始今日挑战|再来一次/ })
    .first()
    .click();
  await page.waitForSelector('.puzzle', { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.locator('.puzzle .chip', { hasText: '返回玩法' }).click();
  await page.waitForSelector('.play-hub', { timeout: 10000 });
  await page.waitForTimeout(300);
  await page.locator('.segmented button', { hasText: '地图' }).click();
  await page.waitForTimeout(900);
  const afterDaily = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check('每日挑战返回后不覆盖开玩前的对照', afterDaily === beforePuzzle, `${afterDaily.slice(0, 50)}`);

  // 25.13 手机上「换个地方」不能把搜索框滚到吸顶栏底下
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/?sel=CN-440000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(700);
  await page.locator('.stage-caption button', { hasText: '换个地方' }).click();
  await page.waitForTimeout(900);
  const mobileFocus = await page.evaluate(() => {
    const header = document.querySelector('.topbar')?.getBoundingClientRect();
    const search = document.querySelector('.picker .search')?.getBoundingClientRect();
    return {
      headerBottom: header ? Math.round(header.bottom) : 0,
      searchTop: search ? Math.round(search.top) : 0,
      searchBottom: search ? Math.round(search.bottom) : 0,
      vh: innerHeight
    };
  });
  check(
    '手机上「换个地方」把搜索框送到吸顶栏下方',
    mobileFocus.searchTop >= mobileFocus.headerBottom && mobileFocus.searchBottom <= mobileFocus.vh,
    JSON.stringify(mobileFocus)
  );

  // 25.14 点菜单外面只收起菜单，不能把这一下穿透给页面（实测会把河南换成巴拉圭）
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/?sel=CN-440000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(700);
  const beforeDismiss = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  await page.locator('.primary-btn', { hasText: '分享' }).click();
  await page.waitForTimeout(250);
  await page.locator('.picker-item', { hasText: '河南省' }).first().click();
  await page.waitForTimeout(500);
  const afterDismiss = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check(
    '关闭分享菜单的那一下不会穿透到页面',
    (await page.locator('.share-menu').count()) === 0 &&
      afterDismiss === beforeDismiss &&
      page.url().includes('sel=CN-440000'),
    `${afterDismiss.slice(0, 40)}｜${page.url().split('?')[1] ?? ''}`
  );
  // 菜单关掉之后，同样的点击要能正常选地方
  await page.locator('.picker-item', { hasText: '河南省' }).first().click();
  await page.waitForTimeout(800);
  check('菜单关掉后选地方恢复正常', /河南/.test((await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ')), (await page.locator('.result-headline h1').innerText()).slice(0, 40));

  check('无运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  // 24. 数据加载失败时不能是白屏：要说人话，还要给一个重试的出口
  // ⚠️ 这条守着的是个白屏级的老毛病：整页提示如果写在 hook 之前，
  // 提前 return 会改变 hook 数量，React 直接把页面渲崩（断网打开就是白屏）。
  // （放在「无运行时错误」之后：这里要故意让请求失败，那条检查不该被它算上。）
  await page.route('**/data/regions.json', (route) => route.abort('failed'));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const fatalText = (await page.locator('.fatal').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const retryButtons = await page.locator('.fatal button').count();
  check(
    '数据加载失败时不是白屏（有提示 + 能重试）',
    /没加载出来/.test(fatalText) && retryButtons > 0,
    fatalText || '（页面是空的）'
  );
  await page.unroute('**/data/regions.json');

  // 24.1 历史文件失败：年份控件保持禁用，结论仍在，不能假装能拨
  await page.route('**/data/regions-history.json', (route) => route.abort('failed'));
  await page.goto(`${BASE}/?sel=CN-410000&y=2010`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  await page.waitForTimeout(800);
  const historyErrorText = (await page.locator('.year-panel .picker-hint').first().innerText()).replace(/\s+/g, ' ');
  const historyDisabled = await page.locator('.year-slider').isDisabled();
  const historyYear = await page.locator('.year-now').innerText();
  const historyHeadline = (await page.locator('.result-headline h1').innerText()).replace(/\s+/g, ' ');
  check(
    '历史数据失败时年份控件保持禁用',
    historyDisabled && /历史数据加载失败/.test(historyErrorText) && /≈/.test(historyHeadline),
    `disabled=${historyDisabled}｜${historyErrorText}｜${historyYear} ${historyHeadline.slice(0, 50)}`
  );
  check(
    '历史失败时 URL 保留请求年份',
    page.url().includes('y=2010'),
    page.url().split('?')[1] ?? ''
  );
  await page.unroute('**/data/regions-history.json');
} catch (e) {
  check('验收脚本执行', false, String(e).slice(0, 200));
} finally {
  await browser.close();
  await stopServer();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过；截图与导出文件在 ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
