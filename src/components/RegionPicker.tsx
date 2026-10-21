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
  /** 分组显示（按所属国家） */
  groups?: Array<{ label: string; items: Region[] }>;
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
  groups,
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

  const shownGroups = useMemo(() => {
    if (!groups) return null;
    const q = query.trim().toLowerCase();
    return groups
      .map((g) => ({
        label: g.label,
        // 组名就是国家名：搜「德国」要把整组都留下
        items: q
          ? g.label.toLowerCase().includes(q)
            ? g.items
            : g.items.filter((r) => r.search.includes(q))
          : g.items
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, query]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const renderItem = (r: Region) => {
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
  };

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
        placeholder="搜索：广东 / guangdong / gd / Texas"
        onChange={(e) => setQuery(e.target.value)}
      />

      {shownGroups ? (
        <div className="picker-groups">
          {shownGroups.map((g) => (
            <div key={g.label} className="picker-group">
              <div className="picker-group-title">{g.label}</div>
              <div className="picker-list">{g.items.map(renderItem)}</div>
            </div>
          ))}
          {shownGroups.length === 0 ? <p className="empty">{emptyLabel}</p> : null}
        </div>
      ) : (
        <div className="picker-list">
          {filtered.length === 0 ? <p className="empty">{emptyLabel}</p> : null}
          {filtered.map(renderItem)}
        </div>
      )}

      {!multi ? <p className="picker-hint">单选模式：选新的会替换当前选择。</p> : null}
    </section>
  );
}
