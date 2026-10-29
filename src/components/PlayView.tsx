import { useEffect, useRef, useState } from 'react';
import { METRICS } from '../lib/metrics';
import type { Metric, MetricId } from '../lib/metrics';
import { challengeUrlFor, dailyShareText, dailyTargetLine, resetPassport } from '../lib/play';
import type { BlindItem, DailyTarget, HigherItem, PlayProgress } from '../lib/play';
import type { GeoFeature } from '../lib/types';
import { BlindGuess } from './BlindGuess';
import { HigherLower } from './HigherLower';
import { Passport } from './Passport';
import type { PassportGroup } from './Passport';

type Game = 'hub' | 'higher' | 'blind' | 'passport';

interface Props {
  progress: PlayProgress;
  onProgress: (next: PlayProgress) => void;
  dailyTarget: DailyTarget | null;
  today: string;
  historyReady: boolean;
  metric: Metric;
  metricId: MetricId;
  year: number;
  playYears: number[];
  /** 国家侧最后一年的预测值（2025）；面积不随年份变，调用方会传 undefined */
  forecastYear?: number;
  onYearChange: (year: number) => void;
  yearLocked: boolean;
  higherItems: HigherItem[];
  blindItems: BlindItem[];
  features: Map<string, GeoFeature>;
  passportGroups: PassportGroup[];
  selectedIds: string[];
  onStartDaily: () => void;
  onSelectPassport: (id: string, kind: 'country' | 'region') => void;
  onShareText: (text: string, message: string) => void;
}

const ScoreBar = ({ score }: { score: number }) => {
  const filled = Math.max(0, Math.min(5, Math.floor(score / 20)));
  return (
    <span className="score-bar" aria-label={`得分 ${score}`}>
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={i < filled ? 'on' : ''} />
      ))}
    </span>
  );
};

