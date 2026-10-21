import { useEffect, useMemo, useRef, useState } from 'react';

export interface RankEntry {
  id: string;
  zh: string;
  value: number;
  /** 对象类型：国家还是省/州（榜里两类混排时要能分开看） */
  kind?: 'country' | 'region';
  /** 是否是当前选中的 */
  selected?: boolean;
  /** 是否是这次对照出来的对象 */
  matched?: boolean;
  /** 组名（例如「中国」「美国」），有的话按组分隔 */
  group?: string;
}

type Scope = 'all' | 'country' | 'region';

const SCOPE_LABEL: Record<Scope, string> = { all: '全部', country: '国家', region: '省/州' };

interface Props {
  entries: RankEntry[];
  /** 指标格式化 */
  format: (value: number) => string;
  /** 每条后面补的小字（例如「世界第 22 位」） */
  noteFor?: (entry: RankEntry, rank: number) => string | undefined;
  /** 最多显示多少条 */
  limit?: number;
  /** 这个对象相当于多少个国家之和（省/州才有意义，别的口径下不给） */
  equivCount?: (entry: RankEntry) => number | undefined;
  onSelect?: (id: string) => void;
}

/**
 * 排行榜：把对象按当前指标排成一条横向条形榜。
 *
 * 它回答的是选择器回答不了的那句「我选的这个，在同类里到底排第几」——
 * 排名卡给的是名次，这里给的是**上下文**：前后邻居有多大。
 *
 * 国家与省/州排在同一张榜上，所以榜上的名次和「假如它是一个国家」那张名次卡
 * 用的是同一个池子、同一套年份，切到「只看国家」时两边读到的名次就是同一个。
 *
 * 动效不是通用的条形图竞速：这里行与行会**互相让位**，
 * 名次变了的那一行还带着「升了几位 / 降了几位」的标记——
 * 动画让你看见动，标记告诉你动了多少。
 */
