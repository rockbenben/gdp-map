import { formatPercent } from '../lib/format';
import { relativeError } from '../lib/match';
import type { MatchResult } from '../lib/match';
import type { Metric, MetricTitle } from '../lib/metrics';
import { AreaSilhouette } from './AreaSilhouette';
import { CounterfactualCard } from './CounterfactualCard';
import { CountUp } from './CountUp';
import type { RankRow } from './CounterfactualCard';
import type { GeoFeature } from '../lib/types';

interface Props {
  /** 主标题，例如「河南省」 */
  sourceLabel: string;
  /** 覆盖默认标题（用于「比大国家」这种要写成倍数的场合） */
  headline?: MetricTitle | null;
  /** 参照物的指标值合计 */
  target: number;
  /** 参照物金额的可读写法 */
  targetText: string;
  result: MatchResult;
  /** 匹配出来的对象叫「国家」还是「省份」 */
  unitName: string;
  /** 当前指标 */
  metric: Metric;
  /** 当前对照方式的名称 */
  strategyLabel: string;
  /** 参照物在被比对象里能排第几（year 是它自己那一年的年份） */
  worldRank?: { rank: number; total: number; year?: string } | null;
  /** 匹配到的对象一共多少人 */
  matchedPopulation?: number;
  /** 最接近的单个对象 */
  closest?: { zh: string; value: number } | null;
  /** 面积对照：同一比例尺的剪影 */
  silhouette?: {
    source: GeoFeature;
    target: GeoFeature;
    sourceLabel: string;
    targetLabel: string;
    sourceArea: string;
    targetArea: string;
  } | null;
  /** 两个目标的直接对比 */
  comparison?: React.ReactNode;
  /** 「假如它是一个国家」的排名卡 */
  counterfactual?: { name: string; rows: RankRow[] } | null;
  /** 「比大国家」时：它是其中哪几个的百分之几 */
  fraction?: { value: number; of: string } | null;
}

export function ResultPanel({
  sourceLabel,
  headline,
  target,
  targetText,
  result,
  unitName,
  metric,
  strategyLabel,
  worldRank,
  matchedPopulation = 0,
  closest,
  silhouette,
  comparison,
  counterfactual,
  fraction = null
}: Props) {
  const error = relativeError(result);
  const over = result.gap >= 0;
  const only = result.items[0];
  const title = headline ?? metric.title(sourceLabel, result.count, only?.zh ?? '', unitName);

  return (
    <section className="result">
      <div className="result-headline">
        <h1>
          {title.before}
          {title.eq ? <span className="eq">{title.eq}</span> : null}
          {title.value != null ? <CountUp value={title.value} format={title.format} /> : null}
          {title.suffix}
          {title.after}
        </h1>
        <p className="result-sub">
          {targetText} ·{' '}
          {result.count === 1 ? (
            <>
              对照 <strong>{metric.format(result.sum)}</strong>
            </>
          ) : (
            <>
              合计 <strong>{metric.format(result.sum)}</strong>
            </>
          )}
          {result.count > 0 ? (
            fraction != null ? (
              <>
                {' '}
                · 是{fraction.of}的{' '}
                <strong>
                  {fraction.value >= 1
                    ? `${fraction.value.toFixed(fraction.value < 10 ? 1 : 0)} 倍`
                    : `${(fraction.value * 100).toFixed(0)}%`}
                </strong>
              </>
            ) : (
              <>
                {' '}
                · {over ? '超出' : '还差'} <strong>{formatPercent(error)}</strong>
              </>
            )
          ) : null}
        </p>
        {counterfactual ? (
          <CounterfactualCard name={counterfactual.name} rows={counterfactual.rows} />
        ) : null}
        {closest ? (
          <p className="result-single">
            单个最接近：<strong>{closest.zh}</strong>（{metric.format(closest.value)}）
          </p>
        ) : null}
        <p className="result-strategy">
          {metric.valueLabel}｜对照方式：{strategyLabel}
          {worldRank
            ? `｜在 ${worldRank.year ?? ''} 年的 ${worldRank.total} 个经济体里排第 ${worldRank.rank} 位`
            : ''}
        </p>
        {result.count > 1 && matchedPopulation > 0 ? (
          <p className="result-single">
            这 {result.count} 个{unitName}加起来住着 <strong>{metric.format(matchedPopulation)}</strong>
          </p>
        ) : null}
        {result.count === 1 && only && only.value > 0 ? (
          <p className="result-single">
            换算成倍数：<strong>{(target / only.value).toFixed(2)} 倍</strong>（以{only.zh}为 1）
          </p>
        ) : null}
      </div>

      {comparison}

      {silhouette ? (
        <AreaSilhouette
          source={silhouette.source}
          target={silhouette.target}
          sourceLabel={silhouette.sourceLabel}
          targetLabel={silhouette.targetLabel}
          sourceArea={silhouette.sourceArea}
          targetArea={silhouette.targetArea}
        />
      ) : null}

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
                <span className="gdp">{metric.short(item.value)}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="empty">没有可匹配的对象。</p>
      )}

      {result.count === 1 ? (
        <p className="result-hint">想看「几个加起来」，换一种对照方式或多选几个地区。</p>
      ) : null}
    </section>
  );
}
