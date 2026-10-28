import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { geoPath } from 'd3-geo';
import { GlobeView } from './components/GlobeView';
import { Bracket } from './components/Bracket';
import { RegionPicker } from './components/RegionPicker';
import { ResultPanel } from './components/ResultPanel';
import { PlayView } from './components/PlayView';
import type { PassportGroup } from './components/Passport';
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
  loadHistory,
  mergeHistory,
  loadUsStates,
  loadWorld,
  metricValue,
  splitDataset,
  toRegion
} from './lib/data';
import { copyText, exportPng, exportShareCard } from './lib/export';
import { exportGif, gifFrameYears } from './lib/export-gif';
import { createChinaProjection, featureMainCentroid, mixColor, PALETTE } from './lib/geo';
import { useSystemReducedMotion } from './lib/motion';
import {
  BIG_POOL_SIZE,
  closestSingle,
  matchByStrategy,
  relativeError,
  STRATEGY_HINT,
  STRATEGY_LABEL,
  topByValue,
  usableCount
} from './lib/match';
import type { GdpItem, MatchStrategy } from './lib/match';
import { METRICS, METRIC_DEFAULT_STRATEGY, METRIC_HINT, METRIC_HINT_REVERSE, METRIC_ORDER, titleText, titleValueText } from './lib/metrics';
import type { MetricId, MetricTitle } from './lib/metrics';
import {
  challengeUrlFor,
  dailyShareText,
  dailyTargetFor,
  loadProgress,
  puzzleShareText,
  recordDaily,
  saveProgress,
  scoreFor,
  todayKey
} from './lib/play';
import type { BlindItem, HigherItem, PlayProgress } from './lib/play';
import { anchorYear, toPriceBasis } from './lib/price';
import { dataSourceLine } from './lib/sources';
import { loadState, shareUrl, writeState } from './lib/url';
import { buildMatchVariants } from './lib/variants';
import type { CompareMode, FeatureCollection, GeoFeature, Region, ViewMode } from './lib/types';

/** 世界地图的画布尺寸（与 WorldMap 的默认 viewBox 一致） */
const MAP_W = 1000;
const MAP_H = 520;

/**
 * 源码仓库地址。
 *
 * 顶栏的 GitHub 图标与页脚的「源码」链接都指向它——
 * 一个数据项目应该让人能找到它的数据是怎么来的。
 */
const REPO_URL = 'https://github.com/rockbenben/gdp-map';

/**
 * GitHub 官方 mark（24×24 那版路径，缩到 16px 显示）。
 *
 * ⚠️ **必须用 24 单位的路径 + `viewBox="0 0 24 24"`**：
 * 网上常见的「16×16 版」路径画出来只有 8.9 宽（半边），
 * 另一版 16 单位路径又画到 21 高（尾巴出框）——两种都会缺一块。
 * 这版量过：包围盒 23.8×23.7，正好落在框里。
 */
function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 4 16.615 4 16.615c0-1.38.965-2.385 2.24-2.385 1.2 0 1.795.78 1.795.78 1.05 1.8 2.805 1.305 3.495.998.108-.776.42-1.305.763-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
      />
    </svg>
  );
}

/** 等界面把一次状态变更画完（两次 rAF：第一帧提交，第二帧才是画好的） */
const nextPaint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** 拼图最多能选几个国家 */
const PUZZLE_MAX = 3;

/**
 * 开玩前的对照状态。
 *
 * 玩一局/每日挑战/挑战好友会把地图切到游戏目标（换地区、换指标、换年份），
 * 退出时要还原成用户原来正在看的对照，否则「玩一局」会悄悄改掉他的题目。
 */
interface GameSnapshot {
  mode: CompareMode;
  view: ViewMode;
  selected: string[];
  metric: MetricId;
  strategy: MatchStrategy;
  ignoreMicro: boolean;
  worldYear: number;
}

/**
 * 「世界 → 地方」模式下，对照池至少要有多少个省/州，那一年才算能选。
 *
 * 省/州的数据不是同时开始的：港澳台（世界银行口径）从 1960 起，美国州 1997 起，
 * 中国省 2000 起，欧盟 2000 起，日本府县只有 2023。
 * 所以早年的池子里只有一两个「经济体」（1960 年只有香港），
 * 拿它跟德国比没有可比性——结论会变成「德国 ≈ 1 个省/州之和」。
 * 池子规模站得住的年份才放进年份控件。
 */
const MIN_POOL_SIZE = 10;

/**
 * 把「有数据的年份」压成一段段区间：2000–2011、2024。
 *
 * 目标的数据可能有缺口（欧盟一级区只有 2000–2024、日本府县只有 2023），
 * 说清楚是哪几段，比只说一个起止年要诚实。
 */
function yearRanges(years: number[]): string {
  const sorted = [...years].sort((a, b) => a - b);
  if (!sorted.length) return '';
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const y of sorted.slice(1)) {
    if (y === prev + 1) {
      prev = y;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = y;
    prev = y;
  }
  parts.push(start === prev ? `${start}` : `${start}–${prev}`);
  return parts.join('、');
}

/**
 * 每个视图里那块画布的宽高比（宽 ÷ 高）。
 *
 * 地图的高度是宽度决定的，所以窗口矮的时候宽度得让开——
 * 不让的话地图会压到页脚上（1366x768 实测压掉 49px，页脚的字画在地图上）。
 * 页脚的高度是动态的（数据来源那段展开时最宽），所以这里不写死，
 * 由 `useMapMaxWidth` 量出可用高度再算。
 */
