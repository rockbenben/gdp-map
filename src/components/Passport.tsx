import { useState } from 'react';

export interface PassportGroup {
  key: string;
  label: string;
  items: { id: string; zh: string; kind: 'country' | 'region' }[];
}

interface Props {
  groups: PassportGroup[];
  passport: string[];
  selectedIds: string[];
  onSelect: (id: string, kind: 'country' | 'region') => void;
  onReset: () => void;
  onShare: (text: string, message: string) => void;
  onBack: () => void;
}

/** 经济护照：选过的参照物按地区分组盖戳 */
export function Passport({ groups, passport, selectedIds, onSelect, onReset, onShare, onBack }: Props) {
  const [active, setActive] = useState(groups[0]?.key ?? '');
  const [confirming, setConfirming] = useState(false);

  const collectedSet = new Set(passport);
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  const collected = groups.reduce(
    (sum, g) => sum + g.items.filter((item) => collectedSet.has(item.id)).length,
    0
  );
  // 415 个地方时 2 个只占 0.5%，整数百分比会一直显示 0
  const percent = total ? Math.round((collected / total) * 1000) / 10 : 0;
  const group = groups.find((g) => g.key === active) ?? groups[0];
  const groupCollected = group ? group.items.filter((item) => collectedSet.has(item.id)).length : 0;

  const share = () =>
    onShare(`我的经济护照：已收集 ${collected}/${total} 个地方（${percent}%），来 GDP 等价地图盖戳`, '护照进度已复制');

  const handleReset = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    onReset();
    setConfirming(false);
  };

  return (
    <section className="play-game passport">
      <header className="play-game-head">
        <button type="button" className="chip ghost" onClick={onBack}>
          返回玩法
        </button>
        <div>
          <span className="play-kicker">经济护照</span>
          <h2>
            已收集 {collected}/{total}
          </h2>
          <p className="play-sub">选过的参照物会自动盖戳，点印章可以跳回地图。</p>
        </div>
        <span className="passport-percent">{percent}%</span>
      </header>

      <div className="passport-bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>

      <div className="passport-tabs" role="tablist" aria-label="护照分组">
        {groups.map((g) => {
          const n = g.items.filter((item) => collectedSet.has(item.id)).length;
          return (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={group?.key === g.key}
              className={`passport-tab${group?.key === g.key ? ' active' : ''}`}
              onClick={() => setActive(g.key)}
            >
              {g.label}
              <b>
                {n}/{g.items.length}
              </b>
            </button>
          );
        })}
      </div>

      {group ? (
        <div className="passport-grid">
          {group.items.map((item) => {
            const on = collectedSet.has(item.id);
            const current = selectedIds.includes(item.id);
            return (
              <button
                key={item.id}
                type="button"
                className={`passport-tile${on ? ' on' : ''}${current ? ' current' : ''}`}
                title={item.zh}
                aria-pressed={on}
                onClick={() => onSelect(item.id, item.kind)}
              >
                <span>{item.zh}</span>
                {on ? (
                  <i className="passport-stamp" aria-hidden="true">
                    ✓
                  </i>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="play-hint">地区数据加载中…</p>
      )}

      <div className="play-actions">
        <button type="button" className="primary-btn" onClick={share}>
          分享护照
        </button>
        <button type="button" className="chip ghost" onClick={handleReset}>
          {confirming ? '再点一次确认重置' : '重置护照'}
        </button>
        <span className="play-hint">
          {group ? `${group.label}：${groupCollected}/${group.items.length}` : ''}
        </span>
      </div>
    </section>
  );
}
