import { useMemo } from 'react';

export interface RankEntry {
  id: string;
  zh: string;
  value: number;
  /** 是否是当前选中的 */
  selected?: boolean;
  /** 是否是这次对照出来的对象 */
  matched?: boolean;
  /** 组名（例如「中国」「美国」），有的话按组分隔 */
  group?: string;
}

interface Props {
  entries: RankEntry[];
  /** 指标格式化 */
  format: (value: number) => string;
  /** 每条后面补的小字（例如「世界第 22 位」） */
  noteFor?: (entry: RankEntry, rank: number) => string | undefined;
  /** 最多显示多少条 */
  limit?: number;
  onSelect?: (id: string) => void;
}

/**
 * 排行榜：把对象按当前指标排成一条横向条形榜。
 *
 * 它回答的是选择器回答不了的那句「我选的这个，在同类里到底排第几」——
 * 排名卡给的是名次，这里给的是**上下文**：前后邻居有多大。
 */
export function RankingView({ entries, format, noteFor, limit = 60, onSelect }: Props) {
  const rows = useMemo(() => {
    const sorted = [...entries]
      .filter((e) => e.value > 0)
      .sort((a, b) => b.value - a.value);
    // 被选中的那条必须在榜上，哪怕它排在 limit 之外
    const picked = sorted.filter((e) => e.selected);
    const head = sorted.slice(0, limit);
    const missing = picked.filter((e) => !head.includes(e));
    return [...head, ...missing];
  }, [entries, limit]);

  /** 每条的真实名次（选中项排在 limit 之外时，名次仍然是它真正的位置） */
  const rankOf = useMemo(() => {
    const sorted = [...entries]
      .filter((e) => e.value > 0)
      .sort((a, b) => b.value - a.value);
    return new Map(sorted.map((e, i) => [e.id, i + 1]));
  }, [entries]);

  const max = useMemo(() => Math.max(...rows.map((r) => r.value), 1), [rows]);

  if (!rows.length) {
    return <p className="picker-hint">这个指标下还没有可排的数据。</p>;
  }

  return (
    <div className="ranking">
      {rows.map((e, i) => {
        const ratio = e.value / max;
        return (
          <button
            key={e.id}
            type="button"
            className={['rank-row', e.selected ? 'is-selected' : '', e.matched ? 'is-matched' : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => onSelect?.(e.id)}
            title={`${e.zh} · ${format(e.value)}`}
          >
            <span className="rank-idx">{i + 1}</span>
            <span className="rank-name">
              {e.group ? <em>{e.group}</em> : null}
              {e.zh}
            </span>
            <span className="rank-bar">
              <span className="rank-fill" style={{ width: `${(ratio * 100).toFixed(2)}%` }} />
            </span>
            <span className="rank-value">{format(e.value)}</span>
            <span className="rank-note">{noteFor?.(e, rankOf.get(e.id) ?? i + 1) ?? ''}</span>
          </button>
        );
      })}
    </div>
  );
}
