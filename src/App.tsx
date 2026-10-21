import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { geoPath } from 'd3-geo';
import { GlobeView } from './components/GlobeView';
import { Bracket } from './components/Bracket';
import { RegionPicker } from './components/RegionPicker';
import { ResultPanel } from './components/ResultPanel';
import { SquareCartogram } from './components/SquareCartogram';
import { SouthSeaBox } from './components/SouthSeaBox';
import { TargetComparison } from './components/TargetComparison';
import { WorldMap } from './components/WorldMap';
import {
  loadChina,
  loadDataset,
  loadUsStates,
  loadWorld,
  metricValue,
  splitDataset
} from './lib/data';
import { copyText, exportPng, exportShareCard } from './lib/export';
import { createChinaProjection, featureMainCentroid, mixColor, PALETTE } from './lib/geo';
import {
  BIG_POOL_SIZE,
  closestSingle,
  matchByStrategy,
  STRATEGY_HINT,
  STRATEGY_LABEL,
  topByValue
} from './lib/match';
import type { GdpItem, MatchStrategy } from './lib/match';
import { METRICS, METRIC_DEFAULT_STRATEGY, METRIC_HINT, METRIC_ORDER } from './lib/metrics';
import type { MetricId } from './lib/metrics';
import { loadState, shareUrl, writeState } from './lib/url';
import type { CompareMode, FeatureCollection, GeoFeature, Region, ViewMode } from './lib/types';

/** 世界地图的画布尺寸（与 WorldMap 的默认 viewBox 一致） */
const MAP_W = 1000;
const MAP_H = 520;

/** 拼图最多能选几个国家 */
const PUZZLE_MAX = 3;

