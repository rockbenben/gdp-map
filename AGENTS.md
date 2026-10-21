# AGENTS.md

046 · GDP 等价地图：把「一个省相当于多少个国家」做成可以自己玩、自己分享的图。

> 写给协作方（AI 编程工具或人类开发者）。读完这一份就该知道：项目是什么、边界在哪、
> 哪些已决定、下一步做什么、怎样算做完。

---

## 1. 一句话

选一个中国省级地区（或一个国家），自动匹配出「它相当于哪些国家之和」，
在 2D 世界地图 / 中国地图 / 3D 地球上高亮出来，可以分享链接、导出 PNG。

## 2. 现状

已经跑起来了：数据管线、2D 地图、3D 地球、搜索、URL 分享、PNG 导出全部可用，
浏览器级验收 26 项全过。

```
046/
├── AGENTS.md / README.md / LICENSE
├── package.json / tsconfig.json / vite.config.ts / vitest.config.ts
├── scripts/
│   ├── fetch-sources.mjs   # 抓原始数据源 → data/raw/
│   ├── build-data.mjs      # 合并 → public/data/regions.json + public/geo/*
│   └── acceptance.mjs      # Playwright 验收（用本机 Chrome）
├── data/
│   ├── provincial-gdp-2024.json   # 年鉴表 3-9 读数（含出处 URL）
│   ├── us-states.json             # 美国 51 州中英文名对照
│   └── raw/                       # 原始缓存（.gitignore）
├── public/
│   ├── data/regions.json          # 统一对象池：189 国 + 34 中国省级 + 51 美国州
│   └── geo/{world,china,us-states}.json
└── src/
    ├── lib/match.ts               # 唯一自研：贪心累加匹配
    ├── lib/metrics.ts             # 指标定义（格式、标题、能不能累加）
    ├── lib/{data,geo,format,url,export}.ts
    └── components/{WorldMap,ChinaMap,GlobeView,RegionPicker,ResultPanel,AreaSilhouette,SouthSeaBox}.tsx
```

- 数据年份 2024：国家用 IMF WEO 2025-04 的实际值，中国省级用《中国统计年鉴2025》表 3-9，
  美国各州用 BEA 州级 GDP。
- 交叉校验：31 省合计与全国 GDP 差 0.72%；美国 51 州合计与全美 GDP 差 0.16%。

## 3. 已确定的事（不要重新讨论）

1. **主答案是「一组国家」，不是一个。** 「河南 ≈ 81 个国家」这个数字才是这个项目的卖点，
   所以匹配算法用贪心累加，不要改成「找最接近的单个国家」。
2. **对照方式有四种，不要合并成一种。** 纯贪心永远给出图瓦卢、瑙鲁那一串微型国家，
   所以另给了「尽量多件 / 尽量打过 / 大件优先 / 最接近」四种口径，
   外加「忽略微型经济体（人口 < 100 万）」开关。默认「尽量打过」。
3. **指标有四个，不只是 GDP。** 总 GDP / 人均 GDP / 面积 / 人口。
   人均 GDP 不可累加，只能跟单个对象比：UI 里另外三个口径会置灰，地区只能单选，
   URL 里的口径参数会被锁成 `nearest`（`effectiveStrategy` 是唯一权威值）。
   面积、人口、总量可累加。指标定义集中在 `src/lib/metrics.ts`，加指标不用动算法。
4. **不只中国。** 地区池是「国家 + 省/州」的统一对象池（`regions.json` 的 `objects`），
   目前有中国 34 个省级行政区与美国 51 个州；接欧洲 NUTS、日本都道府县只要再加一份源数据。
5. **纯 SVG，不引 WebGL。** 地球用 d3-geo 正射投影实现。曾经用 globe.gl（three.js），
   在受限环境里会把页面渲染进程卡死，且导出要走 canvas，收益远小于代价。
6. **只用名义 GDP（当年价格美元）。** PPP 在原始数据里备着，但省级没有同口径 PPP 源，
   开放切换会造成两边口径不一致，所以不做。
