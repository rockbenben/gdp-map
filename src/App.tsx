import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { geoPath } from 'd3-geo';
import { GlobeView } from './components/GlobeView';
import { Bracket } from './components/Bracket';
import { RegionPicker } from './components/RegionPicker';
import { ResultPanel } from './components/ResultPanel';
import { SquareCartogram } from './components/SquareCartogram';
import { RankingView } from './components/RankingView';
import type { RankEntry } from './components/RankingView';
import { SouthSeaBox } from './components/SouthSeaBox';
import { TargetComparison } from './components/TargetComparison';
import { WorldMap } from './components/WorldMap';
import {
  loadChina,
  loadDataset,
  loadExtraRegions,
  loadUsStates,
  loadWorld,
  metricValue,
  splitDataset
} from './lib/data';
import { copyText, exportPng, exportShareCard } from './lib/export';
import { exportGif } from './lib/export-gif';
import { createChinaProjection, featureMainCentroid, mixColor, PALETTE } from './lib/geo';
import { useSystemReducedMotion } from './lib/motion';
import {
  BIG_POOL_SIZE,
  closestSingle,
  matchByStrategy,
  relativeError,
  STRATEGY_HINT,
  STRATEGY_LABEL,
  topByValue
} from './lib/match';
import type { GdpItem, MatchStrategy } from './lib/match';
import { METRICS, METRIC_DEFAULT_STRATEGY, METRIC_HINT, METRIC_ORDER, titleText } from './lib/metrics';
import type { MetricId, MetricTitle } from './lib/metrics';
import { loadState, shareUrl, writeState } from './lib/url';
import type { CompareMode, FeatureCollection, GeoFeature, Region, ViewMode } from './lib/types';

/** 世界地图的画布尺寸（与 WorldMap 的默认 viewBox 一致） */
const MAP_W = 1000;
const MAP_H = 520;

/** 等界面把一次状态变更画完（两次 rAF：第一帧提交，第二帧才是画好的） */
const nextPaint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** 拼图最多能选几个国家 */
const PUZZLE_MAX = 3;

