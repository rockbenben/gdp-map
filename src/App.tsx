import { useEffect, useMemo, useState } from 'react';
import { geoCentroid, geoPath } from 'd3-geo';
import { ChinaMap } from './components/ChinaMap';
import { GlobeView } from './components/GlobeView';
import { RegionPicker } from './components/RegionPicker';
import { ResultPanel } from './components/ResultPanel';
import { WorldMap } from './components/WorldMap';
import { loadChina, loadDataset, loadWorld, metricValue, provinceToRegion, toRegion } from './lib/data';
import { copyText, exportPng } from './lib/export';
import { createChinaProjection, featureMainCentroid, mixColor, PALETTE } from './lib/geo';
import { closestSingle, matchByStrategy, STRATEGY_HINT, STRATEGY_LABEL } from './lib/match';
import type { GdpItem, MatchStrategy } from './lib/match';
import { METRICS, METRIC_DEFAULT_STRATEGY, METRIC_HINT, METRIC_ORDER } from './lib/metrics';
import type { MetricId } from './lib/metrics';
import { loadState, shareUrl, writeState } from './lib/url';
import type { CompareMode, FeatureCollection, Region, ViewMode } from './lib/types';

const PRESETS = [
  { id: 'CN-440000', label: '广东' },
  { id: 'CN-320000', label: '江苏' },
  { id: 'CN-370000', label: '山东' },
  { id: 'CN-410000', label: '河南' },
  { id: 'CN-330000', label: '浙江' },
  { id: 'CN-510000', label: '四川' }
];

