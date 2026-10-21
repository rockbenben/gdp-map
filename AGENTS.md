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
浏览器级验收 12 项全过。

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
│   └── raw/                       # 原始缓存（.gitignore）
├── public/
│   ├── data/regions.json          # 189 个国家 + 34 个省级地区
│   └── geo/{world,china}.json
└── src/
    ├── lib/match.ts               # 唯一自研：贪心累加匹配
    ├── lib/{data,geo,format,url,export}.ts
    └── components/{WorldMap,ChinaMap,GlobeView,RegionPicker,ResultPanel}.tsx
```

- 数据年份 2024：国家用 IMF WEO 2025-04 的实际值，省级用《中国统计年鉴2025》表 3-9。
- 31 省合计与全国 GDP 差 0.72%（地区加总 ≠ 全国的正常口径差）。

## 3. 已确定的事（不要重新讨论）

1. **主答案是「一组国家」，不是一个。** 「河南 ≈ 81 个国家」这个数字才是这个项目的卖点，
   所以匹配算法用贪心累加，不要改成「找最接近的单个国家」。
2. **纯 SVG，不引 WebGL。** 地球用 d3-geo 正射投影实现。曾经用 globe.gl（three.js），
   在受限环境里会把页面渲染进程卡死，且导出要走 canvas，收益远小于代价。
3. **只用名义 GDP（当年价格美元）。** PPP 在原始数据里备着，但省级没有同口径 PPP 源，
   开放切换会造成两边口径不一致，所以不做。
4. **数据年份锁定 2024。** 这是双方都有官方实绩的最新完整年度。要扩年份，先解决省级数据来源。
5. **中国地图用 DataV 边界并附南海诸岛小图。** 面向国内发布时这是合规要求，别去掉。
6. **台湾并入中国轮廓（世界地图）。** 中国省级列表里台湾省是单独一级行政区。
7. **港澳台走省级池，不进国家池。** 避免同一个经济体在两个列表里各出现一次。

## 4. 已知的技术坑（改代码前先看这里）

- **d3-geo 与 DataV 边界的绕向相反。** 直接渲染会被当成「球面补集」，整张图变成一个碗。
  `scripts/build-data.mjs` 里的 `reverseRings()` 就是为此存在的，改动数据管线时别把它删了。
- **国家统计局数据接口（data.stats.gov.cn）对本机 IP 返回 403（UrlACL）。**
  分省数据因此来自年鉴图片，不是接口。
- **IMF 官网对本机 403。** IMF WEO 走 DBnomics 镜像（`api.db.nomics.world`）。
- **导出前必须摘掉 SVG 上的滤镜。** 逐路径高斯模糊会让栅格化慢到页面假死（105 个高亮路径时实测会卡）。
  `src/lib/export.ts` 里已经做了 `clone.querySelectorAll('[filter]')` 的清理。
- **地球每帧要重算 209 条路径**，所以做了节流（约 18 帧/秒），别去掉。
- **国家统计局年鉴表是图片**（`html/C03-09.jpg`），数值是人工读出来的，存在 `data/provincial-gdp-2024.json`；
  换年鉴版本时要重新读数，不要从别处抄。

## 5. 下一步可以做什么

按价值排序：

1. **省掉图片人工读数**：找一份可机读的分省 GDP 官方来源（年鉴 Excel、统计公报汇总），
   把 `data/provincial-gdp-2024.json` 变成脚本产物。
2. **接入美国州 / 欧洲 NUTS-1**，让「地方」不止中国。
3. **PPP 口径**：需要省级 PPP 源，否则保持现状。
4. **OG 分享图**：加 `ImageResponse` 之类，让分享链接在社交平台带缩略图。
5. **部署**：静态站，`dist/` 可直接上 Cloudflare Pages / GitHub Pages / Vercel。

## 6. 怎样算做完

- `npm run typecheck` 无错
- `npm run test` 全绿（核心算法单测）
- `node scripts/acceptance.mjs` 12 项全过（需先起 dev server）
- `npm run build` 成功产出 `dist/`
- 页脚数据来源与官方原表链接可点、可见