const VIEW_ASPECT: Record<ViewMode, number> = {
  map: MAP_W / MAP_H,
  globe: 1,
  square: 1100 / 620,
  bracket: 880 / 560,
  rank: 0,
  play: 0
};

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
  // 首次进来别给一片空地图：默认就有一个现成的结论看。
  // 默认值要跟 mode 匹配：world-to-region 的池子是国家，塞一个省进去会落空。
  const [selected, setSelected] = useState<string[]>(() => {
    if (initial.selected.length) return initial.selected;
    return initial.mode === 'world-to-region' ? ['USA'] : ['CN-440000'];
  });
  const [metric, setMetric] = useState<MetricId>(initial.metric);
  const [strategy, setStrategy] = useState<MatchStrategy>(initial.strategy);
  const [ignoreMicro, setIgnoreMicro] = useState(initial.ignoreMicro);
  const [worldYear, setWorldYear] = useState(initial.worldYear);
  /** 0 原版；1/2 熟脸；最后一个随机。URL 的 v 参数复现同一版。 */
  const [variantIndex, setVariantIndex] = useState(initial.variant);
  /** 年份是否在自动播放 */
  const [playing, setPlaying] = useState(false);
  const [puzzle, setPuzzle] = useState<{
    target: number;
    label: string;
    metric: MetricId;
    picked: string[];
    done: boolean;
    /** 真提交过（不是「看答案」），才计成绩 */
    submitted: boolean;
    regionId: string;
    year: string;
    /** 每日挑战的日期键；普通拼图为 null */
    daily: string | null;
    /** 挑战链接里对方的分数 */
    challengeScore: number | null;
  } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [progress, setProgress] = useState<PlayProgress>(() => loadProgress());

  /**
   * 量出「舞台里能给画布留多宽」，写进 `--map-max`。
   *
   * 地图是宽高比固定的东西（1000:520），高度得跟着可用高度走：
   * 窗口矮的时候不缩窄，地图就会压到页脚上（1366x768 实测压掉 49px，
   * 页脚的字直接画在地图上，读不了）。
   * 页脚的高度是动态的（数据来源那段展开时最宽），所以这里不写死数字，
   * 量出来再算。用 ResizeObserver 跟着窗口与视图变化重算，
   * 写的是 CSS 变量，不触发 React 重渲染。
   * ⚠️ 用 useLayoutEffect 而不是 useEffect：后者在首帧**之后**才跑，
   * 页面会先按兜底的 1180 宽画一帧、再跳到真尺寸（看着像闪了一下）。
   */
  useLayoutEffect(() => {
    const inner = document.querySelector<HTMLElement>('.stage-inner');
    const aspect = VIEW_ASPECT[view];
    if (!inner || !aspect) return;
    const update = () => {
      const cap = inner.querySelector<HTMLElement>('.stage-caption');
      // 可用高度 = 舞台内容区 - 上下留白 - 图注 - 间隙 - 画布自己的内边距
      const avail = inner.clientHeight - 28 - (cap ? cap.offsetHeight + 10 : 0) - 22;
      inner.style.setProperty('--map-max', `${Math.max(360, Math.floor(avail * aspect))}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [view]);

  /**
   * 分享菜单：点外面或按 Esc 收起。
   *
   * 以前只能再点一次「分享」才关得掉——鼠标用户还能忍，键盘用户直接被卡住。
   * ⚠️ **关闭菜单的那一下不能穿透到页面**：实测点地图空白处收起菜单，
   * 同一次点击会落到地图上的国家路径，把「河南」悄悄换成「巴拉圭」。
   * 所以在捕获阶段把这一下吃掉；但**要放行 `<a>`**——导出会临时创建一个
   * `<a download>` 并 `.click()`，一起拦掉的话会出现「已导出」却没有文件。
   */
  useEffect(() => {
    if (!shareOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShareOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t.closest('.share-wrap')) return;
      if (t.closest('a')) {
        setShareOpen(false);
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      setShareOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick, true);
    };
  }, [shareOpen]);
  /** 用户是否已经动过选择（用于区分「第一次点击」和「继续多选」） */
  const touchedRef = useRef(false);
  /**
   * 提示条。
   *
   * ⚠️ **收的时候也要有动效**：直接卸载是「啪」地一下消失，页面看着像抖了一下。
   * 现在收之前先播一段退场（`.toast.out`），播完再卸载。
   * ⚠️ 导出进度每帧都会更新提示，于是重新计时——这是原来那个 useEffect 的行为，保留。
   */
  const [toast, setToastText] = useState<string | null>(null);
  const [toastOut, setToastOut] = useState(false);
  const toastTimer = useRef<number | null>(null);

  const setToast = useCallback((text: string | null) => {
    if (toastTimer.current != null) {
      window.clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
    if (text == null) {
      setToastOut(true);
      toastTimer.current = window.setTimeout(() => {
        setToastText(null);
        setToastOut(false);
        toastTimer.current = null;
      }, 200);
      return;
    }
    setToastOut(false);
    setToastText(text);
    // 六秒后自己收起来
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  // 卸载时别再改状态（导出中关掉页面会触发）
  useEffect(
    () => () => {
      if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    },
    []
  );

  const metricDef = METRICS[metric];
  /**
   * 年份范围：跟着数据走，别写死在代码里。
   * 1960–1989 是世界银行口径，1990–2025 是 IMF WEO。
   */
  const [yearFromText, yearToText] = dataset?.meta.yearRange ?? ['1960', '2025'];
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
   * 正在拖年份滑块。
   *
   * 拖动期间地图颜色要**立刻**跟手，不能走 0.55s 的过渡——
   * 过渡追不上滑块，地图看着是糊的。这个标记写进 `.app.scrubbing`，
   * 由 CSS 把过渡关掉（见 styles.css「拖年份滑块时要把过渡关掉」）。
   */
  const [scrubbing, setScrubbing] = useState(false);
  /**
   * 拖动结束一定要把 `scrubbing` 清掉。
   *
   * ⚠️ 只在滑块上监听 pointerup 是不够的：手指在滑块外松手时，
   * 那个事件不一定送得到滑块上——标记卡住的话，全站的过渡就永远没了。
   * 所以再挂一层 window 级的兜底。
   */
  useEffect(() => {
    if (!scrubbing) return;
    const clear = () => setScrubbing(false);
    window.addEventListener('pointerup', clear);
    window.addEventListener('pointercancel', clear);
    return () => {
      window.removeEventListener('pointerup', clear);
      window.removeEventListener('pointercancel', clear);
    };
  }, [scrubbing]);
  /**
   * 系统关了动画时提示一次。
   *
   * 用户看到的是「页面一点动静都没有」，但他不知道是网站没做动效，
   * 还是自己的系统关了动画——不说明白，他就只会觉得「这网站是死的」。
   * 点一下就能打开动效。
   */
  const [motionHint, setMotionHint] = useState(false);
  useEffect(() => {
    if (!systemReduced || motionOverride !== null) {
      setMotionHint(false);
      return;
    }
    let seen = false;
    try {
      seen = localStorage.getItem('gdp-motion-hint-seen') === '1';
    } catch {
      // 隐私模式下 localStorage 可能不可用；退化成「每次打开都提示」
    }
    setMotionHint(!seen);
  }, [systemReduced, motionOverride]);
  const dismissMotionHint = () => {
    setMotionHint(false);
    try {
      localStorage.setItem('gdp-motion-hint-seen', '1');
    } catch {
      // 同上
    }
  };
  /** 宽屏才默认展开数据来源（窄屏先给结论） */
  const [wide] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= 1080
  );
  const [sourcesOpen, setSourcesOpen] = useState(wide);

  /**
   * 加载分两波，别一次把 700 多 KB 全等齐才渲染。
   *
   * ⚠️ **第一波（首屏要等的）**：基础数据（每对象的默认年，约 36 KB gzip）+ 世界底图（约 90 KB gzip）。
   *    到了就能出结论——「打开就有结果」不能等历史数据。
   * ⚠️ **第二波（随后到）**：
   *    - 省/州细分层（china 167 KB、us-states 104 KB）：地图先画世界，边界后补上；
   *    - 历史数据（约 342 KB gzip）：年份回溯要用，到齐后年份控件才可用。
   *
   * 之前是四个文件一起等（733 KB gzip），手机上首屏光等数据就一两秒。
   */
  const [historyReady, setHistoryReady] = useState(false);
  /** 历史数据加载失败的原因；失败时年份控件保持禁用，不能假装「只有默认年」 */
  const [historyError, setHistoryError] = useState<string | null>(null);
  /** 历史数据的加载 promise：导出动图要等它（动图每帧都要切年份，缺历史就全是空帧） */
  const historyPromiseRef = useRef<Promise<void> | null>(null);
  /** 导出函数读的可靠状态：state 在 await 之后可能是旧的 */
  const historyStatusRef = useRef<'loading' | 'ready' | 'error'>('loading');
  /** 读 ref 的函数：直接比较 ref.current 会被 TS 的控制流窄化，误判 await 之后不可能变 */
  const isHistoryReady = () => historyStatusRef.current === 'ready';
  useEffect(() => {
    let cancelled = false;
    // ⚠️ **数据与底图分开到**：结论只等数据（约 36 KB gzip），地图晚一点到也没关系——
    //    「先给结论」是规则 #16 的要求，文字不必等地图。
    loadDataset()
      .then((d) => {
        if (cancelled) return;
        setDataset(d);
        // 第二波：细分层（地图先画世界，边界后补）
        loadChina()
          .then((c) => !cancelled && setChina(c))
          .catch((e) => console.warn('中国省界加载失败', e));
        loadUsStates()
          .then((u) => !cancelled && setUsStates(u))
          .catch((e) => console.warn('美国州界加载失败', e));
        // 第二波：历史数据（年份回溯要用）
        historyPromiseRef.current = loadHistory()
          .then((h) => {
            if (cancelled) return;
            setDataset((cur) => (cur ? mergeHistory(cur, h) : cur));
            historyStatusRef.current = 'ready';
            setHistoryReady(true);
          })
          .catch((e) => {
            if (cancelled) return;
            console.warn('历史数据加载失败', e);
            historyStatusRef.current = 'error';
            setHistoryError('历史数据加载失败，年份回溯不可用');
          });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    loadWorld()
      .then((w) => !cancelled && setWorld(w))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const year = dataset?.meta.defaultYear ?? '2024';

  /**
   * 手动拨年份就把播放停掉：用户想自己控制节奏。
   *
   * ⚠️ 历史数据没到之前不能拨：那一年的值不在基础文件里，
   *    拨过去只会得到「0 个国家」这种空结论。等历史到了再拨。
   */
  const setYear = (y: number) => {
    setPlaying(false);
    // 拼图的目标在开局时按当时那一年算好了；拨年份会让目标和对照池脱节
    if (puzzle) return;
    if (!historyReady && y !== Number(year)) return;
    setWorldYear(y);
  };

  /** 玩法视图的年份：用国家侧全量年份，不受参照物的可选年份限制 */
  const setPlayYear = (y: number) => {
    if (puzzle || !historyReady) return;
    setPlaying(false);
    setWorldYear(y);
  };

  /**
   * URL 里指定的年份要等历史数据到齐才生效。
   *
   * 基础文件里只有每个对象的默认年（2024 / 2023），
   * 所以直接停在 ?y=2010 上，结论会是一句空话。
   * 做法：历史没到之前先停在默认年，到了再跳到 URL 指定的那一年。
   */
  const requestedYearRef = useRef(initial.worldYear);
  useEffect(() => {
    if (historyReady) return;
    if (worldYear !== Number(year)) setWorldYear(Number(year));
  }, [historyReady, worldYear, year]);
  useEffect(() => {
    if (!historyReady) return;
    const want = requestedYearRef.current;
    if (want !== Number(year)) setWorldYear(want);
  }, [historyReady, year]);

  /**
   * 写进 URL 的年份。
   *
   * 历史没到之前界面先停在默认年，但 URL 不能跟着被改掉：
   * 否则分享链接里的 ?y=2010 在慢网上刷新一次就丢了。
   */
  const urlYear =
    !historyReady && requestedYearRef.current !== Number(year)
      ? requestedYearRef.current
      : worldYear;

  /**
   * 数据里真的有的那些年份。
   *
   * 滑块和播放都按这份清单走，不然会一路滑到没有数据的年份，
   * 结论变成「0 个国家」。
   */
  const playableYears = useMemo(() => {
    if (!dataset) return [] as number[];
    const set = new Set<number>();
    for (const o of dataset.objects) {
      if (o.kind !== 'country') continue;
      // ⚠️ 用 `o.years`（对象自带的有数据的年份清单），不要用指标键：
      //    基础文件里只有默认年的数值，用指标键的话滑块范围会塌成一年。
      for (const y of o.years ?? Object.keys(o.metrics.gdp.nominal)) set.add(Number(y));
    }
    return [...set].filter((y) => Number.isFinite(y)).sort((a, b) => a - b);
  }, [dataset]);

  // 播放：让年份自己往前走（见下面的 selectableYears —— 走的是「能选的那些年」）。

  const { countries: allCountries, regions } = useMemo(
    () => (dataset ? splitDataset(dataset, String(worldYear), String(worldYear)) : { countries: [], regions: [] }),
    [dataset, worldYear]
  );

  /** 可参与对照的国家池：开启「忽略微型经济体」时剔掉人口不足 100 万的 */
  const countries = useMemo(
    () => (ignoreMicro ? allCountries.filter((c) => !c.isMicro) : allCountries),
    [allCountries, ignoreMicro]
  );

  const regionById = useMemo(() => new Map(regions.map((r) => [r.id, r])), [regions]);
  const countryById = useMemo(() => new Map(allCountries.map((c) => [c.id, c])), [allCountries]);
  /** 悬停提示里的中文国名（geo 里存的是英文名） */
  const countryName = useCallback(
    (id: string) => countryById.get(id)?.zh ?? id,
    [countryById]
  );

  // ---------- 玩法数据 ----------
  const today = todayKey();
  /** 每日题的地区池：每个地区取自己的默认年（日本府县 2023，其余 2024） */
  const dailyRegions = useMemo(() => {
    if (!dataset) return [] as Region[];
    const defaultYear = dataset.meta.defaultYear ?? '2024';
    return dataset.objects
      .filter((o) => o.kind === 'region')
      .map((o) => toRegion(o, o.year ?? defaultYear));
  }, [dataset]);
  const dailyTarget = useMemo(() => dailyTargetFor(today, dailyRegions), [today, dailyRegions]);

  /** Higher/Lower 的牌：国家走 ignoreMicro，省/州全上 */
  const higherItems = useMemo<HigherItem[]>(
    () =>
      [...countries, ...regions]
        .map((r) => ({
          id: r.id,
          zh: r.zh,
          value: metricValue(r, metric),
          kind: r.kind,
          parentName: r.parentName
        }))
        .filter((x) => x.value > 0),
    [countries, regions, metric]
  );

  const passportGroups = useMemo<PassportGroup[]>(() => {
    const regionItem = (r: Region) => ({ id: r.id, zh: r.zh, kind: 'region' as const });
    const countryItem = (c: Region) => ({ id: c.id, zh: c.zh, kind: 'country' as const });
    return [
      { key: 'cn', label: '中国省级', items: regions.filter((r) => r.parentId === 'CHN').map(regionItem) },
      { key: 'us', label: '美国州', items: regions.filter((r) => r.parentId === 'USA').map(regionItem) },
      { key: 'eu', label: '欧洲 NUTS-1', items: regions.filter((r) => r.id.startsWith('EU-')).map(regionItem) },
      { key: 'jp', label: '日本都道府县', items: regions.filter((r) => r.id.startsWith('JP-')).map(regionItem) },
      { key: 'world', label: '国家', items: allCountries.map(countryItem) }
    ];
  }, [regions, allCountries]);

  const isRegionMode = mode === 'region-to-world';
  /** 参照对象池：地方 → 世界时是省/州，世界 → 地方时是国家 */
  const sourcePool = isRegionMode ? regions : allCountries;
  /**
   * 选择器里真正能选的对象：面积口径下剔掉没有面积的对象（科索沃）。
   * 其他指标不要按当前年份过滤——日本府县在 2024 是「—」，
   * 但选中后年份会切到 2023；按当年值过滤会把它们从选择器里删掉。
   */
  const pickerPool = useMemo(
    () => (metric === 'area' ? sourcePool.filter((r) => metricValue(r, 'area') > 0) : sourcePool),
    [sourcePool, metric]
  );
  /** 人均这类指标不可叠加：只允许选一个，且只能用「最接近」口径 */
  const additive = metricDef.additive;
  const effectiveStrategy: MatchStrategy = additive ? strategy : 'nearest';
  const sourceSelected = useMemo(() => {
    const picked = selected.map((id) => sourcePool.find((r) => r.id === id)).filter(Boolean) as Region[];
    return additive ? picked : picked.slice(0, 1);
  }, [selected, sourcePool, additive]);

  // 选过的参照物自动进经济护照
  useEffect(() => {
    if (!sourceSelected.length) return;
    const ids = sourceSelected.map((r) => r.id);
    setProgress((p) => {
      if (ids.every((id) => p.passport.includes(id))) return p;
      return { ...p, passport: [...p.passport, ...ids.filter((id) => !p.passport.includes(id))] };
    });
  }, [sourceSelected]);

  // URL 里的 sel 可能和 mode 不匹配（旧链接、手改链接）：落到当前池子里
  useEffect(() => {
    if (!dataset || !sourcePool.length || !selected.length) return;
    if (selected.some((id) => sourcePool.some((r) => r.id === id))) return;
    setSelected([isRegionMode ? 'CN-440000' : 'USA']);
  }, [dataset, sourcePool, selected, isRegionMode]);

  /**
   * 年份控件能选的范围：**目标（和对照池）都有数据的年份**。
   *
   * 规则：「拿哪一年的世界来比，选中目标的 GDP 也该变动」——
   * 目标没有那一年的数据，就不该提供那一年；否则就是拿 2024 年的河南
   * 去比 2010 年的世界，两边年份对不上，结论是拼出来的。
   *
   * 目标是谁：
   * - 地方 → 世界：选中的省/州（多选时取交集，每个都得有那一年）
   * - 世界 → 地方：国家侧（1960–2025）**加上**对照池那一年也有省/州——
   *   否则会出现「德国 ≈ 0 个省/州之和」这种结论（省/州最早只到 1997 年）。
   *
   * 对照池里没有那一年的对象照旧按 0 算，口径行会写明「当年有记录 N 个」。
   */
  /**
   * 每一年的省/州对照池有多大（当年有数据的省/州个数）。
   *
   * ⚠️ 这个数字决定「世界 → 地方」模式能选哪些年：
   *    1960 年只有香港一个省/州有数据，拿它跟德国比没有可比性
   *    （结论会变成「德国 ≈ 1 个省/州之和」）。
   *    池子规模站得住的年份才给。
   */
  const regionPoolSize = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of regions) {
      for (const y of r.years) m.set(Number(y), (m.get(Number(y)) ?? 0) + 1);
    }
    return m;
  }, [regions]);

  /** 完整对象池（含历史序列）：按候选年份查指标值用 */
  const objectById = useMemo(
    () => new Map(dataset?.objects.map((o) => [o.id, o]) ?? []),
    [dataset]
  );

  const selectableYears = useMemo(() => {
    if (!playableYears.length) return [] as number[];
    if (!sourceSelected.length) return playableYears;
    // 面积不随年份变：年份只影响对照池的成员，选它只会让标题写出
    // 「广东省的面积 ≈ 2000 年的柬埔寨」这种像在说面积有年份的话。
    if (metric === 'area') {
      const fallback = Number(dataset?.meta.defaultYear ?? yearToText);
      return playableYears.includes(fallback) ? [fallback] : [playableYears[playableYears.length - 1]];
    }
    const sets = sourceSelected.map((r) => new Set(r.years));
    // 年份清单是 GDP 口径；换成人口/人均/密度时，那一年可能没有这个指标的值。
    // 用完整序列再验一遍，避免「年份能选、结论是 0」。
    const hasMetric = (id: string, y: number) => {
      const o = objectById.get(id);
      if (!o) return false;
      return metricValue(toRegion(o, String(y)), metric) > 0;
    };
    const years = playableYears.filter(
      (y) => sets.every((s) => s.has(String(y))) && sourceSelected.every((r) => hasMetric(r.id, y))
    );
    if (isRegionMode) return years;
    // 世界 → 地方：对照池是省/州，池子里得有人有那一年的数据，
    // 而且**规模得站得住**（见 MIN_POOL_SIZE）
    return years.filter((y) => (regionPoolSize.get(y) ?? 0) >= MIN_POOL_SIZE);
  }, [
    playableYears,
    sourceSelected,
    isRegionMode,
    regionPoolSize,
    objectById,
    metric,
    dataset?.meta.defaultYear,
    yearToText
  ]);

  const yearFrom = selectableYears.length ? selectableYears[0] : Number(yearFromText);
  const yearTo = selectableYears.length ? selectableYears[selectableYears.length - 1] : Number(yearToText);
  /** 滑块上的快捷年份：起点 + 若干中间点 + 最后一年 */
  const yearTicks = useMemo(() => {
    const out = new Set<number>();
    if (!selectableYears.length) return [];
    out.add(selectableYears[0]);
    // 每隔几年给一个中间刻度：区间短（省/州现在有 25 年）时只给两个端点，
    // 用户得拖滑块才知道中间有哪些年。
    const span = yearTo - yearFrom;
    const step = span > 40 ? 20 : span > 12 ? 10 : 5;
    for (let y = yearFrom + step; y < yearTo; y += step) out.add(y);
    out.add(2000);
    // 最后一年要能一键点到（省/州侧的最后一年是 2024，不是世界侧的 2025）。
    // 世界侧的最后一年是预测值，所以那一年前面那一年（2024）也留一个刻度。
    out.add(yearTo);
    if (yearTo > Number(dataset?.meta.defaultYear ?? yearTo)) out.add(yearTo - 1);
    return [...out].filter((y) => selectableYears.includes(y)).sort((a, b) => a - b);
  }, [selectableYears, yearFrom, yearTo, dataset]);
  /**
   * 年份为什么只能选这么少。
   *
   * 目标只有一年的数据时，控件就只剩一年——得说清楚是「没得选」，
   * 不然用户会以为滑块卡住了。
   * 有缺口时（比如欧盟一级区只有 2000–2024、日本府县只有 2023），
   * 把有数据的年份压成一段段区间说清楚。
   */
  const yearRangeNote = useMemo(() => {
    // 加载中/失败时由上面的提示说明；这时候说「只有默认年」会被误解成数据本身
    if (!historyReady || historyError || !sourceSelected.length || !selectableYears.length) return null;
    const all = Number(yearToText) - Number(yearFromText) + 1;
    if (selectableYears.length >= all) return null;
    const names = sourceSelected.map((r) => r.zh).join('、');
    const ranges = yearRanges(selectableYears);
    // 世界 → 地方：限制来自省/州那一侧（目标国家本身有 1960–2025 的数据）
    if (!isRegionMode) {
      const ok = [...regionPoolSize.entries()]
        .filter(([, n]) => n >= MIN_POOL_SIZE)
        .map(([y]) => y)
        .sort((a, b) => a - b);
      return `省/州的数据是 ${yearRanges(ok)}（更早的年份只有港澳台有统计，比不了），所以年份只能选这些年`;
    }
    if (selectableYears.length === 1) return `${names}只有 ${ranges} 年的数据，所以年份只能选这一年`;
    // 目标自己的年份里有没有缺口（中间几年没有统计）
    const own = new Set<string>(sourceSelected[0].years);
    for (const r of sourceSelected.slice(1)) for (const y of r.years) own.add(y);
    const ownRanges = yearRanges([...own].map(Number).sort((a, b) => a - b));
    if (ownRanges.includes('、')) {
      return `${names}的数据是 ${ownRanges}（中间几年没有统计），所以年份只能选这些年`;
    }
    return `${names}的数据是 ${ranges} 年（更早的年份没有省/州统计），所以年份只能选这些年`;
  }, [
    sourceSelected,
    selectableYears,
    yearFromText,
    yearToText,
    isRegionMode,
    regionPoolSize,
    historyReady,
    historyError
  ]);

  /** 年份控件真的能拨：历史已到、没报错、且至少有两个年份 */
  const canBrowseYears = historyReady && !historyError && selectableYears.length > 1;

  // 播放：让年份自己往前走。
  // ⚠️ 走的不是「年份 +1」，而是「能选的那些年里的下一个」——
  // 逐年播会一路播到没有数据的年份，结论变成「0 个国家」。
  useEffect(() => {
    if (!playing || !selectableYears.length) return;
    const t = setTimeout(() => {
      const idx = selectableYears.indexOf(worldYear);
      const next = idx >= 0 ? idx + 1 : 0;
      if (next >= selectableYears.length) setPlaying(false);
      else setWorldYear(selectableYears[next]);
    }, 700);
    return () => clearTimeout(t);
  }, [playing, worldYear, selectableYears]);

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (puzzle || !historyReady) return; // 拼图中/历史没到，播出来的是空帧
    // 播放是「从头看一遍」：总是从能选的最早一年起，播到最后一年停。
    // 不然默认停在 2024 时只剩一步可走，这个按钮等于没用。
    setWorldYear(yearFrom);
    setPlaying(true);
  };

  /**
   * 参照物自己的年份。
   *
   * 省/州与国家都跟滑块走（日本府县这类只有一年的对象，控件会把它夹到那一年）。
   * 正常路径两边同年，价格折算系数是 1；不同年份时才用平减指数兜底。
   */
  const refYear = sourceSelected[0]?.year ?? String(worldYear);
  /** 价格基准指数：随数据一起发布，没有就退化成不折算 */
  const deflator = useMemo(() => dataset?.meta.priceBasis?.deflator ?? {}, [dataset]);
  /** 对照池：数据年份不一致时，钱要折到参照物的价基准上（同年时系数为 1） */
  const comparePool = useMemo(() => {
    const raw = isRegionMode ? countries : regions;
    if (!dataset?.meta.priceBasis) return raw;
    const basis = anchorYear(refYear);
    return raw.map((r) => toPriceBasis(r, deflator, basis));
  }, [isRegionMode, countries, regions, dataset, deflator, refYear]);

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
            // 面积口径要画剪影对照，29 个没有边界的小国/地区不参与
            // （世界底图是 110m 分辨率，把它们漏掉了）。拿一个画不出来的国家当对照，
            // 剪影就整块消失——所以面积口径下只用有边界的对象。
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

  const baseMatch = useMemo(() => {
    if (!target) return null;
    const exclude = sourceSelected.map((r) => r.id);
    return matchByStrategy(target, poolForStrategy(effectiveStrategy), effectiveStrategy, { exclude });
  }, [target, poolForStrategy, sourceSelected, effectiveStrategy]);

  /**
   * 结果卡上的「换个组合」只在「地方 → 世界」、可累加的 GDP/人口类指标、
   * 且当前口径本身是在凑一组对象时出现；面积有专用剪影对照，不混进来。
   */
  const canVariant =
    isRegionMode &&
    additive &&
    (effectiveStrategy === 'many' || effectiveStrategy === 'over') &&
    metric !== 'area';
  const variantSeed = `${worldYear}|${metric}|${effectiveStrategy}|${target.toFixed(0)}`;
  const variants = useMemo(
    () =>
      canVariant && target
        ? buildMatchVariants(
            target,
            poolForStrategy(effectiveStrategy),
            effectiveStrategy,
            { exclude: sourceSelected.map((r) => r.id) },
            variantSeed
          )
        : [],
    [canVariant, target, poolForStrategy, effectiveStrategy, sourceSelected, variantSeed]
  );
  const activeVariant = variants[variantIndex] ?? variants[0] ?? null;
  const match = activeVariant?.match ?? baseMatch;

  /**
   * 这一口径下能参与对照的对象一共多少个。
   *
   * ⚠️ 只数「有值」的：1960 年前大部分国家没有数据（值是 0），
   * 把它们算进来，「池子被用光」这个判断就永远不成立。
   */
  const poolSize = useMemo(
    () =>
      usableCount(poolForStrategy(effectiveStrategy), { exclude: sourceSelected.map((r) => r.id) }),
    [poolForStrategy, effectiveStrategy, sourceSelected]
  );

  /**
   * 当年有多少个国家有数据（不管有没有被「忽略微型经济体」滤掉）。
   *
   * 这是「那一年世界被记下来多少」的数字，跟对照池的大小不是一回事——
   * 口径行里要说清楚的是这个。
   */
  const coverageCount = useMemo(() => {
    if (!isRegionMode) return poolSize;
    return allCountries.filter((c) => metricValue(c, metric) > 0).length;
  }, [isRegionMode, allCountries, metric, poolSize]);

  /** 对照池是省/州时（世界 → 地方），当年有数据的省/州有多少个 */
  const regionCoverage = useMemo(
    () => regions.filter((r) => metricValue(r, metric) > 0).length,
    [regions, metric]
  );

  /**
   * 池子用光也不够。
   *
   * 现在两边取同一年，正常数据下很难触发（来源国自己也在池子里）；
   * 留着是对数据异常/稀疏年份的兜底：这时再说「≈ 20 个国家之和」是句假话，
   * 那 20 个是当年**记录在案的全部**，所以结论改成「是那 20 个总和的几倍」。
   */
  const poolExhausted = useMemo(() => {
    if (!match || !match.count || match.sum >= match.target) return false;
    if (effectiveStrategy !== 'many' && effectiveStrategy !== 'over') return false;
    return match.count >= poolSize;
  }, [match, effectiveStrategy, poolSize]);

  const closest = useMemo(() => {
    if (!target) return null;
    const pool: GdpItem[] = comparePool.map((r) => ({ id: r.id, zh: r.zh, value: metricValue(r, metric) }));
    return closestSingle(target, pool, { exclude: sourceSelected.map((r) => r.id) });
  }, [target, comparePool, sourceSelected, metric]);

  /**
   * 欧洲 NUTS-1 与日本都道府县的边界，按需加载。
   *
   * 这个文件 542 KB（gzip 191 KB），比首屏那一波（约 125 KB gzip）还大，而绝大多数访问根本不需要它——
   * 选中国省走的是 china.json，选美国州走 us-states.json，国家侧走 world.json。
   * 只有「选中的就是欧洲/日本的地区」或「对照结果落到了它们身上」时才用得上。
   */
  const needsExtraGeometry = useMemo(() => {
    // 盲猜轮廓需要欧洲/日本边界；玩视图打开时提前拉
    if (view === 'play') return true;
    const isExtra = (id?: string) => Boolean(id && (id.startsWith('EU-') || id.startsWith('JP-')));
    if (sourceSelected.some((r) => isExtra(r.geometryId))) return true;
    return (match?.items ?? []).some((i) => isExtra(i.id));
  }, [sourceSelected, match, view]);

  useEffect(() => {
    if (!needsExtraGeometry || extraRegions) return;
    loadExtraRegions()
      .then(setExtraRegions)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [needsExtraGeometry, extraRegions]);

  /**
   * 年份控件只覆盖**有正式统计的年份**（1960 年起：世界银行 + IMF WEO）。
   *
   * 1960 年前只有麦迪逊项目的「估算」，而省/州在那些年份根本没有统计——
   * 拿 2024 年的省去比 1700 年的猜测，结论是拼出来的，所以那些年份不发布。
   * 数据管线那边已经不再产出它们，这里也就不必再按需加载。
   */

  // 落在目标没有数据的年份上时，挪到**最近**的有数据的年份。
  // ⚠️ 目标的数据可能有缺口（欧盟一级区 2000–2024、日本府县只有 2023），
  // 所以要挑离得最近的一个，而不是「下一个不小于它的」——那会从 2014 一路跳到 2024。
  useEffect(() => {
    // 玩法视图用国家侧全量年份（Higher/Lower 的年份选择），不跟参照物夹
    if (view === 'play') return;
    if (!dataset || !selectableYears.length) return;
    if (selectableYears.includes(worldYear)) return;
    let best = selectableYears[0];
    let bestD = Infinity;
    for (const y of selectableYears) {
      const d = Math.abs(y - worldYear);
      if (d < bestD) {
        bestD = d;
        best = y;
      }
    }
    setWorldYear(best);
  }, [dataset, selectableYears, worldYear, view]);

  // URL 里的年份可能超出数据范围（数据改了、链接是旧的），夹一下
  useEffect(() => {
    if (!dataset?.meta.yearRange) return;
    const [from, to] = dataset.meta.yearRange.map(Number);
    if (worldYear < from) setYear(from);
    else if (worldYear > to) setYear(to);
  }, [dataset?.meta.yearRange]);

  useEffect(() => {
    saveProgress(progress);
  }, [progress]);

  /**
   * 换目标/指标/口径时回到原版；URL 带 v 打开时保留那一版。
   * 第一次挂载只记下 key，不重置，否则分享出去的 v 会被吃掉。
   *
   * ⚠️ 年份**不进**这个 key：年份不只由用户改，还会被历史数据加载、播放、
   *    GIF 导出改（GIF 会逐帧拨年份）——把它算进来的话，分享链接里的 v
   *    和导完动图后的那一版都会被这些「不是用户换的」年份变动清掉。
   */
  const variantKey = `${mode}|${selected.join(',')}|${metric}|${effectiveStrategy}|${ignoreMicro}`;
  const variantKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (variantKeyRef.current === null) {
      variantKeyRef.current = variantKey;
      return;
    }
    if (variantKeyRef.current !== variantKey) {
      variantKeyRef.current = variantKey;
      setVariantIndex(0);
    }
  }, [variantKey]);

  useEffect(() => {
    // 数据/目标还没到齐时 variants 自然是空的，不能把 URL 里的 v 当成越界清掉。
    // ⚠️ 还得等历史数据：链接指到往年时，基础文件里那一年的值是 0，
    //    选出来的组合只有「原版」一个，v=1 会在这里被误清掉。
    if (!dataset || !target || !historyReady) return;
    if (variantIndex !== 0 && variantIndex >= variants.length) setVariantIndex(0);
  }, [variantIndex, variants.length, dataset, target, historyReady]);

  useEffect(() => {
    writeState({
      mode,
      view,
      selected,
      metric,
      strategy: effectiveStrategy,
      ignoreMicro,
      worldYear: urlYear,
      variant: variantIndex
    });
  }, [
    mode,
    view,
    selected,
    metric,
    effectiveStrategy,
    ignoreMicro,
    worldYear,
    urlYear,
    variantIndex
  ]);

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
            ? // 分数超过 100% 时不写「149%」（一个对象不可能占掉别人的 149%），
              // 改成倍数说法，跟标题/结果卡保持一致
              `${fractionNames} 的 ${
                fraction >= 1
                  ? `${fraction.toFixed(fraction < 10 ? 1 : 0)} 倍`
                  : `${(fraction * 100).toFixed(0)}%`
              }`
            : r.count === 1
              ? `${r.items[0].zh} · ${metricDef.format(r.sum)}（${gapText}）`
              : `${r.count} 个 · ${metricDef.format(r.sum)}（${gapText}）`;
      return { id, label: STRATEGY_LABEL[id], hint: STRATEGY_HINT[id], preview, fraction };
    });
  }, [target, poolForStrategy, sourceSelected, additive, metricDef]);

  /**
   * 参照物在「被比对象」里能排第几。
   *
   * 比的是**参照物自己那一年**的经济体。现在省/州也跟滑块走，
   * 所以参照物的年份就是滑块那一年，名次卡与排行榜同口径。
   */
  const sourceYear = sourceSelected[0]?.year ?? String(worldYear);
  const countriesAtSourceYear = useMemo(
    () => (dataset ? splitDataset(dataset, sourceYear, year).countries : []),
    [dataset, sourceYear, year]
  );

  const worldRank = useMemo(() => {
    if (!target || !isRegionMode) return null;
    const bigger = countriesAtSourceYear.filter((c) => metricValue(c, metric) > target).length;
    // 分母是「当年在当前指标上有记录的国家数」，不是对象池长度：
    // 1990 年池子里有 189 个对象，但只有 149 个有 GDP。
    return { rank: bigger + 1, total: coverageCount, year: sourceYear };
  }, [target, isRegionMode, countriesAtSourceYear, metric, sourceYear, coverageCount]);

  const matchedPopulation = useMemo(() => {
    if (!match) return 0;
    return match.items.reduce((sum, item) => {
      const region = regionById.get(item.id) ?? countryById.get(item.id);
      // 缺当年人口时用最近一年的记录；不能直接加 0（伊拉克 2000 年就缺人口）。
      return sum + (region?.popForAggregate ?? region?.pop ?? 0);
    }, 0);
  }, [match, regionById, countryById]);

  /** 导出图只署实际用到的数据源：加州要写 BEA，而不是中国年鉴。 */
  const exportSourceLine = useMemo(() => {
    if (!sourceSelected.length) return '';
    const entities: Region[] = [...sourceSelected];
    for (const item of match?.items ?? []) {
      const found = regionById.get(item.id) ?? countryById.get(item.id);
      if (found) entities.push(found);
    }
    return dataSourceLine(entities);
  }, [sourceSelected, match, regionById, countryById]);

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

  /** 盲猜只有「有边界」的对象，否则画不出剪影 */
  const blindItems = useMemo<BlindItem[]>(() => {
    const out: BlindItem[] = [];
    for (const c of allCountries) {
      if (c.hasGeometry && featureById.has(c.id)) {
        out.push({ id: c.id, zh: c.zh, kind: 'country', geoId: c.id });
      }
    }
    for (const r of regions) {
      if (featureById.has(r.geometryId)) {
        out.push({ id: r.id, zh: r.zh, kind: 'region', geoId: r.geometryId });
      }
    }
    return out;
  }, [allCountries, regions, featureById]);

  /** 省/州细分层：画在世界地图上（合规的南海诸岛也在这层里）
   *  欧洲 NUTS-1 与日本都道府县也在这层里，但它们标了 drawOnlyWhenHighlighted，
   *  不被高亮时不描边——141 个区一起画会把欧洲糊成一片。
   *
   *  ⚠️ **允许只有一部分**：省界文件是第二波才到的（地图先画世界，边界后补），
   *    所以这里不能等 china 与 usStates 都到齐——那会让世界地图多等 270 KB。 */
  const subdivisions = useMemo<FeatureCollection | null>(() => {
    const features = [
      ...(china?.features ?? []),
      ...(usStates?.features ?? []),
      ...(extraRegions?.features ?? [])
    ];
    return features.length ? { type: 'FeatureCollection', features } : null;
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
  /** 对照对象的单位：地方 → 世界时是「国家」，世界 → 地方时是「省/州」 */
  const unitName = isRegionMode ? '国家' : '省/州';
  /** 对照池那一侧的年份：两边都跟滑块走，就是滑块那一年 */
  const poolYear = String(worldYear);
  /**
   * 结论是不是在讲「非默认年份」。
   *
   * 以前这里是「参照物与对照池是不是隔着年份」——现在两边都取滑块那一年，
   * 不再隔着年份了；但**读的人还是得知道结论说的是哪一年**，
   * 所以只要不是默认年（2024），就把年份写出来。
   */
  const crossYear = String(worldYear) !== String(dataset?.meta.defaultYear ?? '2024');

  /**
   * 把「那一年有多少个对象有数据」写出来。
   *
   * ⚠️ 1960 年前后世界银行的口径覆盖不全（有些国家没有那年的数），
   * 不说清楚的话，读者会把「当年有记录 N 个国家」当成「那年世界上只有 N 个国家」。
   */
  const poolNote = useMemo(() => {
    if (!isRegionMode) {
      // 世界 → 地方：对照池是省/州，它们各自的数据年份不一样，
      // 早的年份只有欧盟那一批有数据——不说清楚，读者会以为
      // 「那一年世界上只有这么几个省/州」。
      if (!crossYear) return null;
      const usable = regionCoverage === poolSize ? '' : `，参与对照 ${poolSize} 个`;
      return `对照 ${poolYear} 年的省/州（当年有记录 ${regionCoverage} 个${usable}）`;
    }
    // 默认年 + 覆盖完整 → 没什么要交代的
    if (!crossYear && coverageCount === poolSize) return null;
    // 「当年有记录」是数据覆盖，「参与对照」是真正进了池子的数量——
    // 开了「忽略微型经济体」或面积口径时会差几个，得把原因写出来，不然看着像矛盾
    const reasons = [
      ignoreMicro ? '已忽略人口不足 100 万的微型经济体' : '',
      metric === 'area' ? '只比较有边界的国家' : ''
    ].filter(Boolean);
    const usable =
      coverageCount === poolSize
        ? ''
        : `，参与对照 ${poolSize} 个${reasons.length ? `（${reasons.join('；')}）` : ''}`;
    return `对照 ${poolYear} 年的世界（当年有记录 ${coverageCount} 个国家${usable}）`;
  }, [isRegionMode, crossYear, poolYear, coverageCount, poolSize, regionCoverage, ignoreMicro, metric]);

  const headline = useMemo<MetricTitle | null>(() => {
    if (!match || !sourceSelected.length) return null;
    // 「比大国家」：写成「它是其中哪几个的几分之几」，分数不过 100%
    if (bigFraction) {
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
    }
    // 池子用光也不够：不能说「≈ N 个国家之和」，得说「比那 N 个加起来还大几倍」
    if (poolExhausted && match.sum > 0) {
      const poolDesc = isRegionMode
        ? `${poolYear} 年这 ${match.count} 个${unitName}`
        : `这 ${match.count} 个${unitName}`;
      return {
        before: `${sourceLabel} 比 ${poolDesc}加起来还大 `,
        eq: '',
        value: match.target / match.sum,
        format: (v) => (v < 10 ? v.toFixed(1) : v.toFixed(0)),
        suffix: ' 倍',
        after: ''
      };
    }
    // 普通情况：不是默认年时，把年份写进标题（不然读的人不知道说的是哪一年）
    const base = metricDef.title(sourceLabel, match.count, match.items[0]?.zh ?? '', unitName);
    if (!crossYear) return base;
    // 地方 → 世界：年份属于对照的那批国家（「≈ 2010 年的 56 个国家」）
    // 世界 → 地方：年份属于参照物那个国家（「德国（2010 年）≈ 56 个省/州」）
    return isRegionMode
      ? { ...base, eq: `${base.eq}${poolYear} 年的 ` }
      : { ...base, before: `${base.before}（${poolYear} 年）` };
  }, [
    match,
    sourceSelected,
    bigFraction,
    sourceLabel,
    metricDef,
    unitName,
    poolExhausted,
    poolYear,
    crossYear,
    isRegionMode
  ]);

  /**
   * 完整结论句（不管是「比大国家」的倍数，还是「52 个国家之和」）。
   * 动图的字幕用这个——headline 为空时（没有匹配结果、也没选参照物）才退回用匹配结果拼一句。
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
    conclusionRef.current = titleText(metricDef.title(sourceLabel, count, only, unitName));
  }, [headline, match, metricDef, sourceLabel, unitName]);

  /**
   * 图注：把这张图在讲什么，用一句人话写在地图上方。
   *
   * 结论卡那行是数字（「≈ 52 个国家之和」），图注是这句话的意思——
   * 读者不用在脑子里翻译，地图上那一片颜色到底是什么就清楚了。
   */
  const variantPrefix =
    activeVariant && activeVariant.key !== 'original' ? `【${activeVariant.label}】` : '';

  const captionBase = useMemo(() => {
    const unit = isRegionMode ? '国家' : '省/州';
    if (!dataset) return '正在载入数据…';
    if (!sourceSelected.length) return '挑一个地方，地图上就会亮出它等价的对照对象。';
    if (!match) return '';
    // 池子用光也不够：那年有记录的国家加起来都不如它，这句话本身就是结论
    if (poolExhausted) {
      return `${poolYear} 年有记录的那 ${match.count} 个${unit}加起来，还不如 ${poolYear} 年的${sourceLabel}`;
    }
    // 「比大国家」：只跟一个大件比，地图上亮的是前十，图注得说清是跟谁比
    if (effectiveStrategy === 'big' && bigFraction) {
      const v = bigFraction.value;
      return v <= 1
        ? `只跟体量最大的 10 个${unit}比：${sourceLabel}顶得上${bigFraction.of}的 ${(v * 100).toFixed(0)}%`
        : `只跟体量最大的 10 个${unit}比：${sourceLabel}比${bigFraction.of}还大 ${v.toFixed(1)} 倍`;
    }
    // 只挑了一个对象出来（最像的一个 / 尽量多凑只凑上一个）：说清是谁
    if (match.count === 1 && match.items[0]) {
      const one = match.items[0];
      return `${sourceLabel}最接近${one.zh}（${metricDef.format(one.value)}）`;
    }
    if (isRegionMode) {
      // 地方 → 世界：池子是那一年的国家，参照物用它自己那年的数
      // ⚠️ 两边都是同一年了（目标的大小也跟年份走），所以不能再写「今天的」——
      // 那样会把 2010 年的巴伐利亚说成今天的。
      const years = crossYear ? `${poolYear} 年的` : '';
      return `${variantPrefix}这 ${match.count} 个 ${years}${unit}加起来，也就抵得上一个${sourceLabel}`;
    }
    // 世界 → 地方：池子是省/州，参照物是国家（都取滑块那一年）
    const refYears = crossYear ? `（${poolYear} 年）` : '';
    return `这 ${match.count} 个来自世界各地的${unit}加起来，也就抵得上${refYears}${sourceLabel}`;
  }, [
    isRegionMode,
    dataset,
    sourceSelected.length,
    match,
    poolExhausted,
    poolYear,
    crossYear,
    metricDef,
    sourceLabel,
    effectiveStrategy,
    bigFraction,
    worldYear,
    variantPrefix
  ]);

  /**
   * 图注的最后一段。
   *
   * 滑块的最后一年是 IMF 的**预测值**（不是实际值）——拨到那一年、
   * 或者「▶ 播放」播到底，结论就建立在预测上了。图注是首屏就能看到、
   * 而且会进导出的分享卡的那句话，所以「这是预测」得写在这里。
   *
   * ⚠️ **预测年只有一个：2025**（IMF WEO 那版的末年）。
   *    别拿滑块的末年（`yearTo`）来判断——省/州侧现在有多年的数据，
   *    河南的末年是 2024，那是**实际数**，标成「预测值」就是句错话。
   */
  const forecastNote =
    dataset && worldYear === Number(yearToText) ? `（${worldYear} 年是预测值，不是实际数字）` : '';

  /** 图注 = 上面那句人话 + 预测年的提示 */
  const caption = captionBase ? `${captionBase}${forecastNote}` : captionBase;

  /**
   * 拼图模式下的图注。
   *
   * 地图上亮的是玩家自己挑的国家，不是「它等于哪些国家」——
   * 这时候还说「这 72 个国家加起来也就抵得上一个广东省」是句错话
   * （地图上根本没有那 72 个国家）。图注改成讲怎么玩。
   */
  const puzzleCaption = puzzle
    ? `在地图上点最多 ${PUZZLE_MAX} 个国家，凑出${puzzle.label}——合计不能超过目标，越接近越好`
    : null;

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

  /** 排名卡：省/州问「假如它是一个国家」，国家侧直接写世界名次 */
  const counterfactual = useMemo(() => {
    if (!sourceSelected.length || !countriesAtSourceYear.length) return null;
    const rows = (['gdp', 'gdpPc', 'area', 'pop'] as const).map((id) => {
      const m = METRICS[id];
      const v = additive
        ? sourceSelected.reduce((s, r) => s + metricValue(r, id), 0)
        : metricValue(sourceSelected[0], id);
      const bigger = countriesAtSourceYear.filter((c) => metricValue(c, id) > v).length;
      const total = countriesAtSourceYear.filter((c) => metricValue(c, id) > 0).length;
      return {
        id,
        label: m.label,
        value: m.format(v),
        rank: bigger + 1,
        total,
        isCurrent: id === metric
      };
    });
    return { name: sourceLabel, rows, isCountry: sourceSelected[0]?.kind === 'country' };
  }, [sourceSelected, countriesAtSourceYear, metric, additive, sourceLabel]);

  // ---------- 拼图玩法：点国家凑出目标 ----------
  const gameSnapshotRef = useRef<GameSnapshot | null>(null);
  const rememberGameSnapshot = () => {
    if (puzzle) return;
    gameSnapshotRef.current = { mode, view, selected, metric, strategy, ignoreMicro, worldYear };
  };
  const restoreGameSnapshot = () => {
    const snap = gameSnapshotRef.current;
    gameSnapshotRef.current = null;
    if (!snap) return;
    setMode(snap.mode);
    setSelected(snap.selected);
    setMetric(snap.metric);
    setStrategy(snap.strategy);
    setIgnoreMicro(snap.ignoreMicro);
    setWorldYear(snap.worldYear);
    setView(snap.view);
    setPlaying(false);
  };

  /**
   * 按指定地区/指标/年份开一局。
   * 挑战链接和每日挑战都走这里，避免被「当前选择/当前年份」带偏。
   */
  const startPuzzleFor = (
    regionId: string,
    puzzleMetric: MetricId,
    puzzleYear: string,
    extra: { daily?: string | null; challengeScore?: number | null } = {}
  ) => {
    if (!dataset || !METRICS[puzzleMetric].additive) return false;
    const obj = dataset.objects.find((o) => o.id === regionId);
    if (!obj || obj.kind !== 'region') return false;
    const region = toRegion(obj, puzzleYear);
    const value = metricValue(region, puzzleMetric);
    if (!(value > 0)) return false;
    rememberGameSnapshot();
    setToast(null);
    setPlaying(false);
    setView('map');
    setMode('region-to-world');
    setMetric(puzzleMetric);
    setStrategy(METRIC_DEFAULT_STRATEGY[puzzleMetric]);
    setSelected([regionId]);
    setWorldYear(Number(puzzleYear));
    setPuzzle({
      target: value,
      label: `${region.zh}的${METRICS[puzzleMetric].label}`,
      metric: puzzleMetric,
      picked: [],
      done: false,
      submitted: false,
      regionId,
      year: puzzleYear,
      daily: extra.daily ?? null,
      challengeScore: extra.challengeScore ?? null
    });
    revealResult('puzzle');
    return true;
  };

  const startPuzzle = () => {
    // 游戏是「用国家凑出一个省/州的总量」，所以目标**必须**是一个省/州。
    // 「世界 → 地方」模式下选中的是国家——把国家的 id 塞进省/州的池子里，
    // 选择就落空了（结论卡会变成「挑一个地方…」的空状态，地图也跟着空掉）。
    // 这时换成它下面最大的那个省/州，跟换对照方向时用的口径一致。
    const m: MetricId = additive ? metric : 'gdp';
    const current = sourceSelected[0];
    const validRegions = regions.filter((r) => metricValue(r, m) > 0);
    const under = current ? regions.filter((r) => r.parentId === current.id) : [];
    const validUnder = under.filter((r) => metricValue(r, m) > 0);
    const biggestOf = validUnder.sort((a, b) => metricValue(b, m) - metricValue(a, m))[0];
    // 不在「当年有值」的地区里选题：日本府县在 1997 年没有数据，
    // 选到东京都会得到「目标 0 亿」这种没法玩的局。
    // 这个国家本身没有接入省/州（under 为空）才退回随机一个有效地区。
    const region = isRegionMode
      ? current
      : (biggestOf ??
        (under.length === 0 ? validRegions[Math.floor(Math.random() * validRegions.length)] : undefined));
    if (!region || metricValue(region, m) <= 0) {
      setToast('这个国家在这一年没有省/州数据，换一年再玩');
      return;
    }
    startPuzzleFor(region.id, m, region.year);
  };

  /** 「换一题」：换一个随机地区，不跟着当前参照物原地打转 */
  const startRandomPuzzle = () => {
    const m: MetricId = additive ? metric : 'gdp';
    const pool = regions.filter((r) => metricValue(r, m) > 0);
    if (!pool.length) return;
    const region = pool[Math.floor(Math.random() * pool.length)];
    startPuzzleFor(region.id, m, region.year);
  };

  /** 每日挑战：按日期抽题，切回地图开一局 */
  const startDaily = () => {
    if (!dailyTarget) return;
    const ok = startPuzzleFor(dailyTarget.regionId, dailyTarget.metric, dailyTarget.year, { daily: today });
    if (!ok) setToast('今天的题暂时开不了，稍后再试');
  };

  // 挑战链接：数据/历史到齐后按同一个目标开一局，只读一次
  const challengeStartedRef = useRef(false);
  useEffect(() => {
    if (challengeStartedRef.current || !initial.challenge) return;
    if (!dataset || !historyReady) return;
    const id = initial.selected[0];
    if (!id) return;
    challengeStartedRef.current = true;
    const ok = startPuzzleFor(id, initial.metric, String(initial.worldYear), {
      challengeScore: initial.challengeScore ?? null
    });
    if (!ok) setToast('挑战链接里的目标不可用');
  }, [dataset, historyReady, initial, startPuzzleFor]);

  /**
   * 拼图用的国家池：同样要折到参照物的价基准上。
   *
   * 拼图的目标是省/州自己那一年（2024）的体量，被挑的国家是滑块那一年的世界——
   * 两边不在同一个价上，凑出来的小数就是假的。
   */
  const puzzlePool = useMemo(() => {
    if (!dataset?.meta.priceBasis) return allCountries;
    const basis = anchorYear(refYear);
    return allCountries.map((r) => toPriceBasis(r, deflator, basis));
  }, [allCountries, dataset, deflator, refYear]);

  const sumPicked = (ids: string[], p: NonNullable<typeof puzzle>) => {
    let sum = 0;
    for (const id of ids) {
      const c = puzzlePool.find((x) => x.id === id);
      if (c) sum += metricValue(c, p.metric);
    }
    return sum;
  };

  const recordPuzzleScore = (p: NonNullable<typeof puzzle>, sum: number) => {
    if (!p.daily) return;
    const success = sum > 0 && sum <= p.target;
    setProgress((prev) => recordDaily(prev, p.daily!, scoreFor(sum, p.target), success));
  };

  const submitPuzzle = () => {
    if (!puzzle || puzzle.done || !puzzle.picked.length) return;
    const sum = sumPicked(puzzle.picked, puzzle);
    setPuzzle({ ...puzzle, done: true, submitted: true });
    recordPuzzleScore(puzzle, sum);
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
    const full = picked.length >= PUZZLE_MAX;
    setPuzzle({ ...puzzle, picked, done: full, submitted: full });
    if (full) recordPuzzleScore(puzzle, sumPicked(picked, puzzle));
  };

  /**
   * 窄屏上用来点选的国家清单（手机上地图太小，点不中）。
   *
   * 只留「不比目标大」的国家（超过目标的根本不能选），
   * 按数值从大到小排——大的先垫底，小的用来微调，最优解就藏在中间那几档。
   */
  const puzzleChoices = useMemo(() => {
    if (!puzzle) return [];
    return puzzlePool
      .map((c) => ({ id: c.id, zh: c.zh, value: metricValue(c, puzzle.metric) }))
      .filter((c) => c.value > 0 && c.value <= puzzle.target)
      .sort((a, b) => b.value - a.value)
      .slice(0, 40);
  }, [puzzle, puzzlePool]);

  const puzzleSum = useMemo(() => {
    if (!puzzle) return 0;
    let sum = 0;
    for (const id of puzzle.picked) {
      const c = puzzlePool.find((x) => x.id === id);
      if (c) sum += metricValue(c, puzzle.metric);
    }
    return sum;
  }, [puzzle, puzzlePool]);

  /** 最优解：最多 3 个国家、合计不超过目标，取最大的一组 */
  const puzzleBest = useMemo(() => {
    if (!puzzle) return null;
    const vals = puzzlePool
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
  }, [puzzle, puzzlePool]);

  const switchMetric = (next: MetricId) => {
    setMetric(next);
    setStrategy(METRIC_DEFAULT_STRATEGY[next]);
    // 换成不可叠加的指标时，多选只剩第一个（状态也要真的收掉，否则列表里还亮着两个）
    if (!METRICS[next].additive) setSelected((prev) => prev.slice(0, 1));
  };

  /**
   * 换地方之后，把结论滚到眼前。
   *
   * 结论卡在侧栏最上面（手机上在 550px 处），选择器在最下面——
   * 用户选完新地方，结论还在屏幕外，不滚一下就会以为「点了没反应」。
   * `block: 'nearest'`：已经在眼前就别动。
   *
   * ⚠️ **拼图模式要露出来的是拼图面板，不是结论卡**：
   * 拼图面板排在结论卡**上面**（侧栏里两者都是 `order: 0`，DOM 里拼图在前），
   * 滚结论卡会把面板整个推出视口——实测面板落在 y = -133..72，
   * 全被顶栏盖住。用户点完「玩一局」只看到一张空地图，会以为页面坏了。
   */
  const revealResult = (what: 'result' | 'puzzle' = 'result') => {
    requestAnimationFrame(() => {
      const el = document.querySelector(what === 'puzzle' ? '.puzzle' : '.result');
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const toggle = (id: string) => {
    // 记住这个国家上次选的是哪个省/州（切方向回来时用得上）
    const picked = regions.find((r) => r.id === id);
    if (picked?.parentId) lastRegionByCountry.current.set(picked.parentId, picked.id);
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
      revealResult();
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
    setToast(`已切换到${c.zh}：看它相当于哪些省/州`);
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

  /** 护照里点一个印章：回到地图看它 */
  const selectPassport = (id: string, kind: 'country' | 'region') => {
    touchedRef.current = true;
    setView('map');
    setMode(kind === 'country' ? 'world-to-region' : 'region-to-world');
    setSelected([id]);
  };

  /**
   * 换对照方向，但**别把题目换掉**。
   *
   * 原来的做法是清空选择，结果切过去是一片空白——和首屏直接给结论的做法不一致，
   * 用户得从头再选一遍。现在顺着上下文换：选的是省/州，就换成它所属的国家；
   * 选的是国家，就换成它下面按当前指标最大的那个省/州。像是「放大一级 / 缩小一级」。
   */
  /**
   * 每个国家上一次选的是哪个省/州。
   *
   * 来回切方向时用同一个：省 → 世界 → 省 走一圈，回来的应该是刚才那个省，
   * 不该变成这个国家里最大的那个（那等于把用户的题目偷偷换了）。
   */
  const lastRegionByCountry = useRef(new Map<string, string>());

  const switchMode = (next: CompareMode) => {
    // 点已经激活的那个按钮不该换题
    if (next === mode) return;
    setMode(next);
    const current = sourceSelected[0];
    if (next === 'world-to-region') {
      const parent = current?.parentId;
      if (parent && countryById.has(parent)) {
        // 记下来：等会儿切回去，还是这个省
        if (current?.id) lastRegionByCountry.current.set(parent, current.id);
        setSelected([parent]);
        return;
      }
      setSelected(['USA']); // 没有上下文就用最大的经济体
      return;
    }
    // 世界 → 地方：优先回到刚才选过的那个省
    const remembered = current ? lastRegionByCountry.current.get(current.id) : undefined;
    const rememberedRegion = remembered ? regions.find((r) => r.id === remembered) : undefined;
    if (rememberedRegion) {
      setSelected([rememberedRegion.id]);
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
    if (!pickerPool.length) return;
    const pick = pickerPool[Math.floor(Math.random() * pickerPool.length)];
    setSelected([pick.id]);
    setToast(`随机换到了：${pick.zh}`);
    revealResult();
  };

  /** 结果卡上的「换个组合」：原版 → 熟脸 A → 熟脸 B → 随机 → 原版 */
  const cycleVariant = () => {
    if (variants.length <= 1) return;
    setVariantIndex((i) => (i + 1) % variants.length);
  };

  /** 把焦点送到选择器：图注上的「换个地方」不该偷偷随机换一个 */
  const focusPicker = () => {
    const picker = document.querySelector('.picker');
    picker?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      document.querySelector<HTMLInputElement>('.picker .search')?.focus({ preventScroll: true });
    }, 350);
  };

  /** 随机一题：随机抽一个地区 + 一个指标 + 一套口径 */
  const randomQuestion = () => {
    if (!regions.length) return;
    const region = regions[Math.floor(Math.random() * regions.length)];
    const m = METRIC_ORDER[Math.floor(Math.random() * METRIC_ORDER.length)];
    setMode('region-to-world');
    setMetric(m);
    setStrategy(METRIC_DEFAULT_STRATEGY[m]);
    setSelected([region.id]);
    setToast(`随机一题：${region.zh}的${METRICS[m].label}`);
    revealResult();
  };

  /**
   * 今日一地：和「每日挑战」用同一个日期题（地区 + 指标 + 年份），
   * 这样今日一地和每日挑战不会各抽各的。
   */
  const dailyPick = () => {
    if (!dailyTarget || !regions.length) return;
    const region = regions.find((r) => r.id === dailyTarget.regionId);
    if (!region) return;
    setMode('region-to-world');
    setMetric(dailyTarget.metric);
    setStrategy(METRIC_DEFAULT_STRATEGY[dailyTarget.metric]);
    setSelected([region.id]);
    setWorldYear(Number(dailyTarget.year));
    touchedRef.current = true;
    setToast(`今日一地（${dailyTarget.date}）：${region.zh}的${METRICS[dailyTarget.metric].label}`);
    revealResult();
  };

  // ---------- 高亮 ----------
  const countryHighlights = useMemo(() => {
    // 拼图模式：地图上高亮的是玩家已经选中的国家
    if (puzzle) {
      return puzzle.picked.map((id, idx) => {
        const c = puzzlePool.find((x) => x.id === id);
        return { id, rank: idx, label: c?.zh ?? id, value: c ? metricValue(c, puzzle.metric) : undefined };
      });
    }
    if (!match || !isRegionMode) return [];
    return match.items.map((item, idx) => ({ id: item.id, rank: idx, label: item.zh, value: item.value }));
  }, [match, isRegionMode, puzzle, puzzlePool]);

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
   * 方形图上画哪些国家。
   *
   * 方形图是「世界按当前指标重画」的世界观，跟「哪些国家参与对照」是两件事——
   * 所以这里用**全部**国家，不套「忽略微型经济体」那个开关。
   * 顺带解决一个问题：参照的国家若是微型经济体（冰岛这类），
   * 套了开关它就不在图上，图注说「高亮的是参照的那个国家」就会落空。
   */
  const squareItems = allCountries;

  /**
   * 方形图上高亮谁。
   *
   * 地方 → 世界：对照出来的是国家，方形图里正是它们，直接高亮。
   * 世界 → 地方：对照出来的是**省/州**，而方形图画的是国家，一个都对不上——
   * 整张图没有一块高亮，图例却写着「这次对照出来的对象」（实测 0 块）。
   * 这时改成高亮**参照的那个国家**：它是这轮比对的题目，图上看得见。
   */
  const squareMatched = useMemo(() => {
    if (isRegionMode) return highlightedIds;
    const ref = sourceSelected[0]?.id;
    return new Set(ref ? [ref] : []);
  }, [isRegionMode, highlightedIds, sourceSelected]);

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
    if (view === 'play') return [];
    if (view === 'rank') {
      return [
        { label: '这次对照出来的', color: PALETTE.matchedLow },
        { label: '当前选中的', color: PALETTE.source },
        { label: '其余对象', color: '#3a5f9e' }
      ];
    }
    if (view === 'square') {
      // 世界 → 地方时方形图高亮的是参照的那个国家（对照出来的省/州不在图上），
      // 图例得跟着改，否则说着一件图上根本没有的事。
      // 方形图的对照色是个由大到小的黄→红渐变，图例不能只画黄块：
      // 默认的 72 个小国全是红的，读者会以为图例在说另一组格子。
      const matched = `linear-gradient(90deg, ${PALETTE.matchedLow}, ${PALETTE.matchedHigh})`;
      return isRegionMode
        ? [
            { label: '这次对照出来的对象', color: matched },
            { label: '其余国家与地区', color: '#3b4e79' }
          ]
        : [
            { label: '这轮对照的参照国家', color: matched },
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
    // ⚠️ **世界 → 地方要用另一套说法**：图上亮的是「凑出来的省/州」，
    // 参照物是国家（整个美国被涂成青绿，里面几块州是橙黄）。
    // 还写「等价对象 / 参照地区」，读者对不上图上那一堆州——
    // 「美国被画成黄绿相间的拼布，图例解释不了」就是这么来的。
    if (!isRegionMode) {
      return [
        { label: '凑出它的省/州（由小到大）', color: PALETTE.matchedLow },
        { label: '其中最大的几个', color: PALETTE.matchedHigh },
        ...(twoSources
          ? [
              { label: sourceSelected[0].zh, color: PALETTE.source },
              { label: sourceSelected[1].zh, color: PALETTE.source2 }
            ]
          : [{ label: sourceLabel, color: PALETTE.source }])
      ];
    }
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
  }, [view, sourceSelected, isRegionMode, sourceLabel]);

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
          const c = puzzlePool.find((x) => x.id === id);
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
  }, [match, puzzle, isRegionMode, regionById, puzzlePool]);

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
    copyText(shareUrl({ mode, view, selected, metric, strategy: effectiveStrategy, ignoreMicro, worldYear: urlYear, variant: variantIndex })).then(
      (ok) => setToast(ok ? '链接已复制到剪贴板' : '复制失败，请手动复制地址栏'),
      () => setToast('复制失败，请手动复制地址栏')
    );
  };

  const handleShareText = (text: string, message: string) => {
    copyText(text).then(
      (ok) => setToast(ok ? message : '复制失败，请手动选择文本'),
      () => setToast('复制失败，请手动选择文本')
    );
  };

  // 拼图的成绩/挑战分享
  const puzzleScore = puzzle && puzzle.submitted ? scoreFor(puzzleSum, puzzle.target) : 0;
  const puzzleChallengeUrl =
    puzzle && typeof window !== 'undefined'
      ? challengeUrlFor(window.location.origin, window.location.pathname, {
          regionId: puzzle.regionId,
          metric: puzzle.metric,
          year: puzzle.year,
          score: puzzleScore
        })
      : '';
  const sharePuzzle = () => {
    if (!puzzle || !puzzle.submitted) return;
    if (puzzle.daily) {
      handleShareText(
        dailyShareText({
          date: puzzle.daily,
          score: puzzleScore,
          streak: progress.daily.streak,
          challengeUrl: puzzleChallengeUrl
        }),
        '今日成绩已复制'
      );
    } else {
      handleShareText(puzzleShareText(puzzleScore, puzzleChallengeUrl), '成绩已复制');
    }
  };
  const sharePuzzleChallenge = () => {
    if (puzzleChallengeUrl) handleShareText(puzzleChallengeUrl, '挑战链接已复制');
  };
  /** 普通拼图结束：关掉游戏，回到开玩前正在看的地方 */
  const endPuzzle = () => {
    setPuzzle(null);
    restoreGameSnapshot();
  };
  /** 每日挑战/挑战好友结束：回玩法大厅（开玩前的对照也会还原） */
  const returnToPlay = () => {
    setPuzzle(null);
    restoreGameSnapshot();
    setView('play');
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

  /**
   * 导出用的三层信息：**标题**说「是谁」，**结论**说「等于多少」，**图注**说「什么意思」。
   *
   * ⚠️ 结论必须单独占一行大字。以前结论（「52 个国家之和」）是塞在
   * 图注那句长话里的（这 52 个国家加起来，也就抵得上一个河南省），
   * 分享出去缩成小图，最该被看见的数字反而找不着。
   *
   * ⚠️ 分享卡与高清图共用这一份——以前两处各算一遍，改一处就忘了另一处
   * （高清图上标题与结论还撞过车：标题已是整句结论，下面又来一行）。
   */
  const exportCopy = useMemo(() => {
    const variant = !puzzle && activeVariant && activeVariant.key !== 'original' ? activeVariant : null;
    const conclusion = puzzle
      ? null
      : variant
        ? titleValueText(
            metricDef.title(sourceLabel, variant.match.count, variant.match.items[0]?.zh ?? '', unitName),
            sourceLabel
          )
        : headline
          ? titleValueText(headline, sourceLabel)
          : match
            ? `相当于 ${match.count} 个${isRegionMode ? '国家' : '省/州'}之和`
            : null;
    const captionText = puzzle
      ? puzzleCaption
      : variant
        ? `${variant.label}：${variant.match.items.map((x) => x.zh).join(' + ')}`
        : match
          ? caption
          : null;
    return { conclusion, captionText };
  }, [
    puzzle,
    activeVariant,
    metricDef,
    sourceLabel,
    unitName,
    headline,
    match,
    isRegionMode,
    puzzleCaption,
    caption
  ]);

  const handleExportCard = async () => {
    try {
      const svg = await exportSvg();
      setToast('正在生成分享卡…');
      const facts = (counterfactual?.rows ?? []).map((r) => ({
        label: r.label,
        value: r.value,
        // 名次是按参照物自己那一年算的，导出的卡片得把年份带上——
        // 卡片上还有一句按滑块年份写的结论，两个年份不写清楚就分不清了
        note: `世界第 ${r.rank} 位（${sourceYear} 年）`
      }));
      await exportShareCard({
        svg,
        // 拼图模式下图上亮的是玩家自己挑的国家，标题再说「这 72 个国家加起来……」
        // 就是句对不上的话（实测导出的卡片写着 72 个国家，图上只有挑的那几个）。
        title: puzzle
          ? `凑一凑：${puzzle.label}`
          : sourceSelected[0]?.kind === 'country'
            ? `${sourceLabel} 的世界名次`
            : `假如 ${sourceLabel} 是一个国家`,
        headline: exportCopy.conclusion ?? undefined,
        caption: exportCopy.captionText ?? undefined,
        facts,
        footnote: exportSourceLine,
        fileName: 'gdp-map-card.png'
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
      /**
       * 高清图是横版：标题说「是谁」，结论说「等于多少」，图注说「什么意思」，
       * 最后一行才是口径与年份（这条是给核对的人看的，不该抢前面几行的戏）。
       */
      await exportPng({
        svg,
        // ⚠️ 标题只放**主体**（「广东省」），结论另起一行。
        // 以前这里写的是整句结论（「广东省 ≈ 72 个国家之和」），
        // 下面又来一行结论——同一句话说两遍。
        title: puzzle ? `凑一凑：${puzzle.label}` : sourceSelected.length ? sourceLabel : 'GDP 等价地图',
        headline: exportCopy.conclusion ?? undefined,
        caption: exportCopy.captionText ?? undefined,
        subtitle: puzzle
          ? ''
          : sourceSelected.length
            ? `${metricDef.format(target)} · ${metricDef.valueLabel} · 数据年份 ${refYear}${
                activeVariant && activeVariant.key !== 'original' ? ` · ${activeVariant.label}` : ''
              }`
            : '选择一个地区开始',
        footnote: exportSourceLine,
        fileName: 'gdp-map@3x.png',
        scale: 3
      });
      setToast('高清图已导出');
      setShareOpen(false);
    } catch (e) {
      setToast(e instanceof Error ? e.message : '导出失败');
    }
  };

  /**
   * 导出动图：让年份从最早的一年走到最后一年。
   *
   * 每一帧都要界面真的切到那一年，所以是「改状态 → 等它画完 → 抓图」，
   * 不能只改个变量就抓。中途要把年份复原。
   * ⚠️ 帧数控制在 32 上下：每帧都要重新渲染 + 栅格化，帧数多了导出会很慢。
   *    采样步长算不准时会多补一个末年，最坏 33 帧。
   */
  const handleExportGif = async () => {
    let savedYear: number | null = null;
    try {
      // 动图每帧都要切年份，缺历史数据就全是空帧——先等它到齐。
      // ⚠️ 用 ref 判断：await 之后 state 还可能是旧值。
      if (!isHistoryReady()) {
        if (!historyPromiseRef.current) {
          setToast('数据还没加载完，稍后再试');
          return;
        }
        setToast('正在加载历史数据…');
        await historyPromiseRef.current;
        if (!isHistoryReady()) {
          setToast('历史数据没加载出来，动图导不了');
          return;
        }
      }
      if (view !== 'map') {
        setView('map');
        await nextPaint();
      }
      // 帧年份必须来自「目标有数据的年份」：用国家侧的 1960–2025 会导出
      // 1960–1999 的空帧，或者标题写 1999、画面却是 2000 的错位帧。
      const years = gifFrameYears(selectableYears);
      if (!years.length) {
        setToast('这个目标没有可导出的年份');
        return;
      }
      savedYear = worldYear;
      setPlaying(false);
      setToast('正在生成动图…');
      await exportGif({
        frameCount: years.length,
        frameAt: async (i) => {
          setWorldYear(years[i]);
          await nextPaint();
          const svg = document.querySelector<SVGSVGElement>('.map-holder svg');
          if (!svg) throw new Error('地图未就绪');
          // 副标题直接读当前渲染出来的图注：它和地图同一次提交，
          // captionRef 那种 effect 时序会慢一帧。
          // ⚠️ 图注里还挂着「点地图上的国家可以反过来查」这句交互提示，
          // 导出时要去掉——GIF 是数据图，不该把界面提示画进去。
          const captionEl = document.querySelector<HTMLElement>('.stage-caption p');
          const exportCaption = captionEl?.cloneNode(true) as HTMLElement | undefined;
          exportCaption?.querySelector('.map-click-hint')?.remove();
          return {
            svg,
            title: `${sourceLabel} · ${years[i]} 年`,
            subtitle: exportCaption?.textContent?.trim() || conclusionRef.current,
            footnote: exportSourceLine
          };
        },
        fileName: `gdp-map-${years[0]}-${years[years.length - 1]}.gif`,
        onProgress: (done, total) => setToast(`正在生成动图… ${done}/${total}`)
      });
      setToast('动图已导出');
      setShareOpen(false);
    } catch (e) {
      setToast(e instanceof Error ? e.message : '动图导出失败');
    } finally {
      // 导出中途抛错时页面已经切到某一帧了，必须把年份还给用户；
      // 只在成功路径恢复的话，失败后界面会停在一个莫名其妙的年份。
      if (savedYear != null) setWorldYear(savedYear);
    }
  };

  // ⚠️ 「数据加载失败」的整页提示不能放在这里：
  // 提前 return 会跳过后面的 useMemo（剪影），下次渲染的 hook 数量变了，
  // React 直接报 #300 把整页渲成白屏（断网打开就是这个结局）。
  // 它必须排在所有 hook 之后。

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



  // 数据没加载出来（断网、服务器抽风）：整页给一句话 + 一个重试的出口。
  // 放在所有 hook 之后——提前 return 会让 React 报 #300 把页面渲成白屏。
  if (error) {
    return (
      <div className="app fatal">
        <p>数据没加载出来，先检查一下网络，再试一次。</p>
        <button type="button" className="primary-btn" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  }

  return (
    <div className={`app ${motionOn ? 'motion-on' : 'motion-off'}${scrubbing ? ' scrubbing' : ''}`}>
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
              title="地方 → 世界：选一个省/州，看它相当于哪些国家"
            >
              地方 → 世界
            </button>
            <button
              type="button"
              className={mode === 'world-to-region' ? 'active' : ''}
              onClick={() => switchMode('world-to-region')}
              title="世界 → 地方：选一个国家，看它相当于哪些省/州"
            >
              世界 → 地方
            </button>
          </div>

          <div className="segmented" role="tablist" aria-label="视图">
            <button
              type="button"
              className={view === 'map' ? 'active' : ''}
              onClick={() => setView('map')}
              title="世界地图：把等价的那些国家在地图上标出来"
            >
              地图
            </button>
            <button
              type="button"
              className={view === 'globe' ? 'active' : ''}
              onClick={() => setView('globe')}
              disabled={Boolean(puzzle)}
              title="3D 地球：拖着转，看看它们在地球上的位置"
            >
              地球
            </button>
            <button
              type="button"
              className={view === 'square' ? 'active' : ''}
              onClick={() => setView('square')}
              disabled={Boolean(puzzle)}
              title="方形图：世界按体量重画成方块，一眼看出谁撑起了世界经济"
            >
              方形图
            </button>
            <button
              type="button"
              className={view === 'bracket' ? 'active' : ''}
              onClick={() => setView('bracket')}
              disabled={Boolean(puzzle)}
              title="擂台：选两个地方逐项 PK，看谁大"
            >
              擂台
            </button>
            <button
              type="button"
              className={view === 'rank' ? 'active' : ''}
              onClick={() => setView('rank')}
              disabled={Boolean(puzzle)}
              title="排行：把国家和省/州按体量排成一张榜"
            >
              排行
            </button>
            <button
              type="button"
              className={view === 'play' ? 'active' : ''}
              onClick={() => setView('play')}
              disabled={Boolean(puzzle)}
              title="玩法：每日挑战、Higher/Lower、盲猜轮廓、经济护照"
            >
              玩法
            </button>
          </div>

        </div>

        {/* 分享按钮跟「复制链接」放在顶栏最外层：手机上让它们跟标题挤在同一行，
            把竖排空间让给地图和结论 */}
        <div className="header-actions">
          <button type="button" className="ghost-btn" onClick={handleCopyLink}>
            复制链接
          </button>
          {/* 源码入口：一个图标按钮就够，占的地方越小越好（窄屏顶栏本来就挤） */}
          <a
            className="ghost-btn icon-btn"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="在 GitHub 上看源码"
            title="在 GitHub 上看源码"
          >
            <GitHubMark />
          </a>
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
                {/* 玩视图里没有地图可导，成绩分享在卡片和拼图面板里 */}
                {view === 'play' ? null : (
                  <>
                    <button type="button" onClick={handleExportCard}>
                      <b>下载分享卡</b>
                      <span>竖版 2400px 宽，适合发群</span>
                    </button>
                    <button type="button" onClick={handleExportHires}>
                      <b>下载高清图</b>
                      <span>横版 3600px 宽</span>
                    </button>
                    {/* 拼图模式下画面不会随年份变（亮的是玩家挑的那几个国家），
                        只有一年数据的对象也没有「怎么变」——给一个不动的动图是骗人。 */}
                    {puzzle || yearFrom === yearTo ? null : (
                      <button type="button" onClick={handleExportGif}>
                        <b>下载动图</b>
                        <span>{yearFrom}→{yearTo} 看它怎么变</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="layout">
        <aside className={`sidebar${view === 'play' ? ' play-sidebar' : ''}`}>
          <section className="strategy">
            <div className="picker-head">
              <h2>{view === 'play' ? 'Higher / Lower 用哪个指标' : '比哪个方面'}</h2>
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
            <p className="picker-hint">
              {view === 'play'
                ? '盲猜和护照不受这里影响；每日挑战的指标由当天题目决定。'
                : isRegionMode
                  ? METRIC_HINT[metric]
                  : (METRIC_HINT_REVERSE[metric] ?? METRIC_HINT[metric])}
            </p>
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
                      <span className="choice-preview" title={opt.preview}>{opt.preview}</span>
                      {active ? <span className="choice-hint">{opt.hint}</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="choice-list">
                <div className="choice active static">
                  <span className="choice-title">{STRATEGY_LABEL.nearest}</span>
                  <span className="choice-preview" title={strategyPreviews[0]?.preview ?? ''}>
                    {strategyPreviews[0]?.preview ?? '—'}
                  </span>
                  <span className="choice-hint">{metricDef.label}不能相加，只能跟单个对象比。</span>
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
              <h2>{isRegionMode ? '拿哪一年的世界来比' : '拿哪一年的国家来比'}</h2>
              <span className="year-tools">
                <button
                  type="button"
                  className={playing ? 'play-btn on' : 'play-btn'}
                  onClick={togglePlay}
                  aria-pressed={playing}
                  title={
                    selectableYears.length < 2
                      ? '只有一年数据，没有可播的年份'
                      : `从 ${yearFrom} 年播到 ${yearTo} 年，看这个地方的体量怎么变`
                  }
                  disabled={!historyReady || Boolean(puzzle) || selectableYears.length < 2}
                >
                  {playing ? '⏸ 暂停' : '▶ 播放'}
                </button>
                <span className="year-now">{worldYear}</span>
                {/* 最后一年的数据是 IMF 的**预测值**（不是实际值）。
                    拨到那一年、或者「▶ 播放」播到底，结论就建立在预测上了——
                    界面上得说一声，不然读的人会当成实际数字。
                    ⚠️ 预测年只有 2025（`yearToText` = 数据里世界侧的末年）；
                    省/州侧的末年（河南 2024）是实际数，别标错。 */}
                {worldYear === Number(yearToText) ? <span className="year-flag">预测值</span> : null}
              </span>
            </div>
            <input
              className="year-slider"
              type="range"
              min={yearFrom}
              max={yearTo}
              step={1}
              value={worldYear}
              onChange={(e) => setYear(Number(e.target.value))}
              /* ⚠️ 按住拖动时把过渡关掉（.app.scrubbing）：
                  0.55s 的颜色过渡会追不上滑块，地图看着是糊的。
                  松手就恢复——点刻度、换指标仍然是「滑过去」的。 */
              onPointerDown={() => setScrubbing(true)}
              onPointerUp={() => setScrubbing(false)}
              onPointerCancel={() => setScrubbing(false)}
              onBlur={() => setScrubbing(false)}
              aria-label="国家数据年份"
              disabled={!historyReady || Boolean(puzzle)}
            />
            <div className="year-ticks">
              {yearTicks.map((y) => (
                <button
                  key={y}
                  type="button"
                  onClick={() => setYear(y)}
                  disabled={!historyReady || Boolean(puzzle)}
                >
                  {y}
                </button>
              ))}
            </div>
            {/* ⚠️ 历史数据没到之前，年份控件是禁用的——那一年的值还没到，
                拨过去只会得到「0 个国家」这种空结论。
                所以得说清楚在等什么，不然用户以为滑块坏了。 */}
            {!historyReady ? (
              <p className={`picker-hint${historyError ? ' year-error' : ''}`}>
                {historyError ?? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    正在加载历史数据（省/州与世界侧的往年数值）…
                  </>
                )}
              </p>
            ) : null}
            {puzzle ? (
              <p className="picker-hint">拼一局时年份固定，结束这一局再拨年份。</p>
            ) : null}
            <p className="picker-hint">
              {metric === 'area' ? (
                <>面积不随年份变化，年份固定为 {dataset?.meta.defaultYear ?? '2024'} 年。</>
              ) : yearRangeNote ? (
                <>
                  {yearRangeNote}
                  {canBrowseYears ? '。往前拨能看出「这个地方放在当年是什么水平」。' : '。'}
                </>
              ) : canBrowseYears ? (
                <>国家和省/州都按同一年的数据比：往前拨能看出「这个地方放在当年是什么水平」。</>
              ) : null}
            </p>
            <details className="more">
              <summary>这些数字是哪来的</summary>
              <p className="picker-hint">
                1990 年起是 IMF WEO（{yearToText} 为预测值），1960–1989 是世界银行口径；
                省/州用自己那年的数据（中国省级 2000–2024、美国各州 1997–2025、
                欧盟一级区 2000–2024、日本府县 2023）。
                1960 年以前只有麦迪逊项目的「估算」，而省/州在那些年份没有统计，
                那些年份不发布。
                中国省级的早期数据来自不同版年鉴，经济普查修订会让相邻年份出现口径断点
                （例如北京 2000→2001）。
              </p>
            </details>
          </section>

          <RegionPicker
            // 换方向时重建：否则上一次搜的词还留在框里，列表看着像空的
            key={mode}
            title={isRegionMode ? '选择一个省 / 州 / 地区' : '选择一个国家'}
            hint={
              isRegionMode
                ? additive
                  ? '中国的省级行政区、美国的州、欧洲的一级区、日本的都道府县都有经济总量，可以直接跟世界比；多选会先加总。'
                  : '这些省/州都有经济总量。人均与密度不能相加，所以只能选一个。'
                : '选一个国家，看它相当于哪些省/州加起来（可以从全世界的省/州里凑，不限于本国）。'
            }
            metric={metricDef}
            items={pickerPool}
            // 数据还没到的时候，列表是空的——那不是「没匹配到」，是「还在加载」
            emptyLabel={dataset ? '没有匹配的地区' : '加载中…'}
            searchPlaceholder={
              isRegionMode
                ? '搜索：广东 / guangdong / gd / Texas'
                : '搜索：美国 / USA / 德国 / Germany'
            }
            groups={pickerGroups}
            selected={selected}
            onToggle={toggle}
            onClear={() => setSelected([])}
            multi={isRegionMode && additive}
          />

          {/* 拼图时藏掉「换换口味」：里面的随机/今日按钮会换掉参照物，
              而这一局的目标已经按开局那一年算好了（规则 #15 同一个理由） */}
          {puzzle ? null : (
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
                随机换个地方
              </button>
              <button type="button" className="chip ghost" onClick={randomQuestion}>
                随机一题
              </button>
              <button type="button" className="chip ghost" onClick={dailyPick}>
                今日一地
              </button>
              <button type="button" className="chip ghost" onClick={startPuzzle}>
                玩一局
              </button>
            </div>
          </section>
          )}

          {puzzle ? (
            <section className="puzzle">
              <h3>凑一凑：{puzzle.label}</h3>
              {puzzle.daily ? <p className="puzzle-daily">每日挑战 · {puzzle.daily}</p> : null}
              {puzzle.challengeScore != null ? (
                <p className="puzzle-challenge">
                  好友的挑战：对方 {puzzle.challengeScore} 分
                  {puzzle.submitted
                    ? ` · 你 ${puzzleScore} 分（${
                        puzzleScore >= puzzle.challengeScore ? '超过' : '还差'
                      } ${Math.abs(puzzleScore - puzzle.challengeScore)} 分）`
                    : ''}
                </p>
              ) : null}
              <p className="picker-hint puzzle-map-hint">
                在地图上点最多 {PUZZLE_MAX} 个国家，合计不能超过目标，越接近越好。
              </p>
              {/* 窄屏上地图只有 180 来像素高，国家小到点不中（葡萄牙实测只有 3px），
                  所以手机上一份可以点的清单顶上——宽屏仍是地图点选。 */}
              <p className="picker-hint puzzle-pick-hint">
                从下面的清单里选最多 {PUZZLE_MAX} 个国家，合计不能超过目标，越接近越好。
                {/* ⚠️ 清单在手机上只有 260px 高，一次露 7 行，
                    不说总数的话用户以为就这 7 个可选——
                    而真正要凑到目标的那几个小国往往在下面。 */}
                <span className="puzzle-pick-count">（共 {puzzleChoices.length} 个候选，可往下滚）</span>
              </p>
              {puzzleChoices.length ? (
                <div className="puzzle-pick">
                  {puzzleChoices.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      data-id={c.id}
                      className={`picker-item${puzzle.picked.includes(c.id) ? ' active' : ''}`}
                      onClick={() => togglePicked(c.id)}
                      aria-pressed={puzzle.picked.includes(c.id)}
                    >
                      {/* 勾选位：picker-item 的网格是「勾 | 名字 | 数值」三列，
                          少这一格的话名字会掉进 18px 的勾选列里 */}
                      <span className="mark" aria-hidden="true">
                        {puzzle.picked.includes(c.id) ? '✓' : ''}
                      </span>
                      <span className="picker-name">{c.zh}</span>
                      <span className="picker-gdp">{METRICS[puzzle.metric].short(c.value)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
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
              {/* 越线了就是输了：规则写着「合计不能超过目标」，
                  所以越线的那一刻就得说——不能等凑满 3 个才说，
                  那时进度条早就满格，用户还以为自己领先着。 */}
              {puzzleSum > puzzle.target ? (
                <p className="puzzle-over">
                  超了 {METRICS[puzzle.metric].short(puzzleSum - puzzle.target)}
                  {puzzle.done ? '，这局没成功' : ' —— 取消一个再试'}
                </p>
              ) : puzzle.done && puzzleBest ? (
                <p className="puzzle-win">
                  {puzzleSum === puzzleBest.sum
                    ? '满分！和最优解一样'
                    : `还差 ${METRICS[puzzle.metric].short(puzzleBest.sum - puzzleSum)}`}
                </p>
              ) : (
                <p className="picker-hint">
                  还可以点 {PUZZLE_MAX - puzzle.picked.length} 个。
                </p>
              )}
              {puzzle.submitted ? (
                <p className="puzzle-score">
                  本局 <b>{puzzleScore}</b> 分
                  {puzzle.daily ? (
                    <span>
                      今日最佳 {progress.daily.best} · 连胜 {progress.daily.streak}
                    </span>
                  ) : null}
                </p>
              ) : null}
              {puzzle.done && puzzleBest ? (
                <p className="puzzle-best">
                  最优解（{puzzleBest.ids.length} 个）：{puzzleBest.names.join(' + ')} ={' '}
                  {METRICS[puzzle.metric].short(puzzleBest.sum)}
                </p>
              ) : null}
              {puzzle.done ? (
                <div className="quick-row">
                  {puzzle.submitted ? (
                    <button type="button" className="chip" onClick={sharePuzzle}>
                      分享成绩
                    </button>
                  ) : null}
                  {puzzle.submitted ? (
                    <button type="button" className="chip ghost" onClick={sharePuzzleChallenge}>
                      挑战好友
                    </button>
                  ) : null}
                  {puzzle.daily ? (
                    <button type="button" className="chip" onClick={startDaily}>
                      {/* ⚠️ 跟玩法大厅那个按钮用同一个说法：
                          「开始今日挑战 / 再玩一次 / 再试一次」三种叫法，
                          用户分不清是重打这题还是换一题。 */}
                      再来一次
                    </button>
                  ) : null}
                  {!puzzle.daily && puzzle.challengeScore == null ? (
                    <button type="button" className="chip" onClick={startRandomPuzzle}>
                      换一题
                    </button>
                  ) : null}
                  {puzzle.daily || puzzle.challengeScore != null ? (
                    <button type="button" className="chip ghost" onClick={returnToPlay}>
                      返回玩法
                    </button>
                  ) : (
                    <button type="button" className="chip ghost" onClick={endPuzzle}>
                      结束
                    </button>
                  )}
                </div>
              ) : (
                <div className="quick-row">
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={submitPuzzle}
                    disabled={!puzzle.picked.length}
                  >
                    提交
                  </button>
                  <button
                    type="button"
                    className="chip ghost"
                    onClick={() => setPuzzle((p) => (p ? { ...p, done: true } : p))}
                  >
                    看答案
                  </button>
                  {!puzzle.daily && puzzle.challengeScore == null ? (
                    <button type="button" className="chip" onClick={startRandomPuzzle}>
                      换一题
                    </button>
                  ) : null}
                  {puzzle.daily || puzzle.challengeScore != null ? (
                    <button type="button" className="chip ghost" onClick={returnToPlay}>
                      返回玩法
                    </button>
                  ) : (
                    <button type="button" className="chip ghost" onClick={endPuzzle}>
                      结束
                    </button>
                  )}
                </div>
              )}
            </section>
          ) : null}

          {match ? (
            <ResultPanel
              sourceLabel={sourceLabel}
              headline={headline}
              /* ⚠️ 拼图/每日挑战进行中：只给题面，不给答案。
                 答案（结论、合计、清单）摊在题目旁边，这游戏就没得玩了——
                 提交或点「看答案」之后才放开。 */
              hideAnswer={Boolean(puzzle) && !puzzle?.done}
              fraction={bigFraction}
              animate={motionOn}
              comparison={view === 'bracket' ? null : comparison}
              counterfactual={counterfactual}
              target={target}
              targetText={
                crossYear ? `${metricDef.format(target)}（${refYear} 年）` : metricDef.format(target)
              }
              metric={metricDef}
              result={match}
              unitName={unitName}
              exhausted={poolExhausted}
              poolNote={activeVariant && activeVariant.key !== 'original' ? null : poolNote}
              strategyLabel={
                activeVariant && activeVariant.key !== 'original'
                  ? activeVariant.label
                  : STRATEGY_LABEL[strategy]
              }
              strategy={effectiveStrategy}
              worldRank={worldRank}
              matchedPopulation={matchedPopulation}
              variant={
                !puzzle && variants.length > 1
                  ? {
                      label: activeVariant?.label ?? '原版组合',
                      canCycle: true,
                      onCycle: cycleVariant
                    }
                  : null
              }
              individualBars={Boolean(activeVariant && activeVariant.key !== 'original')}
              closest={
                closest && (effectiveStrategy === 'many' || effectiveStrategy === 'over')
                  ? { zh: closest.zh, value: closest.value }
                  : null
              }
              silhouette={silhouette}
            />
          ) : (
            <section className="result placeholder">
              {/* 数据还没到的时候别催用户操作——先说在载入 */}
              <p>
                {!dataset ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    正在载入数据…
                  </>
                ) : !historyReady && !historyError ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    正在加载历史数据…
                  </>
                ) : sourceSelected.length ? (
                  `${sourceLabel}在当前年份没有${metricDef.label}数据，换一个地方或指标。`
                ) : (
                  '挑一个地方，地图上就会亮出它等价的对照对象。'
                )}
              </p>
            </section>
          )}
        </aside>

        <main className="stage">
          {/* key={view}：换视图时整个舞台重挂载，
              CSS 的入场动画才会重新放一遍（不重挂载的话，React 会复用同一个
              DOM 节点，动画只放一次，第二次换视图就「啪」地一下换掉了）。 */}
          <div className={`stage-inner${view === 'play' ? ' play-stage' : ''}`} key={view}>
            {/* 图注：先说清这张图在讲什么，再让读者看图 */}
            {view === 'map' || view === 'globe' ? (
              <div className="stage-caption">
                <p>
                  {/* ⚠️ 手机上结论卡在首屏之外（实测结论标题落在视口 74%~87% 处），
                      第一眼只看得到导航、图注和地图。把「等于多少」提到图注最前面，
                      首屏就能看到那个数字。桌面端不重复显示——那边结果卡就在旁边。 */}
                  {puzzleCaption || !headline ? null : (
                    <strong className="caption-lead">{titleValueText(headline, sourceLabel)}</strong>
                  )}
                  {puzzleCaption ?? caption}
                  {view === 'map' && isRegionMode && !puzzle ? (
                    <span className="map-click-hint"> · 点地图上的国家可以反过来查它的省/州</span>
                  ) : null}
                </p>
                {/* 拼图模式下地图亮的是自己挑的国家，「换个地方试试」会把参照物换掉、
                    目标却不变——这时候它只会添乱，藏掉（拼图面板里有「换一题」）。 */}
                {puzzleCaption ? null : (
                  <button type="button" className="chip ghost" onClick={focusPicker}>
                    换个地方
                  </button>
                )}
              </div>
            ) : null}
            {view === 'play' ? (
              <PlayView
                progress={progress}
                onProgress={setProgress}
                dailyTarget={dailyTarget}
                today={today}
                historyReady={historyReady}
                metric={metricDef}
                metricId={metric}
                year={worldYear}
                playYears={playableYears}
                forecastYear={metric === 'area' ? undefined : Number(yearToText)}
                onYearChange={setPlayYear}
                yearLocked={Boolean(puzzle)}
                higherItems={higherItems}
                blindItems={blindItems}
                features={featureById}
                passportGroups={passportGroups}
                selectedIds={selected}
                onStartDaily={startDaily}
                onSelectPassport={selectPassport}
                onShareText={handleShareText}
              />
            ) : view === 'rank' ? (
              <div className="map-holder rank-holder">
                <RankingView
                  entries={rankingEntries}
                  format={metricDef.format}
                  noteFor={(e) => (e.selected ? '当前选中' : undefined)}
                  equivCount={(e) => (e.kind === 'region' ? equivCounts.get(e.id) : undefined)}
                  metricId={metric}
                  onSelect={selectFromRanking}
                />
                <p className="view-caption">
                  {`国家与省/州按「${metricDef.label}」排在一起（两边都取 ${sourceYear} 年，国家侧与「假如它是一个国家」的名次卡同口径）。省/州后面的「≈ N 国」按当前年份的世界算，跟结论卡上的件数同口径。`}
                </p>
              </div>
            ) : view === 'square' ? (
              <div className="map-holder">
                <SquareCartogram
                  items={squareItems.map((c) => ({
                    id: c.id,
                    zh: c.zh,
                    value: metricValue(c, metric),
                    matched: squareMatched.has(c.id)
                  }))}
                  onSelect={handleMapClick}
                  labelFor={(id) => countryById.get(id)?.zh ?? id}
                />
                <p className="view-caption">
                  {isRegionMode
                    ? `世界按「${metricDef.label}」重画：每块的大小就是它的份额，高亮的是这次对照出来的对象。`
                    : `世界按「${metricDef.label}」重画：每块的大小就是它的份额。这轮对照出来的是省/州，方形图画的是国家，所以高亮的是参照的那个国家。`}
                </p>
              </div>
            ) : view === 'bracket' ? (
              <div className="map-holder bracket-holder">
                <div className="bracket-row">
                  <div className="bracket-vs">
                    {comparison ?? (
                      <p className="view-caption">选两个地方，这里就是它们的擂台对阵。</p>
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
                      labelFor={countryName}
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
                    labelFor={countryName}
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
                labelFor={countryName}
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
                  {dataset.meta.coverage ? (
                    <>
                      年份覆盖：国家 {dataset.meta.coverage.countries}｜中国省级{' '}
                      {dataset.meta.coverage.chinaProvinces}
                      {dataset.meta.coverage.hkMacaoTaiwan
                        ? `｜港澳台 ${dataset.meta.coverage.hkMacaoTaiwan}`
                        : ''}
                      ｜美国各州 {dataset.meta.coverage.usStates}
                      ｜欧洲 NUTS-1 {dataset.meta.coverage.euNuts}｜日本都道府县{' '}
                      {dataset.meta.coverage.japanPrefectures}
                      <br />
                    </>
                  ) : null}
                  国家：{dataset.meta.countrySource}｜中国省级：
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
                {/* 源码也写在这儿：这是个数据项目，
                    「这些数字是怎么来的」包括「代码和数据在哪」 */}
                <p className="sources">
                  源码：{' '}
                  <a href={REPO_URL} target="_blank" rel="noreferrer">
                    github.com/rockbenben/gdp-map
                  </a>
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
            dismissMotionHint();
          }}
          title="点击打开动效"
        >
          系统关掉了动画效果，网站的动效也跟着静了 —— 点这里打开
          <button
            type="button"
            className="motion-toast-close"
            aria-label="关闭动效提示"
            onClick={(event) => {
              event.stopPropagation();
              dismissMotionHint();
            }}
          >
            ×
          </button>
        </div>
      ) : null}

      {toast ? (
        <div className={`toast${toastOut ? ' out' : ''}`} onClick={() => setToast(null)} role="status">
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
  // ⚠️ 小图别太大：它压在地图左下角，导出成分享图时最抢眼的就是这块黑框。
  // 168×196 太大，缩到 144×168，底框再透一点——看得出是插图，不像贴上去的。
  const width = 144;
  const height = 168;
  const features = useMemo(() => china.features.filter((f) => !f.properties.isSouthSea), [china]);
  const path = useMemo(() => geoPath(createChinaProjection(width, height, features)), [width, height, features]);

  return (
    <g transform={`translate(20, ${491 - height})`}>
      <rect
        x={-9}
        y={-9}
        width={width + 18}
        height={height + 30}
        rx={9}
        fill="rgba(8,12,22,0.58)"
        stroke="rgba(90,120,180,0.32)"
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

