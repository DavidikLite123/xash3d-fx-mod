#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════
   HASH ONLINE · боевой смоук НАСТОЯЩЕГО движка Xash3D FWGS

   Загружает оригинальные файлы порта в глобальном контексте (как это
   делает <script src> в браузере) и проверяет:
     · var Module (контракт Emscripten) собирается функцией app.buildModuleConfig
     · /xash.html.mem применяется как Module.memoryInitializerRequest
     · Module.preInit останавливает авто-запуск run() (main() не вызван)
     · /server.js, /client.js, /menu.js регистрируются в Module.DLFCN
     · Module.FS живая: mkdir + createDataFile + readFile (round-trip байтов)
     · после resumeEngineRun() движок РЕАЛЬНО стартует: печатает баннер
       «Xash3D FWGS … started», принимает /xash рабочей директорией и
       читает смонтированный нами valve/liblist.gam

   WebGL в Node нет, поэтому ядро доходит до инициализации видео и
   останавливается на контексте — это ожидаемо и не считается провалом.
   ════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* app.js подключается ДО создания DOM-стаба: его браузерная часть
   не должна выполняться в Node (там проверяются только чистые функции) */
const app = require(path.join(__dirname, '..', 'app.js'));

const ROOT = path.join(__dirname, '..');
const REQUIRED = ['xash.js', 'xash.html.mem', 'server.js', 'client.js', 'menu.js'];

const log = [];
const printLines = [];
const errLines = [];
const say = (s) => { log.push(s); console.log(s); };

const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.error('СМОК ПРЕРВАН: нет файлов движка в корне репозитория:', missing.join(', '));
  process.exit(2);
}

/* ── минимальный DOM-стаб: glue должен выбрать WEB-ветку ── */
const mkStyle = () => {
  const st = {};
  st.setProperty = (k, v) => { st[k] = v; };
  st.removeProperty = (k) => { delete st[k]; };
  st.getPropertyValue = (k) => st[k] || '';
  return st;
};

/* заглушка WebGL-контекста: в Node нет GPU, движок доходит до линковки шейдеров */
const glStub = new Proxy({}, {
  get(t, k) {
    switch (k) {
      case 'getParameter': return () => 'WebGL 1.0 (node-stub)';
      case 'getExtension': return () => null;
      case 'getSupportedExtensions': return () => [];
      case 'getShaderPrecisionFormat': return () => ({ rangeMin: 127, rangeMax: 127, precision: 23 });
      case 'getContextAttributes': return () => ({ alpha: false, depth: true, stencil: true, antialias: false });
      case 'createShader': case 'createProgram': case 'createBuffer':
      case 'createTexture': case 'createFramebuffer': case 'createRenderbuffer':
        return () => ({});
      case 'isContextLost': return () => false;
      case 'getProgramParameter': case 'getShaderParameter': return () => true;
      case 'getProgramInfoLog': case 'getShaderInfoLog': return () => '';
      case 'getAttribLocation': case 'getUniformLocation': return () => 0;
      case 'getError': return () => 0;
      default: return typeof k === 'string' ? () => undefined : undefined;
    }
  },
});

const canvas = {
  width: 800, height: 480, style: mkStyle(), nodeName: 'CANVAS', id: 'canvas',
  getContext: () => glStub,
  addEventListener: () => {}, removeEventListener: () => {},
  setAttribute: () => {}, focus: () => {}, requestPointerLock: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 480, right: 800, bottom: 480 }),
  parentNode: { removeChild() {} },
};

global.window = global;
Object.defineProperty(global, 'navigator', {
  value: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    appVersion: '5.0 (X11)', appName: 'Netscape', appCodeName: 'Mozilla', product: 'Gecko',
    platform: 'Linux x86_64', language: 'ru-RU', languages: ['ru-RU', 'en'],
    hardwareConcurrency: 4, maxTouchPoints: 0, vendor: 'Google Inc.', onLine: true,
  },
  configurable: true, writable: true,
});
global.screen = { width: 1280, height: 720 };
global.document = {
  readyState: 'complete', currentScript: null, title: 'smoke', hidden: false, visibilityState: 'visible',
  createElement: (t) => (t === 'canvas' ? canvas : { style: mkStyle(), appendChild() {}, addEventListener() {} }),
  createElementNS: (ns, t) => (t === 'canvas' ? canvas : { style: mkStyle(), appendChild() {} }),
  getElementById: (id) => (id === 'canvas' ? canvas : null),
  querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [],
  addEventListener: () => {}, removeEventListener: () => {},
  body: { appendChild() {}, style: mkStyle() },
  documentElement: { style: mkStyle(), requestFullscreen: () => Promise.resolve() },
  exitPointerLock: () => {}, exitFullscreen: () => Promise.resolve(),
  fullscreenElement: null, pointerLockElement: null,
  location: { href: 'http://localhost:8080/', protocol: 'http:', host: 'localhost:8080' },
};
global.location = global.document.location;
global.self = global;
global.addEventListener = () => {};
global.removeEventListener = () => {};
global.dispatchEvent = () => true;
global.innerWidth = 1280; global.innerHeight = 720; global.devicePixelRatio = 1;
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.XMLHttpRequest = function FakeXHR() {
  return {
    open(m, u) { this._url = u; },
    send() { const e = this.onerror; if (e) setTimeout(() => e({ target: this }), 0); },
    addEventListener() {}, setRequestHeader() {},
  };
};

