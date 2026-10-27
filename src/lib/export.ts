/** 把当前视图导出成一张可分享的 PNG（图 + 标题 + 来源） */

/**
 * 导出用的配色：跟 `styles.css` 里的同名 CSS 变量一一对应。
 *
 * ⚠️ 以前这里是各写各的字面量（#6b7896 / #7f8bab），
 * 页面把次要文字换成过 AA 的 `--text-mute`（#7d8bab）之后，导出的分享卡还留在旧色——
 * 那是要发出去的图，小字同样得看得清。别再写新的字面量，改这里和 CSS 变量一起改。
 */
const C = {
  /** --text */
  text: '#e9eefc',
  /** --text-dim */
  textDim: '#8f9cbb',
  /** --text-mute（卡片底色上 5.08:1，过 AA） */
  textMute: '#7d8bab'
};

const SVG_STYLE = `
  .map-label { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif; font-size: 13px; font-weight: 600; text-anchor: middle; paint-order: stroke; stroke: rgba(4,8,18,0.85); stroke-width: 3px; stroke-linejoin: round; }
  .sea-label { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 11px; fill: ${C.textMute}; text-anchor: middle; }
  .sq-label { font-size: 12px; font-weight: 600; text-anchor: middle; }
  .bracket-label { font-size: 12px; font-weight: 600; paint-order: stroke; stroke: rgba(8,12,22,0.85); stroke-width: 3px; stroke-linejoin: round; }
  .bracket-caption { font-size: 11.5px; fill: ${C.textMute}; }
  .country { transition: none; }
`;

/** 触发浏览器下载一个 blob。PNG、分享卡、GIF 三处都用它。 */
export function downloadBlob(blob: Blob, fileName: string, revokeAfter = 1000): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), revokeAfter);
}

export interface ExportOptions {
  svg?: SVGSVGElement | null;
  canvas?: HTMLCanvasElement | null;
  title: string;
  /** 主结论，例如「52 个国家之和」——图上最该一眼看到的那一句 */
  headline?: string;
  /** 人话图注，例如「这 52 个国家加起来，也就抵得上一个河南省」 */
  caption?: string;
  /** 元信息，例如「名义 GDP（现价美元）· 数据年份 2024」 */
  subtitle?: string;
  footnote?: string;
  fileName: string;
  background?: string;
  /** 导出倍率，2 = 2400px 宽，3 = 3600px 宽 */
  scale?: number;
}

export async function svgToImage(svg: SVGSVGElement, width: number, height: number): Promise<HTMLImageElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  // 滤镜（高斯模糊）在栅格化时非常慢，导出前统一摘掉
  clone.querySelectorAll('[filter]').forEach((el) => el.removeAttribute('filter'));

  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = SVG_STYLE;
  clone.insertBefore(style, clone.firstChild);

  const text = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SVG 转图片超时')), 20000);
      img.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error('SVG 转图片失败'));
      };
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  color: string
): void {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, font: string): string[] {
  ctx.save();
  ctx.font = font;
  const lines: string[] = [];
  let line = '';
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(line);
      line = '';
      continue;
    }
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  ctx.restore();
  return lines;
}

/** 单行放不下就截断加省略号（导出图上的长句不能让它跑出画面） */
export function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, font: string): string {
  ctx.save();
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.restore();
    return text;
  }
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  ctx.restore();
  return `${out}…`;
}

/** 字体栈：页面与导出用同一套，避免导出的字和屏幕上长得不一样 */
const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';
const f = (weight: number, size: number) => `${weight} ${size}px ${FONT_STACK}`;

/** 从 font 串里取字号（`700 58px "PingFang SC"` → 58） */
export function fontSize(font: string): number {
  const m = font.match(/(\d+(?:\.\d+)?)px/);
  return m ? Number(m[1]) : 14;
}

/** 强调色：与页面 `--accent` 一致 */
const ACCENT = '#f6c453';

/**
 * 结论那一行用多大的字。
 *
 * ⚠️ **尽量大，但一行要放得下**：结论长的口径不少（「≈ 巴西的 41%」
 * 「比这 20 个国家加起来还大 1.4 倍」），固定 58px 会折成两行、
 * 吃掉半张卡。放不下就退一档，别硬撑。
 */
function pickHeadlineFont(
  measure: CanvasRenderingContext2D,
  text: string | undefined,
  maxWidth: number,
  sizes: number[] = [58, 46, 36, 28]
): string {
  if (!text) return f(700, sizes[0]);
  for (const size of sizes) {
    const font = f(700, size);
    if (wrapText(measure, text, maxWidth, font).length === 1) return font;
  }
  return f(700, sizes[sizes.length - 1]);
}

