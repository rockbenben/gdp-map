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
        {/* 第四列（谁胜）留空：跟下面的数据行对齐，两边列宽才一致 */}
        <span />
      </div>
      <div className="tc-score">
        {/* ⚠️ 第一格要空着：表头第一列是行标签列（58px），
            比分从第一格开始就整体错位一列——
            「0」落在标签列上，「6」落在「河南省」下面，读的人会以为 6 是河南的比分。 */}
        <span />
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
            <span
              className="tc-gap"
              /* ⚠️ 只写「胜 / 平」，不写名字：
                 第 4 列是**定宽 22px**（.tc-rows li 的 grid-template-columns），
                 写名字会溢出面板，而不是把这一列撑宽。
                 赢的那一列本来就是高亮的（橙色加粗），谁赢一看便知。 */
              title={
                r.winner === 'tie'
                  ? '这一项打平'
                  : `${r.winner === 'a' ? a.zh : b.zh} 赢下这一项`
              }
            >
              {r.winner === 'tie' ? '平' : '胜'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
