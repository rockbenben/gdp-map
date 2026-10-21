import { useEffect, useMemo, useState } from 'react';
import { geoCentroid, geoPath } from 'd3-geo';
import { GlobeView } from './components/GlobeView';
import { RegionPicker } from './components/RegionPicker';
import { ResultPanel } from './components/ResultPanel';
import { SouthSeaBox } from './components/SouthSeaBox';
import { WorldMap } from './components/WorldMap';
import {
  loadChina,
  loadDataset,
  loadUsStates,
  loadWorld,
  metricValue,
  splitDataset
} from './lib/data';
import { copyText, exportPng } from './lib/export';
import { createChinaProjection, featureMainCentroid, mixColor, PALETTE } from './lib/geo';
import { closestSingle, matchByStrategy, STRATEGY_HINT, STRATEGY_LABEL } from './lib/match';
import type { GdpItem, MatchStrategy } from './lib/match';
import { METRICS, METRIC_DEFAULT_STRATEGY, METRIC_HINT, METRIC_ORDER } from './lib/metrics';
import type { MetricId } from './lib/metrics';
import { loadState, shareUrl, writeState } from './lib/url';
import type { CompareMode, FeatureCollection, GeoFeature, Region, ViewMode } from './lib/types';

/** 世界地图的画布尺寸（与 WorldMap 的默认 viewBox 一致） */
const MAP_W = 1000;
const MAP_H = 520;

