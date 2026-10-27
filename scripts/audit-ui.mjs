/**
 * UI 审计：把每个分辨率 × 每个视图都过一遍，量出真问题。
 *
 * 验收脚本守的是「功能对不对」，这个守的是「长什么样」：
 *   - 横向溢出（元素超出视口右缘、文档比视口宽）
 *   - 文字裁切（内容宽于/高于容器且被 overflow 藏掉）
 *   - 过小的可点区域（触摸设备上 < 32px 按不准）
 *   - 文字与元素重叠
 *   - 全量可见文字（拿来审文案）
 *   - 截图（给人眼看）
 *
 * 用法：npm run build && npm run audit:ui
 * 产物：tmp/audit/{report.json,texts.json,*.png}
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './static-server.mjs';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'tmp/audit');

const VIEWPORTS = [
  { name: 'desktop-1920', width: 1920, height: 1080 },
  { name: 'laptop-1440', width: 1440, height: 900 },
  { name: 'laptop-1280', width: 1280, height: 800 },
  { name: 'small-1024', width: 1024, height: 768 },
  { name: 'tablet-834', width: 834, height: 1112 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'phone-430', width: 430, height: 932 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'phone-360', width: 360, height: 760 }
];

/** 场景：URL + 打开后要点的操作 */
const SCENARIOS = [
  { name: 'map', url: '/?sel=CN-410000' },
  // 旧链接的 1800 会被夹到目标有数据的最早年份；这个场景守的是夹取后的布局
  { name: 'map-old-url', url: '/?sel=CN-410000&y=1800' },
  { name: 'globe', url: '/?sel=CN-410000&view=globe' },
  { name: 'square', url: '/?sel=CN-410000&view=square' },
  { name: 'bracket', url: '/?sel=CN-410000,CN-440000&view=bracket' },
  { name: 'rank', url: '/?sel=CN-440000&view=rank' },
  { name: 'world-to-region', url: '/?mode=world-to-region&sel=USA' },
  { name: 'puzzle', url: '/?sel=CN-410000', click: '.chip:has-text("玩一局")' },
  { name: 'share', url: '/?sel=CN-410000', click: '.primary-btn:has-text("分享")' },
  { name: 'metric-choices', url: '/?sel=CN-410000', click: '.metric-options button:has-text("人均 GDP")' },
  { name: 'compare-two', url: '/?sel=CN-410000,CN-440000' },
  { name: 'play', url: '/?view=play' },
  { name: 'play-daily', url: '/?view=play', click: '.play-card.daily .primary-btn' },
  { name: 'play-higher', url: '/?view=play', click: '.play-card:has-text("Higher / Lower") .primary-btn' },
  { name: 'play-blind', url: '/?view=play', click: '.play-card:has-text("盲猜轮廓") .primary-btn' },
  { name: 'play-passport', url: '/?view=play', click: '.play-card.passport-card .primary-btn' }
];

