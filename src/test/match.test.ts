import { describe, expect, it } from 'vitest';
import {
  accumulate,
  closestSingle,
  matchByStrategy,
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