export default function App() {
  const [dataset, setDataset] = useState<Awaited<ReturnType<typeof loadDataset>> | null>(null);
  const [world, setWorld] = useState<FeatureCollection | null>(null);
  const [china, setChina] = useState<FeatureCollection | null>(null);
  const [usStates, setUsStates] = useState<FeatureCollection | null>(null);
  const [extraRegions, setExtraRegions] = useState<FeatureCollection | null>(null);
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
  /** 年份是否在自动播放 */
  const [playing, setPlaying] = useState(false);
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
  /**
   * 动效：默认跟着系统，但**用户可以在页面上自己决定**。
   *
   * 系统关了「动画效果」（Windows：辅助功能 → 视觉效果 → 动画效果）时，
   * 浏览器会报 `prefers-reduced-motion: reduce`，全站动效就该让位——
   * 但那只是默认值，不是命令。所以页脚留了「动效」开关：
   * 用户自己打开，`.motion-on` 一加，兜底就不匹配了，动画回来。
   */
  const systemReduced = useSystemReducedMotion();
  const [motionOverride, setMotionOverride] = useState<boolean | null>(null);
  const motionOn = motionOverride ?? !systemReduced;
  /**
   * 系统关了动画时提示一次。
   *
   * 用户看到的是「页面一点动静都没有」，但他不知道是网站没做动效，
   * 还是自己的系统关了动画——不说明白，他就只会觉得「这网站是死的」。
   * 点一下就能打开动效。
   */
  const [motionHint, setMotionHint] = useState(false);
  useEffect(() => {
    setMotionHint(systemReduced && motionOverride === null);
  }, [systemReduced, motionOverride]);
  /** 宽屏才默认展开数据来源（窄屏先给结论） */
  const [wide] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= 1080
  );
  const [sourcesOpen, setSourcesOpen] = useState(wide);

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

  // 播放：让年份自己往前走，结论数字与地图高亮随之滚动。
  // 走到 2025（IMF 预测值）就停——但**要先让 2025 显示出来**再停，
  // 所以停止判断在 timeout 里做，不在 effect 开头做。
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      if (worldYear >= 2025) setPlaying(false);
      else setWorldYear(worldYear + 1);
    }, 700);
    return () => clearTimeout(t);
  }, [playing, worldYear]);

  /** 手动拨年份就把播放停掉：用户想自己控制节奏 */
  const setYear = (y: number) => {
    setPlaying(false);
    setWorldYear(y);
  };

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // 播放是「从头看一遍」：总是从 1990 起，播到 2025 停。
    // 不然默认停在 2024 时只剩一步可走，这个按钮等于没用。
    setWorldYear(1990);
    setPlaying(true);
  };

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
        : comparePool
            // 面积口径要画剪影对照，29 个微型国家没有边界（世界底图是 110m 分辨率，
            // 把它们漏掉了）。拿一个画不出来的国家当对照，剪影就整块消失——
            // 所以面积口径下只用有边界的对象。
            .filter((r) => metric !== 'area' || r.hasGeometry)
            .map((r) => ({ id: r.id, zh: r.zh, value: metricValue(r, metric) })),
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

  /**
   * 欧洲 NUTS-1 与日本都道府县的边界，按需加载。
   *
   * 这个文件 542 KB（gzip 191 KB），占首屏的四分之一，而绝大多数访问根本不需要它——
   * 选中国省走的是 china.json，选美国州走 us-states.json，国家侧走 world.json。
   * 只有「选中的就是欧洲/日本的地区」或「对照结果落到了它们身上」时才用得上。
   */
  const needsExtraGeometry = useMemo(() => {
    const isExtra = (id?: string) => Boolean(id && (id.startsWith('EU-') || id.startsWith('JP-')));
    if (sourceSelected.some((r) => isExtra(r.geometryId))) return true;
    return (match?.items ?? []).some((i) => isExtra(i.id));
  }, [sourceSelected, match]);

  useEffect(() => {
    if (!needsExtraGeometry || extraRegions) return;
    loadExtraRegions()
      .then(setExtraRegions)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [needsExtraGeometry, extraRegions]);

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
      const err = relativeError(r);
      const gapText = `${r.gap >= 0 ? '多' : '少'} ${(err * 100).toFixed(1)}%`;
      // 「比大国家」说的是「它是其中哪几个的几分之几」（分数不过 100%）
      const fraction = id === 'big' && r.count > 0 && r.sum > 0 ? target / r.sum : null;
      const fractionNames = r.items.map((x) => x.zh).join(' + ');
      const preview =
        r.count === 0
          ? '没有能匹配的对象'
          : fraction != null
            ? `${fractionNames} 的 ${(fraction * 100).toFixed(0)}%`
            : r.count === 1
              ? `${r.items[0].zh} · ${metricDef.format(r.sum)}（${gapText}）`
              : `${r.count} 个 · ${metricDef.format(r.sum)}（${gapText}）`;
      return { id, label: STRATEGY_LABEL[id], hint: STRATEGY_HINT[id], preview, fraction };
    });
  }, [target, poolForStrategy, sourceSelected, additive, metricDef]);

  /**
   * 参照物在「被比对象」里能排第几。
   *
   * 比的是**它自己那一年**的经济体：省/州的数据是固定年份的（广东 2024、日本 2021），
   * 拿它去和滑块选的那一年的经济体比，结论是假的——2024 年的广东排进 1990 年的表里
   * 会显示「第 3 位」，而 1990 年的广东连前十都进不去。
   */
  const sourceYear = sourceSelected[0]?.year ?? String(worldYear);
  const countriesAtSourceYear = useMemo(
    () => (dataset ? splitDataset(dataset, sourceYear, year).countries : []),
    [dataset, sourceYear, year]
  );

  const worldRank = useMemo(() => {
    if (!target || !isRegionMode) return null;
    const bigger = countriesAtSourceYear.filter((c) => metricValue(c, metric) > target).length;
    return { rank: bigger + 1, total: countriesAtSourceYear.length, year: sourceYear };
  }, [target, isRegionMode, countriesAtSourceYear, metric, sourceYear]);

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
    for (const f of [
      ...(world?.features ?? []),
      ...(china?.features ?? []),
      ...(usStates?.features ?? []),
      // 欧洲 NUTS-1 与日本都道府县的边界是按需加载的，来了就一并收进查找表
      ...(extraRegions?.features ?? [])
    ]) {
      map.set(String(f.id), f);
    }
    return map;
  }, [world, china, usStates, extraRegions]);

  /** 省/州细分层：画在世界地图上（合规的南海诸岛也在这层里）
   *  欧洲 NUTS-1 与日本都道府县也在这层里，但它们标了 drawOnlyWhenHighlighted，
   *  不被高亮时不描边——141 个区一起画会把欧洲糊成一片。 */
  const subdivisions = useMemo<FeatureCollection | null>(() => {
    if (!china || !usStates) return null;
    return {
      type: 'FeatureCollection',
      features: [...china.features, ...usStates.features, ...(extraRegions?.features ?? [])]
    };
  }, [china, usStates, extraRegions]);

  /**
   * 「比大国家」时，标题写成「它是其中哪几个的几分之几」。
   *
   * ⚠️ 分数不能超过 100%——「占巴西的 115%」是句错话。
   * 所以这里用的是**被选中的大件合计**做分母：单个大件装不下时，
   * 匹配会加上别的大国（见 match.ts 的 matchBig），分数自然落回 100% 以内。
   */
  const bigFraction = useMemo(() => {
    if (!match || effectiveStrategy !== 'big' || !match.count || !match.sum) return null;
    return {
      of: match.items.map((x) => x.zh).join(' + '),
      value: target / match.sum
    };
  }, [match, effectiveStrategy, target]);

  const sourceLabel = sourceSelected.length ? sourceSelected.map((r) => r.zh).join(' + ') : '（未选择）';

  const headline = useMemo<MetricTitle | null>(() => {
    if (!match || !sourceSelected.length || bigFraction == null) return null;
    // 正常情况下分数 ≤ 100%；只有「比所有大件加起来还大」时才会超过
    const isMultiple = bigFraction.value > 1;
    return {
      before: `${sourceLabel} ≈ ${bigFraction.of}的 `,
      eq: '',
      // 不足 1 倍时写成百分比，否则写成倍数——数字本身是要滚动的那个
      value: isMultiple ? bigFraction.value : bigFraction.value * 100,
      format: (v) => (isMultiple ? (v < 10 ? v.toFixed(1) : v.toFixed(0)) : v.toFixed(0)),
      suffix: isMultiple ? ' 倍' : '%',
      after: ''
    };
  }, [match, sourceSelected, bigFraction, sourceLabel]);

  /**
   * 完整结论句（不管是「比大国家」的倍数，还是「52 个国家之和」）。
   * 动图的字幕用这个——「比大国家」口径下 headline 是空的，只用它会没字幕。
   * 数字是滚动的，所以只能取最终值，不能从 DOM 里读。
   */
  const conclusionRef = useRef('');
  useEffect(() => {
    if (headline) {
      conclusionRef.current = titleText(headline);
      return;
    }
    const count = match?.count ?? 0;
    const only = match?.items[0]?.zh ?? '';
    conclusionRef.current = titleText(
      metricDef.title(sourceLabel, count, only, isRegionMode ? '国家' : '省/州')
    );
  }, [headline, match, metricDef, sourceLabel, isRegionMode]);

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
    if (!sourceSelected.length || !countriesAtSourceYear.length) return null;
    const rows = (['gdp', 'gdpPc', 'area', 'pop'] as const).map((id) => {
      const m = METRICS[id];
      const v = additive
        ? sourceSelected.reduce((s, r) => s + metricValue(r, id), 0)
        : metricValue(sourceSelected[0], id);
      const bigger = countriesAtSourceYear.filter((c) => metricValue(c, id) > v).length;
      return {
        id,
        label: m.label,
        value: m.format(v),
        rank: bigger + 1,
        total: countriesAtSourceYear.length,
        isCurrent: id === metric
      };
    });
    return { name: sourceLabel, rows };
  }, [sourceSelected, allCountries, metric, additive, sourceLabel]);

  // ---------- 拼图玩法：点国家凑出目标 ----------
  const startPuzzle = () => {
    const region = sourceSelected[0] ?? regions[Math.floor(Math.random() * regions.length)];
    if (!region) return;
    // 人均和密度都不可累加，玩游戏时用总量
    const m: MetricId = additive ? metric : 'gdp';
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
    // 换成不可叠加的指标时，多选只剩第一个（状态也要真的收掉，否则列表里还亮着两个）
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

  /**
   * 从排行榜里选一条。
   *
   * 榜上国家和省/州混排，点国家就该切到「世界 → 省/州」，
   * 点省/州就该切到「省/州 → 世界」——不然会出现「选了一个国家、
   * 但当前是省/州模式，于是选不中」的怪事。
   */
  const selectFromRanking = (id: string) => {
    touchedRef.current = true;
    if (countryById.has(id)) {
      setMode('world-to-region');
      setSelected([id]);
      return;
    }
    if (regionById.has(id)) {
      setMode('region-to-world');
      setSelected([id]);
    }
  };

  /**
   * 换对照方向，但**别把题目换掉**。
   *
   * 原来的做法是清空选择，结果切过去是一片空白——和首屏直接给结论的做法不一致，
   * 用户得从头再选一遍。现在顺着上下文换：选的是省/州，就换成它所属的国家；
   * 选的是国家，就换成它下面按当前指标最大的那个省/州。像是「放大一级 / 缩小一级」。
   */
  const switchMode = (next: CompareMode) => {
    setMode(next);
    const current = sourceSelected[0];
    if (next === 'world-to-region') {
      const parent = current?.parentId;
      if (parent && countryById.has(parent)) {
        setSelected([parent]);
        return;
      }
      setSelected(['USA']); // 没有上下文就用最大的经济体
      return;
    }
    const biggest = current
      ? regions
          .filter((r) => r.parentId === current.id)
          .sort((a, b) => metricValue(b, metric) - metricValue(a, metric))[0]
      : undefined;
    setSelected(biggest ? [biggest.id] : ['CN-440000']);
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

  /** 当前应该高亮的对象：拼图时是玩家选中的，否则是对照结果 */
  const highlightedIds = useMemo(() => {
    if (puzzle) return new Set(puzzle.picked);
    return new Set((match?.items ?? []).map((i) => i.id));
  }, [puzzle, match]);

  /**
   * 排行的池子：国家与省/州放在一起。
   *
   * 之前只看「能选的对象」——省/州模式里只有省/州，于是「假如广东是一个国家」
   * 那个名次在榜上根本没法核对。现在两边都上榜；国家侧用参照物自己那一年
   * （与名次卡同口径），所以榜上读到的名次就是名次卡给的那个名次。
   */
  const rankingPool = useMemo<Region[]>(
    () => [...countriesAtSourceYear, ...regions],
    [countriesAtSourceYear, regions]
  );

  /**
   * 每个省/州「相当于多少个国家之和」——这个项目自己的说法，榜上直接标出来。
   *
   * 用当前口径算（尽量多凑 / 宁可超出），所以跟结论卡上的件数一致；
   * 「比大国家」「最像的一个」是跟单个对象比，没有「多少个」的概念，就不给。
   */
  const equivCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (!additive || (effectiveStrategy !== 'many' && effectiveStrategy !== 'over')) return m;
    const pool: GdpItem[] = countries.map((c) => ({ id: c.id, zh: c.zh, value: metricValue(c, metric) }));
    for (const r of regions) {
      const v = metricValue(r, metric);
      if (v <= 0) continue;
      m.set(r.id, matchByStrategy(v, pool, effectiveStrategy).count);
    }
    return m;
  }, [countries, regions, metric, additive, effectiveStrategy]);

  /**
   * 图例按视图走。
   *
   * 之前一套图例挂所有视图——在排行榜里「等价对象（由小到大）」是没意义的，
   * 在擂台里也没用。每个视图讲自己的颜色，读者才不用猜。
   */
  const legendItems = useMemo(() => {
    const twoSources = sourceSelected.length >= 2;
    if (view === 'rank') {
      return [
        { label: '这次对照出来的', color: PALETTE.matchedLow },
        { label: '当前选中的', color: PALETTE.source },
        { label: '其余对象', color: '#3a5f9e' }
      ];
    }
    if (view === 'square') {
      return [
        { label: '这次对照出来的对象', color: PALETTE.matchedLow },
        { label: '其余国家与地区', color: '#3b4e79' }
      ];
    }
    if (view === 'bracket') {
      return twoSources
        ? [
            { label: sourceSelected[0].zh, color: PALETTE.source },
            { label: sourceSelected[1].zh, color: PALETTE.source2 }
          ]
        : [];
    }
    // 地图 / 地球
    return [
      { label: '等价对象（由小到大）', color: PALETTE.matchedLow },
      { label: '其中最大的几个', color: PALETTE.matchedHigh },
      ...(twoSources
        ? [
            { label: sourceSelected[0].zh, color: PALETTE.source },
            { label: sourceSelected[1].zh, color: PALETTE.source2 }
          ]
        : [{ label: '参照地区', color: PALETTE.source }])
    ];
  }, [view, sourceSelected]);

  /** 排行榜：把对象按当前指标排开，选中的那条高亮。
      它给的是名次卡给不了的东西——前后邻居到底有多大。 */
  const rankingEntries = useMemo<RankEntry[]>(
    () =>
      rankingPool.map((r) => ({
        id: r.id,
        zh: r.zh,
        value: metricValue(r, metric),
        kind: r.kind,
        selected: selected.includes(r.id),
        matched: highlightedIds.has(r.id),
        // 国家标「国家」，省/州标所属国家——两类混在一张榜上时一眼看得出是哪类
        group: r.kind === 'country' ? '国家' : (r.parentName ?? '地区')
      })),
    [rankingPool, metric, selected, highlightedIds]
  );

  const globeHighlights = useMemo(() => {
    const m = new Map<string, { id: string; label: string; gdp?: number; color: string }>();
    const items = puzzle
      ? puzzle.picked.map((id) => {
          const c = allCountries.find((x) => x.id === id);
          return { id, zh: c?.zh ?? id, value: c ? metricValue(c, puzzle.metric) : 0 };
        })
      : (match?.items ?? []);
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
  }, [match, puzzle, isRegionMode, regionById, allCountries]);

  /**
   * 参照物的颜色：第一个青、第二个紫。
   *
   * 两个地方对比时，地图上两个都得看得见，还得能分清谁是谁——一种颜色画两个
   * 形状，读者只能靠位置猜。颜色只有两种，第三个参照物就复用青色。
   * 两种颜色分不出区别时（两个参照物落在同一块地面上，同一份几何），
   * 宁可退回一种颜色，也不要画一个看不出来的「区分」。
   */
  const sourceColors = useMemo(() => {
    const geoIds = new Set(sourceSelected.map((r) => r.geometryId));
    if (sourceSelected.length > 1 && geoIds.size < sourceSelected.length) return [PALETTE.source];
    return sourceSelected.map((_, i) => (i % 2 === 1 ? PALETTE.source2 : PALETTE.source));
  }, [sourceSelected]);

  /** 几何 id → 颜色（中国小图这类按 id 上色的地方要用） */
  const sourceColorMap = useMemo(() => {
    const m = new Map<string, string>();
    sourceSelected.forEach((r, i) => m.set(r.geometryId, sourceColors[i] ?? PALETTE.source));
    return m;
  }, [sourceSelected, sourceColors]);

  const globeSources = useMemo(() => {
    const m = new Map<string, { id: string; label: string; gdp?: number; color: string }>();
    if (!isRegionMode) {
      sourceSelected.forEach((r, i) => {
        m.set(r.geometryId, {
          id: r.geometryId,
          label: r.zh,
          gdp: r.gdpUsd,
          color: sourceColors[i] ?? PALETTE.source
        });
      });
    }
    return m;
  }, [isRegionMode, sourceSelected, sourceColors]);

  /**
   * 参照物在 2D 地图上的高亮。
   *
   * 之前完全没传，地图上分不出「我选的是哪个」和「它等于哪些」——
   * 选德州，51 个州长得一模一样；选日本的县，那个县连轮廓都不画。
   * 现在：地方→世界时在细分层里标出来（青色），世界→地方时在国家层里标出来。
   */
  const sourceSubHighlights = useMemo(() => {
    if (!isRegionMode) return [];
    return sourceSelected.map((r, i) => ({
      id: r.geometryId,
      rank: i,
      label: r.zh,
      value: r.gdpUsd,
      color: sourceColors[i] ?? PALETTE.source
    }));
  }, [isRegionMode, sourceSelected, sourceColors]);

  const sourceCountryHighlights = useMemo(() => {
    if (isRegionMode) return [];
    return sourceSelected.map((r, i) => ({
      id: r.id,
      rank: i,
      label: r.zh,
      value: r.gdpUsd,
      color: sourceColors[i] ?? PALETTE.source
    }));
  }, [isRegionMode, sourceSelected, sourceColors]);

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

  /**
   * 拿要导出的那张 SVG。
   *
   * 排行视图是 HTML（条形榜）没有 SVG，直接查会拿到 null，导出按钮就报「地图未就绪」。
   * 这时切回地图视图再拿——导出的本来就是地图，跟动图导出一个做法。
   */
  const exportSvg = async (): Promise<SVGSVGElement> => {
    const find = () =>
      document.querySelector<SVGSVGElement>(view === 'globe' ? '.globe-wrap svg' : '.map-holder svg');
    let svg = find();
    if (!svg) {
      setView('map');
      await nextPaint();
      await new Promise((r) => setTimeout(r, 400));
      svg = document.querySelector<SVGSVGElement>('.map-holder svg');
    }
    if (!svg) throw new Error('地图未就绪');
    return svg;
  };

  const handleExportCard = async () => {
    try {
      const svg = await exportSvg();
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
          (headline ? titleText(headline) : null) ??
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
      const svg = await exportSvg();
      setToast('正在生成高清图…');
      await exportPng({
        svg,
        title: (headline ? titleText(headline) : null) ?? (sourceSelected.length ? sourceLabel : 'GDP 等价地图'),
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

  /**
   * 导出动图：让年份从 1990 走到 2025，一帧一年（隔年取一帧）。
   *
   * 每一帧都要界面真的切到那一年，所以是「改状态 → 等它画完 → 抓图」，
   * 不能只改个变量就抓。中途要把年份复原。
   */
  const handleExportGif = async () => {
    try {
      if (view !== 'map') {
        setView('map');
        await nextPaint();
      }
      const years: number[] = [];
      for (let y = 1990; y <= 2024; y += 2) years.push(y);
      years.push(2025);
      const savedYear = worldYear;
      setPlaying(false);
      setToast('正在生成动图…');
      await exportGif({
        frameCount: years.length,
        frameAt: async (i) => {
          setWorldYear(years[i]);
          await nextPaint();
          const svg = document.querySelector<SVGSVGElement>('.map-holder svg');
          if (!svg) throw new Error('地图未就绪');
          return {
            svg,
            title: `${sourceLabel} · ${years[i]} 年`,
            subtitle: conclusionRef.current
          };
        },
        fileName: `gdp-equivalence-${years[0]}-${years[years.length - 1]}.gif`,
        onProgress: (done, total) => setToast(`正在生成动图… ${done}/${total}`)
      });
      setWorldYear(savedYear);
      setToast('动图已导出');
      setShareOpen(false);
    } catch (e) {
      setToast(e instanceof Error ? e.message : '动图导出失败');
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
    <div className={`app ${motionOn ? 'motion-on' : 'motion-off'}`}>
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
            <button type="button" className={view === 'rank' ? 'active' : ''} onClick={() => setView('rank')}>
              排行
            </button>
          </div>

          <div className="header-actions">
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
                    <span>竖版 2400px 宽，适合发群</span>
                  </button>
                  <button type="button" onClick={handleExportHires}>
                    <b>下载高清图</b>
                    <span>横版 3600px 宽</span>
                  </button>
                  <button type="button" onClick={handleExportGif}>
                    <b>下载动图</b>
                    <span>1990→2025 看它怎么变</span>
                  </button>
                </div>
              ) : null}
            </div>
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
            {isRegionMode ? (
              <label className="toggle inline">
                <input
                  type="checkbox"
                  checked={ignoreMicro}
                  onChange={(e) => setIgnoreMicro(e.target.checked)}
                />
                <span>忽略微型经济体（人口不足 100 万）</span>
              </label>
            ) : null}
          </section>

          {/*
            年份条：以前藏在「更多选项」里，要展开才看得见「▶ 播放」——
            可它直接决定结论是哪一年的（面板里那句「在 2024 年的 189 个经济体里排第 22 位」）。
            所以提到结论卡正下方，直接露出来。
          */}
          <section className="year-panel">
            <div className="picker-head">
              <h2>拿哪一年的世界来比</h2>
              <span className="year-tools">
                <button
                  type="button"
                  className={playing ? 'play-btn on' : 'play-btn'}
                  onClick={togglePlay}
                  aria-pressed={playing}
                  title="从 1990 年播到 2025 年，看这个地方的体量怎么变"
                >
                  {playing ? '⏸ 暂停' : '▶ 播放'}
                </button>
                <span className="year-now">{worldYear}</span>
              </span>
            </div>
            <input
              className="year-slider"
              type="range"
              min={1990}
              max={2025}
              step={1}
              value={worldYear}
              onChange={(e) => setYear(Number(e.target.value))}
              aria-label="国家数据年份"
            />
            <div className="year-ticks">
              <button type="button" onClick={() => setYear(1990)}>
                1990
              </button>
              <button type="button" onClick={() => setYear(2000)}>
                2000
              </button>
              <button type="button" onClick={() => setYear(2010)}>
                2010
              </button>
              <button type="button" onClick={() => setYear(2024)}>
                2024
              </button>
            </div>
            <p className="picker-hint">
              国家数据可回溯到 1990 年（2025 为 IMF 预测值），省/州按各自年份。
              往后拨能看出「今天这个地方放在当年是什么水平」，按「播放」让它自己走一遍。
            </p>
          </section>

          <RegionPicker
            // 换方向时重建：否则上一次搜的词还留在框里，列表看着像空的
            key={mode}
            title={isRegionMode ? '选择一个省 / 州' : '选择一个国家'}
            hint={
              isRegionMode
                ? additive
                  ? '中国的省级行政区、美国的州、欧洲的一级区、日本的都道府县都有经济总量，可以直接跟世界比；多选会先加总。'
                  : '这些省/州都有经济总量。人均与密度不能相加，所以只能选一个。'
                : '选一个国家，看它相当于哪些省/州加起来。'
            }
            metric={metricDef}
            items={sourcePool}
            // 数据还没到的时候，列表是空的——那不是「没匹配到」，是「还在加载」
            emptyLabel={dataset ? '没有匹配的地区' : '加载中…'}
            groups={pickerGroups}
            selected={selected}
            onToggle={toggle}
            onClear={() => setSelected([])}
            multi={isRegionMode && additive}
          />

          <section className="quick-panel">
            <div className="picker-head">
              <h2>换换口味</h2>
            </div>
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
          </section>

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
              animate={motionOn}
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
            {view === 'rank' ? (
              <div className="map-holder rank-holder">
                <RankingView
                  entries={rankingEntries}
                  format={metricDef.format}
                  noteFor={(e) => (e.selected ? '当前选中' : undefined)}
                  equivCount={(e) => (e.kind === 'region' ? equivCounts.get(e.id) : undefined)}
                  onSelect={selectFromRanking}
                />
                <p className="view-caption">
                  {`国家与省/州按「${metricDef.label}」排在一起（国家侧用 ${sourceYear} 年的数据）。省/州后面标着它相当于多少个国家。`}
                </p>
              </div>
            ) : view === 'square' ? (
              <div className="map-holder">
                <SquareCartogram
                  items={countries.map((c) => ({
                    id: c.id,
                    zh: c.zh,
                    value: metricValue(c, metric),
                    matched: highlightedIds.has(c.id)
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
                      sources={[]}
                      totalRanks={Math.max(1, countryHighlights.length)}
                      formatValue={metricDef.format}
                      subdivisions={subdivisions ?? undefined}
                      subHighlights={sourceSubHighlights}
                      southSea={china ? <SouthSeaBox geo={china} x={MAP_W - 126} y={MAP_H - 146} width={108} height={128} /> : null}
                      onSelect={handleMapClick}
                      chinaInset={
                        sourceSelected.some((r) => r.parentId === 'CHN') ? (
                          <ChinaInset china={china} highlightColors={sourceColorMap} />
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
                    sources={sourceCountryHighlights}
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
              {legendItems.map((item) => (
                <span className="legend-item" key={item.label}>
                  {item.color ? <i className="swatch" style={{ background: item.color }} /> : null}
                  {item.label}
                </span>
              ))}
              <span className="legend-item motion-item">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={motionOn}
                    onChange={(e) => setMotionOverride(e.target.checked)}
                  />
                  <span>动效</span>
                </label>
                {systemReduced && !motionOn ? (
                  <em className="motion-hint">系统关了动画，这里可以打开</em>
                ) : null}
              </span>
            </div>
            {dataset ? (
              <details
                className="sources-details"
                open={sourcesOpen}
                onToggle={(e) => setSourcesOpen(e.currentTarget.open)}
              >
                <summary>数据来源与口径</summary>
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
                  {dataset.meta.extraRegionSource ? dataset.meta.extraRegionSource : null}
                  <br />
                  {dataset.meta.note}
                </p>
              </details>
            ) : null}
          </footer>
        </main>
      </div>

      {motionHint ? (
        <div
          className="toast motion-toast"
          role="status"
          onClick={() => {
            setMotionOverride(true);
            setMotionHint(false);
          }}
          title="点击打开动效"
        >
          系统关掉了动画效果，网站的动效也跟着静了 —— 点这里打开
        </div>
      ) : null}

      {toast ? (
        <div className="toast" onClick={() => setToast(null)} role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

/** 中国小图（世界地图左下角的定位插图） */
function ChinaInset({
  china,
  highlightColors
}: {
  china: FeatureCollection;
  /** 几何 id → 颜色。两个参照物时各用各的颜色，分得清谁是谁 */
  highlightColors: Map<string, string>;
}) {
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
        const color = highlightColors.get(id);
        return (
          <path
            key={id}
            d={path(f as never) ?? ''}
            fill={color ?? 'rgba(30,42,72,0.9)'}
            fillOpacity={color ? 1 : 0.75}
            stroke={color ? 'rgba(255,255,255,0.6)' : '#26314f'}
            strokeWidth={color ? 0.8 : 0.3}
          />
        );
      })}
      <text x={width / 2} y={height + 10} className="sea-label" textAnchor="middle">
        中国
      </text>
    </g>
  );
}

