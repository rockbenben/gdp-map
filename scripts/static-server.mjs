/**
 * 验收用的静态服务器：伺服 dist/。
 *
 * 为什么自己写而不用 `vite preview`：
 *   - `vite preview` 要先有 devDependencies 装好，CI 里 `npm ci` 之后当然有，
 *     但它是个 CLI，端口被占时行为不好控，自己起一个更省事；
 *   - 验收脚本要能「一条命令跑完」，所以服务器得由脚本自己管，脚本结束就关掉。
 *
 * 只做三件事，够用即可：
 *   1. 正确的 MIME（.js 必须以 text/javascript 下发，否则浏览器拒绝执行 ES module）
 *   2. 目录 → index.html
 *   3. 不许走出 dist 目录
 *
 * 绑定 127.0.0.1：localhost 属于安全上下文，http 就够了，不需要证书。
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 起一个静态服务器。
 * @param {string} rootDir 要伺服的目录（dist/）
 * @param {number} [port] 0 表示让系统挑一个空闲端口
 * @returns {Promise<{origin: string, port: number, close: () => Promise<void>}>}
 */
export function startServer(rootDir, port = 0) {
  const root = path.resolve(rootDir);

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.endsWith('/')) pathname += 'index.html';

        const file = path.resolve(root, '.' + pathname);
        // 防目录穿越
        if (file !== root && !file.startsWith(root + path.sep)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('403 forbidden');
          return;
        }

        const info = await stat(file).catch(() => null);
        if (!info || !info.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404 not found: ' + pathname);
          return;
        }

        res.writeHead(200, {
          'Content-Type': contentType(file),
          'Content-Length': info.size,
          // 每次跑验收都拿到最新产物，不吃浏览器缓存
          'Cache-Control': 'no-cache'
        });
        createReadStream(file).pipe(res);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 ' + String(err));
      }
    })();
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolvePromise({
        origin: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          })
      });
    });
  });
}