export async function exportPng(opts: ExportOptions): Promise<void> {
  const { svg, canvas: sourceCanvas, title, headline, caption, subtitle, footnote, fileName } = opts;
  const background = opts.background ?? '#080c16';

  const scale = opts.scale ?? 2;
  const W = 1200;
  const pad = 32;

  let content: HTMLImageElement | HTMLCanvasElement | null = null;
  let contentWidth = 0;
  let contentHeight = 0;

  if (svg) {
    const vb = svg.viewBox.baseVal;
    const ratio = vb && vb.height ? vb.width / vb.height : 2;
    contentWidth = W;
    contentHeight = Math.round(contentWidth / ratio);
    content = await svgToImage(svg, contentWidth, contentHeight);
  } else if (sourceCanvas) {
    contentWidth = sourceCanvas.width;
    contentHeight = sourceCanvas.height;
    content = sourceCanvas;
  }

  if (!content) throw new Error('没有可导出的视图');

  // ⚠️ **先量文字再排版**：版面高度是算出来的，不是写死的。
  // 写死的话，标题长一点（省名长、指标名长）就压到地图上，或者下面留一大片空。
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('无法创建画布');
  const maxText = contentWidth - pad * 2;
  const F_TITLE = f(700, 42);
  const F_CAPTION = f(400, 20);
  const F_SUBTITLE = f(400, 20);
  const F_FOOTNOTE = f(400, 16);

  // 横版的结论字比竖版小一号：横版的头部要薄，地图才是主角
  const headlineFont = pickHeadlineFont(measure, headline, maxText, [34, 28, 24]);
  const headlineLineH = fontSize(headlineFont) + 10;
  const footnoteLines = footnote ? wrapText(measure, footnote, maxText, F_FOOTNOTE) : [];

  // 版面：标题 → 结论 → 图注 → 元信息
  const blocks = [
    makeBlock(measure, title, F_TITLE, C.text, 50, 0, maxText),
    makeBlock(measure, headline, headlineFont, ACCENT, headlineLineH, 10, maxText, true),
    makeBlock(measure, caption, F_CAPTION, C.textDim, 27, 8, maxText),
    makeBlock(measure, subtitle, F_SUBTITLE, C.textDim, 27, 8, maxText)
  ].filter((b): b is TextBlock => Boolean(b));

  const headerH = pad + blocksHeight(blocks) + 26;
  const footerH = footnoteLines.length ? 30 + footnoteLines.length * 23 : 0;

  const out = document.createElement('canvas');
  out.width = contentWidth * scale;
  out.height = (headerH + contentHeight + footerH) * scale;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');

  ctx.scale(scale, scale);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, contentWidth, headerH + contentHeight + footerH);

  // 标题区：标题 → 结论 → 图注 → 元信息，四层各说各的
  const accentBaseline = drawBlocks(ctx, blocks, pad, pad);
  if (accentBaseline) {
    ctx.fillStyle = ACCENT;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(pad, accentBaseline + 10, 44, 3);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = 'rgba(120,150,220,0.25)';
  ctx.beginPath();
  ctx.moveTo(pad, headerH - 14);
  ctx.lineTo(contentWidth - pad, headerH - 14);
  ctx.stroke();

  // 主体
  ctx.drawImage(content as CanvasImageSource, 0, headerH, contentWidth, contentHeight);

  // 页脚
  footnoteLines.forEach((line, i) => {
    drawText(ctx, line, pad, headerH + contentHeight + 34 + i * 23, F_FOOTNOTE, C.textMute);
  });

  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('导出 PNG 失败');
  downloadBlob(blob, fileName);
}

/** 版面块：一段文字（可能折成多行）+ 字号 + 颜色 + 行高 */
interface TextBlock {
  lines: string[];
  font: string;
  color: string;
  /** 行高（含行间距） */
  lh: number;
  /** 与上一块的间距 */
  gap: number;
  /** 是不是结论块（要在下面画一段强调线） */
  accent?: boolean;
}

/**
 * 排版：**先算每块占多高，再决定画布多高**，然后按同一套块往下画。
 *
 * ⚠️ 以前是「边画边推 y」，高度另算一份——两处一改就错位：
 * 分隔线会穿过图注、右侧那列名次会被切掉。
 * 现在只有一处算法：块的顺序 → 高度 → 画布 → 画。
 */
function makeBlock(
  measure: CanvasRenderingContext2D,
  text: string | undefined,
  font: string,
  color: string,
  lh: number,
  gap: number,
  maxWidth: number,
  accent = false
): TextBlock | null {
  if (!text) return null;
  return { lines: wrapText(measure, text, maxWidth, font), font, color, lh, gap, accent };
}

function blocksHeight(blocks: TextBlock[]): number {
  return blocks.reduce((n, b) => n + b.gap + b.lines.length * b.lh, 0);
}

/** 画一排块，返回最后一块结论的基线（用来挂强调线） */
function drawBlocks(ctx: CanvasRenderingContext2D, blocks: TextBlock[], x: number, top: number): number {
  let y = top;
  let lastAccentBaseline = 0;
  for (const b of blocks) {
    y += b.gap;
    for (const line of b.lines) {
      y += b.lh;
      // 基线抬到行底往上一点：中文的行盒下面要留降部空间
      const baseline = y - b.lh * 0.22;
      drawText(ctx, line, x, baseline, b.font, b.color);
      if (b.accent) lastAccentBaseline = baseline;
    }
  }
  return lastAccentBaseline;
}

