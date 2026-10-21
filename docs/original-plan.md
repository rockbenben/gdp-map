# GDP 等价地图（GDP Equivalence Map）项目文档

> ⚠️ **这是最初的方案原稿，不是当前设计。** 留档是为了对照「当初是怎么想的」，
> 里面有些地方后来没采纳（依赖清单、渲染方式、部署平台等）。
> **现在的状态、边界与验收标准以仓库根目录的 `AGENTS.md` 为准。**

<aside>
💡

一句话：用户随意选择一个或多个地区（省 / 州 / 城市 / 国家），系统自动找出 GDP 相当的国家（或反过来：一个国家 ≈ 哪几个地区之和），并在漂亮的 2D / 3D 地图上用同色高亮、柱状拔高、地球仪飞线等方式展示，可一键分享链接和导出图片。

</aside>

## 1. 背景与目标

网上常见"广东 GDP ≈ 韩国""加州 GDP ≈ 印度""日本 = 中国 N 个省之和"这类对比图，但都是静态图片，无法自己选、自己比。本项目目标：

- **可交互**：任何人都能自己挑地区、组合、对比。
- **好看**：默认就能出"可分享级别"的图，支持 3D 效果。
- **可分享**：选择状态写进 URL，分享链接即可复现；支持导出 PNG。
- **少造轮子**：地图、3D、状态、UI、数据处理全部用成熟库，自研只保留"GDP 匹配算法"这一小块业务逻辑。

## 2. 核心功能

### 2.1 三种对比模式

| 模式 | 输入 | 输出 | 示例 |
| --- | --- | --- | --- |
| A. 地区 → 国家 | 选 1 个地区 | GDP 最接近的 N 个国家 | 广东 ≈ 韩国 / 澳大利亚 |
| B. 多地区组合 → 国家 | 选多个地区 | 组合总和最接近的国家 | 江苏 + 浙江 ≈ 法国 |
| C. 国家 → 地区组合 | 选 1 个国家 + 地区池（如中国各省） | 若干个地区之和 ≈ 该国家 | 日本 ≈ 广东 + 江苏 + 山东 + … |

### 2.2 交互

- 地图上直接点击选择 / 取消地区；侧边栏搜索（支持中英文、拼音模糊搜索）。
- 结果中"被比较的双方"使用同一颜色高亮，其他区域灰显。
- 指标切换：名义 GDP（USD）/ PPP GDP；年份切换。
- 误差容忍度滑块（如 ±5%）。
- 一键"随机来一组"，增加趣味性。
- 分享：URL 自动同步状态；导出 PNG（带标题、数据来源水印）。

### 2.3 视觉模式

- **2D 平面地图**：同色块高亮 + 标注（适合分享图）。
- **2.5D 拔高地图**：按 GDP 将区域挤出为立体柱（倾斜视角）。
- **3D 地球仪**：旋转地球，被比较的地区之间用发光弧线（arc）连接。

## 3. 技术选型（全部成熟依赖）

### 3.1 前端框架与 UI

| 用途 | 依赖 | 说明 |
| --- | --- | --- |
| 框架 | Next.js（App Router）+ TypeScript | 也可用 Vite + React，纯静态站即可 |
| 样式 | Tailwind CSS |  |
| 组件库 | shadcn/ui（基于 Radix UI） | Slider、Select、Dialog、Tabs 等 |
| 搜索 / 命令面板 | cmdk + Fuse.js + pinyin-pro | 中英文 + 拼音模糊搜索 |
| 状态管理 | Zustand | 选中地区、模式、指标 |
| URL 状态同步 | nuqs | 选择状态 ↔ URL query，天然支持分享 |
| 国际化 | next-intl（或 i18next） | 中 / 英 |
| 动画 | Framer Motion | 侧边栏、结果卡片动画 |
| 图表（辅助） | ECharts（echarts-for-react） | 结果区的条形对比图 |

### 3.2 地图与 3D

