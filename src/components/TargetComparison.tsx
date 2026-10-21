import type { Metric } from '../lib/metrics';
import { METRICS } from '../lib/metrics';
import type { Region } from '../lib/types';

interface Props {
  a: Region;
  b: Region;
  /** 当前主指标（高亮显示） */
  current: Metric;
}

/** 两个人的差距怎么算：指名道姓地说谁大多少 */
function gapText(a: number, b: number, nameA: string, nameB: string, unit: string): string {
  if (!a || !b) return '—';
  const bigger = a >= b ? nameA : nameB;
  const smaller = a >= b ? nameB : nameA;
  const ratio = a >= b ? a / b : b / a;
  if (unit === '倍') return `${bigger}是${smaller}的 ${ratio.toFixed(ratio < 10 ? 1 : 0)} 倍`;
  return `${bigger}高出 ${((ratio - 1) * 100).toFixed(1)}%`;
}

/** 两个目标的直接对比：逐项列出，并说明差多少 */
export function TargetComparison({ a, b, current }: Props) {
  const rows = (['gdp', 'gdpPc', 'area', 'pop'] as const).map((id) => {
    const metric = METRICS[id];
    const va = id === 'gdp' ? a.gdpUsd : id === 'gdpPc' ? (a.gdpPerCapitaUsd ?? 0) : id === 'area' ? (a.areaKm2 ?? 0) : (a.pop ?? 0);
    const vb = id === 'gdp' ? b.gdpUsd : id === 'gdpPc' ? (b.gdpPerCapitaUsd ?? 0) : id === 'area' ? (b.areaKm2 ?? 0) : (b.pop ?? 0);
    return { id, metric, va, vb, text: gapText(va, vb, a.zh, b.zh, id === 'gdp' ? '倍' : '') };
  });

  return (
    <section className="target-compare">
      <h3>两个目标对比</h3>
      <div className="tc-head">
        <span className="tc-name a">{a.zh}</span>
        <span className="tc-name b">{b.zh}</span>
      </div>
      <ul className="tc-rows">
        {rows.map((r) => (
          <li key={r.id} className={r.id === current.id ? 'current' : ''}>
            <span className="tc-label">{r.metric.label}</span>
            <span className="tc-val a">{r.metric.format(r.va)}</span>
            <span className="tc-val b">{r.metric.format(r.vb)}</span>
            <span className="tc-gap">{r.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
