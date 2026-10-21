import type { Metric, MetricId } from '../lib/metrics';
import { METRICS } from '../lib/metrics';
import type { Region } from '../lib/types';

interface Props {
  a: Region;
  b: Region;
  current: Metric;
  /** 取某个指标上的数值 */
  values: (r: Region, metric: MetricId) => number;
}

/** 擂台：两个地方逐项 PK，谁赢几项就记几分 */
export function TargetComparison({ a, b, current, values }: Props) {
  const rows = (['gdp', 'pppGdp', 'gdpPc', 'density', 'area', 'pop'] as const)
    .map((id) => {
      const metric = METRICS[id];
      const va = values(a, id);
      const vb = values(b, id);
      const aWin = va > vb;
      const bWin = vb > va;
      return { id, metric, va, vb, winner: aWin ? 'a' : bWin ? 'b' : ('tie' as const) };
    })
    .filter((r) => r.va > 0 && r.vb > 0);

  const scoreA = rows.filter((r) => r.winner === 'a').length;
  const scoreB = rows.filter((r) => r.winner === 'b').length;

  return (
    <section className="target-compare">
      <h3>擂台</h3>
      {/* 两边各是哪一列，得写出来——不然两串数字分不清谁是谁 */}
      <div className="tc-head">
        <span />
        <span className="tc-a">{a.zh}</span>
        <span className="tc-b">{b.zh}</span>
      </div>
      <div className="tc-score">
        <span className={`tc-num${scoreA >= scoreB ? ' win' : ''}`}>{scoreA}</span>
        <span className={`tc-num${scoreB >= scoreA ? ' win' : ''}`}>{scoreB}</span>
      </div>
      <p className="tc-verdict">
        {scoreA === scoreB ? '平局' : scoreA > scoreB ? `${a.zh} 胜出` : `${b.zh} 胜出`}
        {current ? `（当前指标：${current.label}）` : ''}
      </p>
      <ul className="tc-rows">
        {rows.map((r) => (
          <li key={r.id} className={r.id === current.id ? 'current' : ''}>
            <span className="tc-label">{r.metric.label}</span>
            <span className={`tc-val a${r.winner === 'a' ? ' win' : ''}`}>{r.metric.format(r.va)}</span>
            <span className={`tc-val b${r.winner === 'b' ? ' win' : ''}`}>{r.metric.format(r.vb)}</span>
            <span className="tc-gap">
              {r.winner === 'tie' ? '打平' : r.winner === 'a' ? `${a.zh} 胜` : `${b.zh} 胜`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