/** 玩法大厅：每日挑战 + 三个随时能玩的小游戏 */
export function PlayView({
  progress,
  onProgress,
  dailyTarget,
  today,
  historyReady,
  metric,
  metricId,
  year,
  playYears,
  forecastYear,
  onYearChange,
  yearLocked,
  higherItems,
  blindItems,
  features,
  passportGroups,
  selectedIds,
  onStartDaily,
  onSelectPassport,
  onShareText
}: Props) {
  const [game, setGame] = useState<Game>('hub');
  /**
   * 从大厅进游戏（或退回来）时，把新面板送到顶栏下面。
   *
   * 手机上新用户要点到第四张「护照」卡才进来，此时页面已经滚过一屏；
   * 新面板从上方接替大厅，页面却停在原来的滚动位置——实测护照落在 -46px，
   * 标题、进度和分组标签全在视口外，只看见名单中间。
   */
  const lastGame = useRef<Game>('hub');
  useEffect(() => {
    if (game === lastGame.current) return;
    lastGame.current = game;
    requestAnimationFrame(() => {
      const el = document.querySelector(game === 'hub' ? '.play-hub' : '.play-game');
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [game]);
  const dailyDone = progress.daily.date === today && progress.daily.done;
  const passportTotal = passportGroups.reduce((sum, g) => sum + g.items.length, 0);
  const passportCount = passportGroups.reduce(
    (sum, g) => sum + g.items.filter((item) => progress.passport.includes(item.id)).length,
    0
  );
  const passportPercent = passportTotal ? Math.round((passportCount / passportTotal) * 1000) / 10 : 0;

  const dailyChallenge =
    dailyTarget && typeof window !== 'undefined'
      ? challengeUrlFor(window.location.origin, window.location.pathname, {
          regionId: dailyTarget.regionId,
          metric: dailyTarget.metric,
          year: dailyTarget.year,
          score: progress.daily.best
        })
      : '';

  const shareDaily = () => {
    if (!dailyTarget) return;
    onShareText(
      dailyShareText({
        date: today,
        score: progress.daily.best,
        streak: progress.daily.streak,
        challengeUrl: dailyChallenge
      }),
      '今日成绩已复制'
    );
  };

  const shareDailyChallenge = () => {
    if (dailyChallenge) onShareText(dailyChallenge, '挑战链接已复制');
  };

  if (game === 'higher') {
    return (
      <HigherLower
        key={`${metricId}-${year}`}
        items={higherItems}
        metricLabel={metric.label}
        metricShort={metric.short}
        year={year}
        years={playYears}
        forecastYear={forecastYear}
        onYearChange={onYearChange}
        yearLocked={yearLocked}
        best={progress.higherBest}
        onBest={(best) => onProgress({ ...progress, higherBest: best })}
        onShare={onShareText}
        onBack={() => setGame('hub')}
      />
    );
  }

  if (game === 'blind') {
    return (
      <BlindGuess
        items={blindItems}
        features={features}
        best={progress.blindBest}
        onBest={(best) => onProgress({ ...progress, blindBest: best })}
        onShare={onShareText}
        onBack={() => setGame('hub')}
      />
    );
  }

  if (game === 'passport') {
    return (
      <Passport
        groups={passportGroups}
        passport={progress.passport}
        selectedIds={selectedIds}
        onSelect={onSelectPassport}
        onReset={() => onProgress(resetPassport(progress))}
        onShare={onShareText}
        onBack={() => setGame('hub')}
      />
    );
  }

  const dailyLabel = dailyTarget
    ? `${dailyTarget.regionZh}的${METRICS[dailyTarget.metric].label}`
    : '今日题目准备中';
  // ⚠️ 那行小字里的年份由 dailyTargetLine 决定：不随年份变的指标（面积）不写年份，
  //    否则卡片上的年份会跟「今日一地」停在地图上的那一年对不上。
  const dailySub = dailyTargetLine(dailyTarget);
  const dailyBusy = !historyReady || !dailyTarget;

  return (
    <div className="play-hub">
      <header className="play-hub-head">
        <span className="play-kicker">玩法</span>
        <h2>换个方式玩这张地图</h2>
        <p>每天一局，或者来两局快的。成绩只存在这台设备上。</p>
      </header>

      <div className="play-cards">
        <section className="play-card daily">
          <div className="play-card-top">
            <span className="play-kicker">每日挑战 · {today}</span>
            {dailyDone ? <span className="play-badge">已完成</span> : null}
          </div>
          <h3>{dailyLabel}</h3>
          <p className="play-card-sub">{dailySub}</p>
          {dailyDone ? (
            <>
              <div className="play-scoreline">
                <ScoreBar score={progress.daily.best} />
                <strong>{progress.daily.best} 分</strong>
                <span>连胜 {progress.daily.streak}</span>
              </div>
              <div className="play-actions">
                <button type="button" className="chip ghost" onClick={shareDaily}>
                  分享成绩
                </button>
                <button type="button" className="chip ghost" onClick={shareDailyChallenge} disabled={!dailyChallenge}>
                  挑战好友
                </button>
                <button type="button" className="chip ghost" onClick={onStartDaily} disabled={dailyBusy}>
                  {/* ⚠️ 跟下面那个按钮、跟玩法结束页的按钮用同一个说法：
                      「开始今日挑战 / 再来一次 / 再玩一次」三种叫法，
                      用户分不清哪个是重打今天的题。 */}
                  再来一次
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="play-card-note">
                {!historyReady
                  ? '正在加载历史数据…'
                  : dailyTarget
                    ? '最多选 3 个国家凑出目标，合计不能超过它。'
                    : '今天的题还没抽出来。'}
              </p>
              <div className="play-actions">
                <button type="button" className="primary-btn" onClick={onStartDaily} disabled={dailyBusy}>
                  {progress.daily.date === today ? '再来一次' : '开始今日挑战'}
                </button>
                {progress.daily.streak > 0 ? <span className="play-hint">连胜 {progress.daily.streak}</span> : null}
              </div>
            </>
          )}
        </section>

        <section className="play-card">
          <div className="play-card-top">
            <span className="play-kicker">Higher / Lower</span>
            <span className="play-badge">最佳 {progress.higherBest} 连</span>
          </div>
          <h3>谁更大？</h3>
          <p className="play-card-sub">
            按当前指标「{metric.label}」翻两张卡，猜数值更大的那一张。
            {/* ⚠️ 指标选择器在侧栏里：桌面上它在左边（不是下面），窄屏才排到下面。
                卡片上不指个路，多数人以为指标跟这张卡绑死了、不能改。
                ⚠️ 侧栏那个标题在玩法视图里是「Higher / Lower 用哪个指标」，
                不是别处的「比哪个方面」——指错了用户就找不到。 */}
            <span className="play-card-hint">指标可在侧栏的「Higher / Lower 用哪个指标」里改。</span>
          </p>
          <div className="play-actions">
            <button type="button" className="primary-btn" onClick={() => setGame('higher')} disabled={!historyReady || !higherItems.length}>
              开一局
            </button>
            {!historyReady ? <span className="play-hint">正在加载历史数据…</span> : null}
          </div>
        </section>

        <section className="play-card">
          <div className="play-card-top">
            <span className="play-kicker">盲猜轮廓</span>
            <span className="play-badge">最佳 {progress.blindBest}/10</span>
          </div>
          <h3>看形状猜地方</h3>
          <p className="play-card-sub">只给一个剪影，从四个名字里选。10 题一轮。</p>
          <div className="play-actions">
            <button type="button" className="primary-btn" onClick={() => setGame('blind')} disabled={!blindItems.length}>
              开一局
            </button>
            {!blindItems.length ? <span className="play-hint">轮廓加载中…</span> : null}
          </div>
        </section>

        <section className="play-card passport-card">
          <div className="play-card-top">
            <span className="play-kicker">经济护照</span>
            <span className="play-badge">
              {passportCount}/{passportTotal}
            </span>
          </div>
          <h3>盖满一本护照</h3>
          <p className="play-card-sub">选过的地方自动盖戳，按国家或地区分组。点印章能跳回地图。</p>
          <div className="passport-bar" aria-hidden="true">
            <span style={{ width: `${passportPercent}%` }} />
          </div>
          <div className="play-actions">
            <button type="button" className="primary-btn" onClick={() => setGame('passport')} disabled={!passportGroups.length}>
              翻开护照
            </button>
            <span className="play-hint">
              {/* ⚠️ 跟护照里的百分比同一个写法（固定一位小数），
                  不然同一件事在两处显示成「1%」和「0.7%」，像两套统计。 */}
              {passportPercent.toFixed(1)}% · 已收集 {passportCount} 个
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
