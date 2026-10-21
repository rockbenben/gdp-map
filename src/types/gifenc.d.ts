/**
 * gifenc 的类型声明（这个包没带 .d.ts）。
 *
 * 只声明我们实际用到的那几个：编码器、量化、调色板映射。
 * 签名对着 node_modules/gifenc/src/ 核过。
 */
declare module 'gifenc' {
  export interface GifFrameOptions {
    /** 256 色调色板（每项 [r, g, b]） */
    palette?: number[][];
    /** 每帧停留多少毫秒 */
    delay?: number;
    /** 0 = 无限循环，-1 = 只播一次 */
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
  }

  export interface GifEncoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: GifFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(opt?: { initialCapacity?: number; auto?: boolean }): GifEncoder;

  /** 把 RGBA 像素量化成不超过 maxColors 色的调色板 */
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: { format?: string; clearAlpha?: boolean; oneBitAlpha?: boolean }
  ): number[][];

  /** 把 RGBA 像素映射到调色板索引 */
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string
  ): Uint8Array;
}
