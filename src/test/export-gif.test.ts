import { describe, expect, it } from 'vitest';
import { gifFrameYears } from '../lib/export-gif';

describe('gifFrameYears', () => {
  it('空清单不出帧', () => {
    expect(gifFrameYears([])).toEqual([]);
  });

  it('不超过 32 年时全部保留', () => {
    const years = Array.from({ length: 25 }, (_, i) => 2000 + i);
    expect(gifFrameYears(years)).toEqual(years);
  });

  it('长区间抽帧：首尾都在、帧数受限、年份不越界', () => {
    const years = Array.from({ length: 66 }, (_, i) => 1960 + i);
    const frames = gifFrameYears(years);
    expect(frames[0]).toBe(1960);
    expect(frames[frames.length - 1]).toBe(2025);
    expect(frames.length).toBeLessThanOrEqual(33);
    expect(frames.every((y) => years.includes(y))).toBe(true);
    expect(new Set(frames).size).toBe(frames.length);
  });

  it('最后一帧不是整步长时也补上', () => {
    const years = Array.from({ length: 33 }, (_, i) => 2000 + i);
    const frames = gifFrameYears(years);
    expect(frames[frames.length - 1]).toBe(2032);
    expect(frames.every((y) => years.includes(y))).toBe(true);
  });
});