export default function App() {
  const [dataset, setDataset] = useState<Awaited<ReturnType<typeof loadDataset>> | null>(null);
  const [world, setWorld] = useState<FeatureCollection | null>(null);
  const [china, setChina] = useState<FeatureCollection | null>(null);
  const [usStates, setUsStates] = useState<FeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [initial] = useState(loadState);
  const [mode, setMode] = useState<CompareMode>(initial.mode);
  const [view, setView] = useState<ViewMode>(initial.view);
  // 首次进来别给一片空地图：默认就有一个现成的结论看
  const [selected, setSelected] = useState<string[]>(
    initial.selected.length ? initial.selected : ['CN-440000']
  );
  const [metric, setMetric] = useState<MetricId>(initial.metric);
  const [strategy, setStrategy] = useState<MatchStrategy>(initial.strategy);
  const [ignoreMicro, setIgnoreMicro] = useState(initial.ignoreMicro);
  const [worldYear, setWorldYear] = useState(initial.worldYear);
  const [puzzle, setPuzzle] = useState<{
    target: number;
    label: string;
    metric: MetricId;
    picked: string[];
    done: boolean;
  } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  /** 用户是否已经动过选择（用于区分「第一次点击」和「继续多选」） */
  const touchedRef = useRef(false);
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

  const year = dataset?.meta.defaultYear ?? '2024';

  const { countries: allCountries, regions } = useMemo(
    () => (dataset ? splitDataset(dataset, String(worldYear), year) : { countries: [], regions: [] }),
    [dataset, worldYear, year]
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
  /** 人均这类指标不可叠加：只允许选一个，且只能用「最接近」口径 */
  const additive = metricDef.additive;
  const effectiveStrategy: MatchStrategy = additive ? strategy : 'nearest';
  const sourceSelected = useMemo(() => {
    const picked = selected.map((id) => sourcePool.find((r) => r.id === id)).filter(Boolean) as Region[];
    return additive ? picked : picked.slice(0, 1);
  }, [selected, sourcePool, additive]);
  /** 对照池 */
  const comparePool = isRegionMode ? countries : regions;

  /** 「大件」池：按当前指标排名前 10 的对象 */
  const bigPool = useMemo(
    () =>
      topByValue(
        comparePool.map((r) => ({ id: r.id, zh: r.zh, value: metricValue(r, metric) })),
        BIG_POOL_SIZE
      ),
    [comparePool, metric]
  );

  /** 每种口径用哪个池子来凑 */
  const poolForStrategy = useCallback(
    (s: MatchStrategy): GdpItem[] =>
      s === 'big'
        ? bigPool
        : comparePool.map((r) => ({ id: r.id, zh: r.zh, value: metricValue(r, metric) })),
    [bigPool, comparePool, metric]
  );

  // 可叠加的指标才求和；不可叠加的只取唯一那一个
  const target = additive
    ? sourceSelected.reduce((sum, r) => sum + metricValue(r, metric), 0)
    : sourceSelected.length
      ? metricValue(sourceSelected[0], metric)
      : 0;

  const match = useMemo(() => {
    if (!target) return null;
    const exclude = sourceSelected.map((r) => r.id);
    return matchByStrategy(target, poolForStrategy(effectiveStrategy), effectiveStrategy, { exclude });
  }, [target, poolForStrategy, sourceSelected, effectiveStrategy]);

  const closest = useMemo(() => {
    if (!target) return null;
    const pool: GdpItem[] = comparePool.map((r) => ({ id: r.id, zh: r.zh, value: metricValue(r, metric) }));
    return closestSingle(target, pool, { exclude: sourceSelected.map((r) => r.id) });
  }, [target, comparePool, sourceSelected, metric]);

  useEffect(() => {
    writeState({ mode, view, selected, metric, strategy: effectiveStrategy, ignoreMicro, worldYear });
  }, [mode, view, selected, metric, effectiveStrategy, ignoreMicro, worldYear]);

  /** 四种口径各自会得到什么：让用户直接看懂区别，而不是背术语 */
  const strategyPreviews = useMemo(() => {
    if (!target) return [];
    const exclude = sourceSelected.map((r) => r.id);
    const list: MatchStrategy[] = additive ? ['many', 'over', 'big', 'nearest'] : ['nearest'];
    return list.map((id) => {
      const r = matchByStrategy(target, poolForStrategy(id), id, { exclude });
      const err = target ? Math.abs(r.gap) / target : 0;
      const gapText = `${r.gap >= 0 ? '多' : '少'} ${(err * 100).toFixed(1)}%`;
      // 「比大国家」说的是「它是其中哪一个的几分之几」
      const fraction =
        id === 'big' && r.count === 1 && r.items[0].value > 0 ? target / r.items[0].value : null;
      const preview =
        r.count === 0
          ? '没有能匹配的对象'
          : fraction != null
            ? `${r.items[0].zh} 的 ${(fraction * 100).toFixed(0)}%`
            : r.count === 1
              ? `${r.items[0].zh} · ${metricDef.format(r.sum)}（${gapText}）`
              : `${r.count} 个 · ${metricDef.format(r.sum)}（${gapText}）`;
      return { id, label: STRATEGY_LABEL[id], hint: STRATEGY_HINT[id], preview, fraction };
    });
  }, [target, poolForStrategy, sourceSelected, additive, metricDef]);

  /** 参照物在「被比对象」里能排第几 */
  const worldRank = useMemo(() => {
    if (!target || !isRegionMode) return null;
    const bigger = allCountries.filter((c) => metricValue(c, metric) > target).length;
    return { rank: bigger + 1, total: allCountries.length, year: worldYear };
  }, [target, isRegionMode, allCountries, metric, worldYear]);

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

  /** 「比大国家」时，标题写成「它是其中哪一个的几分之几」 */
  const bigFraction = useMemo(() => {
    if (!match || effectiveStrategy !== 'big' || match.count !== 1 || !match.items[0].value) return null;
    return target / match.items[0].value;
  }, [match, effectiveStrategy, target]);

  const sourceLabel = sourceSelected.length ? sourceSelected.map((r) => r.zh).join(' + ') : '（未选择）';

  const headline = useMemo(() => {
    if (!match || !sourceSelected.length || bigFraction == null) return null;
    const part =
      bigFraction >= 1
        ? `${bigFraction.toFixed(bigFraction < 10 ? 1 : 0)} 倍`
        : `${(bigFraction * 100).toFixed(0)}%`;
    return `${sourceLabel} ≈ ${match.items[0].zh}的 ${part}`;
  }, [match, sourceSelected, bigFraction, sourceLabel]);

  // 两个目标的擂台对比（擂台视图里用大号版本，侧栏就不用重复了）
  const comparison = useMemo(() => {
    if (sourceSelected.length !== 2) return null;
    return (
      <TargetComparison
        a={sourceSelected[0]}
        b={sourceSelected[1]}
        current={metricDef}
        values={(r, m) => metricValue(r, m)}
      />
    );
  }, [sourceSelected, metricDef, metric]);

  /** 「假如它是一个国家」：四项指标各自在世界上的名次 */
  const counterfactual = useMemo(() => {
    if (!sourceSelected.length || !allCountries.length) return null;
    const rows = (['gdp', 'gdpPc', 'area', 'pop'] as const).map((id) => {
      const m = METRICS[id];
      const v = additive
        ? sourceSelected.reduce((s, r) => s + metricValue(r, id), 0)
        : metricValue(sourceSelected[0], id);
      const bigger = allCountries.filter((c) => metricValue(c, id) > v).length;
      return {
        id,
        label: m.label,
        value: m.format(v),
        rank: bigger + 1,
        total: allCountries.length,
        isCurrent: id === metric
      };
    });
    return { name: sourceLabel, rows };
  }, [sourceSelected, allCountries, metric, additive, sourceLabel]);

  // ---------- 拼图玩法：点国家凑出目标 ----------
  const startPuzzle = () => {
    const region = sourceSelected[0] ?? regions[Math.floor(Math.random() * regions.length)];
    if (!region) return;
    // 人均不可累加，玩游戏时用总量
    const m: MetricId = metric === 'gdpPc' ? 'gdp' : metric;
    setMode('region-to-world');
    setMetric(m);
    setStrategy(METRIC_DEFAULT_STRATEGY[m]);
    setSelected([region.id]);
    setPuzzle({
      target: metricValue(region, m),
      label: `${region.zh}的${METRICS[m].label}`,
      metric: m,
      picked: [],
      done: false
    });
  };

  const togglePicked = (countryId: string) => {
    if (!puzzle || puzzle.done) return;
    if (puzzle.picked.includes(countryId)) {
      setPuzzle({ ...puzzle, picked: puzzle.picked.filter((x) => x !== countryId) });
      return;
    }
    if (puzzle.picked.length >= PUZZLE_MAX) {
      setToast(`最多只能选 ${PUZZLE_MAX} 个国家`);
      return;
    }
    const picked = [...puzzle.picked, countryId];
    setPuzzle({ ...puzzle, picked, done: picked.length >= PUZZLE_MAX });
  };

  const puzzleSum = useMemo(() => {
    if (!puzzle) return 0;
    let sum = 0;
    for (const id of puzzle.picked) {
      const c = allCountries.find((x) => x.id === id);
      if (c) sum += metricValue(c, puzzle.metric);
    }
    return sum;
  }, [puzzle, allCountries]);

  /** 最优解：最多 3 个国家、合计不超过目标，取最大的一组 */
  const puzzleBest = useMemo(() => {
    if (!puzzle) return null;
    const vals = allCountries
      .map((c) => ({ id: c.id, zh: c.zh, v: metricValue(c, puzzle.metric) }))
      .filter((x) => x.v > 0 && x.v <= puzzle.target)
      .sort((a, b) => b.v - a.v);
    let best = { sum: 0, ids: [] as string[], names: [] as string[] };
    for (const a of vals) if (a.v > best.sum) best = { sum: a.v, ids: [a.id], names: [a.zh] };
    for (let i = 0; i < vals.length; i += 1) {
      for (let j = i + 1; j < vals.length; j += 1) {
        const s2 = vals[i].v + vals[j].v;
        if (s2 > puzzle.target) break;
        if (s2 > best.sum) best = { sum: s2, ids: [vals[i].id, vals[j].id], names: [vals[i].zh, vals[j].zh] };
        for (let k = j + 1; k < vals.length; k += 1) {
          const s3 = s2 + vals[k].v;
          if (s3 > puzzle.target) break;
          if (s3 > best.sum) best = { sum: s3, ids: [vals[i].id, vals[j].id, vals[k].id], names: [vals[i].zh, vals[j].zh, vals[k].zh] };
        }
      }
    }
    return best;
  }, [puzzle, allCountries]);

  const switchMetric = (next: MetricId) => {
    setMetric(next);
    setStrategy(METRIC_DEFAULT_STRATEGY[next]);
    // 换成不可叠加的指标时，多选只剩第一个
    if (!METRICS[next].additive) setSelected((prev) => prev.slice(0, 1));
  };

  const toggle = (id: string) => {
    // 注意：不要在 setState 的 updater 里改 ref —— StrictMode 会把 updater 跑两遍，
    // 第一遍就把「已经动过了」置真，第二遍就会把选中的当成追加。
    if (selected.includes(id)) {
      touchedRef.current = true;
      setSelected(selected.filter((x) => x !== id));
      return;
    }
    // 人均这类不可叠加的指标：选新的就替换旧的
    if (!additive || !isRegionMode) {
      touchedRef.current = true;
      setSelected([id]);
      return;
    }
    // 第一次点击算「换地方」，把预选的默认值替掉；之后才是多选加总
    if (!touchedRef.current) {
      touchedRef.current = true;
      setSelected([id]);
      return;
    }
    setSelected([...selected, id]);
  };

  /** 地图上的点击：拼图时是「选上/取消」，平时是反向查这个国家 */
  const handleMapClick = (id: string) => {
    if (puzzle) {
      togglePicked(id);
      return;
    }
    const c = allCountries.find((x) => x.id === id);
    if (!c) return;
    setMode('world-to-region');
    setSelected([c.id]);
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

  /** 今日一题：随机抽一个地区 + 一个指标 + 一套口径 */
  const randomQuestion = () => {
    if (!regions.length) return;
    const region = regions[Math.floor(Math.random() * regions.length)];
    const m = METRIC_ORDER[Math.floor(Math.random() * METRIC_ORDER.length)];
    setMode('region-to-world');
    setMetric(m);
    setStrategy(METRIC_DEFAULT_STRATEGY[m]);
    setSelected([region.id]);
    setToast(`今日一题：${region.zh}的${METRICS[m].label}`);
  };

  /** 今日一省：按日期确定性地抽一个省——今天打开的人看到的都一样，方便分享 */
  const dailyPick = () => {
    if (!regions.length) return;
    const today = new Date();
    const stamp = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
    let hash = 0;
    for (const ch of stamp) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const region = regions[hash % regions.length];
    setMode('region-to-world');
    setSelected([region.id]);
    touchedRef.current = true;
    setToast(`今日一省（${stamp}）：${region.zh}`);
  };

  // ---------- 高亮 ----------
  const countryHighlights = useMemo(() => {
    // 拼图模式：地图上高亮的是玩家已经选中的国家
    if (puzzle) {
      return puzzle.picked.map((id, idx) => {
        const c = allCountries.find((x) => x.id === id);
        return { id, rank: idx, label: c?.zh ?? id, value: c ? metricValue(c, puzzle.metric) : undefined };
      });
    }
    if (!match || !isRegionMode) return [];
    return match.items.map((item, idx) => ({ id: item.id, rank: idx, label: item.zh, value: item.value }));
  }, [match, isRegionMode, puzzle, allCountries]);

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
    /** 省/州的中心点：中国省用官方质心，美国州用几何主体质心 */
    const centroidOfRegion = (geoId: string): [number, number] | null => {
      const cn = china.features.find((x) => String(x.id) === geoId);
      if (cn) {
        if (cn.properties.centroid) return [cn.properties.centroid[0], cn.properties.centroid[1]];
        return featureMainCentroid(cn);
      }
      const f = featureById.get(geoId);
      return f ? featureMainCentroid(f) : null;
    };
    const top = match.items.slice().sort((a, b) => b.value - a.value).slice(0, 12);

    if (isRegionMode) {
      const start = sourceSelected[0] ? centroidOfRegion(sourceSelected[0].geometryId) : null;
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
        const end = centroidOfRegion(geoId);
        if (!end) continue;
        out.push({ start, end, color: PALETTE.source });
      }
    }
    return out;
  }, [match, isRegionMode, world, china, sourceSelected, regionById, featureById]);

  const handleCopyLink = () => {
    setToast('正在复制链接…');
    copyText(shareUrl({ mode, view, selected, metric, strategy: effectiveStrategy, ignoreMicro, worldYear })).then(
      (ok) => setToast(ok ? '链接已复制到剪贴板' : '复制失败，请手动复制地址栏'),
      () => setToast('复制失败，请手动复制地址栏')
    );
  };

  const handleExportCard = async () => {
    try {
      const svg = document.querySelector<SVGSVGElement>(view === 'globe' ? '.globe-wrap svg' : '.map-holder svg');
      if (!svg) throw new Error('地图未就绪');
      setToast('正在生成分享卡…');
      const facts = (counterfactual?.rows ?? []).map((r) => ({
        label: r.label,
        value: r.value,
        note: `世界第 ${r.rank} 位`
      }));
      await exportShareCard({
        svg,
        title: `假如 ${sourceLabel} 是一个国家`,
        subtitle:
          headline ??
          (match ? `相当于 ${match.count} 个${isRegionMode ? '国家' : '省/州'}之和` : ''),
        facts,
        footnote: dataset
          ? `数据：${dataset.meta.countrySource.split('（')[0]}｜${dataset.meta.provinceSource.split('（')[0]}`
          : '',
        fileName: 'gdp-equivalence-card.png'
      });
      setToast('分享卡已导出');
      setShareOpen(false);
    } catch (e) {
      setToast(e instanceof Error ? e.message : '导出失败');
    }
  };

  const handleExportHires = async () => {
    try {
      const svg = document.querySelector<SVGSVGElement>(view === 'globe' ? '.globe-wrap svg' : '.map-holder svg');
      if (!svg) throw new Error('地图未就绪');
      setToast('正在生成高清图…');
      await exportPng({
        svg,
        title: headline ?? (sourceSelected.length ? sourceLabel : 'GDP 等价地图'),
        subtitle: sourceSelected.length
          ? `${metricDef.format(target)} · ${metricDef.valueLabel} · 数据年份 ${year}`
          : '选择一个地区开始',
        footnote: dataset
          ? `国家：${dataset.meta.countrySource}｜省级：${dataset.meta.provinceSource}`
          : '',
        fileName: 'gdp-equivalence-map@3x.png',
        scale: 3
      });
      setToast('高清图已导出');
      setShareOpen(false);
    } catch (e) {
      setToast(e instanceof Error ? e.message : '导出失败');
    }
  };

  if (error) {
    return (
      <div className="app fatal">
        <p>数据加载失败：{error}</p>
      </div>
    );
  }

  // 面积对照的剪影：参照地区与对照对象各取一个（只对单个参照物有意义）
  const silhouette = useMemo(() => {
    if (metric !== 'area' || !match || !match.items.length || sourceSelected.length !== 1) return null;
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
              地图
            </button>
            <button type="button" className={view === 'globe' ? 'active' : ''} onClick={() => setView('globe')}>
              地球
            </button>
            <button type="button" className={view === 'square' ? 'active' : ''} onClick={() => setView('square')}>
              方形图
            </button>
            <button type="button" className={view === 'bracket' ? 'active' : ''} onClick={() => setView('bracket')}>
              擂台
            </button>
          </div>

          <button type="button" className="ghost-btn" onClick={handleCopyLink}>
            复制链接
          </button>
          <div className="share-wrap">
            <button
              type="button"
              className="primary-btn"
              onClick={() => setShareOpen((v) => !v)}
              aria-expanded={shareOpen}
            >
              分享 ▾
            </button>
            {shareOpen ? (
              <div className="share-menu">
                <button type="button" onClick={handleCopyLink}>
                  <b>复制链接</b>
                  <span>对方打开就是同一张图</span>
                </button>
                <button type="button" onClick={handleExportCard}>
                  <b>下载分享卡</b>
                  <span>竖版 2400×3200，适合发群</span>
                </button>
                <button type="button" onClick={handleExportHires}>
                  <b>下载高清图</b>
                  <span>横版 3600px 宽</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <section className="strategy">
            <div className="picker-head">
              <h2>比哪个方面</h2>
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
          </section>

          <section className="compare-panel">
            <div className="picker-head">
              <h2>{isRegionMode ? '拿哪些国家来凑' : '拿哪些省/州来凑'}</h2>
            </div>
            {additive ? (
              <div className="choice-list" role="radiogroup" aria-label="对照方式">
                {strategyPreviews.map((opt) => {
                  const active = effectiveStrategy === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`choice${active ? ' active' : ''}`}
                      onClick={() => setStrategy(opt.id)}
                      title={opt.hint}
                    >
                      <span className="choice-title">{opt.label}</span>
                      <span className="choice-preview">{opt.preview}</span>
                      {active ? <span className="choice-hint">{opt.hint}</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="choice-list">
                <div className="choice active static">
                  <span className="choice-title">{STRATEGY_LABEL.nearest}</span>
                  <span className="choice-preview">{strategyPreviews[0]?.preview ?? '—'}</span>
                  <span className="choice-hint">人均不能相加，只能跟单个国家比。</span>
                </div>
              </div>
            )}
            <details className="more">
              <summary>更多选项</summary>
              {isRegionMode ? (
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={ignoreMicro}
                    onChange={(e) => setIgnoreMicro(e.target.checked)}
                  />
                  <span>忽略微型经济体（人口不足 100 万）</span>
                </label>
              ) : null}

              <div className="picker-head" style={{ marginTop: 12 }}>
                <h2>拿哪一年的世界来比</h2>
                <span className="year-now">{worldYear}</span>
              </div>
              <input
                className="year-slider"
                type="range"
                min={1990}
                max={2025}
                step={1}
                value={worldYear}
                onChange={(e) => setWorldYear(Number(e.target.value))}
                aria-label="国家数据年份"
              />
              <div className="year-ticks">
                <button type="button" onClick={() => setWorldYear(1990)}>
                  1990
                </button>
                <button type="button" onClick={() => setWorldYear(2000)}>
                  2000
                </button>
                <button type="button" onClick={() => setWorldYear(2010)}>
                  2010
                </button>
                <button type="button" onClick={() => setWorldYear(2024)}>
                  2024
                </button>
              </div>
              <p className="picker-hint">
                国家数据可回溯到 1990 年（2025 为 IMF 预测值），省级数据固定 {year} 年。
                往后拨，能看出「今天这个地方放在当年是什么水平」。
              </p>
            </details>
          </section>

          <RegionPicker
            title={isRegionMode ? '选择一个省 / 州' : '选择一个国家'}
            hint={
              isRegionMode
                ? additive
                  ? '中国的省级行政区与美国的州都有经济总量，可以直接跟世界比；多选会先加总。'
                  : '中国的省级行政区与美国的州都有经济总量。人均不能相加，所以只能选一个。'
                : '选一个国家，看它相当于哪些省/州加起来。'
            }
            metric={metricDef}
            items={sourcePool}
            groups={pickerGroups}
            selected={selected}
            onToggle={toggle}
            onClear={() => setSelected([])}
            multi={isRegionMode && additive}
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
            <button type="button" className="chip ghost" onClick={randomQuestion}>
              今日一题
            </button>
            <button type="button" className="chip ghost" onClick={dailyPick}>
              今日一省
            </button>
            <button type="button" className="chip ghost" onClick={startPuzzle}>
              玩一局
            </button>
          </div>

          {puzzle ? (
            <section className="puzzle">
              <h3>凑一凑：{puzzle.label}</h3>
              <p className="picker-hint">
                在地图上点最多 {PUZZLE_MAX} 个国家，合计不能超过目标，越接近越好。
              </p>
              <div className="puzzle-meter">
                <div className="puzzle-bar">
                  <span
                    style={{
                      width: `${Math.min(100, (puzzleSum / puzzle.target) * 100).toFixed(1)}%`,
                      background: puzzleSum > puzzle.target ? '#ef4d4d' : undefined
                    }}
                  />
                </div>
                <div className="puzzle-nums">
                  <span>
                    已选 {puzzle.picked.length}/{PUZZLE_MAX} · 合计 {METRICS[puzzle.metric].short(puzzleSum)}
                  </span>
                  <span>目标 {METRICS[puzzle.metric].short(puzzle.target)}</span>
                </div>
              </div>
              {puzzle.done && puzzleBest ? (
                <div className="puzzle-result">
                  <p className={puzzleSum > puzzle.target ? 'puzzle-over' : 'puzzle-win'}>
                    {puzzleSum > puzzle.target
                      ? `超了 ${METRICS[puzzle.metric].short(puzzleSum - puzzle.target)}`
                      : puzzleSum === puzzleBest.sum
                        ? '满分！和最优解一样'
                        : `还差 ${METRICS[puzzle.metric].short(puzzleBest.sum - puzzleSum)}`}
                  </p>
                  <p className="puzzle-best">
                    最优解（{puzzleBest.ids.length} 个）：{puzzleBest.names.join(' + ')} ={' '}
                    {METRICS[puzzle.metric].short(puzzleBest.sum)}
                  </p>
                </div>
              ) : (
                <p className="picker-hint">
                  还可以点 {PUZZLE_MAX - puzzle.picked.length} 个。
                </p>
              )}
              <div className="quick-row">
                <button type="button" className="chip" onClick={startPuzzle}>
                  换一题
                </button>
                <button
                  type="button"
                  className="chip ghost"
                  onClick={() => setPuzzle((p) => (p ? { ...p, done: true } : p))}
                >
                  看答案
                </button>
                <button type="button" className="chip ghost" onClick={() => setPuzzle(null)}>
                  结束
                </button>
              </div>
            </section>
          ) : null}

          {match ? (
            <ResultPanel
              sourceLabel={sourceLabel}
              headline={headline}
              fraction={bigFraction}
              comparison={view === 'bracket' ? null : comparison}
              counterfactual={counterfactual}
              target={target}
              targetText={metricDef.format(target)}
              metric={metricDef}
              result={match}
              unitName={isRegionMode ? '国家' : '省/州'}
              strategyLabel={STRATEGY_LABEL[strategy]}
              worldRank={worldRank}
              matchedPopulation={matchedPopulation}
              closest={
                closest && (effectiveStrategy === 'many' || effectiveStrategy === 'over')
                  ? { zh: closest.zh, value: closest.value }
                  : null
              }
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
            {view === 'square' ? (
              <div className="map-holder">
                <SquareCartogram
                  items={countries.map((c) => ({
                    id: c.id,
                    zh: c.zh,
                    value: metricValue(c, metric),
                    matched: (match?.items ?? []).some((m) => m.id === c.id)
                  }))}
                  onSelect={handleMapClick}
                  labelFor={(id) => countryById.get(id)?.zh ?? id}
                />
                <p className="view-caption">
                  世界按「{metricDef.label}」重画：每块的大小就是它的份额，高亮的是这次对照出来的对象。
                </p>
              </div>
            ) : view === 'bracket' ? (
              <div className="map-holder bracket-holder">
                <div className="bracket-row">
                  <div className="bracket-vs">
                    {comparison ?? (
                      <p className="view-caption">在左侧选两个地方，这里就是它们的擂台对阵。</p>
                    )}
                  </div>
                  <div className="bracket-tree">
                    <Bracket
                      entrants={[...regions]
                        .sort((a, b) => metricValue(b, metric) - metricValue(a, metric))
                        .slice(0, 16)
                        .map((r) => ({
                          id: r.id,
                          zh: r.zh,
                          value: metricValue(r, metric),
                          text: metricDef.short(metricValue(r, metric))
                        }))}
                      highlightIds={selected}
                      onSelect={(id) => {
                        setSelected([id]);
                        touchedRef.current = true;
                      }}
                    />
                    <p className="view-caption">
                      省/州按「{metricDef.label}」排前 16 名，两两淘汰——越往右越是赢家。
                    </p>
                  </div>
                </div>
              </div>
            ) : view === 'map' ? (
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
                      onSelect={handleMapClick}
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
                    onSelect={handleMapClick}
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
                  if (puzzle) {
                    togglePicked(id);
                    return;
                  }
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

