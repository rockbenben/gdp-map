/** 金额与数量的统一格式化（单位：美元） */

const CN_UNITS: Array<[number, string]> = [
  [1e12, '万亿'],
  [1e8, '亿'],
  [1e4, '万']
];

/** 完整写法：1.97 万亿美元 / 6345 亿美元 */
export function formatUsd(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  for (const [scale, unit] of CN_UNITS) {
    if (abs >= scale) {
      const n = value / scale;
      return `${n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unit}美元`;
    }
  }
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 美元`;
}

/** 紧凑写法：1.97 万亿 / 6345 亿 */
export function formatUsdShort(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)} 万亿`;
  if (abs >= 1e8) return `${(value / 1e8).toFixed(abs >= 1e9 ? 0 : 1)} 亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(1)} 万`;
  return value.toFixed(0);
}

/** 人民币口径（省级原始值） */
export function formatCny(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(2)} 万亿元`;
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 亿元`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}
