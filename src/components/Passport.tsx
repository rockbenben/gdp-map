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
  // ⚠️ **固定一位小数**：四舍五入到整数的话，4/415 会显示成「1%」，
  // 而一位小数是「1.0%」——同一件事两种写法，看着像两套统计。
  const percentText = `${percent.toFixed(1)}%`;
  const group = groups.find((g) => g.key === active) ?? groups[0];
  const groupCollected = group ? group.items.filter((item) => collectedSet.has(item.id)).length : 0;

  const share = () =>
    onShare(`我的经济护照：已收集 ${collected}/${total} 个地方（${percentText}），来 GDP 等价地图盖戳`, '护照进度已复制');

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
          <p className="play-sub">
            选过的参照物会自动盖戳。
            {/* ⚠️ 光说「点印章能跳回地图」不够：格子里大部分是**没盖过**的，
                用户不知道该点没章的（去盖）还是有章的（跳回），
                于是可能一个都不敢点。两种格子都写清楚。 */}
            点没盖过的地方＝去那儿盖戳，点盖过的印章＝跳回地图。
          </p>
        </div>
        <span className="passport-percent">{percentText}</span>
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
        <span className="play-hint">
          {group ? `${group.label}：${groupCollected}/${group.items.length}` : ''}
        </span>
        {/* ⚠️ 「重置」是危险操作（清掉全部收集进度），不能跟「分享」并排挨着——
            扫一眼就会按错。用 margin-left:auto 把它顶到行末（同一行，但离得远），
            DOM 里也放在最后。 */}
        <button type="button" className="chip ghost passport-reset" onClick={handleReset}>
          {confirming ? '再点一次确认重置' : '重置护照'}
        </button>
      </div>
    </section>
  );
}