| 用途 | 依赖 | 说明 |
| --- | --- | --- |
| 底图引擎 | MapLibre GL JS + react-map-gl | 开源、免 token，矢量渲染 |
| 底图样式 | OpenFreeMap / Protomaps（PMTiles）/ CARTO 底图 | 免费底图，可选暗色风格 |
| 数据可视化图层 | [deck.gl](http://deck.gl)（GeoJsonLayer、PolygonLayer、ArcLayer、TextLayer） | 支持 `extruded` 3D 拔高、弧线、与 MapLibre 叠加 |
| 3D 地球仪 | [react-globe.gl](http://react-globe.gl)（基于 three.js / [globe.gl](http://globe.gl)） | 多边形拔高、弧线、标签开箱即用 |
| 配色 | d3-scale-chromatic + d3-scale | 成对高亮色、GDP 色阶 |
| 地理计算 | Turf.js | 中心点（标签位置）、面积等 |
| 导出图片 | MapLibre `preserveDrawingBuffer`  • html-to-image | 地图 canvas + 叠加文字一起导出 |

> 备选：如果想要"一个库搞定"，也可以直接用 ECharts + echarts-gl（map3D / globe），开发更快，但定制性和美观上限不如 [deck.gl](http://deck.gl)。
> 

### 3.3 数据处理（离线脚本）

| 用途 | 依赖 |
| --- | --- |
| 数据清洗 | Python + pandas |
| 世界银行数据 | `wbgapi`（World Bank API Python 客户端） |
| 边界简化 / 合并 / 转 TopoJSON | mapshaper（CLI） |
| 前端解码 TopoJSON | topojson-client |
| 数据校验 | zod（前端）/ pydantic（脚本） |

## 4. 数据来源

<aside>
⚠️

数据口径统一是本项目最容易出错的地方：**同一年份、同一币种（USD）、同一口径（名义 / PPP）**才能比较。所有地区数据都要转换成 USD，并在页面上标注年份与来源。

</aside>

### 4.1 GDP 数据

| 范围 | 来源 | 备注 |
| --- | --- | --- |
| 国家 | World Bank WDI：`NY.GDP.MKTP.CD`（名义）、`NY.GDP.MKTP.PP.CD`（PPP） | 也可用 IMF WEO 获取最新年份 / 预测值 |
| 中国省级 | 国家统计局（年度数据） | 人民币 → 按同年平均汇率换算 USD |
| 美国州 | US BEA（GDP by State） | 本身为 USD |
| 欧洲 NUTS-1 / 2 | Eurostat（`nama_10r_2gdp`） | 欧元 → USD |
| 日本都道府县 | 内阁府 县民经济计算 | 时滞较大，需标注年份 |
| 其他国家一级行政区 | OECD Regional Database | MVP 可先不做 |
| 汇率 | World Bank `PA.NUS.FCRF`（年平均汇率） | 统一换算口径 |

### 4.2 边界数据

- 国家：Natural Earth `admin_0_countries`（1:50m）。
- 一级行政区：Natural Earth `admin_1_states_provinces`，或 geoBoundaries（ADM1）。
- 中国边界请使用符合国内审图要求的数据（如阿里云 DataV.GeoAtlas），面向国内发布时需注意地图合规问题。
- 用 mapshaper 简化到合适精度，输出 TopoJSON（体积通常可降至 1–3 MB）。

### 4.3 统一数据结构

```tsx
// regions.json（由离线脚本生成）
interface Region {
  id: string;          // 如 "CN-GD", "US-CA", "KOR"
  type: "country" | "admin1";
  parentIso3?: string; // admin1 所属国家，如 "CHN"
  name: { zh: string; en: string };
  gdp: {
    [year: string]: { nominalUsd?: number; pppUsd?: number };
  };
  source: string;      // 数据来源标识
}
```

边界文件中每个 feature 的 `properties.id` 与 `Region.id` 一一对应。

## 5. 匹配算法（唯一需要自研的部分）

逻辑很小，写成纯函数并配单元测试（Vitest）。

- **模式 A（1 → 国家）**：对国家列表按 `|gdp - target| / target` 排序，取前 N 个。O(n log n)。
- **模式 B（多 → 国家）**：先求和，再同模式 A。
- **模式 C（国家 → 地区组合）**：子集和近似问题。
    - 默认：贪心（从大到小填充，不超过目标 + 容忍度）→ 结果直观，接近"头部几个省"。
    - 可选："最少地区数"或"相邻地区"约束——相邻关系可用 topojson-client 的 `neighbors()` 直接得到，无需自己算拓扑。
    - 地区池一般 ≤ 60 个，性能不是问题。

```tsx
// lib/match.ts（示意）
export function closestCountries(target: number, countries: Region[], metric: Metric, year: string, n = 3) {
  return countries
    .map(c => ({ c, v: getGdp(c, metric, year) }))
    .filter(x => x.v)
    .sort((a, b) => Math.abs(a.v! - target) - Math.abs(b.v! - target))
    .slice(0, n);
}
```

## 6. 架构

纯静态站点，无需后端：

```
离线数据管线 (Python + mapshaper)
   └─► public/data/regions.json + boundaries.topo.json
          └─► Next.js 静态导出 (SSG)
                 ├─ Zustand（选择状态）◄─► nuqs（URL）
                 ├─ lib/match.ts（匹配算法）
                 └─ 视图层
                      ├─ MapLibre + deck.gl（2D / 2.5D）
                      └─ react-globe.gl（3D 地球）
```

- 数据年更一次，GitHub Actions 定时跑数据脚本并提交产物。
- 部署：Vercel / Cloudflare Pages，静态资源走 CDN。
- 分享图预览（可选）：Next.js `ImageResponse`（@vercel/og）生成 OG 图，让分享链接在社交平台带缩略图。

## 7. 目录结构

```
gdp-equivalence-map/
├─ data-pipeline/
│  ├─ fetch_worldbank.py      # wbgapi 拉取国家 GDP、汇率
│  ├─ fetch_regions.py        # 各国地区 GDP（统计局 / BEA / Eurostat）
│  ├─ build.py                # 合并、换算 USD、校验、输出 regions.json
│  └─ boundaries.sh           # mapshaper 简化 + 输出 TopoJSON
├─ public/data/
│  ├─ regions.json
│  └─ boundaries.topo.json
├─ src/
│  ├─ app/                    # Next.js 页面
│  ├─ components/
│  │  ├─ MapView2D.tsx        # react-map-gl + deck.gl
│  │  ├─ GlobeView.tsx        # react-globe.gl
│  │  ├─ RegionPicker.tsx     # cmdk + Fuse.js
│  │  ├─ ResultPanel.tsx      # 结果卡片 + ECharts 条形图
│  │  └─ ExportButton.tsx     # html-to-image
│  ├─ lib/
│  │  ├─ match.ts             # 匹配算法
│  │  ├─ data.ts              # 数据加载（topojson-client）
│  │  └─ colors.ts            # d3-scale-chromatic 配色
│  └─ store/useSelection.ts   # Zustand + nuqs
└─ tests/match.test.ts        # Vitest
```

## 8. 关键实现要点（都依赖库能力）

- **2.5D 拔高**：[deck.gl](http://deck.gl) `GeoJsonLayer`，`extruded: true`，`getElevation: f => gdp * scale`，`getFillColor` 按选中状态返回高亮色；配合 MapLibre `pitch: 45`。
- **点击选择**：[deck.gl](http://deck.gl) `pickable: true` + `onClick`，直接拿到 feature id。
- **地球弧线**：[react-globe.gl](http://react-globe.gl) `arcsData`，起点为被选地区中心（Turf `centroid`），终点为匹配国家中心；`arcDashAnimateTime` 实现流光动画。
- **地球多边形高亮**：[react-globe.gl](http://react-globe.gl) `polygonsData` + `polygonAltitude` 让被选区域"浮起"。
- **成对配色**：`d3.schemeTableau10`，每组对比（如 A 组：广东 ↔ 韩国）使用同一颜色。
- **URL 分享**：nuqs 将 `?mode=A&ids=CN-GD,CN-JS&metric=nominal&year=2024` 同步到状态。
- **导出**：MapLibre 初始化时开启 `preserveDrawingBuffer`，html-to-image 截取包含地图与标题卡片的容器。

## 9. 里程碑

### MVP（约 1–2 周）

- [ ]  数据：国家（World Bank）+ 中国省级 + 美国州，单一年份，名义 GDP
- [ ]  模式 A、B
- [ ]  2D 地图 + 同色高亮 + 搜索选择
- [ ]  URL 分享 + PNG 导出
- [ ]  部署到 Vercel

### V1

- [ ]  模式 C（国家 → 地区组合，含"相邻地区"约束）
- [ ]  2.5D 拔高视图 + 3D 地球仪视图
- [ ]  PPP 指标、年份切换
- [ ]  中英文切换、OG 分享图

### V2

- [ ]  更多国家一级行政区（欧洲 NUTS、日本、印度等）
- [ ]  城市级 GDP（需整理城市边界数据）
- [ ]  人均 GDP、人口等其他指标对比
- [ ]  时间轴动画（历年"某省追上某国"的变化）

## 10. 风险与注意事项

- **数据口径**：不同国家统计年份、修订频率不同，页面必须展示年份与来源；缺失数据要明确标为"无数据"，不要插值掩盖。
- **汇率影响**：名义 GDP 对汇率敏感，建议默认名义、同时提供 PPP 切换，并在说明中解释差异。
- **地图合规**：涉及中国境内发布时，边界数据需使用合规底图，必要时申请审图号；争议地区处理需谨慎。
- **性能**：一级行政区全球边界较大，按需加载（先国家，选中国家后再加载该国 admin1），或使用 PMTiles 矢量瓦片。
- **移动端**：3D 地球在低端手机上较耗资源，移动端默认 2D 视图。

## 11. 参考链接

- [deck.gl](https://deck.gl) · [MapLibre GL JS](https://maplibre.org) · [react-map-gl](https://visgl.github.io/react-map-gl/)
- [globe.gl / react-globe.gl](https://github.com/vasturiano/react-globe.gl)
- [Natural Earth](https://www.naturalearthdata.com) · [geoBoundaries](https://www.geoboundaries.org) · [mapshaper](https://github.com/mbloch/mapshaper)
- [World Bank Data API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392) · [wbgapi](https://pypi.org/project/wbgapi/)
- [shadcn/ui](https://ui.shadcn.com) · [nuqs](https://nuqs.47ng.com) · [Zustand](https://github.com/pmndrs/zustand)