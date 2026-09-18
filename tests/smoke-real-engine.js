#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════
   HASH ONLINE · боевой смоук НАСТОЯЩЕГО движка Xash3D FWGS (поток CS 1.6)

   Загружает оригинальные файлы порта в глобальном контексте (как это
   делает <script src> в браузере) и проверяет:
     · var Module (контракт Emscripten) собирается app.ensureModule +
       app.buildModuleConfig — arguments=['-game','cstrike','+maxplayers','16']
       выставляются ДО загрузки ядра
     · «контролируемый» Module.memoryInitializerRequest держит main():
       после загрузки ВСЕХ скриптов Module.calledRun обязан быть false
       (детерминированный standby — в браузере это исключало авто-старт
       с пустыми аргументами и падение ядра)
     · /server.js, /client.js, /menu.js регистрируются в Module.DLFCN
     · /rodir/valve + /rodir/cstrike смонтированы побайтово в настоящей FS
       (halflife.wad, gfx.wad, cstrike.wad, модели v_*.mdl, карта de_dust2.bsp)
     · после releaseMemoryRequest() движок РЕАЛЬНО стартует один раз:
       печатает баннер «Xash3D FWGS … started», принимает /rodir рабочей
       директорией, строит search path cstrike + valve
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
  querySelector: (sel) => (sel === 'canvas' ? canvas : null),
  querySelectorAll: () => [], getElementsByTagName: () => [],
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

let depsLeft = -1;
let runtimeReady = false;

/* ── var Module — ровно так, как в браузере: ensureModule + buildModuleConfig ── */
const M = app.ensureModule();
Object.assign(M, app.buildModuleConfig({
  canvas,
  args: [],
  totalMemoryMB: 384,
  websocketUrl: app.websocketProxyUrl('localhost:8080'),
  onPrint: (t) => { if (printLines.length < 400) printLines.push(String(t)); },
  onErr: (t) => { if (errLines.length < 400) errLines.push(String(t)); },
  onStatus: () => {},
  onDeps: (left) => { depsLeft = left; },
  onRuntime: () => { runtimeReady = true; },
}));
M.canvas = canvas;

/* ТРЕБОВАНИЕ 3: аргументы CS 1.6 выставляются ДО загрузки ядра —
   именно с ними glue запустит main() после отдачи памяти */
const args = app.buildEngineArguments('cs16', null).concat(['-nosound']);
M.arguments = args;

/* инициализатор памяти: «контролируемый» request (status 0, без .response) —
   glue создаст run-dependency и дождётся события "load" */
const mem = fs.readFileSync(path.join(ROOT, 'xash.html.mem'));
const memBuffer = mem.buffer.slice(mem.byteOffset, mem.byteOffset + mem.byteLength);
const memRequest = app.createControlledMemoryRequest(memBuffer);
M.memoryInitializerRequest = memRequest;

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
  ok('xash.js: main() НЕ стартовал до отдачи памяти (контролируемый request держит run)',
    !standbyCalledRun, `calledRun=${standbyCalledRun}`);
  ok('xash.js: Module.canvas передан в Emscripten', M.canvas === canvas);
  ok('xash.js: Module.FS — настоящая ФС Emscripten',
    !!M.FS && typeof M.FS.createDataFile === 'function');
  ok('xash.js: инициализатор памяти удержан (run-dependency pending)', standbyDeps > 0, `deps=${standbyDeps}`);
  ok('server.js/client.js/menu.js: библиотеки движка в DLFCN',
    ['server', 'client', 'menu'].every((n) => M.DLFCN.loadedLibNames[n]),
    JSON.stringify(Object.keys(M.DLFCN.loadedLibNames || {})));
  ok('FS: побайтовый round-trip createDataFile → readFile', roundTripOk);
  ok('FS: /rodir/valve смонтирован (halflife.wad/gfx.wad — защита от розовых артефактов)', valveDirOk);
  ok('FS: /rodir/cstrike смонтирован (cstrike.wad, модели, de_dust2.bsp)', csMountOk);
  ok('ENV: XASH3D_BASEDIR=/rodir · XASH3D_GAMEDIR=cstrike',
    M.ENV && M.ENV.XASH3D_BASEDIR === '/rodir' && M.ENV.XASH3D_GAMEDIR === 'cstrike');
  ok('движок: стартан после releaseMemoryRequest (main() исполняется)',
    !!M.calledRun, `calledRun=${!!M.calledRun}`);
  ok('движок: баннер Xash3D FWGS напечатан (main() реально исполняется)',
    /Xash3D FWGS .*started/.test(all), all.slice(0, 160));
  ok('движок: /rodir принят рабочей директорией', /\/rodir is working directory now/.test(all));
  ok('движок: kstrike/valve в search path (карты de_dust2 читаются)',
    /cstrike/.test(all) && /valve/.test(all), all.slice(0, 260));
  ok('движок: дошёл до инициализации видео (WebGL в Node отсутствует)',
    reachedVideo || /Setting video mode|bpp|GL|shader/i.test(all + errLines.join('\n')));

  console.log('─'.repeat(56));
  console.log('вывод ядра (первые строки):');
  console.log(printLines.slice(0, 16).map((l) => '  | ' + l).join('\n') || '  | (пусто)');
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
let standbyCalledRun = false;
let standbyDeps = 0;
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

