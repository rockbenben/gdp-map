/**
 * 重新生成 README / 文档用的预览图。
 *
 * 为什么要有这个脚本：文档里的截图是产品的一部分，界面一改就会跟实际对不上。
 * 之前这些图是一次性脚本 + 手工拷进 docs/ 的，结果 README 挂的那张主图
 * 停留在改版前的布局（侧栏顺序、按钮文案都还是老的）——所以这里把拍摄固化成
 * 一条可复现的命令：`npm run screenshots`。
 *
 * 用法：
 *   npm run screenshots              # 自动起服务器伺服 dist/（推荐）
 *   node scripts/screenshots.mjs http://localhost:5173   # 对着已经跑着的站点拍
 *
 * 产物：docs/preview-*.png
 */
import { chromium } from 'playwright';
import { mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './static-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const DOCS = resolve(ROOT, 'docs');
await mkdir(DOCS, { recursive: true });

const given = process.argv[2];
let base = given;
let stop = async () => {};
if (!base) {
  const server = await startServer(DIST);
  base = server.origin;
  stop = () => server.close();
  console.log(`· 站点：${base}（伺服 dist/）`);
}

const browser = await chromium.launch();
const written = [];

async function shot(
  name,
  url,
  { width = 1440, height = 900, selector = null, mobile = false, before = null } = {}
) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile
  });
  await page.goto(`${base}${url}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(900);
  if (before) await before(page);
  const path = resolve(DOCS, `preview-${name}.png`);
  if (selector) {
    const el = page.locator(selector).first();
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await el.screenshot({ path });
  } else {
    await page.screenshot({ path, fullPage: false });
  }
  await page.close();
  const kb = Math.round((await stat(path)).size / 1024);
  written.push([`preview-${name}.png`, kb]);
  console.log(`  ✓ preview-${name}.png (${kb} KB)`);
}

// 1. 新用户首屏：默认就是广东省 + 结论
await shot('first-screen', '/?sel=CN-440000');
// 2. 2D 世界地图（河南省）：省/州细分层 + 南海诸岛小图都在这张里
await shot('map', '/?sel=CN-410000');
// 3. 3D 地球
await shot('globe', '/?sel=CN-410000&view=globe', { height: 1000 });
// 4. 方形图
await shot('square', '/?sel=CN-410000&view=square');
// 5. 擂台：两个目标逐项 PK + 对阵树
await shot('bracket', '/?sel=CN-410000,CN-440000&view=bracket', { height: 1000 });
// 6. 拼图玩法：要点「玩一局」才进拼图模式，面板是 .puzzle
//    空面板说明不了玩法，所以先在地图上点两个国家，让「已选 2/3 · 合计」有内容
await shot('puzzle', '/?sel=CN-410000', {
  selector: '.puzzle',
  before: async (page) => {
    await page.locator('.chip', { hasText: '玩一局' }).click();
    await page.waitForSelector('.puzzle', { timeout: 10000 });
    for (const id of ['KOR', 'PER']) {
      await page.locator(`.map-holder svg .countries path[data-id="${id}"]`).click({ force: true });
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(300);
  }
});
// 7. 面积剪影对照（同一比例尺）
await shot('area', '/?sel=CN-410000&m=area&st=nearest', { selector: '.result' });
// 8. 反事实排名卡
await shot('counterfactual', '/?sel=CN-410000', { selector: '.counterfactual' });
// 9. 反向模式：国家 → 省/州
await shot('world-to-region', '/?mode=world-to-region&sel=JPN', { height: 1000 });
// 10. 排行榜
await shot('rank', '/?sel=CN-410000&view=rank', { height: 1000 });
// 11. 手机上的首屏
await shot('mobile', '/?sel=CN-410000', { width: 390, height: 844, mobile: true });

/**
 * 等比缩小一张 PNG。
 *
 * 分享卡原图 2400px 宽、3.7 MB，但 README 里只按 420px 宽显示——放原图进仓库
 * 纯属浪费。这里用浏览器自带的 canvas 降采样（不引新依赖），1200px 宽在页面上
 * 看不出差别，文件小一大半。
 */
async function downscalePng(path, factor = 2) {
  const dataUrl = `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
  const page = await browser.newPage();
  const out = await page.evaluate(
    async ({ dataUrl, factor }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = Math.round(img.width / factor);
      c.height = Math.round(img.height / factor);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    },
    { dataUrl, factor }
  );
  await page.close();
  await writeFile(path, Buffer.from(out.split(',')[1], 'base64'));
}

// 11. 分享卡：走真实的导出流程，存的就是用户下载到的那张
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await page.goto(`${base}/?sel=CN-410000`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.result-headline h1', { timeout: 20000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page
      .locator('.primary-btn', { hasText: '分享' })
      .click()
      .then(() => page.locator('.share-menu button', { hasText: '下载分享卡' }).click())
  ]);
  const path = resolve(DOCS, 'preview-share-card.png');
  await download.saveAs(path);
  await page.close();
  await downscalePng(path, 2);
  const kb = Math.round((await stat(path)).size / 1024);
  written.push(['preview-share-card.png', kb]);
  console.log(`  ✓ preview-share-card.png (${kb} KB，已缩到 1200px 宽)`);
}

await browser.close();
await stop();

const total = written.reduce((s, [, kb]) => s + kb, 0);
console.log(`\n共 ${written.length} 张，合计 ${Math.round(total / 1024)} MB，写在 ${DOCS}`);