export default function App() {
  const [dataset, setDataset] = useState<Awaited<ReturnType<typeof loadDataset>> | null>(null);
  const [world, setWorld] = useState<FeatureCollection | null>(null);
  const [china, setChina] = useState<FeatureCollection | null>(null);
  const [usStates, setUsStates] = useState<FeatureCollection | null>(null);
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
    Promise.all([loadDataset(), loadWorld(), loadChina(), loadUsStates()])
      .then(([d, w, c, u]) => {
        setDataset(d);
        setWorld(w);
        setChina(c);
        setUsStates(u);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    writeState({ mode, view, selected, metric, strategy, ignoreMicro });
  }, [mode, view, selected, metric, strategy, ignoreMicro]);

  const year = dataset?.meta.defaultYear ?? '2024';

  const { countries: allCountries, regions } = useMemo(
    () => (dataset ? splitDataset(dataset, year) : { countries: [], regions: [] }),
    [dataset, year]
  );

  /** 可参与对照的国家池：开启「忽略微型经济体」时剔掉人口不足 100 万的 */
  const countries = useMemo(
    () => (ignoreMicro ? allCountries.filter((c) => (c.pop ?? Infinity) >= 1e6) : allCountries),
    [allCountries, ignoreMicro]
  );

  const regionById = useMemo(() => new Map(regions.map((r) => [r.id, r])), [regions]);
  const countryById = useMemo(() => new Map(allCountries.map((c) => [c.id, c])), [allCountries]);

  const isRegionMode = mode === 'region-to-world';
  /** 参照对象池：地方 → 世界时是省/州，世界 → 地方时是国家 */
  const sourcePool = isRegionMode ? regions : allCountries;
  const sourceSelected = useMemo(
    () => selected.map((id) => sourcePool.find((r) => r.id === id)).filter(Boolean) as Region[],
    [selected, sourcePool]
  );
  /** 对照池 */
  const comparePool = isRegionMode ? countries : regions;

  const target = sourceSelected.reduce((sum, r) => sum + metricValue(r, metric), 0);

  const match = useMemo(() => {
    if (!target) return null;
    const exclude = sourceSelected.map((r) => r.id);
    const pool: GdpItem[] = comparePool.map((r) => ({
      id: r.id,
      zh: r.zh,
      value: metricValue(r, metric)
    }));
    return matchByStrategy(target, pool, strategy, { exclude });
  }, [target, comparePool, sourceSelected, metric, strategy]);

  const closest = useMemo(() => {
    if (!target) return null;
    const pool: GdpItem[] = comparePool.map((r) => ({ id: r.id, zh: r.zh, value: metricValue(r, metric) }));
    return closestSingle(target, pool, { exclude: sourceSelected.map((r) => r.id) });
  }, [target, comparePool, sourceSelected, metric]);

  /** 参照物在「被比对象」里能排第几 */
  const worldRank = useMemo(() => {
    if (!target || !isRegionMode) return null;
    const bigger = allCountries.filter((c) => metricValue(c, metric) > target).length;
    return { rank: bigger + 1, total: allCountries.length };
  }, [target, isRegionMode, allCountries, metric]);

  const matchedPopulation = useMemo(() => {
    if (!match) return 0;
    return match.items.reduce((sum, item) => {
      const region = regionById.get(item.id) ?? countryById.get(item.id);
      return sum + (region?.pop ?? 0);
    }, 0);
  }, [match, regionById, countryById]);

  // 几何查找表（省州与国家放在一起，按 id 取）
  const featureById = useMemo(() => {
    const map = new Map<string, GeoFeature>();
    for (const f of [...(world?.features ?? []), ...(china?.features ?? []), ...(usStates?.features ?? [])]) {
      map.set(String(f.id), f);
    }
    return map;
  }, [world, china, usStates]);

  /** 省/州细分层：画在世界地图上（合规的南海诸岛也在这层里） */
  const subdivisions = useMemo<FeatureCollection | null>(() => {
    if (!china || !usStates) return null;
    return {
      type: 'FeatureCollection',
      features: [...china.features, ...usStates.features]
    };
  }, [china, usStates]);

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
    if (!sourcePool.length) return;
    const pick = sourcePool[Math.floor(Math.random() * sourcePool.length)];
    setSelected([pick.id]);
  };

  // ---------- 高亮 ----------
  const countryHighlights = useMemo(() => {
    if (!match || !isRegionMode) return [];
    return match.items.map((item, idx) => ({ id: item.id, rank: idx, label: item.zh, value: item.value }));
  }, [match, isRegionMode]);

  const regionHighlights = useMemo(() => {
    if (!match || isRegionMode) return [];
    return match.items.map((item, idx) => {
      const r = regionById.get(item.id);
      return { id: r?.geometryId ?? item.id, rank: idx, label: item.zh, value: item.value };
    });
  }, [match, isRegionMode, regionById]);

  const globeHighlights = useMemo(() => {
    const m = new Map<string, { id: string; label: string; gdp?: number; color: string }>();
    const items = match?.items ?? [];
    items.forEach((item, idx) => {
      const t = items.length <= 1 ? 0 : idx / (items.length - 1);
      const geoId = isRegionMode ? item.id : (regionById.get(item.id)?.geometryId ?? item.id);
      m.set(geoId, {
        id: geoId,
        label: item.zh,
        gdp: item.value,
        color: mixColor(PALETTE.matchedLow, PALETTE.matchedHigh, t)
      });
    });
    return m;
  }, [match, isRegionMode, regionById]);

  const globeSources = useMemo(() => {
    const m = new Map<string, { id: string; label: string; gdp?: number; color: string }>();
    if (!isRegionMode) {
      for (const r of sourceSelected) {
        m.set(r.geometryId, { id: r.geometryId, label: r.zh, gdp: r.gdpUsd, color: PALETTE.source });
      }
    }
    return m;
  }, [isRegionMode, sourceSelected]);

  // ---------- 地球仪：世界国家 + 省/州合为一层 ----------
  const globePolygons = useMemo<FeatureCollection | null>(() => {
    if (!world || !subdivisions) return null;
    const features = [
      ...world.features.filter((f) => String(f.id) !== 'CHN'),
      ...subdivisions.features
    ];
    return { type: 'FeatureCollection', features };
  }, [world, subdivisions]);

  const arcs = useMemo(() => {
    if (!match || !world || !china) return [];
    const out: Array<{ start: [number, number]; end: [number, number]; color: string }> = [];
    const centroidOfWorld = (id: string): [number, number] | null => {
      const f = world.features.find((x) => String(x.id) === id);
      if (!f) return null;
      return featureMainCentroid(f);
    };
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
        const geoId = regionById.get(item.id)?.geometryId ?? item.id;
        const end = chinaCentroid(china, geoId);
        if (!end) continue;
        out.push({ start, end, color: PALETTE.source });
      }
    }
    return out;
  }, [match, isRegionMode, world, china, sourceSelected, regionById]);

  // ---------- 导出 ----------
  const handleExport = async () => {
    try {
      const title = sourceSelected.length
        ? metricDef.title(
            sourceSelected.map((r) => r.zh).join(' + '),
            match?.count ?? 0,
            match?.items[0]?.zh ?? '',
            isRegionMode ? '国家' : '省/州'
          )
        : 'GDP 等价地图';
      const subtitle = sourceSelected.length
        ? `${metricDef.format(target)} · ${metricDef.valueLabel} · 数据年份 ${year}`
        : '选择一个地区开始';
      const footnote = dataset
        ? `国家：${dataset.meta.countrySource}｜省级：${dataset.meta.provinceSource}`
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

  // 面积对照的剪影：参照地区与对照对象各取一个
  const silhouette = useMemo(() => {
    if (metric !== 'area' || !match || !match.items.length || !sourceSelected[0]) return null;
    const sourceFeature = featureById.get(sourceSelected[0].geometryId) ?? null;
    const targetId = match.items[0].id;
    const targetFeature =
      featureById.get(isRegionMode ? targetId : (regionById.get(targetId)?.geometryId ?? targetId)) ?? null;
    if (!sourceFeature || !targetFeature) return null;
    return {
      source: sourceFeature,
      target: targetFeature,
      sourceLabel: sourceSelected[0].zh,
      targetLabel: match.items[0].zh,
      sourceArea: METRICS.area.format(sourceSelected[0].areaKm2 ?? 0),
      targetArea: METRICS.area.format(match.items[0].value)
    };
  }, [metric, match, sourceSelected, featureById, isRegionMode, regionById]);

  // 选择器分组：省/州按所属国家分组
  const pickerGroups = useMemo(() => {
    if (!isRegionMode) return undefined;
    const byParent = new Map<string, Region[]>();
    for (const r of regions) {
      const key = r.parentId ?? 'other';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(r);
    }
    return [...byParent.entries()].map(([parentId, items]) => ({
      label: parentId === 'CHN' ? '中国' : parentId === 'USA' ? '美国' : (countryById.get(parentId)?.zh ?? parentId),
      items
    }));
  }, [isRegionMode, regions, countryById]);

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
              className={mode === 'region-to-world' ? 'active' : ''}
              onClick={() => switchMode('region-to-world')}
            >
              地方 → 世界
            </button>
            <button
              type="button"
              className={mode === 'world-to-region' ? 'active' : ''}
              onClick={() => switchMode('world-to-region')}
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
            title={isRegionMode ? '选择一个省 / 州' : '选择一个国家'}
            hint={
              isRegionMode
                ? '中国的省级行政区与美国的州都有经济总量，可以直接跟世界比。'
                : '选一个国家，看它相当于哪些省/州加起来。'
            }
            metric={metricDef}
            items={sourcePool}
            groups={pickerGroups}
            selected={selected}
            onToggle={toggle}
            onClear={() => setSelected([])}
            multi={isRegionMode}
          />

          <div className="quick-row">
            {isRegionMode ? (
              <>
                {['CN-440000', 'CN-410000', 'US-06', 'US-48'].map((id) => {
                  const r = regionById.get(id);
                  if (!r) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`chip${selected.includes(id) ? ' active' : ''}`}
                      onClick={() => setSelected([id])}
                    >
                      {r.zh.replace(/(省|州|自治区)$/, '')}
                    </button>
                  );
                })}
              </>
            ) : null}
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
              unitName={isRegionMode ? '国家' : '省/州'}
              strategyLabel={STRATEGY_LABEL[strategy]}
              worldRank={worldRank}
              matchedPopulation={matchedPopulation}
              closest={closest && strategy !== 'nearest' ? { zh: closest.zh, value: closest.value } : null}
              silhouette={silhouette}
            />
          ) : (
            <section className="result placeholder">
              <p>在左侧挑一个地方，地图上就会亮出它等价的对照对象。</p>
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
                      highlights={countryHighlights}
                      totalRanks={Math.max(1, countryHighlights.length)}
                      formatValue={metricDef.format}
                      subdivisions={subdivisions ?? undefined}
                      southSea={china ? <SouthSeaBox geo={china} x={MAP_W - 126} y={MAP_H - 146} width={108} height={128} /> : null}
                      onSelect={(id) => {
                        const c = allCountries.find((x) => x.id === id);
                        if (c) {
                          setMode('world-to-region');
                          setSelected([c.id]);
                        }
                      }}
                      chinaInset={
                        sourceSelected[0]?.parentId === 'CHN' ? (
                          <ChinaInset
                            china={china}
                            highlightIds={new Set(sourceSelected.map((r) => r.geometryId))}
                          />
                        ) : null
                      }
                    />
                  </div>
                ) : (
                  <div className="loading">加载地图…</div>
                )
              ) : china ? (
                <div className="map-holder">
                  <WorldMap
                    geo={world ?? { type: 'FeatureCollection', features: [] }}
                    highlights={[]}
                    totalRanks={1}
                    formatValue={metricDef.format}
                    subdivisions={subdivisions ?? undefined}
                    subHighlights={regionHighlights}
                    southSea={china ? <SouthSeaBox geo={china} x={MAP_W - 126} y={MAP_H - 146} width={108} height={128} /> : null}
                    onSelect={(id) => {
                      const c = allCountries.find((x) => x.id === id);
                      if (c) {
                        setMode('world-to-region');
                        setSelected([c.id]);
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
                  const c = allCountries.find((x) => x.id === id);
                  if (c) {
                    setMode('world-to-region');
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
                数据年份 {dataset.meta.provinceYear}｜国家：{dataset.meta.countrySource}｜中国省级：
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
                {dataset.meta.usStateSource ? `美国各州：${dataset.meta.usStateSource}` : null}
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
