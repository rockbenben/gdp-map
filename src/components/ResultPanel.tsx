import { formatPercent } from '../lib/format';
import { relativeError } from '../lib/match';
import type { MatchResult, MatchStrategy } from '../lib/match';
import type { Metric, MetricTitle } from '../lib/metrics';
import { METRICS } from '../lib/metrics';
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
  /** 当前对照方式（判定「最像的一个」这类口径下该不该显示倍数） */
  strategy?: MatchStrategy;
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
  /** 排名卡：省/州问「假如它是一个国家」，国家直接给世界名次 */
  counterfactual?: { name: string; rows: RankRow[]; isCountry?: boolean } | null;
  /** 「比大国家」时：它是其中哪几个的百分之几 */
  fraction?: { value: number; of: string } | null;
  /**
   * 池子用光也不够：结论写成「是那 N 个总和的几倍」。
   *
   * 这时再说「还差 X%」会跟标题打架（标题说的是几倍），所以这一段不显示。
   */
  exhausted?: boolean;
  /** 对照池那一侧的口径说明，例如「对照 1990 年的世界（当年有记录 149 个国家）」 */
  poolNote?: string | null;
  /** 结果卡上的「换个组合」：原版 / 熟脸 / 随机 */
  variant?: { label: string; canCycle: boolean; onCycle: () => void } | null;
  /**
   * 条形按单项值画（熟脸/随机组合按从大到小排，累计值会让每条都接近满格）。
   * 原版的从小到大列表仍用累计值，表示总和怎么一步步凑出来。
   */
  individualBars?: boolean;
  /** 要不要数字滚动（系统关了动画、用户也没手动打开时就是 false） */
  animate?: boolean;
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
  strategy,
  worldRank,
  matchedPopulation = 0,
  closest,
  silhouette,
  comparison,
  counterfactual,
  fraction = null,
  exhausted = false,
  poolNote = null,
  variant = null,
  individualBars = false,
  animate = true
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
          {title.value != null ? <CountUp value={title.value} format={title.format} animate={animate} /> : null}
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
            ) : exhausted ? null : (
              <>
                {' '}
                · {over ? '超出' : '还差'} <strong>{formatPercent(error)}</strong>
              </>
            )
          ) : null}
        </p>
        {counterfactual ? (
          <CounterfactualCard
            name={counterfactual.name}
            rows={counterfactual.rows}
            isCountry={counterfactual.isCountry}
          />
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
          {poolNote ? `｜${poolNote}` : ''}
        </p>
        {variant && variant.canCycle ? (
          <div className="result-variant">
            <button type="button" className="chip ghost" onClick={variant.onCycle}>
              换个组合
            </button>
            <span className="variant-label">
              {variant.label} · {result.count} 国 · 误差 {(error * 100).toFixed(1)}%
            </span>
          </div>
        ) : null}
        {result.count > 1 && matchedPopulation > 0 ? (
          <p className="result-single">
            {/* ⚠️ 人口要用人口自己的格式：拿当前指标（可能是 GDP）的格式去写，
                会变成「住着 10 亿美元」这种鬼话 */}
            这 {result.count} 个{unitName}加起来住着 <strong>{METRICS.pop.format(matchedPopulation)}</strong>
          </p>
        ) : null}
        {result.count === 1 && only && only.value > 0 && strategy !== 'nearest' ? (
          <p className="result-single">
            {/* ⚠️ 「最像的一个」口径下这个比值按定义就是 1，写出来是废话——所以那条口径下不显示 */}
            {target <= only.value ? (
              <>
                相当于<strong>{only.zh}</strong>的 <strong>{((target / only.value) * 100).toFixed(0)}%</strong>
              </>
            ) : (
              <>
                是<strong>{only.zh}</strong>的 <strong>{(target / only.value).toFixed(2)} 倍</strong>
              </>
            )}
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
            const ratio = target
              ? Math.min(1, (individualBars ? item.value : item.cumulative) / target)
              : 0;
            return (
              <li key={item.id} className="result-item">
                <span className="idx">{i + 1}</span>
                {/* 长名字（欧洲一级区那种十几个字的）会被省略号截断，
                    补个 title，鼠标停上去能看到全名 */}
                <span className="name" title={item.zh}>
                  {item.zh}
                </span>
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

      {/* ⚠️ 这条建议只在「能累加」的指标下成立：人均、密度锁死了对照方式、
          地区也只能单选，让用户「换个方式或多选几个」是让他去撞墙 */}
      {result.count === 1 && metric.additive ? (
        <p className="result-hint">
          想看「几个加起来」，换一种对照方式{unitName === '国家' ? '或多选几个地区' : ''}。
        </p>
      ) : null}
    </section>
  );
}
