import { useEffect, useMemo, useState } from 'react';
import { geoCentroid, geoPath } from 'd3-geo';
import { ChinaMap } from './components/ChinaMap';
import { GlobeView } from './components/GlobeView';
import { RegionPicker } from './components/RegionPicker';
import { ResultPanel } from './components/ResultPanel';
import { WorldMap } from './components/WorldMap';
import { loadChina, loadDataset, loadWorld, provinceToRegion, toRegion } from './lib/data';
import { copyText, exportPng } from './lib/export';
import { createChinaProjection, mixColor, PALETTE } from './lib/geo';
import { formatUsd } from './lib/format';
import { closestSingle, matchByStrategy, STRATEGY_HINT, STRATEGY_LABEL } from './lib/match';
import type { GdpItem, MatchStrategy } from './lib/match';
import { loadState, shareUrl, writeState } from './lib/url';
import type { CompareMode, FeatureCollection, GeoFeature, Region, ViewMode } from './lib/types';

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
  const [strategy, setStrategy] = useState<MatchStrategy>(initial.strategy);
  const [ignoreMicro, setIgnoreMicro] = useState(initial.ignoreMicro);
  const [toast, setToast] = useState<string | null>(null);

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
    writeState({ mode, view, selected, strategy, ignoreMicro });
  }, [mode, view, selected, strategy, ignoreMicro]);

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

  const target = sourceSelected.reduce((sum, r) => sum + r.gdpUsd, 0);

  const match = useMemo(() => {
    if (!target) return null;
    const exclude = sourceSelected.map((r) => r.id);
    if (isRegionMode) {
      return matchByStrategy(
        target,
        countries.map((c) => ({ id: c.id, zh: c.zh, gdp: c.gdpUsd })),
        strategy,
        { exclude }
      );
    }
    return matchByStrategy(
      target,
      provinces.map((p) => ({ id: p.id, zh: p.zh, gdp: p.gdpUsd })),
      strategy,
      { exclude }
    );
  }, [target, isRegionMode, countries, provinces, sourceSelected, strategy]);

  const closest = useMemo(() => {
    if (!target) return null;
    const pool: GdpItem[] = (isRegionMode ? countries : provinces).map((r) => ({
      id: r.id,
      zh: r.zh,
      gdp: r.gdpUsd
    }));
    return closestSingle(target, pool, { exclude: sourceSelected.map((r) => r.id) });
  }, [target, isRegionMode, countries, provinces, sourceSelected]);

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

  // ---------- 地球仪：世界国家 + 中国分省（合并为一个图层）----------
  const globePolygons = useMemo<FeatureCollection | null>(() => {
    if (!world || !china) return null;
    const features: GeoFeature[] = [
      ...world.features.filter((f) => String(f.id) !== 'CHN'),
      ...china.features.filter((f) => !f.properties.isSouthSea)
    ];
    return { type: 'FeatureCollection', features };
  }, [world, china]);

  const worldHighlights = useMemo(() => {
    if (!match || !isRegionMode) return [];
    return match.items.map((item, idx) => ({ id: item.id, rank: idx, label: item.zh, gdp: item.gdp }));
  }, [match, isRegionMode]);

  const chinaHighlights = useMemo(() => {
    if (!match || isRegionMode) return [];
    return match.items.map((item, idx) => ({
      id: provinceById.get(item.id)?.geometryId ?? item.id,
      rank: idx,
      label: item.zh,
      gdp: item.gdp
    }));
  }, [match, isRegionMode, provinceById]);

  const globeHighlights = useMemo(() => {
    const m = new Map<string, { id: string; label: string; gdp?: number; color: string }>();
    const items = match?.items ?? [];
    items.forEach((item, idx) => {
      const t = items.length <= 1 ? 0 : idx / (items.length - 1);
      const geoId = isRegionMode ? item.id : (provinceById.get(item.id)?.geometryId ?? item.id);
      m.set(geoId, { id: geoId, label: item.zh, gdp: item.gdp, color: mixColor(PALETTE.matchedLow, PALETTE.matchedHigh, t) });
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

  const arcs = useMemo(() => {
    if (!match || !world || !china) return [];
    const out: Array<{ start: [number, number]; end: [number, number]; color: string }> = [];
    const centroidOfWorld = (id: string): [number, number] | null => {
      const f = world.features.find((x) => String(x.id) === id);
      if (!f) return null;
      const c = geoCentroid(f as never);
      return [c[0], c[1]];
    };
    // 弧线太多会糊成一团：只连最大的若干个
    const top = match.items.slice().sort((a, b) => b.gdp - a.gdp).slice(0, 12);

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
      const unit = isRegionMode ? '国家' : '省份';
      const title = sourceSelected.length
        ? `${sourceSelected.map((r) => r.zh).join(' + ')} ≈ ${
            match && match.count === 1 ? match.items[0].zh : `${match?.count ?? 0} 个${unit}`
          }`
        : 'GDP 等价地图';
      const subtitle = sourceSelected.length ? `${formatUsd(target)} · 数据年份 ${year}` : '选择一个地区开始';
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
    copyText(shareUrl({ mode, view, selected, strategy, ignoreMicro })).then(
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
              地方 → 国家
            </button>
            <button
              type="button"
              className={mode === 'country-to-region' ? 'active' : ''}
              onClick={() => switchMode('country-to-region')}
            >
              国家 → 地方
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
              <h2>对照方式</h2>
            </div>
            <div className="strategy-options" role="radiogroup" aria-label="对照方式">
              {(Object.keys(STRATEGY_LABEL) as MatchStrategy[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={strategy === s}
                  className={`strategy-btn${strategy === s ? ' active' : ''}`}
                  onClick={() => setStrategy(s)}
                >
                  {STRATEGY_LABEL[s]}
                </button>
              ))}
            </div>
            <p className="picker-hint">{STRATEGY_HINT[strategy]}</p>
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
                ? '可以多选：多个地区先加总，再去找等价的国家。'
                : '选一个国家，看它相当于中国哪几个省加起来。'
            }
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
              targetText={formatUsd(target)}
              result={match}
              unitName={isRegionMode ? '国家' : '省份'}
              strategyLabel={STRATEGY_LABEL[strategy]}
              closest={closest && strategy !== 'nearest' ? { zh: closest.zh, gdp: closest.gdp } : null}
            />
          ) : (
            <section className="result placeholder">
              <p>在左侧挑一个地区，地图上就会亮出它等价的国家。</p>
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
                数据年份 {dataset.meta.provinceYear}｜国家：{dataset.meta.countrySource}｜省份：{dataset.meta.provinceSource}
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
      <rect x={-9} y={-9} width={width + 18} height={height + 30} rx={9} fill="rgba(8,12,22,0.74)" stroke="#26314f" strokeWidth={0.8} />
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
