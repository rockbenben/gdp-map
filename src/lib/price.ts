import type { Region } from './types';

/**
 * 价格基准的锚点年。
 *
 * 正常路径上省/州与对照池都取滑块那一年，系数是 1；
 * 这份折算只在数据源给出不同年份时兜底（例如只有单年数据的对象）。
 * 两边年份不同的时候直接相比，等于把两个年份之间的物价差算进结论里——
 * 1960 年的世界跟 2024 年的河南相比，差着八倍多的物价。
 *
 * 所以跨年比较时要把两边折到同一个价基准：用美国 GDP 平减指数做换算
 * （指数只有比率有意义，基年是谁无所谓）。
 *
 * ⚠️ 1960 年前没有数据了（只有麦迪逊项目的估算，不发布），
 * 所以这个函数现在只是兜底：真出现早于 1960 的年份时，按 1960 年的价算。
 */
export function anchorYear(year: string | number): number {
  const y = Number(year);
  return Number.isFinite(y) && y < 1960 ? 1960 : y;
}

/** 把 {from} 年的钱折成 {to} 年的钱 */
export function priceFactor(deflator: Record<string, number>, from: number, to: number): number {
  const a = deflator[String(from)];
  const b = deflator[String(to)];
  if (!a || !b) return 1;
  return b / a;
}

/**
 * 把一个地区的「钱」折到 {basisYear} 的价基准上。
 *
 * 只折钱：人口和面积不是价格，不动。
 * 平价口径（国际元）跟着一起折——历史那一侧的平价值本来就是从名义值推出来的，
 * 不跟着折就对不上了。
 */
export function toPriceBasis(r: Region, deflator: Record<string, number>, basisYear: number): Region {
  const k = priceFactor(deflator, anchorYear(r.year), basisYear);
  if (k === 1) return r;
  return {
    ...r,
    gdpUsd: r.gdpUsd * k,
    pppUsd: r.pppUsd == null ? undefined : r.pppUsd * k,
    gdpPerCapitaUsd: r.gdpPerCapitaUsd == null ? undefined : r.gdpPerCapitaUsd * k
  };
}