let savedRun = null;
let runtimeReady = false;
let depsLeft = -1;
let calledRunBeforeResume = false;

/* ── var Module собирается той же функцией, что и в браузере ── */
global.Module = app.buildModuleConfig({
  canvas,
  args: [],
  totalMemoryMB: 384,
  websocketUrl: app.websocketProxyUrl('localhost:8080'),
  onPrint: (t) => { if (printLines.length < 400) printLines.push(String(t)); },
  onErr: (t) => { if (errLines.length < 400) errLines.push(String(t)); },
  onStatus: () => {},
  onDeps: (left) => { depsLeft = left; },
  onRuntime: () => { runtimeReady = true; },
  onHaltRun: () => { savedRun = app.haltEngineRun(global); },
});
/* как в оригинальном порте: инициализатор памяти уже загружен XHR'ом */
const mem = fs.readFileSync(path.join(ROOT, 'xash.html.mem'));
global.Module.memoryInitializerRequest = {
  status: 200,
  response: mem.buffer.slice(mem.byteOffset, mem.byteOffset + mem.byteLength),
  addEventListener() {},
};

const loadScript = (name) => {
  const t0 = Date.now();
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, name), 'utf8'), { filename: name });
  return ((Date.now() - t0) / 1000).toFixed(1);
};

let reachedVideo = false;
process.on('uncaughtException', (e) => {
  const msg = String((e && (e.message || e)) || '').split('\n')[0];
  errLines.push('[uncaught] ' + msg);
  finish();
});

const results = [];
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; results.push(`  [PASS] ${name}`); }
  else { fail++; results.push(`  [FAIL] ${name} ${extra}`); }
}

