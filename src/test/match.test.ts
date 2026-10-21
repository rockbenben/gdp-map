import { describe, expect, it } from 'vitest';
import { accumulateAscending, accumulateDescending, closestSingle, relativeError } from '../lib/match';
import type { GdpItem } from '../lib/match';

const item = (id: string, gdp: number): GdpItem => ({ id, zh: id.toUpperCase(), gdp });

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
    expect(Math.abs(r.gap)).toBeLessThan(20);
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
