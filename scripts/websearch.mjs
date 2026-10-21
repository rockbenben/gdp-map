#!/usr/bin/env node
/**
 * 网页搜索 / 网页抓取（走 DeepSeek 的 Search & Fetch API）。
 *
 * 为什么要它：写数据管线的时候，找官方数据源、核对口径、读文档，
 * 全靠「猜 URL → 抓 → 404 → 再猜」，绕得很。搜索 API 一句话就能给出准确地址，
 * 抓取 API 还能把网页直接转成 Markdown，省掉手写 HTML 清洗。
 *
 * 用法：
 *   node scripts/websearch.mjs "查询词" [--count 5] [--content]
 *   node scripts/websearch.mjs --fetch <url>
 *
 * 凭据：环境变量 DEEPSEEK_API_KEY
 *   （DeepSeek 的 Search & Fetch API 是免费的；key 在 platform.deepseek.com 申请）
 *
 * 搜索语法（会原样传给它的搜索引擎）：
 *   site:example.com   限定站点，多个用空格分隔（OR）
 *   -site:example.com  排除站点
 *   "精确短语"          精确匹配
 *   lang:zh,en         限定语言
 *   after:2025-01-01   限定发布时间
 */
import { writeFile } from 'node:fs/promises';

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error('缺少环境变量 DEEPSEEK_API_KEY');
  process.exit(1);
}
const HEADERS = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const BASE = 'https://api.deepseek.com/v1/tools';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// ---------- 抓取 ----------
if (flag('--fetch')) {
  const url = opt('--fetch');
  if (!url) {
    console.error('--fetch 需要一个网址');
    process.exit(1);
  }
  const page = await post('/fetch', { url });
  const out = opt('--out');
  if (out) {
    await writeFile(out, page.content ?? '', 'utf8');
    console.error(`已写入 ${out}（${(page.content ?? '').length} 字符）`);
  } else {
    console.log(`# ${page.title ?? url}\n\n${page.content ?? ''}`);
  }
  process.exit(0);
}

// ---------- 搜索 ----------
const query = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--count')).join(' ');
if (!query) {
  console.error('给一个查询词，或用 --fetch <url>');
  process.exit(1);
}

const count = Number(opt('--count', '5'));
const needContent = flag('--content');
const data = await post('/search', { query, count, need_content: needContent });

console.log(`# ${query}\n`);
for (const [i, r] of (data.results ?? []).entries()) {
  const meta = [r.site_name, r.date?.slice(0, 10), r.authority != null ? `权威 ${r.authority}` : null]
    .filter(Boolean)
    .join(' · ');
  console.log(`## ${i + 1}. ${r.title}`);
  console.log(`${r.url}`);
  if (meta) console.log(`   ${meta}`);
  if (r.summary) console.log(`   ${r.summary}`);
  if (r.content) console.log(`\n   ${r.content.slice(0, 1200)}…`);
  console.log();
}
console.log(`共 ${(data.results ?? []).length} 条`);