function finish() {
  if (finish.done) return;
  finish.done = true;

  const all = printLines.join('\n');
  ok('xash.js: main() НЕ вызван до монтирования (preInit остановил run)', !calledRunBeforeResume);
  ok('xash.js: run() сохранена для старта по кнопке', typeof savedRun === 'function');
  ok('xash.js: Module.canvas передан в Emscripten', global.Module.canvas === canvas);
  ok('xash.js: Module.FS — настоящая ФС Emscripten',
    !!global.Module.FS && typeof global.Module.FS.createDataFile === 'function');
  ok('xash.js: инициализатор памяти применён (run-dependencies = 0)', depsLeft === 0, `deps=${depsLeft}`);
  ok('server.js/client.js/menu.js: библиотеки движка в DLFCN',
    ['server', 'client', 'menu'].every((n) => global.Module.DLFCN.loadedLibNames[n]),
    JSON.stringify(Object.keys(global.Module.DLFCN.loadedLibNames || {})));
  ok('FS: побайтовый round-trip createDataFile → readFile', roundTripOk);
  ok('FS: каталог /xash/valve создан через FS.mkdir', valveDirOk);
  ok('FS: перезапись файла в настоящей MEMFS (мод поверх оригинала)', roundTripOk);
  ok('FS: /xash/cstrike/… смонтирован побайтово (путь Counter-Strike 1.6)', csMountOk);
  ok('движок: баннер Xash3D FWGS напечатан (main() реально исполняется)',
    /Xash3D FWGS .*started/.test(all), all.slice(0, 160));
  ok('движок: /xash принят рабочей директорией', /\/xash is working directory now/.test(all));
  ok('движок: прочитан смонтированный valve/liblist.gam',
    /valve\/liblist\.gam/.test(all), all.slice(0, 200));
  ok('движок: дошёл до инициализации видео (WebGL в Node отсутствует)',
    reachedVideo || /Setting video mode|bpp|GL|shader/i.test(all + errLines.join('\n')));

  console.log('─'.repeat(56));
  console.log('вывод ядра (первые строки):');
  console.log(printLines.slice(0, 14).map((l) => '  | ' + l).join('\n') || '  | (пусто)');
  if (errLines.length) {
    console.log('ошибки/предупреждения (первые строки):');
    console.log(errLines.slice(0, 6).map((l) => '  ! ' + l).join('\n'));
  }
  console.log('─'.repeat(56));
  console.log(results.join('\n'));
  console.log(`ИТОГ СМОКА: ${pass} OK · ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

/* ── загрузка цепочки ядра ── */
let roundTripOk = false;
let valveDirOk = false;
let csMountOk = false;

try {
  say(`загружаю /xash.js (${app.ENGINE_SCRIPTS.join(' → ')}) …`);
  say(`  xash.js выполнен за ${loadScript('xash.js')}s`);
  for (const lib of ['server.js', 'client.js', 'menu.js']) {
    say(`  ${lib} выполнен за ${loadScript(lib)}s → ${printLines.filter((l) => /loaded as/.test(l)).slice(-1)[0] || ''}`);
  }
} catch (e) {
  console.error('СБОЙ ЗАГРУЗКИ ЯДРА:', e && (e.stack || e.message || e));
  process.exit(2);
}

/* до старта main(): авто-запуск ядра обязан быть перехвачен в Module.preInit */
calledRunBeforeResume = !!global.Module.calledRun;
say(`  после загрузки скриптов: Module.calledRun = ${calledRunBeforeResume} (main ещё не вызван)`);

/* ── монтирование игровых файлов в настоящую Module.FS ── */
const FS = global.Module.FS;
try {
  const dir = app.setupEngineFS(FS, 'valve');
  valveDirOk = !!dir && FS.readdir('/xash/valve').length >= 0 && FS.cwd() === app.ENGINE_ROOT;
  app.mountFileToFS(FS, '/xash/valve/liblist.gam',
    'game "Half-Life"\nstartmap "hldemo1"\ngamedll "dlls/hl.so"\ntype "singleplayer_only"\n', true, true, false);
  app.mountFileToFS(FS, '/xash/valve/models/player.mdl', new Uint8Array([73, 68, 83, 84, 250, 0, 66]), true, true, true);
  const back = FS.readFile('/xash/valve/models/player.mdl');
  roundTripOk = back.length === 7 && back[0] === 73 && back[4] === 250 && back[6] === 66;

  /* перезапись того же пути (мод поверх оригинала) в настоящей MEMFS */
  app.mountFileToFS(FS, '/xash/valve/models/player.mdl', new Uint8Array([9, 8, 7]), true, true, true);
  const back2 = FS.readFile('/xash/valve/models/player.mdl');
  roundTripOk = roundTripOk && back2.length === 3 && back2[0] === 9;

  /* каталог CS 1.6: /xash/cstrike/… — то, что требует движок */
  app.setupEngineFS(FS, 'cstrike');
  app.mountFileToFS(FS, '/xash/cstrike/models/player/urban/urban.mdl', new Uint8Array([1, 2, 3]), true, true, true);
  const csList = FS.readdir('/xash/cstrike/models/player/urban');
  const csBytes = FS.readFile('/xash/cstrike/models/player/urban/urban.mdl');
  csMountOk = csList.indexOf('urban.mdl') >= 0 && csBytes.length === 3 && csBytes[2] === 3;
  say(`  FS: /xash/cstrike/models/player/urban = ${JSON.stringify(csList)} · байты = ${JSON.stringify(Array.from(csBytes))}`);

  say(`  FS.cwd() = ${FS.cwd()} · /xash/valve: ${FS.readdir('/xash/valve').join(', ')}`);
} catch (e) {
  console.error('СБОЙ МОНТИРОВАНИЯ В FS:', e && (e.message || e));
}

/* ── старт main(): ровно то, что делает кнопка [ ЗАПУСТИТЬ ] ── */
global.Module.ENV.XASH3D_BASEDIR = app.ENGINE_ROOT;
global.Module.ENV.XASH3D_GAMEDIR = 'valve';
const args = app.buildEngineArguments('hl1', null, { width: 800, height: 480 }).concat(['-nosound']);
say(`  Module['arguments'] = ${JSON.stringify(args)}`);
try {
  app.resumeEngineRun(global, savedRun, args);
  say('  resumeEngineRun(): main() вызван');
} catch (e) {
  const msg = String((e && (e.message || e)) || '');
  if (/SimulateInfiniteLoop/.test(msg)) say('  main() ушёл в бесконечный цикл движка (штатно)');
  else say('  исключение при старте main(): ' + msg.slice(0, 200));
}

/* ждём вывода ядра: видео-инициализация в Node обрывается на WebGL-стабе */
setTimeout(() => {
  reachedVideo = /Setting video mode|bpp \d+/i.test(printLines.join('\n'));
  finish();
}, 6000);
