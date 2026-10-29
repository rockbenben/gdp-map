import { describe, expect, it } from 'vitest';
import {
  ADDITIVE_METRICS,
  DEFAULT_PROGRESS,
  blindOptions,
  blindRound,
  challengeUrlFor,
  clampScore,
  dailyShareText,
  dailyTargetFor,
  dailyTargetLine,
  higherLowerPair,
  loadProgress,
  previousDayKey,
  puzzleShareText,
  recordDaily,
  saveProgress,
  scoreFor,
  scoreSquares,
  todayKey
} from '../lib/play';
import type { BlindItem, DailyTarget, HigherItem, PlayProgress } from '../lib/play';
import type { Region } from '../lib/types';

function region(over: Partial<Region> = {}): Region {
  return {
    id: 'CN-410000',
    kind: 'region',
    zh: '河南省',
    en: 'Henan',
    parentId: 'CHN',
    year: '2024',
    years: ['2024'],
    gdpUsd: 883_500_000_000,
    pppUsd: 1_800_000_000_000,
    gdpPerCapitaUsd: 9_000,
    pop: 98_000_000,
    areaKm2: 167_000,
    geometryId: '410000',
    hasGeometry: true,
    search: 'henan',
    ...over
  };
}

function emptyProgress(): PlayProgress {
  return { ...DEFAULT_PROGRESS, daily: { ...DEFAULT_PROGRESS.daily }, passport: [] };
}

describe('日期', () => {
  it('本地日期键与前一天', () => {
    expect(todayKey(new Date(2026, 9, 25))).toBe('2026-10-25');
    expect(previousDayKey('2026-10-25')).toBe('2026-10-24');
    expect(previousDayKey('2026-03-01')).toBe('2026-02-28');
  });
});

describe('dailyTargetFor', () => {
  const regions = [
    region({ id: 'a', zh: '甲', gdpUsd: 100, pppUsd: 200, pop: 10, areaKm2: 5 }),
    region({ id: 'b', zh: '乙', gdpUsd: 200, pppUsd: 100, pop: 20, areaKm2: 6 }),
    region({ id: 'c', zh: '丙', year: '2023', gdpUsd: 300, pppUsd: 300, pop: 30, areaKm2: 7 })
  ];

  it('同一天抽到同一题，指标只从可累加指标里出', () => {
    const a = dailyTargetFor('2026-10-25', regions);
    const b = dailyTargetFor('2026-10-25', regions);
    expect(a).not.toBeNull();
    expect(a?.regionId).toBe(b?.regionId);
    expect(a?.metric).toBe(b?.metric);
    expect(ADDITIVE_METRICS).toContain(a?.metric);
    expect(a?.date).toBe('2026-10-25');
  });

  it('目标地区那一年有值，年份跟地区走', () => {
    const t = dailyTargetFor('2026-10-25', regions);
    const chosen = regions.find((r) => r.id === t?.regionId);
    expect(t?.year).toBe(chosen?.year);
    expect(t?.value).toBeGreaterThan(0);
    expect(t?.regionZh).toBeTruthy();
  });

  it('空池返回 null', () => {
    expect(dailyTargetFor('2026-10-25', [])).toBeNull();
  });
});

describe('每日挑战那行小字', () => {
  const target = (over: Partial<DailyTarget> = {}): DailyTarget => ({
    date: '2026-10-29',
    regionId: 'JP-22',
    regionZh: '静冈县',
    metric: 'gdp',
    year: '2023',
    value: 136_080_869_119,
    ...over
  });

  it('随年份变的指标写上那一年', () => {
    expect(dailyTargetLine(target())).toBe('2023 年 · 目标 1,361 亿美元');
  });

  it('面积不随年份变，卡片上就不写年份', () => {
    // 面积口径下地图的年份固定为默认年（2024）。
    // 卡片上再写「2023 年」就跟「今日一地」对不上了——读的人会以为是两道题。
    const line = dailyTargetLine(target({ metric: 'area', value: 7669 }));
    expect(line).toBe('目标 7,669 km²');
    expect(line).not.toMatch(/\d{4}\s*年/);
  });

  it('没抽到题时给一句准备中的话', () => {
    expect(dailyTargetLine(null)).toBe('正在准备今天的题');
  });
});

describe('得分与色条', () => {
  it('得分是重合比例，越线也扣', () => {
    expect(scoreFor(100, 100)).toBe(100);
    expect(scoreFor(80, 100)).toBe(80);
    expect(scoreFor(120, 100)).toBe(83);
    expect(scoreFor(0, 100)).toBe(0);
  });

  it('分数夹在 0–100', () => {
    expect(clampScore(-1)).toBe(0);
    expect(clampScore(150)).toBe(100);
    expect(clampScore(Number.NaN)).toBe(0);
  });

  it('5 格色条', () => {
    expect(scoreSquares(100)).toBe('🟩🟩🟩🟩🟩');
    expect(scoreSquares(86)).toBe('🟩🟩🟩🟩⬜');
    expect(scoreSquares(0)).toBe('⬜⬜⬜⬜⬜');
  });
});