export function RankingView({ entries, format, noteFor, limit = 60, equivCount, onSelect }: Props) {
  const [scope, setScope] = useState<Scope>('all');
  /** 一次显示多少条，底部「再显示」往下翻 */
  const [shown, setShown] = useState(limit);
  /** 名次变化：id → 上升了几位（正数是升，负数是降） */
  const [deltas, setDeltas] = useState<Record<string, number>>({});

  // 换范围时回到第一页
  useEffect(() => setShown(limit), [scope, limit]);

  /** 只有一类对象时给筛选没意义 */
  const scopes = useMemo(() => {
    const hasCountry = entries.some((e) => e.kind === 'country');
    const hasRegion = entries.some((e) => e.kind === 'region');
    return hasCountry && hasRegion ? (['all', 'country', 'region'] as const) : (['all'] as const);
  }, [entries]);

  const scoped = useMemo(
    () => (scope === 'all' ? entries : entries.filter((e) => e.kind === scope)),
    [entries, scope]
  );

  const rows = useMemo(() => {
    const sorted = [...scoped]
      .filter((e) => e.value > 0)
      .sort((a, b) => b.value - a.value);
    // 被选中的那条必须在榜上，哪怕它排在 limit 之外
    const picked = sorted.filter((e) => e.selected);
    const head = sorted.slice(0, shown);
    const missing = picked.filter((e) => !head.includes(e));
    return [...head, ...missing];
  }, [scoped, shown]);

  /** 每条的真实名次（选中项排在 limit 之外时，名次仍然是它真正的位置） */
  const rankOf = useMemo(() => {
    const sorted = [...scoped]
      .filter((e) => e.value > 0)
      .sort((a, b) => b.value - a.value);
    return new Map(sorted.map((e, i) => [e.id, i + 1]));
  }, [scoped]);

  /**
   * 名次变化徽章：跟上一版名次表比，谁升了谁降了。
   *
   * ⚠️ 只在**名次表真的变了**时重算——行数、顺序都一样的重新渲染不该把徽章抹掉。
   * 所以依赖的是顺序的签名（拼起来的 id 串），不是数组本身。
   */
  const orderKey = rows.map((r) => r.id).join('|');
  const prevOrder = useRef<string[]>([]);
  useEffect(() => {
    const next = orderKey ? orderKey.split('|') : [];
    const prev = prevOrder.current;
    if (prev.length && next.length) {
      const prevRank = new Map(prev.map((id, i) => [id, i]));
      const moved: Record<string, number> = {};
      next.forEach((id, i) => {
        const before = prevRank.get(id);
        // 之前在榜上且位置变了 → 记下升降；之前不在榜上 → 999（标「新进榜」）
        if (before === undefined) moved[id] = 999;
        else if (before !== i) moved[id] = before - i;
      });
      setDeltas(moved);
    }
    prevOrder.current = next;
  }, [orderKey]);

  const total = useMemo(() => scoped.filter((e) => e.value > 0).length, [scoped]);
  const max = useMemo(() => Math.max(...rows.map((r) => r.value), 1), [rows]);

  /** 被范围筛掉的选中项：说清楚它去哪了，别让人以为选择丢了 */
  const outOfScope = useMemo(
    () => (scope === 'all' ? [] : entries.filter((e) => e.selected && e.kind !== scope)),
    [entries, scope]
  );

  if (!rows.length) {
    return <p className="picker-hint">这个指标下还没有可排的数据。</p>;
  }

  return (
    <div className="ranking">
      {scopes.length > 1 ? (
        <div className="rank-filters" role="group" aria-label="排行范围">
          {scopes.map((s) => (
            <button
              key={s}
              type="button"
              className={scope === s ? 'is-on' : ''}
              onClick={() => setScope(s)}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
      ) : null}

      {outOfScope.length ? (
        <p className="rank-hint">
          {outOfScope.map((e) => e.zh).join('、')} 不在本榜（它是
          {outOfScope[0].kind === 'region' ? '省/州' : '国家'}，切到「全部」或对应范围才看得到）。
        </p>
      ) : null}

      <div className="rank-rows" style={{ height: `calc(var(--row-h) * ${rows.length})` }}>
        {rows.map((e, i) => {
          const ratio = e.value / max;
          // 显示真正的名次，不是它在榜上的位置——选中的那条可能排在 limit 之外
          const rank = rankOf.get(e.id) ?? i + 1;
          const delta = deltas[e.id];
          const equiv = equivCount?.(e);
          return (
            <button
              key={e.id}
              type="button"
              // 位置由 transform 决定：名次变了就滑到新位置（排行追逐）
              style={{ transform: `translateY(calc(var(--row-h) * ${i}))` }}
              className={['rank-row', e.selected ? 'is-selected' : '', e.matched ? 'is-matched' : '']
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelect?.(e.id)}
              title={`${e.zh} · ${format(e.value)}`}
            >
              <span className="rank-idx">
                {rank}
                {delta ? (
                  <i className={delta > 0 ? 'rank-delta up' : 'rank-delta down'}>
                    {delta === 999 ? '新' : delta > 0 ? `▲${delta}` : `▼${-delta}`}
                  </i>
                ) : null}
              </span>
              <span className="rank-name">
                {/* 只看国家时不用每行都挂个「国家」标签；省/州始终带着所属国家 */}
                {(scope === 'all' || e.kind === 'region') && e.group ? <em>{e.group}</em> : null}
                {e.zh}
              </span>
              <span className="rank-bar">
                <span className="rank-fill" style={{ width: `${(ratio * 100).toFixed(2)}%` }} />
              </span>
              <span className="rank-value">{format(e.value)}</span>
              {/* 永远占位：有的行没有这个数，空着也不能少一个格子，
                  否则后面的「备注」列会在各行之间错位 */}
              <span className="rank-equiv" title={equiv ? '这个省/州相当于多少个国家加起来' : undefined}>
                {equiv ? `≈ ${equiv} 国` : ''}
              </span>
              <span className="rank-note">{noteFor?.(e, rank) ?? ''}</span>
            </button>
          );
        })}
      </div>

      {shown < total ? (
        <button type="button" className="rank-more" onClick={() => setShown((n) => n + limit)}>
          再显示 {limit} 名（共 {total} 名）
        </button>
      ) : null}
    </div>
  );
}
