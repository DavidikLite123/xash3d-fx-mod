#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════
   HASH ONLINE · server.js/dev-server — автономный dev-сервер портала
   Ноль зависимостей (только стандартная библиотека Node.js, ESM).

   Зачем: оригинальный asm.js-порт Xash3D отдаёт статику из корня
   репозитория (index.html, app.js, xash.js, xash.html.mem, server.js,
   client.js, menu.js, vendor/), поэтому сервер:
     · раздаёт корень как есть,
     · ставит COOP/COEP (изолированное окружение),
     · отдаёт корректный MIME для .mem / .wasm / .js.

   Запуск:  node dev-server.js            (порт из $PORT или 8080)
            PORT=3000 node dev-server.js
   ════════════════════════════════════════════════════════════════ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  /* инициализатор статической памяти ядра xash.js (Module.memoryInitializerRequest) */
  '.mem':  'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.zip':  'application/zip',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
};

const stamp = () => new Date().toISOString().slice(11, 19);

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.normalize(path.join(ROOT, urlPath));

    // защита от выхода за пределы корня
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('403 Forbidden');
      return;
    }

    let stat = fs.existsSync(filePath) && fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = fs.existsSync(filePath) && fs.statSync(filePath);
    }

    // вся статика (включая ядро /xash.js, /xash.html.mem, /server.js,
    // /client.js, /menu.js) лежит прямо в корневой директории репозитория
    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('404 — файл не найден: ' + urlPath);
      console.log(`[${stamp()}] 404 ${req.url}`);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      // изоляция окружения (SharedArrayBuffer / потоки wasm на будущее)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    fs.createReadStream(filePath).pipe(res);
    console.log(`[${stamp()}] 200 ${req.url} (${stat.size} B)`);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('500 — ' + err.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  HASH ONLINE · dev-server Xash3D             │');
  console.log('└──────────────────────────────────────────────┘');
  console.log(`  root (репо): ${ROOT}`);
  console.log(`  url        : http://${HOST}:${PORT}/`);
  console.log('  ядро       : /xash.js + /xash.html.mem + /server.js + /client.js + /menu.js');
  console.log('  coop/coep  : включены · mime .mem/.wasm: octet-stream/application-wasm');
});
