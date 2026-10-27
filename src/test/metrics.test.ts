import { describe, expect, it } from 'vitest';
import { METRICS } from '../lib/metrics';

describe('金额格式', () => {
  it('不足 1 亿时不显示成 0 亿', () => {
    expect(METRICS.gdp.short(15_000_000)).not.toBe('0 亿');
    expect(METRICS.gdp.format(15_000_000)).not.toBe('0 亿美元');
    expect(METRICS.gdp.short(15_000_000)).toContain('亿');
  });

  it('很小的金额显示小于 0.1 亿', () => {
    expect(METRICS.gdp.short(5_000_000)).toBe('<0.1 亿');
    expect(METRICS.gdp.format(5_000_000)).toBe('<0.1 亿美元');
  });

  it('平价 GDP 用同一套收口', () => {
    expect(METRICS.pppGdp.short(5_000_000)).toBe('<0.1 亿');
    expect(METRICS.pppGdp.format(5_000_000)).toBe('<0.1 亿美元（平价）');
  });
});
