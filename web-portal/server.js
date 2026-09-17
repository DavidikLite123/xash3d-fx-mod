#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════
   ХА-КЭШ · server.js — автономный dev-сервер портала Hash Online
   Ноль зависимостей (только стандартная библиотека Node.js).

   Зачем: официальный wasm-порт движка требует изолированного
   окружения (SharedArrayBuffer), поэтому сервер отдаёт заголовки
   COOP/COEP и корректный MIME для .wasm уже сейчас.

   Запуск:  node server.js            (порт из $PORT или 8080)
            PORT=3000 node server.js
   ════════════════════════════════════════════════════════════════ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
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
      // изоляция окружения для будущего SharedArrayBuffer (wasm threads)
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
  console.log('│  HASH ONLINE · dev-server «Ха-кэш»           │');
  console.log('└──────────────────────────────────────────────┘');
  console.log(`  root : ${ROOT}`);
  console.log(`  url  : http://${HOST}:${PORT}/`);
  console.log('  coop/coep: включены · wasm mime: application/wasm');
});
