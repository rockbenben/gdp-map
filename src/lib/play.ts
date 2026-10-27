import type { MetricId } from './metrics';
import type { Region } from './types';

/** 可累加的指标：拼图/每日挑战只能用这些 */
export const ADDITIVE_METRICS: MetricId[] = ['gdp', 'pppGdp', 'area', 'pop'];

export const PLAY_STORAGE_KEY = 'gdp-play-v1';

// ---------- 日期 ----------

/** 本地日期键：YYYY-MM-DD。和「今日一地」一样按本地日期，跨时区会差一天。 */
export function todayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function previousDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return todayKey(new Date(y, m - 1, d - 1));
}

/** 31 进制字符串哈希：同一个日期/种子在所有机器上一致 */
export function hashString(s: string): number {
  let hash = 0;
  for (const ch of s) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash;
}

// ---------- 每日挑战 ----------

export interface DailyTarget {
  date: string;
  regionId: string;
  regionZh: string;
  metric: MetricId;
  year: string;
  value: number;
}

function metricValueOf(r: Region, metric: MetricId): number {
  switch (metric) {
    case 'gdp':
      return r.gdpUsd;
    case 'pppGdp':
      return r.pppUsd ?? 0;
    case 'area':
      return r.areaKm2 ?? 0;
    case 'pop':
      return r.pop ?? 0;
    default:
      return 0;
  }
}

/**
 * 今日题目：先按日期抽指标，再在「该指标有值」的地区里抽一个。
 *
 * `regions` 要传**各地区默认年**的那一份（中国/美国/欧洲 2024，日本 2023），
 * 这样同一天所有用户看到的是同一个目标，也不会抽到 0。
 */
export function dailyTargetFor(dateKey: string, regions: Region[]): DailyTarget | null {
  if (!regions.length) return null;
  const metric = ADDITIVE_METRICS[hashString(`${dateKey}|metric`) % ADDITIVE_METRICS.length];
  const pool = regions.filter((r) => metricValueOf(r, metric) > 0);
  if (!pool.length) return null;
  const region = pool[hashString(`${dateKey}|region`) % pool.length];
  return {
    date: dateKey,
    regionId: region.id,
    regionZh: region.zh,
    metric,
    year: region.year,
    value: metricValueOf(region, metric)
  };
}

// ---------- 得分 ----------

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 得分 = 合计与目标的重合比例；越线的部分自然扣分 */
export function scoreFor(sum: number, target: number): number {
  if (!Number.isFinite(sum) || !Number.isFinite(target) || sum <= 0 || target <= 0) return 0;
  return clampScore((100 * Math.min(sum, target)) / Math.max(sum, target));
}

/** 5 格成绩条：100 分五格全绿，20 分一格 */
export function scoreSquares(score: number): string {
  const filled = Math.max(0, Math.min(5, Math.floor(clampScore(score) / 20)));
  return '🟩'.repeat(filled) + '⬜'.repeat(5 - filled);
}

// ---------- 本地进度 ----------

export interface DailyProgress {
  /** 最近一次提交的日期 */
  date: string;
  best: number;
  /** 今天是否已经成功（合计不超过目标） */
  done: boolean;
  streak: number;
  /** 连续完成的最后一天 */
  last: string | null;
}

export interface PlayProgress {
  version: 1;
  daily: DailyProgress;
  higherBest: number;
  blindBest: number;
  /** 经济护照：选过的参照物 id */
  passport: string[];
}

export const DEFAULT_PROGRESS: PlayProgress = {
  version: 1,
  daily: { date: '', best: 0, done: false, streak: 0, last: null },
  higherBest: 0,
  blindBest: 0,
  passport: []
};

function normalizeProgress(raw: unknown): PlayProgress {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PROGRESS, daily: { ...DEFAULT_PROGRESS.daily }, passport: [] };
  const o = raw as Record<string, unknown>;
  const daily = (o.daily && typeof o.daily === 'object' ? o.daily : {}) as Record<string, unknown>;
  const passport = Array.isArray(o.passport) ? o.passport.filter((x): x is string => typeof x === 'string') : [];
  return {
    version: 1,
    daily: {
      date: typeof daily.date === 'string' ? daily.date : '',
      best: Number.isFinite(Number(daily.best)) ? Math.max(0, Number(daily.best)) : 0,
      done: Boolean(daily.done),
      streak: Number.isFinite(Number(daily.streak)) ? Math.max(0, Math.floor(Number(daily.streak))) : 0,
      last: typeof daily.last === 'string' ? daily.last : null
    },
    higherBest: Number.isFinite(Number(o.higherBest)) ? Math.max(0, Math.floor(Number(o.higherBest))) : 0,
    blindBest: Number.isFinite(Number(o.blindBest)) ? Math.max(0, Math.floor(Number(o.blindBest))) : 0,
    passport
  };
}