7. **数据年份锁定 2024。** 这是双方都有官方实绩的最新完整年度。要扩年份，先解决省级数据来源。
8. **中国地图用 DataV 边界并附南海诸岛小图。** 面向国内发布时这是合规要求，别去掉。
9. **台湾并入中国轮廓（世界地图）。** 中国省级列表里台湾省是单独一级行政区。
10. **港澳台走省级池，不进国家池。** 避免同一个经济体在两个列表里各出现一次。
11. **对照方式与过滤开关写进 URL。** 分享链接要复现同一张图，光有选择项不够。

## 4. 已知的技术坑（改代码前先看这里）

- **d3-geo 与 DataV 边界的绕向相反。** 直接渲染会被当成「球面补集」，整张图变成一个碗。
  `scripts/build-data.mjs` 里的 `reverseRings()` 就是为此存在的，改动数据管线时别把它删了。
- **国家统计局数据接口（data.stats.gov.cn）对本机 IP 返回 403（UrlACL）。**
  分省数据因此来自年鉴图片，不是接口。
- **IMF 官网对本机 403。** IMF WEO 走 DBnomics 镜像（`api.db.nomics.world`）。
- **导出前必须摘掉 SVG 上的滤镜。** 逐路径高斯模糊会让栅格化慢到页面假死（105 个高亮路径时实测会卡）。
  `src/lib/export.ts` 里已经做了 `clone.querySelectorAll('[filter]')` 的清理。
- **地球每帧要重算 209 条路径**，所以做了节流（约 18 帧/秒），别去掉。
- **3D 弧线不能横穿球体。** 正射投影在背面返回 null，那一段必须断开成新的子路径，
  否则两点会被直接连成一条横穿地图的直线（这正是「虚线对不上地点」的成因）。
  `src/components/GlobeView.tsx` 里按可见片段拼 `M…L…` 多段子路径。
- **弧线端点要用「主体质心」而不是整国质心。** `geoCentroid` 会把离岛（法属圭亚那之类）
  一起算进去，质心漂到海上，线就落不到地方上；用 `geo.ts` 的 `featureMainCentroid()`。
- **国家统计局年鉴表是图片**（`html/C03-09.jpg`），数值是人工读出来的，存在 `data/provincial-gdp-2024.json`；
  换年鉴版本时要重新读数，不要从别处抄。
- **算面积要用反转绕向后的几何。** 原始 DataV 绕向会被 d3-geo 当成球面补集，
  算出来是 5 亿 km²（`reverseRings()` 之后才是对的 16.6 万 km²）。
- **d3 的 `path.bounds()` 返回 2×2 数组**（`[[x0,y0],[x1,y1]]`），按 4 元组取中心点会得到 NaN，
  路径就会变成 `MNaN,NaN...`（剪影对照踩过这个坑）。
- **面积剪影对照必须用等积投影**（geoEqualEarth）。用 Mercator 的话高纬度国家会被放大，
  比出来的「谁大」就是假的。

## 5. 下一步可以做什么

按价值排序：

1. **再接几个国家的一级行政区**（欧洲 NUTS-1、日本都道府县、德国联邦州、巴西州），
   管线加一份源文件 + 一个中文名对照表即可，数据模型已经是统一的 `objects` 池。
2. **省掉图片人工读数**：找一份可机读的分省 GDP 官方来源（年鉴 Excel、统计公报汇总），
   把 `data/provincial-gdp-2024.json` 变成脚本产物。
3. **PPP 口径**：需要省级 PPP 源，否则保持现状。
4. **OG 分享图**：加 `ImageResponse` 之类，让分享链接在社交平台带缩略图。
5. **部署**：静态站，`dist/` 可直接上 Cloudflare Pages / GitHub Pages / Vercel。

## 6. 怎样算做完

- `npm run typecheck` 无错
- `npm run test` 全绿（核心算法单测）
- `node scripts/acceptance.mjs` 26 项全过（需先起 dev server）
- `npm run build` 成功产出 `dist/`
- 页脚数据来源与官方原表链接可点、可见
