import { describe, expect, it } from 'vitest';
import { toRegion } from '../lib/data';
import type { MetricSeries, RegionObject } from '../lib/types';

const country = (pop?: MetricSeries): RegionObject => ({
  id: 'TUV',
  kind: 'country',
  parentId: null,
  zh: '图瓦卢',
  en: 'Tuvalu',
  geoId: 'TUV',
  hasGeometry: true,
  metrics: {
    gdp: { nominal: { '2000': 15_000_000, '2024': 65_000_000 } },
    pop,
    area: 26
  },
  search: 'tuvalu tuv'
});

describe('toRegion 的微型经济体判定', () => {
  it('当年人口缺值时用最近一年，不会把微型国家当成正常国家', () => {
    const r = toRegion(country({ '2001': 9_500, '2024': 10_000 }), '2000');
    expect(r.pop).toBeUndefined();
    expect(r.popForAggregate).toBe(9_500);
    expect(r.isMicro).toBe(true);
  });

  it('当年有人口时优先用当年（可能已超过 100 万）', () => {
    const r = toRegion(country({ '2000': 1_200_000, '2024': 900_000 }), '2000');
    expect(r.isMicro).toBe(false);
  });

  it('缺当年人口但相邻年份人口超过 100 万时，不算微型', () => {
    const r = toRegion(country({ '2001': 24_000_000, '2024': 44_000_000 }), '2000');
    expect(r.isMicro).toBe(false);
  });

  it('完全没有人口记录时保持原来的兜底：不算微型', () => {
    const r = toRegion(country(undefined), '2000');
    expect(r.isMicro).toBe(false);
  });
});
