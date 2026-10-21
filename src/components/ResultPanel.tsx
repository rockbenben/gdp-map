import { formatPercent, formatUsd, formatUsdShort } from '../lib/format';
import type { MatchResult } from '../lib/match';

interface Props {
  /** 主标题，例如「河南省」 */
  sourceLabel: string;
  /** 参照物的 GDP 合计 */
  target: number;
  /** 参照物金额的可读写法 */
  targetText: string;
  result: MatchResult;
  /** 匹配出来的对象叫「国家」还是「省份」 */
  unitName: string;
  /** 最接近的单个对象 */
  closest?: { zh: string; gdp: number } | null;
}

export function ResultPanel({
  sourceLabel,
  target,
  targetText,
  result,
  unitName,
  closest
}: Props) {
  const error = target ? Math.abs(result.gap) / target : 0;

  return (
    <section className="result">
      <div className="result-headline">
        <h1>
          {sourceLabel} <span className="eq">≈</span> <span className="count">{result.count}</span> 个{unitName}
        </h1>
        <p className="result-sub">
          {targetText} · 合计 <strong>{formatUsd(result.sum)}</strong>
          {result.count > 0 ? (
            <>
              {' '}
              · 与参照物相差 <strong>{formatPercent(error)}</strong>
            </>
          ) : null}
        </p>
        {closest ? (
          <p className="result-single">
            单个最接近：<strong>{closest.zh}</strong>（{formatUsd(closest.gdp)}）
          </p>
        ) : null}
      </div>

      {result.items.length ? (
        <ol className="result-list">
          {result.items.map((item, i) => {
            const ratio = target ? Math.min(1, item.cumulative / target) : 0;
            return (
              <li key={item.id} className="result-item">
                <span className="idx">{i + 1}</span>
                <span className="name">{item.zh}</span>
                <span className="bar">
                  <span className="bar-fill" style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
                </span>
                <span className="gdp">{formatUsdShort(item.gdp)}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="empty">没有可匹配的对象。</p>
      )}

      {result.count === 1 ? (
        <p className="result-hint">想看「几个国家加起来」，可以在左侧多选几个省份。</p>
      ) : null}
    </section>
  );
}
