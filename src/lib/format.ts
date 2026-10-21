/** 通用数字格式化（指标自己的格式在 metrics.ts 里） */

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('zh-CN');
}
