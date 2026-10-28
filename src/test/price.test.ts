import { describe, expect, it } from 'vitest';
import { anchorYear, priceFactor, toPriceBasis } from '../lib/price';
import type { Region } from '../lib/types';

/** 美国 GDP 平减指数的实数片段（1960 = 14.587，2024 = 119.027） */
const deflator: Record<string, number> = {
  '1960': 14.587,
  '1990': 56.278,
  '2024': 119.027
};

const region = (over: Partial<Region> = {}): Region => ({
  id: 'X',
  kind: 'country',
  zh: '某国',
  en: 'X',
  parentId: null,
  year: '2024',
  years: ['2024'],
  gdpUsd: 100,
  pppUsd: 200,
  gdpPerCapitaUsd: 50,
  pop: 2_000_000,
  areaKm2: 1000,
  geometryId: 'X',
  hasGeometry: true,
  search: 'x',
  ...over
});

describe('anchorYear', () => {
  it('1960 年前锚在 1960 年（兜底：早于 1960 的年份不发布，真出现时按 1960 年的价算）', () => {
    expect(anchorYear('1700')).toBe(1960);
    expect(anchorYear('1950')).toBe(1960);
  });

  it('1960 年起就是当年', () => {
    expect(anchorYear('1990')).toBe(1990);
    expect(anchorYear('2024')).toBe(2024);
  });
});

describe('priceFactor', () => {
  it('把 1960 年的钱折成 2024 年的钱：乘上平减指数的比率', () => {
    expect(priceFactor(deflator, 1960, 2024)).toBeCloseTo(119.027 / 14.587, 6);
  });

  it('同一个年份折算系数是 1', () => {
    expect(priceFactor(deflator, 2024, 2024)).toBe(1);
  });

  it('缺指数就退化成不折算', () => {
    expect(priceFactor(deflator, 1800, 2024)).toBe(1);
  });
});

describe('toPriceBasis', () => {
  it('只折钱，人口和面积不动', () => {
    const k = priceFactor(deflator, 1990, 2024);
    const r = toPriceBasis(region({ year: '1990' }), deflator, 2024);
    expect(r.gdpUsd).toBeCloseTo(100 * k, 6);
    expect(r.gdpPerCapitaUsd).toBeCloseTo(50 * k, 6);
    expect(r.pppUsd).toBeCloseTo(200 * k, 6);
    expect(r.pop).toBe(2_000_000);
    expect(r.areaKm2).toBe(1000);
  });

  it('价基准一样时原样返回', () => {
    const r = region({ year: '2024' });
    expect(toPriceBasis(r, deflator, 2024)).toBe(r);
  });

  it('兜底：早于 1960 的年份按 1960 年的价基准折算（这类年份实际不发布）', () => {
    const k = priceFactor(deflator, 1960, 2024);
    const r = toPriceBasis(region({ year: '1800' }), deflator, 2024);
    expect(r.gdpUsd).toBeCloseTo(100 * k, 6);
  });
});
