/**
 * 重测「慢网首屏结论出现」：本地伺服 dist/（**带 gzip**，对齐 GitHub Pages 的行为），
 * 用 CDP 限速到 4 Mbps，量到结论渲染出来用了多久。
 *
 * 为什么不用线上站点量：网络路径本身有噪声，同一条件连测三次是 8.9 / 10.8 / 18.9 秒，
 * 没法作为「可复现的实测」写进文档。本地这条路上只剩应用自身的成本。
 *
 * 用法：npm run audit:firstpaint        （默认 4 Mbps + 60ms RTT）
 *       node scripts/audit-firstpaint.mjs [downKBPS] [rttMs]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { resolve, join, extname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const DOWN_KBPS = Number(process.argv[2] ?? 500); // 4 Mbps ≈ 500 KB/s
const RTT_MS = Number(process.argv[3] ?? 60);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = join(DIST, p);
  try {
    const raw = await readFile(file);
    const body = gzipSync(raw, { level: 9 });
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Encoding': 'gzip',
      'Content-Length': body.length
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('404');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.enable');
// ⚠️ CDP 的 downloadThroughput 单位是**字节/秒**，按位填会慢 8 倍。
await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: RTT_MS,
  downloadThroughput: DOWN_KBPS * 1024,
  uploadThroughput: DOWN_KBPS * 1024
});

const t0 = Date.now();
const log = [];
page.on('response', (r) => {
  const h = r.headers();
  log.push({ t: Date.now() - t0, url: r.url().replace(origin, ''), len: Number(h['content-length'] ?? 0) });
});

await page.goto(`${origin}/?sel=CN-410000`, { waitUntil: 'commit' });
await page.waitForSelector('.result-headline h1', { timeout: 60000 });
const tHeadline = Date.now() - t0;
const headline = (await page.locator('.result-headline h1').first().innerText()).replace(/\s+/g, ' ');

console.log(`伺服: ${origin}（gzip，与 GitHub Pages 同一套行为）`);
console.log(`限速: ${DOWN_KBPS} KB/s (${((DOWN_KBPS * 1024 * 8) / 1e6).toFixed(2)} Mbps), RTT ${RTT_MS}ms`);
console.log(`结论出现: ${(tHeadline / 1000).toFixed(2)}s  「${headline}」`);
console.log('\n逐个请求：');
for (const l of log.sort((a, b) => a.t - b.t)) {
  console.log(`  ${String(l.t).padStart(6)} ms  ${l.url.padEnd(34)} ${l.len ? (l.len / 1024).toFixed(0) + ' KB' : '—'}`);
}
const total = log.reduce((a, l) => a + l.len, 0);
console.log(`  合计 ${(total / 1024).toFixed(0)} KB（gzip 后）`);

await browser.close();
server.close();