const AUDIT = () => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const path = (el) => {
    const bits = [];
    let n = el;
    while (n && n.nodeType === 1 && bits.length < 4) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += `#${n.id}`;
      const cls = (n.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) s += `.${cls.join('.')}`;
      bits.unshift(s);
      n = n.parentElement;
    }
    return bits.join(' > ');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      cs.visibility !== 'hidden' &&
      cs.display !== 'none' &&
      Number(cs.opacity) > 0.05
    );
  };
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  const all = [...document.querySelectorAll('.app *')].filter(visible);

  /**
   * 这个元素是不是住在**可以横向滚动**的容器里。
   *
   * ⚠️ 这种元素超出视口是**设计如此**，不是缺陷：
   * 对阵树在窄屏上给了 `min-width`（压小就看不清字了），容器自己能横向滚。
   * 以前审计把树里的每个 path / text 都算成「横向溢出」，
   * 67 个越界里有 66 个是它——数字一虚，真正的问题就被淹了。
   */
  const inScroller = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return true;
      p = p.parentElement;
    }
    return false;
  };

  // 1. 横向溢出：超出视口右缘或左缘（只报最外层）
  const rawOffenders = [];
  for (const el of all) {
    if (inScroller(el)) continue; // 能滚到的位置不算越界
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      rawOffenders.push({
        sel: path(el),
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        text: text(el).slice(0, 48)
      });
    }
  }
  const offenders = rawOffenders.filter((o) => {
    // 父元素也越界的话，这个不算最外层
    return !rawOffenders.some((p) => p !== o && p.sel.includes(o.sel) && o.sel.length < p.sel.length);
  });

  /**
   * 需要横向滚动的容器（单独一类，别混进越界里）。
   *
   * 它不是 bug，但它是**取舍**：窄屏上这块内容得滑着看。
   * 记一笔，是为了改布局时知道这里是有意为之的。
   */
  const scrollers = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    scrollers.push({
      sel: path(el),
      scroll: el.scrollWidth,
      client: el.clientWidth,
      text: text(el).slice(0, 48)
    });
  }

  // 2. 文字被裁切
  const clipped = [];
  for (const el of all) {
    if (el.children.length) continue;
    const cs = getComputedStyle(el);
    const hiddenY = cs.overflowY === 'hidden' || cs.overflow === 'hidden';
    const hiddenX = cs.overflowX === 'hidden' || cs.overflow === 'hidden';
    // ⚠️ **省略号截断不是裁切**：长名字（欧洲一级区那种十几个字的）本来就该
    // 截断，而且配了 title 提示，鼠标停上去能看到全名。
    // 把它算成「裁切」，等于让真问题（护照格子里那个被切断的名字）淹没在噪声里。
    const deliberate = cs.textOverflow === 'ellipsis';
    if (hiddenY && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) {
      clipped.push({ sel: path(el), kind: 'y', scroll: el.scrollHeight, client: el.clientHeight, text: text(el).slice(0, 48) });
    } else if (hiddenX && !deliberate && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      clipped.push({ sel: path(el), kind: 'x', scroll: el.scrollWidth, client: el.clientWidth, text: text(el).slice(0, 48) });
    }
  }

  // 3. 过小的可点区域
  // ⚠️ **只在触摸尺寸的屏上量**：32px 这条规矩是给手指按不准的手机用的，
  // 在 1920 宽的桌面屏上把 30px 高的分段按钮也报一遍，噪声比信号大得多。
  const small = [];
  if (vw <= 1080) {
    for (const el of document.querySelectorAll('button, a[href], input, select, [role="tab"]')) {
      if (!visible(el)) continue;
      // ⚠️ **开关类的 input 套在 label 里**，真正能点的是整个 label；
      // 量 input 自己（18px 高的小药丸）会把「其实点得到」的东西报成不可点。
      const target = el.tagName === 'INPUT' ? el.closest('label') ?? el : el;
      const r = target.getBoundingClientRect();
      if (r.height < 32 || r.width < 32) {
        small.push({ sel: path(el), w: Math.round(r.width), h: Math.round(r.height), text: text(el).slice(0, 32) });
      }
    }
  }

  // 4. 文字被裁掉的元素（宽高都不够放文字）
  const tooTight = [];
  for (const el of all) {
    if (el.children.length) continue;
    if (!text(el)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    if (r.height + 1 < lineH * 1.05 && cs.overflow !== 'visible') {
      tooTight.push({ sel: path(el), h: Math.round(r.height), lineH: Math.round(lineH), text: text(el).slice(0, 48) });
    }
  }

  // 5. 元素重叠（同级、矩形相交面积占比大）
  // ⚠️ **三种重叠是设计如此，不算问题**：
  //   ① SVG 里的图层（底图 / 国界 / 细分层 / 小图）本来就是一层压一层画上去的；
  //   ② 吸顶或固定的元素（顶栏、浮层）本来就浮在内容上面；
  //   ③ 同一行里的行内文字（标题里的「≈」和数字）挨着，矩形会贴到一起。
  // 以前这三种占了 1066 条里的绝大多数，真问题反而看不见。
  const overlaps = [];
  const groups = new Map();
  for (const el of all) {
    if (!el.parentElement) continue;
    const key = el.parentElement;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(el);
  }
  const inSvg = (el) => Boolean(el.ownerSVGElement) || el.tagName.toLowerCase() === 'svg';
  const floating = (el) => {
    const pos = getComputedStyle(el).position;
    return pos === 'fixed' || pos === 'sticky';
  };
  const inlineish = (el) => getComputedStyle(el).display.startsWith('inline');
  for (const [parent, kids] of groups) {
    if (kids.length < 2 || kids.length > 12) continue;
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        const ea = kids[i];
        const eb = kids[j];
        if (inSvg(ea) || inSvg(eb)) continue;
        if (floating(ea) || floating(eb)) continue;
        if (inlineish(ea) && inlineish(eb)) continue;
        const a = ea.getBoundingClientRect();
        const b = eb.getBoundingClientRect();
        const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const inter = ix * iy;
        if (inter <= 0) continue;
        const minArea = Math.min(a.width * a.height, b.width * b.height);
        if (minArea > 0 && inter / minArea > 0.55) {
          overlaps.push({
            a: path(ea),
            b: path(eb),
            ratio: +(inter / minArea).toFixed(2),
            ta: text(ea).slice(0, 24),
            tb: text(eb).slice(0, 24)
          });
        }
      }
    }
  }

  // 6. 全部可见文字
  const texts = [];
  for (const el of all) {
    if (el.children.length) continue;
    const t = text(el);
    if (t) texts.push({ sel: path(el), text: t });
  }

  return {
    vw,
    vh,
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    offenders,
    scrollers,
    clipped,
    small,
    tooTight,
    overlaps: overlaps.slice(0, 12),
    texts
  };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const server = await startServer(resolve(ROOT, 'dist'), 0);
  const browser = await chromium.launch();
  const report = [];

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      isMobile: vp.width < 700,
      hasTouch: vp.width < 700
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    for (const sc of SCENARIOS) {
      errors.length = 0;
      await page.goto(server.origin + sc.url, { waitUntil: 'networkidle' });
      await page.waitForSelector('.app', { timeout: 20000 });
      await page.waitForTimeout(1400);
      if (sc.click) {
        await page.locator(sc.click).first().click().catch(() => {});
        await page.waitForTimeout(900);
      }
      const audit = await page.evaluate(AUDIT);
      audit.viewport = vp.name;
      audit.size = `${vp.width}x${vp.height}`;
      audit.scenario = sc.name;
      audit.errors = [...errors];
      report.push(audit);

      await page.screenshot({ path: resolve(OUT, `${vp.name}__${sc.name}.png`), fullPage: false });
    }
    await ctx.close();
  }

  await browser.close();
  await server.close();

  await writeFile(resolve(OUT, 'report.json'), JSON.stringify(report, null, 1), 'utf8');

  // 汇总
  const issues = report.filter(
    (r) => r.overflowX || r.offenders.length || r.clipped.length || r.small.length || r.tooTight.length || r.overlaps.length || r.errors.length
  );
  console.log(`场景总数 ${report.length}，有问题的 ${issues.length}\n`);
  for (const r of issues) {
    console.log(`── ${r.viewport} (${r.size}) · ${r.scenario}`);
    if (r.overflowX) console.log(`   横向溢出：文档 ${r.docScrollW} > 视口 ${r.docClientW}`);
    for (const o of r.offenders.slice(0, 5)) console.log(`   越界：${o.sel} [${o.left}, ${o.right}] «${o.text}»`);
    for (const s of r.scrollers.slice(0, 2)) console.log(`   需横向滚动（非越界）：${s.sel} ${s.scroll}>${s.client}`);
    for (const c of r.clipped.slice(0, 5)) console.log(`   裁切(${c.kind})：${c.sel} ${c.scroll}>${c.client} «${c.text}»`);
    for (const s of r.small.slice(0, 6)) console.log(`   小目标：${s.sel} ${s.w}x${s.h} «${s.text}»`);
    for (const t of r.tooTight.slice(0, 4)) console.log(`   文字挤扁：${t.sel} h=${t.h} 行高=${t.lineH} «${t.text}»`);
    for (const o of r.overlaps.slice(0, 4)) console.log(`   重叠 ${o.ratio}：${o.ta} ⟷ ${o.tb}`);
    for (const e of r.errors.slice(0, 3)) console.log(`   控制台错误：${e.slice(0, 120)}`);
  }

  // 汇总：先给总数，再列细节——不然上百个场景的输出里真问题会被淹掉
  const sum = (k) => report.reduce((n, r) => n + (r[k]?.length || 0), 0);
  console.log(
    `\n汇总：越界 ${sum('offenders')} · 裁切 ${sum('clipped')} · 小目标（≤1080px） ${sum('small')} · ` +
      `文字挤扁 ${sum('tooTight')} · 重叠 ${sum('overlaps')} · 需横向滚动 ${sum('scrollers')}`
  );

  // 文案汇总（桌面 + 手机两套视图的文字合在一起）
  const seen = new Map();
  for (const r of report) {
    if (!['desktop-1920', 'phone-390'].includes(r.viewport)) continue;
    for (const t of r.texts) {
      if (!seen.has(t.text)) seen.set(t.text, t.sel);
    }
  }  await writeFile(
    resolve(OUT, 'texts.json'),
    JSON.stringify([...seen.entries()].map(([text, sel]) => ({ text, sel })), null, 1),
    'utf8'
  );
  console.log(`\n可见文本 ${seen.size} 条 → tmp/audit/texts.json`);
};

main().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