export default function App() {
  const [dataset, setDataset] = useState<Awaited<ReturnType<typeof loadDataset>> | null>(null);
  const [world, setWorld] = useState<FeatureCollection | null>(null);
  const [china, setChina] = useState<FeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [initial] = useState(loadState);
  const [mode, setMode] = useState<CompareMode>(initial.mode);
  const [view, setView] = useState<ViewMode>(initial.view);
  const [selected, setSelected] = useState<string[]>(initial.selected);
  const [metric, setMetric] = useState<MetricId>(initial.metric);
  const [strategy, setStrategy] = useState<MatchStrategy>(initial.strategy);
  const [ignoreMicro, setIgnoreMicro] = useState(initial.ignoreMicro);
  const [toast, setToast] = useState<string | null>(null);

  const metricDef = METRICS[metric];

  useEffect(() => {
    Promise.all([loadDataset(), loadWorld(), loadChina()])
      .then(([d, w, c]) => {
        setDataset(d);
        setWorld(w);
        setChina(c);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    writeState({ mode, view, selected, metric, strategy, ignoreMicro });
  }, [mode, view, selected, metric, strategy, ignoreMicro]);

  const year = dataset?.meta.defaultYear ?? '2024';

  const provinces = useMemo<Region[]>(
    () => (dataset ? dataset.provinces.map((p) => provinceToRegion(p, year)) : []),
    [dataset, year]
  );
  const allCountries = useMemo<Region[]>(
    () => (dataset ? dataset.countries.map((c) => toRegion(c, year)) : []),
    [dataset, year]
  );
  /** 可参与对照的国家池：开启「忽略微型经济体」时剔掉人口不足 100 万的 */
  const countries = useMemo(
    () => (ignoreMicro ? allCountries.filter((c) => (c.pop ?? Infinity) >= 1e6) : allCountries),
    [allCountries, ignoreMicro]
  );

  const provinceById = useMemo(() => new Map(provinces.map((p) => [p.id, p])), [provinces]);

  const isRegionMode = mode === 'region-to-country';
  const sourceRegions = isRegionMode ? provinces : countries;
  const sourceSelected = useMemo(
    () => selected.map((id) => sourceRegions.find((r) => r.id === id)).filter(Boolean) as Region[],
    [selected, sourceRegions]
  );

  const target = sourceSelected.reduce((sum, r) => sum + metricValue(r, metric), 0);

  const match = useMemo(() => {
    if (!target) return null;
    const exclude = sourceSelected.map((r) => r.id);
    const pool: GdpItem[] = (isRegionMode ? countries : provinces).map((r) => ({
      id: r.id,
      zh: r.zh,
      value: metricValue(r, metric)
    }));
    return matchByStrategy(target, pool, strategy, { exclude });
  }, [target, isRegionMode, countries, provinces, sourceSelected, metric, strategy]);

  const closest = useMemo(() => {
    if (!target) return null;
    const pool: GdpItem[] = (isRegionMode ? countries : provinces).map((r) => ({
      id: r.id,
      zh: r.zh,
      value: metricValue(r, metric)
    }));
    return closestSingle(target, pool, { exclude: sourceSelected.map((r) => r.id) });
  }, [target, isRegionMode, countries, provinces, sourceSelected, metric]);

  /** 参照物在「被比对象」里能排第几 —— 例如河南的 GDP 在世界上排第几十 */
  const worldRank = useMemo(() => {
    if (!target || !isRegionMode) return null;
    // 排名用全部国家，不受「忽略微型经济体」开关影响
    const bigger = allCountries.filter((c) => metricValue(c, metric) > target).length;
    return { rank: bigger + 1, total: allCountries.length };
  }, [target, isRegionMode, allCountries, metric]);

  /** 匹配到的对象合计住了多少人（拿 GDP 比的时候特别有意思） */
  const matchedPopulation = useMemo(() => {
    if (!match) return 0;
    return match.items.reduce((sum, item) => {
      const region = isRegionMode
        ? countries.find((c) => c.id === item.id)
        : provinces.find((p) => p.id === item.id);
      return sum + (region?.pop ?? 0);
    }, 0);
  }, [match, isRegionMode, countries, provinces]);

  const switchMetric = (next: MetricId) => {
    setMetric(next);
    setStrategy(METRIC_DEFAULT_STRATEGY[next]);
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return isRegionMode ? [...prev, id] : [id];
    });
  };

  const switchMode = (next: CompareMode) => {
    setMode(next);
    setSelected([]);
  };

  const randomPick = () => {
    if (!sourceRegions.length) return;
    const pick = sourceRegions[Math.floor(Math.random() * sourceRegions.length)];
    setSelected([pick.id]);
  };

  // ---------- 地图高亮 ----------
  const worldHighlights = useMemo(() => {
    if (!match || !isRegionMode) return [];
    return match.items.map((item, idx) => ({ id: item.id, rank: idx, label: item.zh, gdp: item.value }));
  }, [match, isRegionMode]);

  const chinaHighlights = useMemo(() => {
    if (!match || isRegionMode) return [];
    return match.items.map((item, idx) => ({
      id: provinceById.get(item.id)?.geometryId ?? item.id,
      rank: idx,
      label: item.zh,
      gdp: item.value
    }));
  }, [match, isRegionMode, provinceById]);

  const globeHighlights = useMemo(() => {
    const m = new Map<string, { id: string; label: string; gdp?: number; color: string }>();
    const items = match?.items ?? [];
    items.forEach((item, idx) => {
      const t = items.length <= 1 ? 0 : idx / (items.length - 1);
      const geoId = isRegionMode ? item.id : (provinceById.get(item.id)?.geometryId ?? item.id);
      m.set(geoId, {
        id: geoId,
        label: item.zh,
        gdp: item.value,
        color: mixColor(PALETTE.matchedLow, PALETTE.matchedHigh, t)
      });
    });
    return m;
  }, [match, isRegionMode, provinceById]);

  const globeSources = useMemo(() => {
    const m = new Map<string, { id: string; label: string; gdp?: number; color: string }>();
    if (!isRegionMode) {
      for (const r of sourceSelected) {
        m.set(r.geometryId, { id: r.geometryId, label: r.zh, gdp: r.gdpUsd, color: PALETTE.source });
      }
    }
    return m;
  }, [isRegionMode, sourceSelected]);

  // ---------- 地球仪：世界国家 + 中国分省合为一层 ----------
  const globePolygons = useMemo<FeatureCollection | null>(() => {
    if (!world || !china) return null;
    const features = [
      ...world.features.filter((f) => String(f.id) !== 'CHN'),
      ...china.features.filter((f) => !f.properties.isSouthSea)
    ];
    return { type: 'FeatureCollection', features };
  }, [world, china]);

  const arcs = useMemo(() => {
    if (!match || !world || !china) return [];
    const out: Array<{ start: [number, number]; end: [number, number]; color: string }> = [];
    const centroidOfWorld = (id: string): [number, number] | null => {
      const f = world.features.find((x) => String(x.id) === id);
      if (!f) return null;
      // 用主体质心：整国的球面质心会被离岛带偏，弧线终点就落不到地方上
      return featureMainCentroid(f);
    };
    // 弧线太多会糊成一团：只连最大的若干个
    const top = match.items.slice().sort((a, b) => b.value - a.value).slice(0, 12);

    if (isRegionMode) {
      const start = sourceSelected[0] ? chinaCentroid(china, sourceSelected[0].geometryId) : null;
      if (!start) return [];
      for (const item of top) {
        const end = centroidOfWorld(item.id);
        if (!end) continue;
        out.push({ start, end, color: mixColor(PALETTE.matchedLow, PALETTE.matchedHigh, 0.45) });
      }
    } else {
      const source = sourceSelected[0];
      const start = source ? centroidOfWorld(source.geometryId) : null;
      if (!start) return [];
      for (const item of top) {
        const geoId = provinceById.get(item.id)?.geometryId ?? item.id;
        const end = chinaCentroid(china, geoId);
        if (!end) continue;
        out.push({ start, end, color: PALETTE.source });
      }
    }
    return out;
  }, [match, isRegionMode, world, china, sourceSelected, provinceById]);

  // ---------- 导出 ----------
  const handleExport = async () => {
    try {
      const title = sourceSelected.length
        ? metricDef.title(
            sourceSelected.map((r) => r.zh).join(' + '),
            match?.count ?? 0,
            match?.items[0]?.zh ?? '',
            isRegionMode ? '国家' : '省份'
          )
        : 'GDP 等价地图';
      const subtitle = sourceSelected.length
        ? `${metricDef.format(target)} · ${metricDef.valueLabel} · 数据年份 ${year}`
        : '选择一个地区开始';
      const footnote = dataset
        ? `国家：${dataset.meta.countrySource}｜省份：${dataset.meta.provinceSource}`
        : '';

      const svg = document.querySelector<SVGSVGElement>(view === 'globe' ? '.globe-wrap svg' : '.map-holder svg');
      if (!svg) throw new Error('地图未就绪');
      setToast('正在生成图片…');
      await exportPng({
        svg,
        title,
        subtitle,
        footnote,
        fileName: view === 'globe' ? 'gdp-equivalence-globe.png' : 'gdp-equivalence-map.png'
      });
      setToast('图片已导出');
    } catch (e) {
      setToast(e instanceof Error ? e.message : '导出失败');
    }
  };

  const handleCopyLink = () => {
    setToast('正在复制链接…');
    copyText(shareUrl({ mode, view, selected, metric, strategy, ignoreMicro })).then(
      (ok) => setToast(ok ? '链接已复制到剪贴板' : '复制失败，请手动复制地址栏'),
      () => setToast('复制失败，请手动复制地址栏')
    );
  };

  if (error) {
    return (
      <div className="app fatal">
        <p>数据加载失败：{error}</p>
      </div>
    );
  }

  const sourceLabel = sourceSelected.length ? sourceSelected.map((r) => r.zh).join(' + ') : '（未选择）';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>GDP 等价地图</h1>
          <p>一个省，到底相当于多少个国家？</p>
        </div>

        <div className="controls">
          <div className="segmented" role="tablist" aria-label="对比方向">
            <button
              type="button"
              className={mode === 'region-to-country' ? 'active' : ''}
              onClick={() => switchMode('region-to-country')}
            >
              地方 → 世界
            </button>
            <button
              type="button"
              className={mode === 'country-to-region' ? 'active' : ''}
              onClick={() => switchMode('country-to-region')}
            >
              世界 → 地方
            </button>
          </div>

          <div className="segmented" role="tablist" aria-label="视图">
            <button type="button" className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>
              2D 地图
            </button>
            <button type="button" className={view === 'globe' ? 'active' : ''} onClick={() => setView('globe')}>
              3D 地球
            </button>
          </div>

          <button type="button" className="ghost-btn" onClick={handleCopyLink}>
            复制链接
          </button>
          <button type="button" className="primary-btn" onClick={handleExport}>
            导出图片
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <section className="strategy">
            <div className="picker-head">
              <h2>比什么</h2>
            </div>
            <div className="metric-options" role="radiogroup" aria-label="对比指标">
              {METRIC_ORDER.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={metric === m}
                  className={`metric-btn${metric === m ? ' active' : ''}`}
                  onClick={() => switchMetric(m)}
                >
                  {METRICS[m].label}
                </button>
              ))}
            </div>
            <p className="picker-hint">{METRIC_HINT[metric]}</p>

            <div className="picker-head" style={{ marginTop: 12 }}>
              <h2>怎么比</h2>
            </div>
            <div className="strategy-options" role="radiogroup" aria-label="对照方式">
              {(['many', 'over', 'big', 'nearest'] as MatchStrategy[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={strategy === s}
                  disabled={!metricDef.additive && s !== 'nearest'}
                  className={`strategy-btn${strategy === s ? ' active' : ''}`}
                  onClick={() => setStrategy(s)}
                >
                  {STRATEGY_LABEL[s]}
                </button>
              ))}
            </div>
            <p className="picker-hint">
              {metricDef.additive ? STRATEGY_HINT[strategy] : '人均不可累加，只能跟单个对象比。'}
            </p>
            <label className="toggle">
              <input
                type="checkbox"
                checked={ignoreMicro}
                onChange={(e) => setIgnoreMicro(e.target.checked)}
              />
              <span>忽略微型经济体（人口不足 100 万）</span>
            </label>
          </section>

          <RegionPicker
            title={isRegionMode ? '选择中国的一个或多个地区' : '选择一个国家'}
            hint={
              isRegionMode
                ? '可以多选：多个地区先加总，再去找等价的对照对象。'
                : '选一个国家，看它相当于中国哪几个省加起来。'
            }
            metric={metricDef}
            items={sourceRegions}
            selected={selected}
            onToggle={toggle}
            onClear={() => setSelected([])}
            multi={isRegionMode}
          />

          <div className="quick-row">
            {isRegionMode
              ? PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`chip${selected.includes(p.id) ? ' active' : ''}`}
                    onClick={() => setSelected([p.id])}
                  >
                    {p.label}
                  </button>
                ))
              : null}
            <button type="button" className="chip ghost" onClick={randomPick}>
              随机来一个
            </button>
          </div>

          {match ? (
            <ResultPanel
              sourceLabel={sourceLabel}
              target={target}
              targetText={metricDef.format(target)}
              metric={metricDef}
              result={match}
              unitName={isRegionMode ? '国家' : '省份'}
              strategyLabel={STRATEGY_LABEL[strategy]}
              worldRank={worldRank}
              matchedPopulation={matchedPopulation}
              closest={closest && strategy !== 'nearest' ? { zh: closest.zh, value: closest.value } : null}
            />
          ) : (
            <section className="result placeholder">
              <p>在左侧挑一个地区，地图上就会亮出它等价的对照对象。</p>
            </section>
          )}
        </aside>

        <main className="stage">
          <div className="stage-inner">
            {view === 'map' ? (
              isRegionMode ? (
                world && china ? (
                  <div className="map-holder">
                    <WorldMap
                      geo={world}
                      highlights={worldHighlights}
                      totalRanks={Math.max(1, worldHighlights.length)}
                      formatValue={metricDef.format}
                      onSelect={(id) => {
                        setMode('country-to-region');
                        setSelected([id]);
                      }}
                      chinaInset={
                        <ChinaInset
                          china={china}
                          highlightIds={new Set(sourceSelected.map((r) => r.geometryId))}
                        />
                      }
                    />
                  </div>
                ) : (
                  <div className="loading">加载地图…</div>
                )
              ) : china ? (
                <div className="map-holder">
                  <ChinaMap
                    geo={china}
                    highlights={chinaHighlights}
                    totalRanks={Math.max(1, chinaHighlights.length)}
                    formatValue={metricDef.format}
                    onSelect={(id) => {
                      const p = provinces.find((x) => x.geometryId === id);
                      if (p) {
                        setMode('region-to-country');
                        setSelected([p.id]);
                      }
                    }}
                  />
                </div>
              ) : (
                <div className="loading">加载地图…</div>
              )
            ) : globePolygons ? (
              <GlobeView
                polygons={globePolygons}
                highlights={globeHighlights}
                sources={globeSources}
                arcs={arcs}
                onSelect={(id) => {
                  if (!isRegionMode) return;
                  const c = countries.find((x) => x.id === id);
                  if (c) {
                    setMode('country-to-region');
                    setSelected([c.id]);
                  }
                }}
              />
            ) : (
              <div className="loading">加载地球…</div>
            )}
          </div>

          <footer className="stage-footer">
            <div className="legend">
              <span className="legend-item">
                <i className="swatch" style={{ background: PALETTE.matchedLow }} /> 等价对象（由小到大）
              </span>
              <span className="legend-item">
                <i className="swatch" style={{ background: PALETTE.matchedHigh }} /> 其中最大的几个
              </span>
              <span className="legend-item">
                <i className="swatch" style={{ background: PALETTE.source }} /> 参照地区
              </span>
            </div>
            {dataset ? (
              <p className="sources">
                数据年份 {dataset.meta.provinceYear}｜国家：{dataset.meta.countrySource}｜省份：
                {dataset.meta.provinceSource}
                {dataset.meta.provinceSourceUrl ? (
                  <>
                    {' '}
                    <a href={dataset.meta.provinceSourceUrl} target="_blank" rel="noreferrer">
                      官方原表
                    </a>
                  </>
                ) : null}
                <br />
                {dataset.meta.note}
              </p>
            ) : null}
          </footer>
        </main>
      </div>

      {toast ? (
        <div className="toast" onClick={() => setToast(null)} role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

/** 中国小图（世界地图左下角的定位插图） */
function ChinaInset({ china, highlightIds }: { china: FeatureCollection; highlightIds: Set<string> }) {
  const width = 168;
  const height = 196;
  const features = useMemo(() => china.features.filter((f) => !f.properties.isSouthSea), [china]);
  const path = useMemo(() => geoPath(createChinaProjection(width, height, features)), [width, height, features]);

  return (
    <g transform="translate(20, 292)">
      <rect
        x={-9}
        y={-9}
        width={width + 18}
        height={height + 30}
        rx={9}
        fill="rgba(8,12,22,0.74)"
        stroke="#26314f"
        strokeWidth={0.8}
      />
      {features.map((f) => {
        const id = String(f.id);
        const active = highlightIds.has(id);
        return (
          <path
            key={id}
            d={path(f as never) ?? ''}
            fill={active ? PALETTE.source : 'rgba(30,42,72,0.9)'}
            fillOpacity={active ? 1 : 0.75}
            stroke={active ? 'rgba(255,255,255,0.6)' : '#26314f'}
            strokeWidth={active ? 0.8 : 0.3}
          />
        );
      })}
      <text x={width / 2} y={height + 10} className="sea-label" textAnchor="middle">
        中国
      </text>
    </g>
  );
}

function chinaCentroid(china: FeatureCollection | null, adcode: string): [number, number] | null {
  if (!china) return null;
  const f = china.features.find((x) => String(x.id) === adcode);
  if (!f) return null;
  if (f.properties.centroid) return [f.properties.centroid[0], f.properties.centroid[1]];
  const c = geoCentroid(f as never);
  return [c[0], c[1]];
}
