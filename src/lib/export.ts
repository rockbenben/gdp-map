/** 把当前视图导出成一张可分享的 PNG（图 + 标题 + 来源） */

const SVG_STYLE = `
  .map-label { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif; font-size: 13px; font-weight: 600; text-anchor: middle; paint-order: stroke; stroke: rgba(4,8,18,0.85); stroke-width: 3px; stroke-linejoin: round; }
  .sea-label { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 11px; fill: #9aa7c7; text-anchor: middle; }
  .sq-label { font-size: 12px; font-weight: 600; text-anchor: middle; }
  .bracket-label { font-size: 12px; font-weight: 600; paint-order: stroke; stroke: rgba(8,12,22,0.85); stroke-width: 3px; stroke-linejoin: round; }
  .bracket-caption { font-size: 11.5px; fill: #6b7896; }
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

export async function exportPng(opts: ExportOptions): Promise<void> {
  const { svg, canvas: sourceCanvas, title, subtitle, footnote, fileName } = opts;
  const background = opts.background ?? '#080c16';

  const scale = opts.scale ?? 2;
  const headerHeight = 132;
  const padding = 28;
  const footnoteFont = '400 15px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

  let content: HTMLImageElement | HTMLCanvasElement | null = null;
  let contentWidth = 0;
  let contentHeight = 0;

  if (svg) {
    const vb = svg.viewBox.baseVal;
    const ratio = vb && vb.height ? vb.width / vb.height : 2;
    contentWidth = 1200;
    contentHeight = Math.round(contentWidth / ratio);
    content = await svgToImage(svg, contentWidth, contentHeight);
  } else if (sourceCanvas) {
    contentWidth = sourceCanvas.width;
    contentHeight = sourceCanvas.height;
    content = sourceCanvas;
  }

  if (!content) throw new Error('没有可导出的视图');

  const out = document.createElement('canvas');
  const ctx0 = out.getContext('2d');
  if (!ctx0) throw new Error('无法创建画布');
  const footnoteLines = footnote ? wrapText(ctx0, footnote, contentWidth - padding * 2, footnoteFont) : [];
  const footerHeight = footnoteLines.length ? 26 + footnoteLines.length * 20 : 0;

  out.width = contentWidth * scale;
  out.height = (headerHeight + contentHeight + footerHeight) * scale;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');

  ctx.scale(scale, scale);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, contentWidth, headerHeight + contentHeight + footerHeight);

  // 标题区
  drawText(ctx, title, padding, 62, '700 40px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif', '#f2f5ff');
  if (subtitle) {
    drawText(ctx, subtitle, padding, 100, '400 21px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif', '#9aa7c7');
  }
  ctx.strokeStyle = 'rgba(120,150,220,0.25)';
  ctx.beginPath();
  ctx.moveTo(padding, headerHeight - 12);
  ctx.lineTo(contentWidth - padding, headerHeight - 12);
  ctx.stroke();

  // 主体
  ctx.drawImage(content as CanvasImageSource, 0, headerHeight, contentWidth, contentHeight);

  // 页脚
  footnoteLines.forEach((line, i) => {
    drawText(ctx, line, padding, headerHeight + contentHeight + 30 + i * 20, footnoteFont, '#7f8bab');
  });

  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('导出 PNG 失败');
  downloadBlob(blob, fileName);
}

export interface ShareCardOptions {
  svg: SVGSVGElement;
  /** 主标题，例如「假如 河南省 是一个国家」 */
  title: string;
  /** 副标题，例如「≈ 52 个国家之和」 */
  subtitle?: string;
  /** 事实行，例如「总 GDP 8,835 亿美元 · 世界第 22 位」 */
  facts: Array<{ label: string; value: string; note?: string }>;
  footnote?: string;
  fileName: string;
  scale?: number;
}

/**
 * 竖版分享卡：标题 + 关键数字 + 地图 + 出处。
 * 比例接近 3:4，适合发朋友圈 / 微博 / 群。
 */
export async function exportShareCard(opts: ShareCardOptions): Promise<void> {
  const scale = opts.scale ?? 2;
  const W = 1200;
  const pad = 56;
  const headerH = 196;
  const factsH = opts.facts.length * 62;
  const footerH = 108;

  const vb = opts.svg.viewBox.baseVal;
  const mapW = W - pad * 2;
  const mapH = Math.round(mapW * ((vb.height || 520) / (vb.width || 1000)));
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

  // 标题
  drawText(ctx, opts.title, pad, 84, '700 44px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif', '#f2f5ff');
  if (opts.subtitle) {
    drawText(ctx, opts.subtitle, pad, 136, '400 26px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif', '#f6c453');
  }
  ctx.strokeStyle = 'rgba(120,150,220,0.22)';
  ctx.beginPath();
  ctx.moveTo(pad, headerH - 28);
  ctx.lineTo(W - pad, headerH - 28);
  ctx.stroke();

  // 事实行
  opts.facts.forEach((f, i) => {
    const y = headerH + 18 + i * 62;
    drawText(ctx, f.label, pad, y, '400 24px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif', '#8f9cbb');
    drawText(ctx, f.value, pad + 150, y, '700 26px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif', '#e9eefc');
    if (f.note) {
      drawText(ctx, f.note, W - pad - 210, y, '400 24px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif', '#6b7896');
    }
  });

  // 地图
  ctx.drawImage(img, pad, headerH + factsH - 10, mapW, mapH);

  // 页脚
  if (opts.footnote) {
    drawText(
      ctx,
      opts.footnote,
      pad,
      H - 46,
      '400 19px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      '#6b7896'
    );
  }

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