/** 量一段文字有多宽（量之前要先把字体设对，否则量的是默认 10px） */
function measureWidth(ctx: CanvasRenderingContext2D, text: string, font: string): number {
  ctx.save();
  ctx.font = font;
  const w = ctx.measureText(text).width;
  ctx.restore();
  return w;
}

export interface ShareCardOptions {
  svg: SVGSVGElement;
  /** 主标题，例如「假如 河南省 是一个国家」 */
  title: string;
  /** 主结论，例如「52 个国家之和」——卡上最该一眼看到的那一句 */
  headline?: string;
  /** 人话图注，例如「这 52 个国家加起来，也就抵得上一个河南省」 */
  caption?: string;
  /** 事实行，例如「总 GDP 8,835 亿美元 · 世界第 22 位」 */
  facts: Array<{ label: string; value: string; note?: string }>;
  footnote?: string;
  fileName: string;
  scale?: number;
}

/**
 * 竖版分享卡：标题 + 结论 + 关键数字 + 地图 + 出处。
 * 比例接近 3:4，适合发朋友圈 / 微博 / 群。
 *
 * ⚠️ **层次是这件产品的命门**：分享出去的人只看一眼，
 * 结论（「52 个国家之和」）必须自己跳出来，不能埋在一句长图注里。
 * 所以版面从上到下是：标题（是谁）→ 结论（等于多少）→ 人话图注（什么意思）
 * → 四行事实 → 地图 → 出处。
 */
export async function exportShareCard(opts: ShareCardOptions): Promise<void> {
  const scale = opts.scale ?? 2;
  const W = 1200;
  const pad = 56;

  const F_TITLE = f(700, 44);
  const F_CAPTION = f(400, 23);
  const F_FACT_LABEL = f(400, 24);
  const F_FACT_VALUE = f(700, 27);
  const F_FACT_NOTE = f(400, 23);
  const F_FOOTNOTE = f(400, 19);

  const vb = opts.svg.viewBox.baseVal;
  const mapW = W - pad * 2;
  const mapH = Math.round(mapW * ((vb.height || 520) / (vb.width || 1000)));

  // ⚠️ 先量文字：高度是算出来的，写死就会在长标题上压行、短标题上留空
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('无法创建画布');
  const maxText = W - pad * 2;
  const headlineFont = pickHeadlineFont(measure, opts.headline, maxText);
  const headlineLineH = fontSize(headlineFont) + 12;

  // 版面：标题 → 结论 → 图注
  const blocks = [
    makeBlock(measure, opts.title, F_TITLE, C.text, 54, 0, maxText),
    makeBlock(measure, opts.headline, headlineFont, ACCENT, headlineLineH, 8, maxText, true),
    makeBlock(measure, opts.caption, F_CAPTION, C.textDim, 31, 10, maxText)
  ].filter((b): b is TextBlock => Boolean(b));

  const footnoteLines = opts.footnote ? wrapText(measure, opts.footnote, maxText, F_FOOTNOTE) : [];
  const factsH = opts.facts.length * 62;
  const footerH = footnoteLines.length ? 56 + footnoteLines.length * 26 : 24;
  const headerH = pad + blocksHeight(blocks) + 26;
  const H = headerH + factsH + mapH + footerH;

  const img = await svgToImage(opts.svg, mapW, mapH);

  const out = document.createElement('canvas');
  out.width = W * scale;
  out.height = H * scale;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.scale(scale, scale);

  // 背景
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0b1224');
  bg.addColorStop(0.5, '#080c16');
  bg.addColorStop(1, '#0a1020');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 标题 → 结论 → 图注
  const accentBaseline = drawBlocks(ctx, blocks, pad, pad);
  if (accentBaseline) {
    // 结论下面一小段强调线：让结论在缩略图里也立得住
    ctx.fillStyle = ACCENT;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(pad, accentBaseline + 14, 56, 4);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = 'rgba(120,150,220,0.22)';
  ctx.beginPath();
  ctx.moveTo(pad, headerH - 16);
  ctx.lineTo(W - pad, headerH - 16);
  ctx.stroke();

  // 事实行
  opts.facts.forEach((f, i) => {
    const fy = headerH + 26 + i * 62;
    drawText(ctx, f.label, pad, fy, F_FACT_LABEL, C.textDim);
    drawText(ctx, f.value, pad + 150, fy, F_FACT_VALUE, C.text);
    if (f.note) {
      const note = ellipsize(ctx, f.note, 360, F_FACT_NOTE);
      drawText(ctx, note, W - pad - measureWidth(ctx, note, F_FACT_NOTE), fy, F_FACT_NOTE, C.textMute);
    }
  });

  // 地图
  ctx.drawImage(img, pad, headerH + factsH - 10, mapW, mapH);

  // 页脚
  footnoteLines.forEach((line, i) => {
    drawText(ctx, line, pad, H - 40 + i * 26, F_FOOTNOTE, C.textMute);
  });

  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('导出分享卡失败');
  downloadBlob(blob, opts.fileName);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
