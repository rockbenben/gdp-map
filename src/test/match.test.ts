import { describe, expect, it } from 'vitest';
import {
  accumulate,
  accumulateAscending,
  accumulateDescending,
  closestSingle,
  matchByStrategy,
  relativeError,
  topByValue
} from '../lib/match';
import type { GdpItem } from '../lib/match';

const item = (id: string, value: number): GdpItem => ({ id, zh: id.toUpperCase(), value });

describe('accumulate', () => {
  it('asc + skip：件尽量多，合计不超过目标', () => {
    const pool = [item('a', 40), item('b', 35), item('c', 30), item('d', 25)];
    const r = accumulate(100, pool, { order: 'asc', rule: 'skip' });
    expect(r.sum).toBeLessThanOrEqual(100);
    expect(r.count).toBe(3); // 25 + 30 + 35 = 90，再加 40 就超了
  });

  it('asc + over：装不下的那一个也算进去，合计 ≥ 目标', () => {
    const pool = [item('a', 40), item('b', 35), item('c', 30), item('d', 25)];
    const r = accumulate(100, pool, { order: 'asc', rule: 'over' });
    expect(r.sum).toBeGreaterThanOrEqual(100);
    expect(r.count).toBe(4); // 25+30+35 = 90，再把装不下的 40 算进去
  });

  it('desc + skip：大件优先', () => {
    const pool = [item('a', 40), item('b', 35), item('c', 30), item('d', 25)];
    const r = accumulate(100, pool, { order: 'desc', rule: 'skip' });
    expect(r.items[0].id).toBe('a');
    expect(r.sum).toBeLessThanOrEqual(100);
  });

  it('遵守排除名单', () => {
    const pool = [item('a', 40), item('b', 35)];
    const r = accumulate(100, pool, { order: 'desc', rule: 'skip', exclude: ['a'] });
    expect(r.items.map((i) => i.id)).not.toContain('a');
  });
});

describe('matchByStrategy', () => {
  const pool = [item('tiny', 2), item('small', 8), item('mid', 30), item('big', 60), item('huge', 200)];

  it('many：件最多且不超过目标', () => {
    const r = matchByStrategy(100, pool, 'many');
    expect(r.count).toBe(4); // 2 + 8 + 30 + 60 = 100，再加 200 就超
    expect(r.sum).toBeLessThanOrEqual(100);
  });

  it('over：合计不低于目标', () => {
    const r = matchByStrategy(100, pool, 'over');
    expect(r.sum).toBeGreaterThanOrEqual(100);
  });

  it('big：先选大件', () => {
    const r = matchByStrategy(100, pool, 'big');
    expect(r.items[0].id).toBe('big');
    expect(r.sum).toBeLessThanOrEqual(100);
  });

  it('nearest：只给一个最接近的', () => {
    const r = matchByStrategy(100, pool, 'nearest');
    expect(r.count).toBe(1);
    expect(r.items[0].id).toBe('big'); // |60-100| < |200-100|
  });

  it('over：小件优先，装不下的那一个也算进去', () => {
    const provinces = [item('a', 60), item('b', 30), item('c', 10)];
    const r = matchByStrategy(100, provinces, 'over');
    expect(r.items.map((i) => i.id)).toEqual(['c', 'b', 'a']); // 10 + 30 + 60 = 100
    expect(r.sum).toBeGreaterThanOrEqual(100);
  });

  it('big：大件优先，与累加方向无关', () => {
    const provinces = [item('a', 60), item('b', 30), item('c', 10)];
    const r = matchByStrategy(100, provinces, 'big');
    expect(r.items[0].id).toBe('a');
  });

  it('big：只在给定的「大件池」里找最接近的一个', () => {
    const pool = [item('huge', 900), item('big', 500), item('mid', 120)];
    const bigPool = topByValue(pool, 2); // 取前 2：huge、big
    const r = matchByStrategy(100, bigPool, 'big');
    expect(r.count).toBe(1);
    expect(r.items[0].id).toBe('big'); // 500 比 900 更接近 100
  });

  it('topByValue：按数值取前 N', () => {
    const pool = [item('a', 10), item('b', 30), item('c', 20)];
    expect(topByValue(pool, 2).map((x) => x.id)).toEqual(['b', 'c']);
  });

  it('目标为 0 时返回空结果', () => {
    const r = matchByStrategy(0, pool, 'many');
    expect(r.count).toBe(0);
  });
});

describe('accumulateAscending', () => {
  it('由小到大累加，并取误差最小的一组', () => {
    const pool = [item('a', 40), item('b', 35), item('c', 30)];
    const r = accumulateAscending(100, pool);
    expect(r.count).toBe(3);
    expect(r.sum).toBe(105);
    expect(r.gap).toBe(5);
    expect(r.items.map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });

  it('累计值单调递增', () => {
    const pool = [item('a', 10), item('b', 20), item('c', 30), item('d', 40)];
    const r = accumulateAscending(50, pool);
    const cumulatives = r.items.map((i) => i.cumulative);
    for (let i = 1; i < cumulatives.length; i += 1) {
      expect(cumulatives[i]).toBeGreaterThan(cumulatives[i - 1]);
    }
  });

  it('跳过被排除的对象', () => {
    const pool = [item('a', 10), item('b', 20), item('c', 30)];
    const r = accumulateAscending(30, pool, { exclude: ['a'] });
    expect(r.items.map((i) => i.id)).not.toContain('a');
    // 可选集合为 {20, 30}：取 20 的误差(10)小于取 50 的误差(20)，所以停在 20
    expect(r.sum).toBe(20);
  });

  it('目标小于最小国家时返回最接近的那一个', () => {
    const r = accumulateAscending(1, [item('a', 100), item('b', 200)]);
    expect(r.count).toBe(1);
    expect(r.items[0].id).toBe('a');
  });

  it('空池返回空结果', () => {
    const r = accumulateAscending(100, []);
    expect(r.count).toBe(0);
    expect(r.items).toHaveLength(0);
  });

  it('结果与目标的相对误差很小', () => {
    const pool = Array.from({ length: 60 }, (_, i) => item(`c${i}`, 10 + i * 7));
    const r = accumulateAscending(1000, pool);
    expect(relativeError(r)).toBeLessThan(0.05);
  });
});

describe('accumulateDescending', () => {
  it('由大到小累加', () => {
    const pool = [item('big', 60), item('mid', 50), item('small', 30)];
    const r = accumulateDescending(100, pool);
    expect(r.items[0].id).toBe('big');
    expect(r.count).toBe(2);
    expect(r.sum).toBe(110);
  });

  it('一个够大时只选一个', () => {
    const pool = [item('big', 120), item('mid', 50)];
    const r = accumulateDescending(100, pool);
    expect(r.count).toBe(1);
    expect(r.items[0].id).toBe('big');
  });
});

describe('closestSingle', () => {
  it('返回 GDP 最接近目标的对象', () => {
    const pool = [item('a', 100), item('b', 190), item('c', 210)];
    expect(closestSingle(200, pool)?.id).toBe('b');
  });

  it('尊重排除名单', () => {
    const pool = [item('a', 200), item('b', 210)];
    expect(closestSingle(200, pool, { exclude: ['a'] })?.id).toBe('b');
  });
});