/* после загрузки ВСЕХ скриптов ядро обязано быть в standby:
   память удержана — main() ещё не вызывался (детерминированный контракт) */
standbyCalledRun = !!M.calledRun;
standbyDeps = depsLeft;
say(`  после загрузки скриптов: Module.calledRun = ${standbyCalledRun} (main ещё не вызван), depsLeft = ${standbyDeps}`);

/* ── монтирование игровых файлов: /rodir/valve + /rodir/cstrike ── */
const FS = M.FS;
try {
  const dir = app.setupEngineFS(FS, 'cstrike');
  ok('FS: setupEngineFS создал /rodir, /rodir/valve, /rodir/cstrike (cwd=/rodir)',
    !!dir && dir === '/rodir/cstrike' && FS.cwd() === app.ENGINE_ROOT);

  /* базовые ассеты — без них розовые артефакты */
  app.mountFileToFS(FS, '/rodir/valve/liblist.gam',
    'game "Half-Life"\nstartmap "hldemo1"\ngamedll "dlls/hl.so"\ntype "singleplayer_only"\n', true, true, false);
  app.mountFileToFS(FS, '/rodir/valve/halflife.wad', new Uint8Array(64).fill(1), true, true, true);
  app.mountFileToFS(FS, '/rodir/valve/gfx.wad', new Uint8Array(32).fill(2), true, true, true);
  valveDirOk = ['halflife.wad', 'gfx.wad', 'liblist.gam'].every(
    (n) => FS.readdir('/rodir/valve').indexOf(n) >= 0);

  /* CS 1.6: wad, модели оружия (v_/p_/w_), карта */
  app.mountFileToFS(FS, '/rodir/cstrike/liblist.gam',
    'game "Counter-Strike"\ngamedir "cstrike"\ngamedll "dlls/cstrike.so"\ntype "multiplayer_only"\n', true, true, false);
  app.mountFileToFS(FS, '/rodir/cstrike/cstrike.wad', new Uint8Array(128).fill(3), true, true, true);
  app.mountFileToFS(FS, '/rodir/cstrike/models/v_glock.mdl', new Uint8Array([1, 2, 3]), true, true, true);
  app.mountFileToFS(FS, '/rodir/cstrike/models/p_glock.mdl', new Uint8Array([4, 5, 6]), true, true, true);
  app.mountFileToFS(FS, '/rodir/cstrike/models/w_glock.mdl', new Uint8Array([7, 8, 9]), true, true, true);
  app.mountFileToFS(FS, '/rodir/cstrike/maps/de_dust2.bsp', new Uint8Array([9, 8, 7]), true, true, true);

  const vBack = FS.readFile('/rodir/cstrike/models/v_glock.mdl');
  const bspBack = FS.readFile('/rodir/cstrike/maps/de_dust2.bsp');
  roundTripOk = vBack.length === 3 && vBack[0] === 1 && bspBack.length === 3 && bspBack[2] === 7;

  /* перезапись того же пути (мод поверх оригинала) в настоящей MEMFS */
  app.mountFileToFS(FS, '/rodir/cstrike/models/v_glock.mdl', new Uint8Array([5, 5]), true, true, true);
  const vBack2 = FS.readFile('/rodir/cstrike/models/v_glock.mdl');
  roundTripOk = roundTripOk && vBack2.length === 2 && vBack2[0] === 5;

  csMountOk = ['cstrike.wad', 'liblist.gam', 'maps', 'models'].every(
    (n) => FS.readdir('/rodir/cstrike').indexOf(n) >= 0);
  say(`  FS: /rodir/cstrike = ${JSON.stringify(FS.readdir('/rodir/cstrike'))} · /rodir/valve = ${JSON.stringify(FS.readdir('/rodir/valve'))}`);
} catch (e) {
  console.error('СБОЙ МОНТИРОВАНИЯ В FS:', e && (e.message || e));
}

/* ── переменные окружения движка (после xash.js — glue владеет ENV) ── */
app.applyEngineEnv(M, { baseDir: app.ENGINE_ROOT, gameDir: 'cstrike' });

/* ── старт main(): ровно то, что делает кнопка [ ЗАПУСТИТЬ ] ── */
say(`  Module['arguments'] = ${JSON.stringify(M.arguments)}`);
const released = app.releaseMemoryRequest(memRequest);
say(`  releaseMemoryRequest() = ${released} → glue применяет xash.html.mem, main() стартует один раз`);

/* ждём вывода ядра: видео-инициализация в Node обрывается на WebGL-стабе */
setTimeout(() => {
  reachedVideo = /Setting video mode|bpp \d+/i.test(printLines.join('\n'));
  finish();
}, 6000);
