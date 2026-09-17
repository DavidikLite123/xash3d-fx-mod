#!/usr/bin/env node
/* Smoke-тест: реальный /xash.js (Emscripten glue) под Node.
   Проверяем: noInitialRun-безопасный runtime-init с подменой памяти,
   живость Module.FS (mkdir/mkdirTree/createDataFile/readFile). */
'use strict';
const path = require('path');

const log = [], errs = [];
let initialized = false;

global.Module = {
  noInitialRun: true,
  arguments: ['-dev', '3', '-log'],
  print: (t) => { if (log.length < 60) log.push(String(t)); },
  printErr: (t) => { if (errs.length < 120) errs.push(String(t)); },
  setStatus: (t) => { if (log.length < 60) log.push('[status] ' + t); },
  monitorRunDependencies: (n) => { log.push('[deps] ' + n); },
  onRuntimeInitialized: () => { initialized = true; },
  // xash.html.mem в поставку не входит — подменяем инициализатор памяти нулями,
  // чтобы runtime-init прошёл без сети и main() НЕ вызывался (noInitialRun)
  ENVIRONMENT: 'WEB',
};

/* xash.html.mem в поставку не входит: браузерный glue берёт инициализатор
   памяти через XHR — отдаём нулевой буфер нужной длины через шим. */
const MEM_ZERO = new ArrayBuffer(67358736 + 64);
global.XMLHttpRequest = function FakeXHR() {
  const listeners = { load: [] };
  return {
    status: 0, response: null, responseType: '',
    open(method, url) { this._url = url; },
    onload: null, onerror: null,
    addEventListener: (type, cb) => { (listeners[type] = listeners[type] || []).push(cb); },
    removeEventListener: () => {},
    send() {
      setTimeout(() => {
        this.status = /\.mem($|\?)/i.test(this._url || '') ? 200 : 404;
        this.response = this.status === 200 ? MEM_ZERO : null;
        const events = [...(listeners.load || [])];
        if (this.onload) events.push(this.onload);
        events.forEach((cb) => cb({ target: this }));
      }, 0);
    },
  };
};

/* минимальный DOM-поддельщик, чтобы glue выбрал WEB-ветку без браузера */
const fakeCanvas = () => ({
  width: 640, height: 480, style: {},
  getContext: () => null,
  addEventListener: () => {}, removeEventListener: () => {},
  setAttribute: () => {}, focus: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
});
global.window = { addEventListener: () => {}, removeEventListener: () => {},
  innerWidth: 640, innerHeight: 480, devicePixelRatio: 1, location: { href: 'http://localhost/' } };
global.document = {
  readyState: 'complete',
  addEventListener: () => {}, removeEventListener: () => {},
  createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : { style: {}, appendChild: () => {} }),
  getElementById: () => null,
  body: { appendChild: () => {} },
  exitPointerLock: () => {}, exitFullscreen: () => Promise.resolve(),
  fullscreenElement: null, pointerLockElement: null,
};
global.self = global.window;
window.navigator = { userAgent: 'node-smoke', hardwareConcurrency: 4 };

(async () => {
  console.log('загружаю', path.join(__dirname, '..', 'xash.js'), '…');
  const t0 = Date.now();
  const vm = require('vm');
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'xash.js'), 'utf8');
  /* оцениваем в ГЛОБАЛЬНОМ контексте — как <script src="xash.js">:
     тогда glue увидит наш глобальный var Module (require() был бы
     обёрткой модуля и спрятал бы его за локальной var Module) */
  vm.runInThisContext(src, { filename: 'xash.js' });
  console.log('скрипт выполнен за', ((Date.now() - t0) / 1000).toFixed(1), 's — жду runtime…');

  global.Module['arguments'] = ['-dev', '3', '-log'];
  const prevInit = global.Module.onRuntimeInitialized;
  global.Module.onRuntimeInitialized = () => {
    if (prevInit) prevInit();
    log.push('[init] main() заблокирован: нет xash.html.mem — живёт только Module.FS');
    global.Module.callMain = () => { log.push('[init] callMain перехвачен (main не запускается)'); };
  };

  await new Promise((res) => {
    let guard = 0;
    const iv = setInterval(() => { if (initialized || ++guard > 240) { clearInterval(iv); res(); } }, 250);
  });

  console.log('onRuntimeInitialized:', initialized);
  console.log('Module.FS:', typeof global.Module.FS);

  if (global.Module.FS) {
    const FS = global.Module.FS;
    const show = (r) => {
      if (r === undefined) return '';
      if (Array.isArray(r) && typeof r[0] === 'string') return 'entries: ' + r.join(', ');
      if (typeof r === 'string') return '"' + r + '"';
      if (r && typeof r === 'object' && 'type' in r && 'parent' in r) return (r.type === 'directory' ? 'dir' : 'node') + ':' + (r.name || '');
      try { return JSON.stringify(r); } catch (e) { return String(r); }
    };
    const step = async (label, fn) => {
      try { const r = await fn(); console.log('  ✓', label, show(r)); return r; }
      catch (e) { console.log('  ✗', label, '→', e && (e.message || e.errno || e.code), '| errno?', e && e.errno); throw new Error('step failed: ' + label); }
    };
    console.log('  methods:', ['mkdir', 'mkdirTree', 'createDataFile', 'readFile', 'readdir', 'writeFile', 'analyzePath', 'symlink']
      .map((m) => m + (typeof FS[m] === 'function' ? '✓' : '✗')).join(' '));
    try {
      await step('mkdir /xash', () => FS.mkdir('/xash'));
      await step('mkdir /xash/valve', () => FS.mkdir('/xash/valve'));
      if (typeof FS.mkdirTree === 'function') await step('mkdirTree /xash/valve/models', () => FS.mkdirTree('/xash/valve/models'));
      else await step('mkdir (fallback) models', () => ['models'].forEach((d) => FS.mkdir('/xash/valve/' + d)));
      await step('createDataFile liblist (string)', () => FS.createDataFile('/xash/valve', 'liblist.gam', 'game "Half-Life"\n', true, true, false));
      await step('createDataFile player.mdl (bytes)', () => FS.createDataFile('/xash/valve/models', 'player.mdl', new Uint8Array([1, 2, 3, 250]), true, true, false));
      await step('readFile bytes', () => Array.from(FS.readFile('/xash/valve/models/player.mdl')));
      await step('readdir', () => FS.readdir('/xash/valve'));
      await step('cwd', () => FS.cwd());
    } catch (e) { console.log('FS-step ERROR:', e.message); }
  }
  console.log('─'.repeat(40));
  console.log('print:', log.slice(-14));
  console.log('printErr:', errs.slice(0, 14));
  const fatal = errs.filter((e) => /abort|could not|failed|error/i.test(e));
  console.log(fatal.length ? 'FATAL: ' + fatal.slice(0, 3).join(' | ') : 'без фаталов');
  process.exit(initialized ? 0 : 1);
})().catch((e) => { console.error('SMOKE CRASH:', e); process.exit(2); });
