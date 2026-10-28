/**
 * 把一串画面导成 GIF。
 *
 * 用途：年份回溯那一段「一个省怎么在世界上掉队」本来只能自己拖滑块看，
 * 导成动图就能直接发出去——这是这个工具最容易被转发的一种形态。
 *
 * 用 gifenc：纯 JS、5 KB、无依赖，浏览器里跑。
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { downloadBlob, ellipsize, fontSize, svgToImage } from './export';

export interface GifFrame {
  /** 这一帧要画的图（世界地图的 SVG） */
  svg: SVGSVGElement;
  /** 标题，例如「河南省 · 1990 年」 */
  title: string;
  /** 副标题，例如「河南省 ≈ 75 个国家之和」 */
  subtitle?: string;
  /** 数据来源，例如「数据：IMF WEO、世界银行、BEA」 */
  footnote?: string;
}

export interface GifOptions {
  /** 总帧数 */
  frameCount: number;
  /**
   * 逐帧取图。**由调用方负责让界面切到对应的状态**——
   * 比如年份。这里返回的 SVG 必须已经是那一帧的样子。
   */
  frameAt: (index: number) => Promise<GifFrame>;
  /** 每帧的宽度（像素） */
  width?: number;
  /** 每帧停留多久（毫秒） */
  delay?: number;
  fileName: string;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 动图取哪些年份：约 32 帧，首尾都要在，且每一帧都来自传入的清单。
 *
 * ⚠️ 「约」是有讲究的：采样步长算不准时，末年不在步长上会**再补一帧**，
 *    所以年份数是 64 这样的数时可能出 33 帧。
 * ⚠️ 调用方要传「目标有数据的年份」（selectableYears），不能传国家侧的
 *    全量年份：那会把目标还没有数据的年份也导成空帧。
 */
export function gifFrameYears(years: number[], maxFrames = 32): number[] {
  if (!years.length) return [];
  if (years.length <= maxFrames) return [...years];
  const step = Math.ceil(years.length / maxFrames);
  const out: number[] = [];
  for (let i = 0; i < years.length; i += step) out.push(years[i]);
  if (out[out.length - 1] !== years[years.length - 1]) out.push(years[years.length - 1]);
  return out;
}

const BG = '#080c16';
const TITLE_FONT = '600 20px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';
const SUB_FONT = '400 15px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const FOOT_FONT = '400 12px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

export async function exportGif(opts: GifOptions): Promise<void> {
  // ⚠️ 720 而不是 600：动图发出去多半会被聊天软件压到一半宽，
  // 600 再压一次字就糊了。720 是个「压完还看得清」的起点。
  const width = opts.width ?? 720;
  const delay = opts.delay ?? 550;
  const gif = GIFEncoder();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建画布');

  for (let i = 0; i < opts.frameCount; i += 1) {
    const frame = await opts.frameAt(i);
    const ratio = frame.svg.viewBox.baseVal.height
      ? frame.svg.viewBox.baseVal.width / frame.svg.viewBox.baseVal.height
      : 1000 / 520;
    const w = Math.round(width / 2) * 2; // GIF 宽度取偶数，省得解码器挑刺
    const h = Math.round(w / ratio / 2) * 2;
    canvas.width = w;
    canvas.height = h;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    const img = await svgToImage(frame.svg, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    /**
     * 文字压在图上，得有底衬。
     *
     * ⚠️ 高亮的国家是亮橙/亮青，浅色字压在上面会糊成一片——
     * 之前没有底衬，帧里的标题时而清楚时而看不清。
     */
    const plate = (text: string, font: string, color: string, x: number, y: number) => {
      ctx.font = font;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(8, 12, 22, 0.74)';
      ctx.beginPath();
      ctx.roundRect(x - 8, y - 15, tw + 16, fontSize(font) + 12, 5);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    };

    ctx.textBaseline = 'top';
    plate(frame.title, TITLE_FONT, '#ffd257', 14, 12);
    if (frame.subtitle) {
      // 图注可能很长，超出画面就截断——宁可少几个字，也不能让它跑出边框
      const text = ellipsize(ctx, frame.subtitle, w - 36, SUB_FONT);
      plate(text, SUB_FONT, '#e8eeff', 14, 40);
    }

    // 来源行贴底：数据图分享出去也要说清是哪几套统计口径。
    if (frame.footnote) {
      const barHeight = 26;
      ctx.fillStyle = 'rgba(8, 12, 22, 0.82)';
      ctx.fillRect(0, h - barHeight, w, barHeight);
      ctx.font = FOOT_FONT;
      ctx.fillStyle = '#aab4cc';
      ctx.textBaseline = 'middle';
      ctx.fillText(ellipsize(ctx, frame.footnote, w - 28, FOOT_FONT), 14, h - barHeight / 2);
    }

    // 进度线：一眼看出这段年份回溯走到哪儿了
    ctx.fillStyle = 'rgba(120, 150, 220, 0.25)';
    ctx.fillRect(0, h - 3, w, 3);
    ctx.fillStyle = '#f6c453';
    ctx.fillRect(0, h - 3, Math.round((w * (i + 1)) / opts.frameCount), 3);

    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, w, h, { palette, delay, repeat: 0 });

    opts.onProgress?.(i + 1, opts.frameCount);
    // 让出主线程，界面上的进度数字才刷得出来
    await new Promise((r) => setTimeout(r, 0));
  }

  gif.finish();
  const blob = new Blob([gif.bytes() as BlobPart], { type: 'image/gif' });
  // GIF 比较大，URL 晚点再回收
  downloadBlob(blob, opts.fileName, 4000);
}