export function loadProgress(storage?: Storage): PlayProgress {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    if (!store) return normalizeProgress(null);
    const raw = store.getItem(PLAY_STORAGE_KEY);
    if (!raw) return normalizeProgress(null);
    return normalizeProgress(JSON.parse(raw));
  } catch {
    return normalizeProgress(null);
  }
}

export function saveProgress(progress: PlayProgress, storage?: Storage): void {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    store?.setItem(PLAY_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    /* 隐私模式/配额满：进度只在内存里，不阻塞游戏 */
  }
}

/**
 * 记录一次每日提交。
 *
 * - 成功（合计不超过目标）才计入 `done` 与最佳成绩；
 * - 连胜按「昨天完成过」续上，断一天就从 1 重新开始；
 * - 同一天重玩只更新最佳，不再加连胜。
 */
export function recordDaily(progress: PlayProgress, date: string, score: number, success: boolean): PlayProgress {
  const p = progress.daily;
  const sameDay = p.date === date;
  const alreadyToday = p.last === date;
  const consecutive = p.last === previousDayKey(date);
  const streak = !success ? p.streak : alreadyToday ? p.streak : consecutive ? p.streak + 1 : 1;
  const last = success && !alreadyToday ? date : p.last;
  const best = success ? Math.max(sameDay ? p.best : 0, clampScore(score)) : sameDay ? p.best : 0;
  return {
    ...progress,
    daily: {
      date,
      best,
      done: success || (sameDay && p.done),
      streak,
      last
    }
  };
}

export function resetPassport(progress: PlayProgress): PlayProgress {
  return { ...progress, passport: [] };
}

// ---------- 分享 / 挑战 ----------

export interface ChallengeTarget {
  regionId: string;
  metric: MetricId;
  year: string;
  score: number;
}

/**
 * 挑战链接：复用正常的分享参数（sel/m/y），额外带挑战标记与对方分数。
 * 接收方打开后按同一个目标开一局；分数只用于展示，按 0–100 夹取。
 */
export function challengeUrlFor(origin: string, pathname: string, target: ChallengeTarget): string {
  const p = new URLSearchParams({
    sel: target.regionId,
    m: target.metric,
    y: target.year,
    challenge: '1',
    score: String(clampScore(target.score))
  });
  return `${origin}${pathname}?${p.toString()}`;
}

export function puzzleShareText(score: number, challengeUrl: string): string {
  return `我在 GDP 等价地图凑了 ${clampScore(score)} 分，来试试：${challengeUrl}`;
}

export function dailyShareText(o: {
  date: string;
  score: number;
  streak: number;
  challengeUrl?: string;
}): string {
  const head = `GDP 等价地图 · 每日挑战 ${o.date}`;
  const line = `${scoreSquares(o.score)} ${clampScore(o.score)} 分 · 连胜 ${o.streak}`;
  return o.challengeUrl ? `${head}\n${line}\n来挑战我：${o.challengeUrl}` : `${head}\n${line}`;
}

// ---------- Higher / Lower ----------

export interface HigherItem {
  id: string;
  zh: string;
  value: number;
  kind: 'country' | 'region';
  parentName?: string;
}

function pickIndex(length: number, rng: () => number): number {
  return Math.max(0, Math.min(length - 1, Math.floor(rng() * length)));
}

/** 抽两张数值不同的卡；池子不足或全相等时返回 null */
export function higherLowerPair(items: HigherItem[], rng: () => number = Math.random): [HigherItem, HigherItem] | null {
  const pool = items.filter((x) => Number.isFinite(x.value) && x.value > 0);
  if (pool.length < 2) return null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const i = pickIndex(pool.length, rng);
    let j = pickIndex(pool.length, rng);
    if (i === j) j = (j + 1) % pool.length;
    if (pool[i].value !== pool[j].value) return [pool[i], pool[j]];
  }
  return null;
}

// ---------- 盲猜轮廓 ----------

export interface BlindItem {
  id: string;
  zh: string;
  kind: 'country' | 'region';
  geoId: string;
}

export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = pickIndex(i + 1, rng);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 四选一：三个同类干扰项 + 正确答案，顺序打乱 */
export function blindOptions(
  answer: BlindItem,
  pool: BlindItem[],
  rng: () => number = Math.random
): BlindItem[] {
  const sameKind = pool.filter((x) => x.kind === answer.kind && x.id !== answer.id);
  const distractors = shuffle(sameKind, rng).slice(0, 3);
  return shuffle([answer, ...distractors], rng);
}

export interface BlindRound {
  answer: BlindItem;
  options: BlindItem[];
}

export function blindRound(pool: BlindItem[], rng: () => number = Math.random): BlindRound | null {
  if (pool.length < 4) return null;
  const answer = pool[pickIndex(pool.length, rng)];
  return { answer, options: blindOptions(answer, pool, rng) };
}
