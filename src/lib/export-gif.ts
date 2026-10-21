/**
 * 把一串画面导成 GIF。
 *
 * 用途：年份回溯那一段「一个省怎么在世界上掉队」本来只能自己拖滑块看，
 * 导成动图就能直接发出去——这是这个工具最容易被转发的一种形态。
 *
 * 用 gifenc：纯 JS、5 KB、无依赖，浏览器里跑。
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { svgToImage } from './export';

export interface GifFrame {
  /** 这一帧要画的图（世界地图的 SVG） */
  svg: SVGSVGElement;
  /** 标题，例如「河南省 · 1990 年」 */
  title: string;
  /** 副标题，例如「河南省 ≈ 75 个国家之和」 */
  subtitle?: string;
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

const BG = '#080c16';
const TITLE_FONT = '600 20px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';
const SUB_FONT = '400 15px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

export async function exportGif(opts: GifOptions): Promise<void> {
  const width = opts.width ?? 600;
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

    // 标题压在图上：左上角年份，右上角结论
    ctx.textBaseline = 'top';
    ctx.font = TITLE_FONT;
    ctx.fillStyle = '#ffd257';
    ctx.fillText(frame.title, 14, 12);
    if (frame.subtitle) {
      ctx.font = SUB_FONT;
      ctx.fillStyle = '#e8eeff';
      ctx.fillText(frame.subtitle, 14, 38);
    }

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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
