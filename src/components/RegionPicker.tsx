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
  /** 搜索框里的例子要跟着模式走：选国家时不能举例「广东 / Texas」 */
  searchPlaceholder?: string;
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
  emptyLabel = '没有匹配的地区',
  searchPlaceholder = '搜索：广东 / guangdong / gd / Texas'
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

  /**
   * 省/州的年份不一致：默认年（2024）下日本府县只有 2023 年的数据。
   * 不解释的话，选择器里会显示成「0 亿」，看起来像没有经济总量。
   * 只有一个分组缺数据时直接点名；多组缺失（比如 1960 年）用通用提示。
   */
  const missingGroups = useMemo(
    () =>
      (groups ?? [])
        .filter(
          (g) =>
            g.items.some((r) => r.years.length > 0) &&
            g.items.every((r) => r.years.length === 0 || metricValue(r, metric.id) <= 0)
        )
        .map((g) => g.label),
    [groups, metric.id]
  );
  const hasMissingYear = useMemo(
    () =>
      (groups ?? []).some((g) =>
        g.items.some((r) => metricValue(r, metric.id) <= 0 && r.years.length > 0)
      ),
    [groups, metric.id]
  );

  const renderItem = (r: Region) => {
    const active = selectedSet.has(r.id);
    const value = metricValue(r, metric.id);
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
        {/* 长名字（欧洲一级区那种十几个字的）放不下会省略号截断，
            补个 title，鼠标停上去能看到全名——结果清单那边就是这么做的 */}
        <span className="picker-name" title={r.zh}>
          {r.zh}
        </span>
        <span className="picker-gdp" title={value > 0 ? undefined : '这一年没有数据；选中后年份会切到它有数据的年份'}>
          {value > 0 ? metric.short(value) : '—'}
        </span>
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
        placeholder={searchPlaceholder}
        aria-label={title}
        onChange={(e) => setQuery(e.target.value)}
      />

      {hasMissingYear ? (
        <p className="picker-hint">
          {missingGroups.length === 1
            ? `${missingGroups[0]}在这一年没有数据（显示 —）；选中后年份会切到它有数据的年份。`
            : '有些地区在这一年没有数据（显示 —）；选中后年份会切到它有数据的年份。'}
        </p>
      ) : null}

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
