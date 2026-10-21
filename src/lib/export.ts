/** 把当前视图导出成一张可分享的 PNG（图 + 标题 + 来源） */

const SVG_STYLE = `
  .map-label { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif; font-size: 13px; font-weight: 600; text-anchor: middle; paint-order: stroke; stroke: rgba(4,8,18,0.85); stroke-width: 3px; stroke-linejoin: round; }
  .sea-label { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 11px; fill: #9aa7c7; text-anchor: middle; }
  .country { transition: none; }
`;

export interface ExportOptions {
  svg?: SVGSVGElement | null;
  canvas?: HTMLCanvasElement | null;
  title: string;
  subtitle?: string;
  footnote?: string;
  fileName: string;
  background?: string;
}

async function svgToImage(svg: SVGSVGElement, width: number, height: number): Promise<HTMLImageElement> {
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

  const scale = 2;
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
