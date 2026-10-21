import { useMemo, useState } from 'react';
import type { Metric } from '../lib/metrics';
import { metricValue } from '../lib/data';
import type { Region } from '../lib/types';

interface Props {
  title: string;
  hint: string;
  /** 当前指标，决定列表里显示什么数 */
  metric: Metric;
  items: Region[];
  selected: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  multi?: boolean;
  emptyLabel?: string;
}

export function RegionPicker({
  title,
  hint,
  metric,
  items,
  selected,
  onToggle,
  onClear,
  multi = true,
  emptyLabel = '没有匹配的地区'
}: Props) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) => r.search.includes(q));
  }, [items, query]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  return (
    <section className="picker">
      <div className="picker-head">
        <h2>{title}</h2>
        {selected.length ? (
          <button type="button" className="link-btn" onClick={onClear}>
            清空（{selected.length}）
          </button>
        ) : null}
      </div>
      <p className="picker-hint">{hint}</p>

      <input
        className="search"
        type="search"
        value={query}
        placeholder="搜索：广东 / guangdong / gd / 河南"
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="picker-list">
        {filtered.length === 0 ? <p className="empty">{emptyLabel}</p> : null}
        {filtered.map((r) => {
          const active = selectedSet.has(r.id);
          return (
            <button
              type="button"
              key={r.id}
              className={`picker-item${active ? ' active' : ''}`}
              onClick={() => onToggle(r.id)}
              aria-pressed={active}
            >
              <span className="mark" aria-hidden="true">
                {active ? '✓' : ''}
              </span>
              <span className="picker-name">{r.zh}</span>
              <span className="picker-gdp">{metric.short(metricValue(r, metric.id))}</span>
            </button>
          );
        })}
      </div>

      {!multi ? <p className="picker-hint">单选模式：选新的会替换当前选择。</p> : null}
    </section>
  );
}
