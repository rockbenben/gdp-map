import { describe, expect, it } from 'vitest';
import { buildMatchVariants } from '../lib/variants';
import type { GdpItem } from '../lib/match';

const item = (id: string, value: number): GdpItem => ({ id, zh: id, value });

const pool = [
  item('DEU', 400),
  item('JPN', 350),
  item('GBR', 250),
  item('ITA', 200),
  item('FRA', 200),
  item('NLD', 100),
  item('BEL', 80),
  item('PRT', 60),
  item('GRC', 50),
  item('FIN', 45),
  item('IRL', 40),
  item('NOR', 35),
  item('SWE', 30),
  item('POL', 25),
  item('AUT', 20),
  item('CZE', 15),
  item('HUN', 10),
  item('SVK', 8),
  item('SVN', 6),
  item('HRV', 5),
  item('EST', 4),
  item('LVA', 3),
  item('LTU', 2),
  item('ISL', 1)
];

describe('结果卡的换组合', () => {
  it('默认返回原版；熟脸组合是 3–6 个、按体量从大到小', () => {
    const variants = buildMatchVariants(1000, pool, 'over', {}, 'seed');
    expect(variants[0]).toMatchObject({ key: 'original', label: '原版组合' });
    const known = variants.filter((v) => v.key === 'known-a' || v.key === 'known-b');
    expect(known.length).toBeGreaterThan(0);
    for (const variant of known) {
      expect(variant.match.count).toBeGreaterThanOrEqual(3);
      expect(variant.match.count).toBeLessThanOrEqual(6);
      expect(Math.abs(variant.match.gap) / 1000).toBeLessThanOrEqual(0.1);
      const values = variant.match.items.map((x) => x.value);
      expect(values).toEqual([...values].sort((a, b) => b - a));
    }
  });

  it('A/B 不是同一组', () => {
    const variants = buildMatchVariants(1000, pool, 'over', {}, 'seed');
    const a = variants.find((v) => v.key === 'known-a');
    const b = variants.find((v) => v.key === 'known-b');
    if (a && b) {
      expect(a.match.items.map((x) => x.id).sort()).not.toEqual(b.match.items.map((x) => x.id).sort());
    }
  });

  it('同一个种子的随机组合可复现', () => {
    const run = () => buildMatchVariants(1000, pool, 'over', {}, 'stable-seed').find((v) => v.key === 'random');
    const first = run();
    const second = run();
    expect(first?.match.items.map((x) => x.id)).toEqual(second?.match.items.map((x) => x.id));
  });

  it('big / nearest 不提供换组合', () => {
    expect(buildMatchVariants(1000, pool, 'big', {}, 'seed').map((v) => v.key)).toEqual(['original']);
    expect(buildMatchVariants(1000, pool, 'nearest', {}, 'seed').map((v) => v.key)).toEqual(['original']);
  });

  it('没有熟脸对象时只留原版', () => {
    const variants = buildMatchVariants(100, [item('XXX', 100)], 'over', {}, 'seed');
    expect(variants.map((v) => v.key)).toEqual(['original']);
  });

  it('target 为 0 不生成组合', () => {
    expect(buildMatchVariants(0, pool, 'over')).toEqual([]);
  });
});