describe('recordDaily', () => {
  it('首次成功记分并开始连胜', () => {
    const p = recordDaily(emptyProgress(), '2026-10-25', 80, true);
    expect(p.daily).toMatchObject({ date: '2026-10-25', best: 80, done: true, streak: 1, last: '2026-10-25' });
  });

  it('同一天重玩只更新最佳，不再加连胜', () => {
    let p = recordDaily(emptyProgress(), '2026-10-25', 80, true);
    p = recordDaily(p, '2026-10-25', 92, true);
    expect(p.daily.best).toBe(92);
    expect(p.daily.streak).toBe(1);
  });

  it('连续第二天续上，断一天从 1 重来', () => {
    let p = recordDaily(emptyProgress(), '2026-10-25', 80, true);
    p = recordDaily(p, '2026-10-26', 70, true);
    expect(p.daily.streak).toBe(2);
    p = recordDaily(p, '2026-10-28', 60, true);
    expect(p.daily.streak).toBe(1);
  });

  it('失败不记最佳、不加连胜，但会写下当天的提交', () => {
    let p = recordDaily(emptyProgress(), '2026-10-25', 80, true);
    p = recordDaily(p, '2026-10-26', 40, false);
    expect(p.daily).toMatchObject({ date: '2026-10-26', best: 0, done: false, streak: 1, last: '2026-10-25' });
  });
});

describe('本地进度', () => {
  function fakeStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      get length() {
        return map.size;
      }
    } as Storage;
  }

  it('保存后读回，坏数据回默认', () => {
    const store = fakeStorage();
    const p = recordDaily(emptyProgress(), '2026-10-25', 88, true);
    saveProgress({ ...p, passport: ['CN-410000', 'USA'] }, store);
    const loaded = loadProgress(store);
    expect(loaded.daily).toMatchObject({ best: 88, done: true, streak: 1 });
    expect(loaded.passport).toEqual(['CN-410000', 'USA']);

    store.setItem('gdp-play-v1', '{oops');
    expect(loadProgress(store).daily.done).toBe(false);
  });

  it('半截数据也能读，护照只留字符串', () => {
    const store = fakeStorage();
    store.setItem('gdp-play-v1', JSON.stringify({ version: 1, passport: ['a', 2, null], higherBest: 5 }));
    const loaded = loadProgress(store);
    expect(loaded.passport).toEqual(['a']);
    expect(loaded.higherBest).toBe(5);
    expect(loaded.daily.streak).toBe(0);
  });
});

describe('分享与挑战链接', () => {
  it('挑战链接带目标与夹取后的分数', () => {
    const url = challengeUrlFor('https://x.test', '/', {
      regionId: 'CN-410000',
      metric: 'gdp',
      year: '2024',
      score: 150
    });
    const u = new URL(url);
    expect(u.searchParams.get('sel')).toBe('CN-410000');
    expect(u.searchParams.get('m')).toBe('gdp');
    expect(u.searchParams.get('y')).toBe('2024');
    expect(u.searchParams.get('challenge')).toBe('1');
    expect(u.searchParams.get('score')).toBe('100');
  });

  it('每日分享带色条、得分与连胜', () => {
    const text = dailyShareText({ date: '2026-10-25', score: 86, streak: 3, challengeUrl: 'https://x.test/' });
    expect(text).toContain('2026-10-25');
    expect(text).toContain('🟩🟩🟩🟩⬜');
    expect(text).toContain('86 分');
    expect(text).toContain('连胜 3');
    expect(text).toContain('https://x.test/');
  });

  it('普通拼图分享文案', () => {
    expect(puzzleShareText(86, 'https://x.test/')).toContain('86 分');
    expect(puzzleShareText(86, 'https://x.test/')).toContain('https://x.test/');
  });
});

describe('Higher / Lower 出题', () => {
  const items: HigherItem[] = [
    { id: 'a', zh: '甲', value: 100, kind: 'country' },
    { id: 'b', zh: '乙', value: 200, kind: 'region' },
    { id: 'c', zh: '丙', value: 300, kind: 'region' }
  ];

  it('两张卡数值不同', () => {
    const pair = higherLowerPair(items, () => 0);
    expect(pair).not.toBeNull();
    expect(pair![0].id).not.toBe(pair![1].id);
    expect(pair![0].value).not.toBe(pair![1].value);
  });

  it('池子不足或全相等时不出题', () => {
    expect(higherLowerPair([items[0]], () => 0)).toBeNull();
    expect(higherLowerPair([{ ...items[0], value: 5 }, { ...items[1], value: 5 }], () => 0)).toBeNull();
  });
});

describe('盲猜出题', () => {
  const pool: BlindItem[] = [
    { id: 'a', zh: '甲', kind: 'country', geoId: 'a' },
    { id: 'b', zh: '乙', kind: 'country', geoId: 'b' },
    { id: 'c', zh: '丙', kind: 'country', geoId: 'c' },
    { id: 'd', zh: '丁', kind: 'country', geoId: 'd' },
    { id: 'e', zh: '戊', kind: 'country', geoId: 'e' },
    { id: 'r1', zh: '某省', kind: 'region', geoId: 'r1' }
  ];

  it('四选一、同类、包含正确答案', () => {
    const round = blindRound(pool, () => 0.2);
    expect(round).not.toBeNull();
    expect(round!.options).toHaveLength(4);
    expect(round!.options.map((x) => x.id)).toContain(round!.answer.id);
    expect(round!.options.every((x) => x.kind === round!.answer.kind)).toBe(true);
    expect(new Set(round!.options.map((x) => x.id)).size).toBe(4);
  });

  it('同类不足 3 个干扰项时返回不足 4 个，不硬凑别的类别', () => {
    const options = blindOptions(pool[0], [pool[0], pool[1], pool[5]], () => 0);
    expect(options.every((x) => x.kind === 'country')).toBe(true);
    expect(options).toHaveLength(2);
  });

  it('池子不足 4 个时不开局', () => {
    expect(blindRound(pool.slice(0, 3), () => 0)).toBeNull();
  });
});
