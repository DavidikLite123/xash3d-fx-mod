/* ════════════════════════════════════════════════════════════════
   HASH ONLINE · портал + боевой запуск НАСТОЯЩЕГО движка Xash3D FWGS
   (оригинальный Emscripten/asm.js web-порт Half-Life / Counter-Strike)

   Файлы движка лежат в корне репозитория и отдаются как есть:
     /xash.js         — скомпилированное клиентское ядро Xash3D FWGS (asm.js)
     /xash.html.mem   — инициализатор статической памяти ядра
     /server.js       — серверная игровая библиотека  → dlopen("server")
     /client.js       — клиентская игровая библиотека → dlopen("client")
     /menu.js         — библиотека меню движка        → dlopen("menu")

   Детерминированный порядок старта (без гонок — main() стартует ровно один
   раз и только тогда, когда ВСЁ готово):

     1. var Module = ensureModule() + buildModuleConfig() — ПОЛНЫЙ контракт
        Emscripten ДО любого доступа (защита от "Cannot read properties of
        undefined (reading 'push')"):
          Module.arguments = ['-game','cstrike','+maxplayers','16'] (CS 1.6)
          Module.preRun / Module.postRun — массивы []
          Module.canvas    = document.getElementById('canvas')
          Module.TOTAL_MEMORY — расчёт под размер кэша (asm.js без роста)
     2. XHR /xash.html.mem → ArrayBuffer → «контролируемый» объект
        Module.memoryInitializerRequest (status 0, без .response): glue ядра
        создаёт run-dependency и ждёт событие "load" — до этого момента
        main() физически не может стартовать.
     3. <script src="/xash.js"> → затем /server.js, /client.js, /menu.js
        (библиотеки движка; после каждого — проверка целостности глобалов).
     4. Module.FS: /rodir, /rodir/valve, /rodir/cstrike (+ каталог мода),
        FS.chdir('/rodir').
     5. Побайтовое монтирование распакованного кэша
        (FS.mkdir + FS.createDataFile) — с прогрессом.
     6. Module.ENV: XASH3D_BASEDIR=/rodir, XASH3D_GAMEDIR=<cstrike|valve|mod>
        (устанавливается ПОСЛЕ xash.js — glue владеет объектом ENV).
     7. releaseMemoryRequest() → glue применяет xash.html.mem, снимает
        run-dependency → run() → main(). Единственный и корректный старт.

   Мышь (требование «свободно в меню, захват в игре»):
     · при старте и в меню Pointer Lock НЕ включается автоматически,
       системный курсор свободен: canvas.style.cursor = 'default';
     · захват — только по клику в холст, пока движок сам держит мышь
       (игровой режим: движок прячет курсор — style.cursor === 'none');
     · Escape или ` — курсор освобождается немедленно.

   Никакого собственного рендерера в этом файле нет: WebGL-контекст создаёт
   и использует только скомпилированное ядро движка.
   ════════════════════════════════════════════════════════════════ */
'use strict';

/* ═══════════════ ЧАСТЬ 1 · ЧИСТЫЕ ФУНКЦИИ ═══════════════ */

const plural = (n, [one, few, many]) => {
  const m = n % 100, d = n % 10;
  if (m > 10 && m < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
};
const filesLabel = (n) => `${n} ${plural(n, ['файл', 'файла', 'файлов'])}`;

const fmtBytes = (n) => {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/* Имя библиотеки для DLFCN-проверки из src скрипта:
   '/server.js' → 'server' · 'server.js' → 'server' · '/x/client.js' → 'client'.
   Ключ обязан совпадать с filename="…" в хвосте саморегистрации сайд-модуля. */
const libNameFromScriptSrc = (src) => String(src).split('/').pop().replace(/\.js$/i, '');

/* Консоль движка использует цветовые коды GoldSrc (^1…^7) — в DOM их снимаем */
const stripEngineColors = (s) => String(s == null ? '' : s).replace(/\^[0-9]/g, '');

/* ТРЕБОВАНИЕ 1 (защита от краша): перед любым .push() целевой массив обязан
   существовать. Все функции парсинга/распаковки нормализуют входные массивы
   этой функцией — TypeError "Cannot read properties of undefined (reading
   'push')" больше невозможен. */
const ensureArray = (arr) => (Array.isArray(arr) ? arr : []);

/* ═══════════════ ЧАСТЬ 2 · УМНАЯ РАСПАКОВКА .zip ═══════════════ */

const JUNK_BASENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const isJunkPath = (name) => {
  const segs = String(name).split('/');
  return segs.some((s) => s === '__MACOSX') ||
         JUNK_BASENAMES.has((segs[segs.length - 1] || '').toLowerCase());
};

/**
 * Выбор записей архива: если заданы targets (['cstrike','valve']) — берутся
 * ВСЕ файлы этих папок (без отсечения по расширению: .wad, .bsp, модели
 * v_*.mdl / p_*.mdl / w_*.mdl и т.д. — ничего не теряется); если targets
 * нет (мод) — всё дерево.
 */
function pickZipTargets(names, targets) {
  names = ensureArray(names);
  const wantTargets = Array.isArray(targets) ? targets : null;
  const picked = [];
  let skipped = 0;
  for (const name of names) {
    const segs = String(name).split('/').filter(Boolean);
    if (!segs.length) { skipped++; continue; }
    if (!wantTargets) { picked.push({ name, rel: segs.join('/') }); continue; }
    const idx = segs.findIndex((s) => wantTargets.includes(s.toLowerCase()));
    if (idx === -1 || idx === segs.length - 1) { skipped++; continue; }
    picked.push({ name, rel: segs.slice(idx).join('/') });
  }
  return { picked, skipped };
}

function makeFileSet(items) {
  items = ensureArray(items).slice();
  items.sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  const size = items.reduce((s, it) => s + (it.size || 0), 0);
  const roots = new Set(items.map((it) => it.path.split('/')[0]));
  const byExt = new Map();
  for (const it of items) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(it.path);
    const ext = m ? m[1].toLowerCase() : '—';
    byExt.set(ext, (byExt.get(ext) || 0) + 1);
  }
  return { items, count: items.length, size,
           root: roots.size === 1 ? [...roots][0] : null, byExt };
}

/* Последовательная распаковка с динамическим прогрессом по байтам */
async function extractZipSet(zip, targets, onProgress) {
  const zipFiles = (zip && zip.files) || {};
  const names = Object.keys(zipFiles).filter((n) => {
    const entry = zipFiles[n];
    return !!entry && !entry.dir && !isJunkPath(n);
  });
  const { picked, skipped } = pickZipTargets(names, targets);
  if (targets && !picked.length) return { set: null, skipped };

  const sizes = picked.map((p) => {
    const d = zipFiles[p.name]._data;
    return (d && d.uncompressedSize > 0) ? d.uncompressedSize : 0;
  });
  const total = sizes.reduce((a, b) => a + b, 0) || picked.length || 1;

  let done = 0;
  const items = [];
  for (let i = 0; i < picked.length; i++) {
    const entry = zipFiles[picked[i].name];
    const data = await entry.async('uint8array', (meta) => {
      if (onProgress) {
        const within = (sizes[i] || 1) * (meta.percent / 100);
        onProgress(Math.min(99, Math.round(((done + within) / total) * 100)));
      }
    });
    done += sizes[i] || (data && data.length) || 0;
    items.push({ file: data, path: picked[i].rel, size: (data && data.length) || 0 });
    if (onProgress) onProgress(Math.round((done / total) * 100));
  }
  return { set: makeFileSet(items), skipped };
}

/* ветка обработчика drop: без папок вперемешку берём только .zip */
const pickDropZips = (files) => ensureArray(files).filter((f) => /\.zip$/i.test((f && f.name) || ''));

/* ═══════════════ ЧАСТЬ 3 · EMSCRIPTEN FS (Module.FS) ═══════════════
   Две директории ОБЯЗАНЫ быть смонтированы (требование 3):
     /rodir/valve   — базовые ассеты Half-Life (halflife.wad, gfx.wad,
                      шрифты, базовые звуки) — без них розовые артефакты
     /rodir/cstrike — ассеты CS 1.6 (cstrike.wad, maps/, models/, sound/)
   Движок (XASH3D_BASEDIR=/rodir) chdir'ится в /rodir и строит search path:
   <gamedir> + ../valve — то есть оба каталога. */

const ENGINE_ROOT = '/rodir';
const KNOWN_GAME_DIRS = ['valve', 'cstrike'];
const BASE_GAME_DIR = 'valve';

/** Каталог игры в ФС движка: cstrike (CS 1.6) или valve (Half-Life / моды) */
function gameDirFor(gameId) {
  const id = String(gameId || '').toLowerCase();
  return (id.startsWith('cs') || id.includes('cstrike')) ? 'cstrike' : BASE_GAME_DIR;
}

/**
 * Рекурсивное создание подпапок через Module.FS.mkdir(path)
 * (например /rodir/cstrike/models/player/urban/).
 */
const __knownDirs = typeof WeakMap === 'function' ? new WeakMap() : null;

function ensureFSDirectory(FS, dirPath) {
  if (!FS || typeof FS.mkdir !== 'function') return [];
  const parts = String(dirPath || '').split('/').filter(Boolean);
  const created = [];
  let known = null;
  if (__knownDirs) {
    known = __knownDirs.get(FS);
    if (!known) { known = new Set(['/']); __knownDirs.set(FS, known); }
  }
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    if (known && known.has(cur)) continue;
    let exists = false;
    try {
      if (typeof FS.analyzePath === 'function') {
        const analyzed = FS.analyzePath(cur);
        exists = !!(analyzed && analyzed.exists);
      } else if (typeof FS.isDir === 'function') {
        exists = FS.isDir(cur);
      }
    } catch (_) {
      exists = false;
    }
    if (!exists) {
      try { FS.mkdir(cur); created.push(cur); } catch (err) { /* EEXIST — уже создан */ }
    }
    if (known) known.add(cur);
  }
  return created;
}

/**
 * Относительный путь из .zip → абсолютный путь виртуальной ФС Emscripten:
 *   valve/…    → /rodir/valve/…
 *   cstrike/…  → /rodir/cstrike/…
 *   прочее     → /rodir/<каталог игры>/…
 */
function resolveFSAbsolutePath(gameId, relPath) {
  let cleanRel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segs = cleanRel.split('/').filter(Boolean);
  const head = (segs[0] || '').toLowerCase();

  let baseDir;
  if (KNOWN_GAME_DIRS.includes(head)) {
    baseDir = head;                      // 'valve/…' или 'cstrike/…' — свой корень
    segs.shift();
  } else {
    baseDir = gameDirFor(gameId);        // иначе — каталог выбранной игры
  }
  return `${ENGINE_ROOT}/${baseDir}/${segs.join('/')}`.replace(/\/+$/, '');
}

/** Приведение данных к Uint8Array (побайтовая запись в ФС движка) */
function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && data.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
  }
  if (typeof data === 'string') {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(data);
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff;
    return out;
  }
  return new Uint8Array(0);
}

/**
 * Побайтовая запись файла в виртуальную файловую систему Emscripten:
 *   Module.FS.mkdir('/rodir/cstrike/подпапка')            — подпапки
 *   Module.FS.createDataFile(parent, name, bytes, true, true, canOwn)
 */
function mountFileToFS(FS, absPath, data, canRead = true, canWrite = true, canOwn = true) {
  if (!FS || typeof FS.createDataFile !== 'function') return false;
  const norm = '/' + String(absPath || '').split('/').filter(Boolean).join('/');
  const lastSlash = norm.lastIndexOf('/');
  const parentPath = lastSlash <= 0 ? '/' : norm.slice(0, lastSlash);
  const filename = norm.slice(lastSlash + 1);
  if (!filename) return false;

  ensureFSDirectory(FS, parentPath);

  // перезапись: снимаем старый узел, если файл уже был смонтирован
  try {
    if (typeof FS.analyzePath === 'function' && FS.analyzePath(norm).exists && typeof FS.unlink === 'function') {
      FS.unlink(norm);
    }
  } catch (_) {}

  const bytes = toUint8Array(data);
  FS.createDataFile(parentPath, filename, bytes, canRead, canWrite, canOwn);
  return true;
}

/** Массовое монтирование набора файлов (побайтово, с прогрессом) */
function mountFileSet(FS, gameId, items, onProgress) {
  const stat = { count: 0, bytes: 0, failed: 0, dirs: new Set() };
  const list = Array.from(ensureArray(items));
  list.forEach((it, i) => {
    const abs = it.absPath || resolveFSAbsolutePath(gameId, it.path);
    try {
      if (mountFileToFS(FS, abs, it.file !== undefined ? it.file : it.data)) {
        stat.count++;
        stat.bytes += (it.size || (it.file && it.file.length) || 0);
        stat.dirs.add(abs.slice(0, abs.lastIndexOf('/')));
      } else stat.failed++;
    } catch (err) {
      stat.failed++;
    }
    if (onProgress && (i % 32 === 0 || i === list.length - 1)) {
      onProgress(Math.round(((i + 1) / (list.length || 1)) * 100), i + 1, list.length);
    }
  });
  stat.dirCount = stat.dirs.size;
  return stat;
}

/** Подготовка ФС движка: /rodir, каталог игры, базовый valve/, cwd = /rodir */
function setupEngineFS(FS, gameDir) {
  ensureFSDirectory(FS, ENGINE_ROOT);
  ensureFSDirectory(FS, `${ENGINE_ROOT}/${BASE_GAME_DIR}`);
  const dir = gameDir || BASE_GAME_DIR;
  ensureFSDirectory(FS, `${ENGINE_ROOT}/${dir}`);
  try { if (typeof FS.chdir === 'function') FS.chdir(ENGINE_ROOT); } catch (_) {}
  return `${ENGINE_ROOT}/${dir}`;
}

/** Имя каталога мода для -game (латиница/цифры, как ожидает движок) */
function sanitizeDirName(name) {
  const clean = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, '').slice(0, 32);
  return clean || null;
}

/**
 * Движку нужен liblist.gam (или gameinfo.txt) в каталоге мода —
 * если в архиве мода его нет, создаём минимальный.
 */
function ensureModGameInfo(FS, modDir, title) {
  if (!FS || !modDir) return false;
  const dir = `${ENGINE_ROOT}/${modDir}`;
  ensureFSDirectory(FS, dir);
  for (const name of ['liblist.gam', 'gameinfo.txt']) {
    try {
      if (typeof FS.analyzePath === 'function' && FS.analyzePath(`${dir}/${name}`).exists) return false;
    } catch (_) {}
  }
  const text = [
    `game "${title || modDir}"`,
    `gamedir "${modDir}"`,
    'url_info "https://hash.online/"',
    'version "1.0"',
    'type "multiplayer_only"',
    '',
  ].join('\n');
  return mountFileToFS(FS, `${dir}/liblist.gam`, text, true, true, false);
}

/**
 * Переменные окружения движка (читаются getenv в C-коде):
 *   XASH3D_BASEDIR — базовый каталог /rodir (движок chdir'ится туда и
 *                    печатает "<base> is working directory now")
 *   XASH3D_GAMEDIR — каталог игры (cstrike / valve / мод)
 * ВАЖНО: вызывать ПОСЛЕ загрузки xash.js — glue подменяет Module.ENV
 * своим внутренним объектом (var ENV={};Module["ENV"]=ENV;).
 */
function applyEngineEnv(Module, opts = {}) {
  if (!Module) return false;
  Module.ENV = Module.ENV || {};
  if (opts.baseDir) Module.ENV.XASH3D_BASEDIR = opts.baseDir;
  if (opts.gameDir) Module.ENV.XASH3D_GAMEDIR = opts.gameDir;
  return true;
}

/* ═══════════════ ЧАСТЬ 4 · АРГУМЕНТЫ ЗАПУСКА (Module['arguments']) ═══════════════ */

/**
 * Параметры клиента (выставляются ДО загрузки xash.js — именно с ними
 * glue ядра стартанет main()):
 *   Counter-Strike 1.6 → ['-game','cstrike','+maxplayers','16']  (строго)
 *   мод CS             → ['-game','<каталог>','+maxplayers','16']
 *   Half-Life          → []  (движок сам находит каталог valve/)
 *   мод HL             → ['-game','<каталог>']
 */
function getLaunchArguments(gameId, modRoot) {
  const id = String(gameId || '').toLowerCase();
  const isCS = id.startsWith('cs') || id.includes('cstrike');
  if (modRoot) {
    const args = ['-game', modRoot];
    if (isCS) args.push('+maxplayers', '16');
    return args;
  }
  if (isCS) return ['-game', 'cstrike', '+maxplayers', '16'];
  return [];
}

/** Базовые параметры запуска (окно движок сам выравнивает по Module.canvas) */
function buildEngineArguments(gameId, modRoot) {
  return getLaunchArguments(gameId, modRoot);
}

/* ═══════════════ ЧАСТЬ 5 · КОНТРАКТ var Module (Emscripten) ═══════════════ */

/* цепочка скриптов: ядро + серверная/клиентская/меню-библиотеки движка */
const ENGINE_SCRIPTS = ['/xash.js', '/server.js', '/client.js', '/menu.js'];
const ENGINE_MEMORY_INITIALIZER = '/xash.html.mem';
const DEFAULT_MEMORY_MB = 256;   // минимум: статика ядра + зона + стек
const MAX_MEMORY_MB = 2048;      // потолок (asm.js без ALLOW_MEMORY_GROWTH)
const ENGINE_HEADROOM_MB = 192;  // запас под ядро сверх смонтированных файлов

/** Адрес websockify-прокси для сетевой части движка (Module['websocket']) */
function websocketProxyUrl(host) {
  const h = String(host || '').replace(/^ws(proxy)?:\/\//, '').replace(/\/$/, '');
  return h ? `wsproxy://${h}/` : '';
}

/**
 * ТРЕБОВАНИЕ 1: гарантированная полная инициализация глобального Module
 * ПЕРЕД любым обращением к нему. После этого вызова Emscripten-glue ядра и
 * библиотеки движки видят полный объект: arguments/preRun/postRun — массивы,
 * canvas — холст. Краш "Cannot read properties of undefined (reading 'push')"
 * исключён на уровне контракта.
 */
function ensureModule() {
  if (typeof window === 'undefined') return null;
  window.Module = window.Module || {};
  const M = window.Module;
  M.arguments = M.arguments || [];
  M.preRun = M.preRun || [];
  M.postRun = M.postRun || [];
  if (!M.canvas && typeof document !== 'undefined' && typeof document.querySelector === 'function') {
    M.canvas = document.querySelector('canvas') || M.canvas;
  }
  return M;
}

/**
 * asm.js без ALLOW_MEMORY_GROWTH: TOTAL_MEMORY задаётся ОДИН РАЗ до загрузки
 * ядра. Кэш игры побайтово живёт в MEMFS, поэтому объём считается от числа
 * смонтированных байт (запас ×1.5 на узлы MEMFS/выравнивание) + headroom ядра.
 * userMB — явное значение пользователя (0 — автосчёт).
 */
function computeTotalMemoryMB(stagedBytes, userMB) {
  const filesMB = Math.ceil(((Number(stagedBytes) || 0) * 1.5) / (1024 * 1024));
  let mb = Math.max(DEFAULT_MEMORY_MB, ENGINE_HEADROOM_MB + filesMB);
  if (Number(userMB) > 0) mb = Math.max(mb, Math.round(Number(userMB)));
  mb = Math.min(mb, MAX_MEMORY_MB);
  return Math.ceil(mb / 64) * 64;
}

/**
 * «Контролируемый» XHR-объект для Module.memoryInitializerRequest.
 *
 * glue xash.js при его наличии проверяет:
 *   if (request.response) setTimeout(useRequest, 0)
 *   else request.addEventListener("load", useRequest)
 * и ДО этого создаёт run-dependency. Пока мы не вызовем
 * releaseMemoryRequest(), run() видит runDependencies>0 и main() НЕ стартует.
 * Это и есть детерминированный «предыдущий» старт движка: память применяется,
 * зависимости сняты, main() вызывается ровно один раз — когда все файлы
 * уже в Module.FS, ENV и arguments выставлены.
 */
function createControlledMemoryRequest(arrayBuffer) {
  const request = {
    status: 0,
    response: null,
    buffer: (arrayBuffer && arrayBuffer.byteLength) ? arrayBuffer : null,
    _released: false,
    _onload: null,
  };
  request.addEventListener = (type, handler) => {
    if (type === 'load' && typeof handler === 'function') request._onload = handler;
  };
  return request;
}

/**
 * Отдача памяти движку: glue применяет xash.html.mem в HEAP, снимает
 * run-dependency и сам вызывает run() → main(). Возвращает false, если glue
 * не зарегистрировал обработчик (ядро не загрузилось) или память уже отдана.
 */
function releaseMemoryRequest(request) {
  if (!request || request._released) return false;
  request._released = true;
  request.status = 200;
  request.response = request.buffer;
  const handler = request._onload;
  if (typeof handler === 'function') handler();
  return true;
}

/**
 * Объект, который становится глобальным `var Module` для Emscripten.
 * Контракт, которого требует порт Xash3D: canvas, arguments, TOTAL_MEMORY,
 * print/printErr, setStatus, monitorRunDependencies, onRuntimeInitialized,
 * websocket (сетевая часть), locateFile (xash.html.mem).
 *
 * preInit-перехват авто-запуска НЕ нужен: старт удерживается «контролируемым»
 * memoryInitializerRequest (см. createControlledMemoryRequest).
 */
function buildModuleConfig(opts = {}) {
  const noop = () => {};
  const {
    canvas = null,
    args = [],
    totalMemoryMB = DEFAULT_MEMORY_MB,
    websocketUrl = '',
    thisProgram = './xash3d',
    onPrint = noop, onErr = noop, onStatus = noop,
    onDeps = noop, onRuntime = noop,
  } = opts;

  const Module = {
    /* память: статика ядра + стек/куча + смонтированный кэш в MEMFS */
    TOTAL_MEMORY: Math.max(128, Math.round(totalMemoryMB) || DEFAULT_MEMORY_MB) * 1024 * 1024,
    thisProgram,

    /* стартовые параметры клиента игры (выставляются ДО загрузки ядра) */
    arguments: Array.isArray(args) ? args.slice() : [],

    /* холст передаётся в Emscripten напрямую: рисует только движок */
    canvas: canvas || null,

    preRun: [],
    postRun: [],

    print(text) { onPrint(stripEngineColors(text)); },
    printErr(text) { onErr(stripEngineColors(text)); },
    setStatus(text) { onStatus(text); },

    totalDependencies: 0,
    monitorRunDependencies(left) {
      this.totalDependencies = Math.max(this.totalDependencies, left);
      onDeps(left, this.totalDependencies);
    },

    onRuntimeInitialized() { onRuntime(); },

    locateFile(path) {
      return path === 'xash.html.mem' ? ENGINE_MEMORY_INITIALIZER : path;
    },

    /* сетевая часть движка (websockify-прокси) */
    websocket: [],
  };
  Module.websocket.url = websocketUrl || '';
  return Module;
}

/* ── экспорт для Node-тестов и ESM ── */
const __testExports = {
  plural, filesLabel, fmtBytes, escapeHtml, stripEngineColors, ensureArray,
  libNameFromScriptSrc,
  isJunkPath, pickZipTargets, makeFileSet, extractZipSet, pickDropZips,
  ENGINE_ROOT, KNOWN_GAME_DIRS, BASE_GAME_DIR, gameDirFor,
  ensureFSDirectory, resolveFSAbsolutePath, mountFileToFS, mountFileSet,
  setupEngineFS, sanitizeDirName, ensureModGameInfo, toUint8Array,
  applyEngineEnv,
  getLaunchArguments, buildEngineArguments,
  ENGINE_SCRIPTS, ENGINE_MEMORY_INITIALIZER,
  DEFAULT_MEMORY_MB, MAX_MEMORY_MB, ENGINE_HEADROOM_MB,
  websocketProxyUrl, ensureModule, computeTotalMemoryMB,
  createControlledMemoryRequest, releaseMemoryRequest, buildModuleConfig,
};
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = __testExports;
}
export {
  fmtBytes, escapeHtml, stripEngineColors, ensureArray, libNameFromScriptSrc,
  isJunkPath, pickZipTargets, makeFileSet, extractZipSet, pickDropZips,
  ENGINE_ROOT, KNOWN_GAME_DIRS, gameDirFor,
  ensureFSDirectory, resolveFSAbsolutePath, mountFileToFS, mountFileSet,
  setupEngineFS, sanitizeDirName, ensureModGameInfo, toUint8Array,
  applyEngineEnv,
  getLaunchArguments, buildEngineArguments,
  ENGINE_SCRIPTS, ENGINE_MEMORY_INITIALIZER,
  DEFAULT_MEMORY_MB, MAX_MEMORY_MB, ENGINE_HEADROOM_MB,
  websocketProxyUrl, ensureModule, computeTotalMemoryMB,
  createControlledMemoryRequest, releaseMemoryRequest, buildModuleConfig,
};

/* ═══════════════ ЧАСТЬ 6 · БРАУЗЕР (UI + РЕАЛЬНЫЙ ЗАПУСК ДВИЖКА) ═══════════════ */
(() => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const html = (markup) => {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstElementChild;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const GAMES = [
    {
      id: 'cs16', place: 'main', kind: 'standard',
      title: 'Counter-Strike 1.6',
      desc: 'Основная турнирная игра портала. Легендарный командный шутер.',
      chips: ['xash3d', 'cstrike/', 'multiplayer'],
      accent: '#ffb454',
      icon: 'crosshair',
      /* ищем в архиве и cstrike/, и базовый valve/ (ресурсы движка) */
      expect: ['cstrike', 'valve'],
      primary: 'cstrike',
      modalSub: 'Оригинальные файлы игры · папки cstrike + valve из мобильного кэша',
    },
    {
      id: 'hl1', place: 'main', kind: 'standard',
      title: 'Half-Life',
      desc: 'Классическая сюжетная игра. С неё всё началось.',
      chips: ['xash3d', 'valve/', 'singleplayer'],
      accent: '#ff7a29',
      icon: 'lambda',
      expect: ['valve'],
      primary: 'valve',
      modalSub: 'Оригинальные файлы игры · папка мобильного кэша valve',
    },
    {
      id: 'cs16mod', place: 'extra', kind: 'modified',
      title: 'Модифицированная CS 1.6',
      desc: 'Оригинальный кэш + кастомные модели и текстуры мода поверх.',
      chips: ['xash3d', 'cstrike/', '+ mod'],
      accent: '#35c9ff',
      icon: 'mod',
      expect: ['cstrike', 'valve'],
      primary: 'cstrike',
      modalSub: 'Требуются два набора файлов: игра + модификация',
    },
    {
      id: 'hl1mod', place: 'extra', kind: 'modified',
      title: 'Модифицированная Half-Life',
      desc: 'Оригинальный кэш valve + ресурсы вашей модификации поверх.',
      chips: ['xash3d', 'valve/', '+ mod'],
      accent: '#9d6bff',
      icon: 'mod',
      expect: ['valve'],
      primary: 'valve',
      modalSub: 'Требуются два набора файлов: игра + модификация',
    },
    {
      id: 'source', place: 'extra', kind: 'port',
      title: 'Source Engine Port',
      desc: 'Экспериментальный порт тяжёлого движка в браузер.',
      chips: ['source', 'wip'],
      accent: '#ff3d71',
      icon: 'source',
      badge: 'скоро',
      message: 'Порт движка Source в разработке, скоро!',
    },
  ];

  const gameById = (id) => GAMES.find((g) => g.id === id);

  /* ── подсказки «где взять файлы» ── */
  const LINKS = {
    cs: {
      where: {
        note: 'Мобильный кэш — это папка <b>«cstrike»</b> из установленной игры, упакованная в .zip (обычно 100–190 МБ). Движку также нужна базовая папка <b>«valve»</b> (gfx.wad, halflife.wad, шрифты) — положите её в тот же архив или загрузите вторым файлом. Обе папки монтируются в <code>/rodir/cstrike</code> и <code>/rodir/valve</code> виртуальной ФС.',
        links: [
          { host: 'официальный сайт', title: 'Counter-Strike — официальная страница',
            url: 'https://www.counter-strike.net/', desc: 'получите игру, затем соберите кэш из папки cstrike' },
          { host: 'moddb.com', title: 'Counter-Strike на ModDB',
            url: 'https://www.moddb.com/games/counter-strike', desc: 'сообщество, гайды и пользовательский контент' },
        ],
      },
      mods: {
        note: 'Бесплатные модификации: скачайте .zip и загрузите в поле «Файлы мода» — содержимое побайтово наложится поверх кэша игры в Module.FS.',
        links: [
          { host: 'gamebanana.com', title: 'GameBanana — моды и скины CS 1.6',
            url: 'https://gamebanana.com/games/4254', desc: 'оружие, звуки, модели игроков и интерфейсы' },
        ],
      },
    },
    hl: {
      where: {
        note: 'Мобильный кэш — это папка <b>«valve»</b> из установленной копии Half-Life. Сожмите её в архив .zip и перетащите в область загрузки — она смонтируется в <code>/rodir/valve</code>.',
        links: [
          { host: 'half-life.com', title: 'Half-Life — официальный сайт Valve',
            url: 'https://www.half-life.com/en/halflife', desc: 'оригинальная игра от Valve' },
          { host: 'moddb.com', title: 'Half-Life на ModDB',
            url: 'https://www.moddb.com/games/half-life', desc: 'огромная база модов и карт' },
        ],
      },
      mods: {
        note: 'Моды для Half-Life (They Hunger, Poke644 и др.): загрузите .zip архива мода во второе поле — каталог мода будет смонтирован в /rodir/<имя_мода>.',
        links: [
          { host: 'runthinkshootlive.com', title: 'Run Think Shoot Live',
            url: 'https://www.runthinkshootlive.com/', desc: 'каталог синглплеерных модификаций для Half-Life' },
        ],
      },
    },
  };

  const linksFor = (g) => (g.primary === 'cstrike' ? LINKS.cs : LINKS.hl);

  /* ── SVG-иконки интерфейса портала (не имеют отношения к рендеру игры) ── */
  const I = {
    crosshair: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
      <circle cx="24" cy="24" r="12.5"/><circle cx="24" cy="24" r="2.6" fill="currentColor" stroke="none"/>
      <path d="M24 3v9M24 36v9M3 24h9M36 24h9"/></svg>`,
    lambda: `<svg viewBox="0 0 48 48" fill="none">
      <text x="24" y="37" text-anchor="middle" font-size="38" font-family="Georgia, 'Times New Roman', serif" fill="currentColor">λ</text></svg>`,
    mod: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M24 5 43 14 24 23 5 14Z"/><path d="M43 22.5 24 31.5 5 22.5"/>
      <circle cx="37" cy="37" r="8" fill="#0b1120"/><path d="M37 32.5v9M32.5 37h9"/></svg>`,
    source: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor">
      <path d="M41 24 32.5 38.7h-17L7 24 15.5 9.3h17Z" stroke-width="2.2" stroke-linejoin="round"/>
      <text x="24" y="31.5" text-anchor="middle" font-size="19" font-weight="700" font-family="inherit" fill="currentColor" stroke="none">S</text></svg>`,
    upload: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M24 31V9M15 18l9-9 9 9"/><path d="M8 30v7a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-7"/></svg>`,
    folder: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 13a3 3 0 0 1 3-3h10l4 6h18a3 3 0 0 1 3 3v16a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V13Z"/><path d="M5 22h38"/></svg>`,
    zip: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <rect x="10" y="7" width="28" height="34" rx="4"/><path d="M24 7v5M21 15h6M24 19v5M21 27h6M24 31v4"/></svg>`,
    x: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
      <path d="M13 13l22 22M35 13 13 35"/></svg>`,
    check: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 26l11 11L40 13"/></svg>`,
  };

  /* ── состояние библиотеки файлов ── */
  const library = new Map();
  const libEntry = (id) => {
    if (!library.has(id)) library.set(id, { game: null, mod: null });
    return library.get(id);
  };
  const isGameReady = (g) => {
    const fs = libEntry(g.id);
    return g.kind === 'modified' ? !!(fs.game && fs.mod) : !!fs.game;
  };

  /* ── staging-зона: absPath → Uint8Array. Архив распаковывается побайтово
     в память сразу при загрузке; в Module.FS записывается при запуске движка ── */
  const stagedFiles = new Map();
  const stagedBytesTotal = () => {
    let s = 0;
    for (const bytes of stagedFiles.values()) s += (bytes && bytes.length) || 0;
    return s;
  };

  /* ═══════════ ЭКРАН ЗАГРУЗКИ ЯДРА (реальный прогресс Emscripten) ═══════════ */
  const bootOverlay = $('#boot-overlay');
  const bootStep = $('#boot-step');
  const bootBar = $('#boot-bar');
  const bootLogEl = $('#boot-log');

  function bootShow(show) {
    if (!bootOverlay) return;
    bootOverlay.classList.toggle('is-active', !!show);
    bootOverlay.setAttribute('aria-hidden', show ? 'false' : 'true');
  }
  function bootStepText(text, pct) {
    if (bootStep) bootStep.textContent = text;
    if (bootBar && typeof pct === 'number') bootBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
  const bootLines = [];
  let bootDirty = false;
  function bootLine(text, kind) {
    const line = stripEngineColors(text);
    if (!line) return;
    bootLines.push(kind === 'err' ? `! ${line}` : line);
    if (bootLines.length > 500) bootLines.splice(0, bootLines.length - 500);
    bootDirty = true;                    // DOM обновляется пачкой (см. flushBootLog)
    pushEngineLog(line, kind);
  }
  /* вывод ядра идёт потоком: пишем в DOM не чаще 4 раз в секунду */
  function flushBootLog() {
    if (!bootDirty || !bootLogEl) return;
    bootDirty = false;
    bootLogEl.textContent = bootLines.slice(-80).join('\n');
    bootLogEl.scrollTop = bootLogEl.scrollHeight;
  }

  /* ═══════════ КОНСОЛЬ ДВИЖКА (вывод Module.print / printErr) ═══════════ */
  const engineConsole = $('#engine-console');
  const engineConsoleLog = $('#engine-console-log');
  const engineLogLines = [];
  let consoleDirty = false;

  function pushEngineLog(text, kind) {
    if (!Array.isArray(engineLogLines)) engineLogLines.length = 0; // защита .push
    engineLogLines.push({ t: text, k: kind || '' });
    if (engineLogLines.length > 600) engineLogLines.splice(0, engineLogLines.length - 600);
    consoleDirty = true;
  }
  function flushEngineConsole() {
    if (!consoleDirty || !engineConsoleLog) return;
    consoleDirty = false;
    if (!engineConsole || engineConsole.classList.contains('is-open')) {
      engineConsoleLog.textContent = engineLogLines.slice(-250).map((l) => (l.k === 'err' ? '! ' : '') + l.t).join('\n');
      engineConsoleLog.scrollTop = engineConsoleLog.scrollHeight;
    }
  }
  setInterval(() => { flushBootLog(); flushEngineConsole(); }, 250);

  function toggleEngineConsole(force) {
    if (!engineConsole) return;
    const open = force === undefined ? !engineConsole.classList.contains('is-open') : !!force;
    engineConsole.classList.toggle('is-open', open);
    const btn = $('#hud-console');
    if (btn) btn.classList.toggle('is-on', open);
    if (open) { consoleDirty = true; flushEngineConsole(); }
  }

  /* ═══════════ ДВИЖОК: состояние, загрузка, запуск ═══════════ */
  const engine = {
    status: 'idle',            // idle | loading | running | error
    dirty: false,              // ядро уже загружено в страницу → новый старт только перезагрузкой
    promise: null,
    memoryOverrideMB: readMemoryOverrideMB(),
    totalMemoryMB: 0,
    error: null,
    get Module() { return (typeof window !== 'undefined' && window.Module) || null; },
    get FS() { const M = window.Module; return (M && M.FS) || null; },
  };

  /** Явное значение памяти пользователя (#mem=NNN / localStorage) или 0 = авто */
  function readMemoryOverrideMB() {
    try {
      const m = /[#&]mem=(\d{2,4})/.exec(window.location.hash || '');
      if (m) return Number(m[1]);
      const saved = Number(window.localStorage.getItem('hash.memoryMB'));
      return saved > 0 ? saved : 0;
    } catch (_) { return 0; }
  }
  function saveMemorySetting(mb) {
    engine.memoryOverrideMB = Number(mb) || 0;
    try { window.localStorage.setItem('hash.memoryMB', String(engine.memoryOverrideMB)); } catch (_) {}
  }

  /**
   * Подключение скрипта цепочки ядра. Пойманы и сетевые ошибки, и ВРЕМЕННЫЕ
   * ошибки выполнения внутри скрипта (window 'error' с filename) — именно так
   * ловится краш «.push по undefined», если xash.js не досчитал глобалов.
   */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      let settled = false;
      const cleanup = () => window.removeEventListener('error', onWindowError, true);
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(msg));
      };
      const onWindowError = (e) => {
        const fname = (e && (e.filename || ((e.target || {}).src))) || '';
        if (fname && fname.endsWith(src)) {
          fail('ошибка выполнения в ' + src + ': ' + ((e && e.message) || 'uncaught exception'));
        }
      };
      el.src = src;
      el.async = false;                 // порядок цепочки важен
      el.onload = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(src);
      };
      el.onerror = () => fail('не удалось загрузить ' + src);
      window.addEventListener('error', onWindowError, true);
      document.body.appendChild(el);
    });
  }

  /**
   * Контроль целостности после загрузки ядра: без этих глобалов библиотеки
   * server.js/client.js/menu.js упадут с
   * «TypeError: Cannot read properties of undefined (reading 'push')»
   * (они делают __ATINIT__.push / __ATPRERUN__.push).
   */
  function assertEngineGlobals(stage) {
    if (!Array.isArray(window.__ATINIT__) || !Array.isArray(window.__ATPRERUN__)) {
      throw new Error('ядро xash.js не закончилось инициализации (' + stage +
        '): __ATINIT__ отсутствует — библиотеки движка подключить нельзя');
    }
    if (!window.Module || !window.Module.FS) {
      throw new Error('Module.FS недоступна после загрузки ядра (' + stage + ')');
    }
  }

  /** XHR /xash.html.mem → ArrayBuffer (до загрузки ядра, с прогрессом) */
  function fetchMemoryInitializer(onProgress) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (ok, value, err) => {
        if (settled) return;
        settled = true;
        if (ok) resolve(value); else reject(err);
      };
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', ENGINE_MEMORY_INITIALIZER, true);
        xhr.responseType = 'arraybuffer';
        xhr.onprogress = (e) => {
          if (e && e.total) onProgress && onProgress(e.loaded, e.total);
        };
        xhr.onload = () => {
          if ((xhr.status === 200 || xhr.status === 0) && xhr.response) {
            done(true, xhr.response, null);
          } else {
            done(false, null, new Error('xash.html.mem: HTTP ' + xhr.status));
          }
        };
        xhr.onerror = () => done(false, null, new Error('xash.html.mem: ошибка сети'));
        xhr.send(null);
      } catch (err) {
        done(false, null, new Error('xash.html.mem: ' + (err && err.message)));
      }
    });
  }

  /** Фатал ядра (Host_Error/abort) — показываем консоль движка с настоящей причиной */
  function noteEngineFatal(text) {
    if (engine.status !== 'running') return;
    if (/Host_Error|abort\(|Could not load|Can't (open|find|init)|Sys_Error|FATAL/i.test(String(text))) {
      toggleEngineConsole(true);
      toast('Движок сообщил об ошибке — смотрите консоль (клавиша `)', 'err', 7000);
    }
  }

  /** Побайтовое монтирование staging-зоны в настоящую Module.FS (с прогрессом) */
  async function mountStagedFiles(onProgress) {
    const FS = engine.FS;
    if (!FS) throw new Error('Module.FS недоступна');
    const list = [...stagedFiles.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([absPath, bytes]) => ({ absPath, file: bytes, size: bytes.length }));
    const total = list.length || 1;
    let okCount = 0, failed = 0, bytesTotal = 0;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      try {
        if (mountFileToFS(FS, it.absPath, it.file, true, true, true)) {
          okCount++;
          bytesTotal += it.size || 0;
        } else failed++;
      } catch (err) {
        failed++;
        bootLine('FS: не удалось смонтировать ' + it.absPath + ' — ' + (err && err.message), 'err');
      }
      if ((i & 63) === 0 || i === list.length - 1) {
        if (onProgress) onProgress(Math.round(((i + 1) / total) * 100), i + 1, list.length);
        if ((i & 255) === 0 && i !== list.length - 1) await sleep(0); // прогрессу «подышать»
      }
    }
    return { count: okCount, failed, bytes: bytesTotal };
  }

  /* ═══════════════ ЗАПУСК ДВИЖКА (одиночный, детерминированный старт) ═══════════════ */
  async function launchGameEngine(game, files) {
    if (engine.status === 'running') {
      throw new Error('движок уже запущен — перезагрузите страницу для новой игры');
    }
    if (engine.status === 'loading') throw new Error('движок уже запускается');
    if (engine.dirty) throw new Error('ядро уже загружено в страницу — перезагрузите для новой игры');

    const canvasEl = document.getElementById('canvas');
    const gameDir = game.primary === 'cstrike' ? 'cstrike' : 'valve';
    const modDir = (files && files.mod) ? modDirName(files.mod) : null;

    engine.status = 'loading';
    engine.error = null;
    engine.promise = (async () => {
      bootShow(true);

      /* ── 1. var Module — ПОЛНЫЙ контракт Emscripten до любого доступа ── */
      bootStepText('var Module: контракт Emscripten …', 2);
      const M = ensureModule();
      const stagedBytes = stagedBytesTotal();
      const totalMemoryMB = computeTotalMemoryMB(stagedBytes, engine.memoryOverrideMB);
      engine.totalMemoryMB = totalMemoryMB;

      const args = buildEngineArguments(game.id, modDir);
      Object.assign(M, buildModuleConfig({
        canvas: canvasEl,
        args,
        totalMemoryMB,
        websocketUrl: websocketProxyUrl(window.location.host),
        onPrint: (text) => { bootLine(text); noteEngineFatal(text); },
        onErr: (text) => { bootLine(text, 'err'); noteEngineFatal(text); },
        onStatus: (text) => { if (text) bootStepText(text, undefined); },
        onDeps: () => {},
        onRuntime: () => {
          engine.status = 'running';
          bootLine('onRuntimeInitialized: runtime ядра готов');
        },
      }));
      window.Module.canvas = canvasEl;      // явно, как требует оригинальный порт
      window.Module.arguments = window.Module.arguments || args.slice();
      window.Module.preRun = window.Module.preRun || [];
      window.Module.postRun = window.Module.postRun || [];
      bootLine(`Module: TOTAL_MEMORY=${fmtBytes(M.TOTAL_MEMORY)} (кэш ${fmtBytes(stagedBytes)}) · canvas=#canvas · args=${JSON.stringify(args)}`);

      /* ── 2. xash.html.mem → «контролируемый» memoryInitializerRequest ──
         Пока память не отдана — main() не может стартовать (run-dependency). */
      bootStepText('загрузка /xash.html.mem — инициализатор памяти …', 5);
      const memBuffer = await fetchMemoryInitializer((loaded, total) => {
        bootStepText(`xash.html.mem · ${fmtBytes(loaded)} из ${fmtBytes(total)}`, 5 + Math.round((loaded / total) * 5));
      });
      M.memoryInitializerRequest = createControlledMemoryRequest(memBuffer);
      bootLine(`xash.html.mem: ${fmtBytes(memBuffer.byteLength)} — запуск ядра удержан (run-dependency)`);

      /* ── 3. цепочка ядра: /xash.js → /server.js → /client.js → /menu.js ── */
      for (let i = 0; i < ENGINE_SCRIPTS.length; i++) {
        const src = ENGINE_SCRIPTS[i];
        bootStepText(`загрузка ${src} …`, 12 + Math.round((i / ENGINE_SCRIPTS.length) * 28));
        await loadScript(src);
        if (src === '/xash.js') {
          assertEngineGlobals('ядро');
        } else {
          assertEngineGlobals('цепочка DSO');
          /* '/server.js' → 'server': ключ ищем ТАК ЖЕ, как хвост сайд-модуля
             (filename="server") пишет его в Module.DLFCN.loadedLibNames */
          const libName = libNameFromScriptSrc(src);
          const registered = (M.DLFCN && M.DLFCN.loadedLibNames) || {};
          if (registered[libName] == null) {
            throw new Error('библиотека движка ' + src + ' не зарегистрировалась в Module.DLFCN'
              + ' (ожидался ключ «' + libName + '»; зарегистрированы: '
              + (Object.keys(registered).join(', ') || 'пусто') + ')');
          }
        }
        bootLine('скрипт подключён: ' + src);
      }

      /* ── 4. виртуальная ФС: /rodir + /rodir/valve + /rodir/<игра> ── */
      bootStepText('подготовка FS движка: /rodir/valve + /rodir/cstrike …', 45);
      setupEngineFS(M.FS, gameDir);
      if (modDir) ensureFSDirectory(M.FS, `${ENGINE_ROOT}/${modDir}`);
      if (modDir && files.mod) ensureModGameInfo(M.FS, modDir, files.mod.root || modDir);

      /* ── 5. побайтовое монтирование кэша в Module.FS ── */
      bootStepText('монтирование файлов в Module.FS …', 50);
      const mounted = await mountStagedFiles((pct, i, n) => {
        bootStepText(`Module.FS.createDataFile: ${i} из ${n}`, 50 + Math.round(pct * 0.42));
      });
      if (mounted.count === 0) throw new Error('не удалось смонтировать ни одного файла в Module.FS');
      bootLine(`Module.FS: смонтировано ${filesLabel(mounted.count)} · ${fmtBytes(mounted.bytes)}${mounted.failed ? ` · ошибок ${mounted.failed}` : ''}`);

      const dirFiles = countFilesIn(M.FS, `${ENGINE_ROOT}/${gameDir}`);
      const valveFiles = countFilesIn(M.FS, `${ENGINE_ROOT}/${BASE_GAME_DIR}`);
      bootLine(`FS: ${ENGINE_ROOT}/${gameDir} — ${dirFiles} файлов · ${ENGINE_ROOT}/${BASE_GAME_DIR} — ${valveFiles} файлов`);
      if (dirFiles === 0) bootLine('ВНИМАНИЕ: каталог игры пуст — проверьте архив мобильного кэша', 'err');
      if (valveFiles === 0) bootLine('ВНИМАНИЕ: базовый valve/ пуст — текстуры будут розовыми (нет halflife.wad/gfx.wad)', 'err');

      /* ── 6. переменные окружения движка (ПОСЛЕ xash.js — glue владеет ENV) ── */
      applyEngineEnv(M, { baseDir: ENGINE_ROOT, gameDir: modDir || gameDir });

      /* ── 7. холст и сессия: мышь свободна, АВТО-захвата Pointer Lock нет ── */
      switchScreen(menuScreen, gameScreen);
      await sleep(420);
      enterGameSession(game, { title: game.title, argv: args, dirFiles });

      /* ── 8. СТАРТ: отдаём память — glue применяет xash.html.mem, снимает
         run-dependency и сам вызывает run() → main() (один раз, с аргументами) ── */
      M.arguments = args.slice();
      bootStepText('Module.run() → main(): движок стартует …', 96);
      bootLine(`Module['arguments'] = ${JSON.stringify(M.arguments)} · XASH3D_BASEDIR=${ENGINE_ROOT} · XASH3D_GAMEDIR=${modDir || gameDir}`);
      const released = releaseMemoryRequest(M.memoryInitializerRequest);
      if (!released) throw new Error('не удалось отдать память: ядро не приняло memoryInitializerRequest');
      engine.status = 'running';
      engine.dirty = true;

      /* watchdog: если за 5 секунд main() не стартовал — честный сигнал */
      setTimeout(() => {
        if (engine.status === 'running' && !M.calledRun) {
          engine.status = 'error';
          engine.error = 'main() не стартовал после отдачи памяти';
          bootLine('ВНИМАНИЕ: main() не стартовал — смотрите консоль движка', 'err');
          bootStepText('ошибка: main() не стартовал', 100);
          bootShow(true);
          toggleEngineConsole(true);
        }
      }, 5000);

      setTimeout(() => bootShow(false), 700);
      refreshMenuStatus();
      return engine;
    })().catch((err) => {
      const msg = (err && (err.message || String(err))) || 'неизвестная ошибка';
      engine.status = engine.dirty ? 'error' : 'idle';
      engine.error = msg;
      if (!engine.dirty) engine.promise = null;   // до xash.js — повтор возможен
      bootLine('ОШИБКА ЗАПУСКА ДВИЖКА: ' + msg, 'err');
      bootStepText('ошибка: ' + msg, 100);
      bootShow(true);
      toggleEngineConsole(true);
      throw err;
    });
    return engine.promise;
  }

  /** Каталог мода: свой gamedir, если корень архива не valve/cstrike */
  function modDirName(set) {
    const root = String((set && set.root) || '').toLowerCase();
    if (!root || KNOWN_GAME_DIRS.includes(root)) return null;
    return sanitizeDirName(root);
  }

  /** Проверка «это каталог» в настоящей ФС Emscripten (mode/analyzePath) */
  function isFsDir(FS, p) {
    try {
      if (typeof FS.stat === 'function' && typeof FS.isDir === 'function') {
        return FS.isDir(FS.stat(p).mode);
      }
    } catch (_) {}
    try {
      const a = typeof FS.analyzePath === 'function' ? FS.analyzePath(p) : null;
      if (a && a.object) return a.object.type === 'directory' || a.object.isFolder === true;
    } catch (_) {}
    return false;
  }

  function countFilesIn(FS, dir, depth = 0) {
    let n = 0;
    if (depth > 8) return 0;
    let entries = [];
    try { entries = FS.readdir(dir) || []; } catch (_) { return 0; }
    for (const name of entries) {
      if (name === '.' || name === '..') continue;
      const p = `${dir}/${name}`;
      if (isFsDir(FS, p)) n += countFilesIn(FS, p, depth + 1);
      else n++;
    }
    return n;
  }

  /* ═══════════════ ИГРОВАЯ СЕССИЯ + МЫШЬ ═══════════════
     Мышь: в меню — свободна (курсор виден, клики по кнопкам движка),
     в игре — захвачена. Движок сам управляет захватом через SDL (в игре
     прячет курсор: style.cursor='none'); портал лишь следит и помогает. */
  let session = null;
  let isGameActive = false;   // флаг активности матча
  let mouseWantsLock = false; // движок сам держит мышь (игровой режим)

  function setFreeCursor() {
    try { canvasEl.style.cursor = 'default'; } catch (_) {}
  }
  function tryLockPointer() {
    if (!canvasEl || typeof canvasEl.requestPointerLock !== 'function') return false;
    try {
      if (document.pointerLockElement === canvasEl) return true;
      const p = canvasEl.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
      return true;
    } catch (_) { return false; }
  }

  function enterGameSession(game, info) {
    if (session) stopSession();

    $('#hud-title').textContent = info.title || game.title;
    $('#hud-args').textContent =
      `argv: ${info.argv.join(' ')} · ${ENGINE_ROOT}/${game.primary || 'valve'} · ${info.dirFiles} файлов в ФС движка`;
    $('#hud-fps').textContent = '— fps';

    isGameActive = true;        // матч активен
    mouseWantsLock = false;     // движок стартует в своё меню — мышь свободна
    setFreeCursor();

    session = { fpsTimer: null, rafWrapped: false };
    startEngineFrameMeter();

    try { canvasEl.focus({ preventScroll: true }); } catch (_) {}
    /* АВТО Pointer Lock здесь нет намеренно: системный курсор остаётся
       свободным и видимым, пока игрок в меню движка. Захват — по клику
       (см. перехватчик в bindGlobal) или кнопкой HUD «ЗАХВАТ МЫШИ». */

    toast(`Движок Xash3D запущен: «${info.title || game.title}»`, 'ok', 4200);
    toggleEngineConsole(false);
  }

  /* Счётчик кадров основного цикла движка (ничего не рисуем — только считаем
     вызовы requestAnimationFrame, которыми mainloop ядра обновляет кадр) */
  function startEngineFrameMeter() {
    if (!session || session.fpsTimer) return;
    if (!session.rafWrapped) {
      const origRaf = window.requestAnimationFrame.bind(window);
      session.frames = 0;
      window.requestAnimationFrame = function (cb) {
        return origRaf(function (t) { session.frames = (session.frames || 0) + 1; return cb(t); });
      };
      session.rafWrapped = true;
    }
    let last = performance.now();
    let lastFrames = session.frames || 0;
    session.fpsTimer = setInterval(() => {
      const now = performance.now();
      const frames = session ? (session.frames || 0) : 0;
      const fps = Math.round(((frames - lastFrames) * 1000) / Math.max(1, now - last));
      lastFrames = frames; last = now;
      const el = $('#hud-fps');
      if (el) el.textContent = `${fps} fps · mainloop движка`;
    }, 1000);
  }

  function stopSession() {
    if (!session) return;
    if (session.fpsTimer) clearInterval(session.fpsTimer);
    session = null;
    isGameActive = false;
    mouseWantsLock = false;
    setFreeCursor();
  }

  function exitGameSession() {
    /* asm.js-ядро нельзя корректно остановить без перезагрузки страницы */
    const overlay = html(`
      <div class="overlay" id="overlay-exit">
        <div class="modal modal--narrow" role="dialog" aria-modal="true" aria-label="Выход из игры">
          <header class="modal__head">
            <div>
              <div class="modal__eyebrow">движок запущен</div>
              <h3 class="modal__title">Выйти в меню?</h3>
              <div class="modal__sub">Ядро Xash3D работает в адресном пространстве страницы: остановка возможна только перезагрузкой. Файлы кэша придётся выбрать заново.</div>
            </div>
            <button class="icon-btn modal__close" data-close aria-label="Закрыть">${I.x}</button>
          </header>
          <footer class="modal__foot">
            <button class="btn btn--bracket" data-close>ОСТАТЬСЯ В ИГРЕ</button>
            <button class="btn btn--bracket btn--danger" id="btn-reload">ПЕРЕЗАГРУЗИТЬ</button>
          </footer>
        </div>
      </div>`);
    mountOverlay(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) unmountOverlay(overlay); });
    overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
      isGameActive = engine.status === 'running';
      unmountOverlay(overlay);
    }));
    $('#btn-reload', overlay).addEventListener('click', () => {
      isGameActive = false;
      window.location.reload();
    });
  }

  /* ── уведомления ────────────────────────────────────────────── */
  const toastRoot = $('#toast-root');
  function toast(message, type = 'info', ttl = 3600) {
    const note = html(`<div class="toast toast--${type}" role="status">${escapeHtml(message)}</div>`);
    toastRoot.appendChild(note);
    const kill = () => { note.classList.add('is-out'); setTimeout(() => note.remove(), 260); };
    const t = setTimeout(kill, ttl);
    note.addEventListener('click', () => { clearTimeout(t); kill(); });
  }

  /* ── экраны ─────────────────────────────────────────────────── */
  const splashScreen = $('#screen-splash');
  const menuScreen   = $('#screen-menu');
  const gameScreen   = $('#screen-game');
  const canvasEl     = $('#canvas');

  function switchScreen(from, to) {
    from.classList.remove('is-active');
    from.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      to.classList.add('is-active');
      to.removeAttribute('aria-hidden');
    }, 380);
  }

  /* ── рендер карточек ────────────────────────────────────────── */
  function cardTpl(g) {
    const ready = isGameReady(g);
    const isPort = g.kind === 'port';
    return html(`
      <div class="game-card ${ready ? 'is-ready' : ''}" data-id="${g.id}" tabindex="0" role="button"
           style="--accent:${g.accent}" aria-label="${escapeHtml(g.title)}">
        <span class="game-card__scan"></span>
        <div class="game-card__icon">${I[g.icon] || ''}</div>
        <div class="game-card__body">
          <div class="game-card__title">
            <span>${escapeHtml(g.title)}</span>
            ${g.badge ? `<span class="game-card__badge">${escapeHtml(g.badge)}</span>` : ''}
          </div>
          <p class="game-card__desc">${escapeHtml(g.desc)}</p>
          <div class="game-card__chips">
            ${g.chips.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')}
          </div>
        </div>
        <div class="game-card__foot">
          <span class="card-status">
            <i class="dot"></i>
            <span class="card-status__text">${isPort ? 'в разработке' : (ready ? 'готов к запуску' : 'файлы не загружены')}</span>
          </span>
          <span class="card-arrow" aria-hidden="true">→</span>
        </div>
      </div>`);
  }

  function renderCards() {
    const mainGrid  = $('#games-grid');
    const extraGrid = $('#extra-grid');

    for (const g of GAMES.filter((x) => x.place === 'main')) mainGrid.appendChild(cardTpl(g));

    mainGrid.appendChild(html(`
      <button class="game-card game-card--more" id="btn-more" aria-expanded="false" aria-controls="extra-wrap">
        <span class="game-card__scan"></span>
        <span class="more-plus" aria-hidden="true">+</span>
        <span class="more-label" id="more-label">ЕЩЁ</span>
        <span class="more-hint">модификации и порты</span>
      </button>`));

    for (const g of GAMES.filter((x) => x.place === 'extra')) extraGrid.appendChild(cardTpl(g));

    document.querySelectorAll('.game-card[data-id]').forEach((card) => {
      const g = gameById(card.dataset.id);
      const activate = () => {
        if (g.kind === 'port') { toast(g.message, 'warn', 4200); return; }
        openGameModal(g);
      };
      card.addEventListener('click', activate);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
    });

    $('#btn-more').addEventListener('click', () => toggleExtra());
  }

  function toggleExtra() {
    const wrap  = $('#extra-wrap');
    const label = $('#more-label');
    const btn   = $('#btn-more');
    const open  = !wrap.classList.contains('is-open');
    wrap.classList.toggle('is-open', open);
    document.body.classList.toggle('extra-open', open);
    btn.setAttribute('aria-expanded', String(open));
    label.textContent = open ? 'СКРЫТЬ' : 'ЕЩЁ';
  }

  /* ── статусы карточек и меню ────────────────────────────────── */
  function refreshCard(id) {
    const g = gameById(id);
    const card = $(`.game-card[data-id="${id}"]`);
    if (!card || g.kind === 'port') return;

    const fs = libEntry(id);
    const missing = [];
    if (!fs.game) missing.push('игру');
    if (g.kind === 'modified' && !fs.mod) missing.push('мод');

    const textEl = $('.card-status__text', card);
    card.classList.remove('is-partial', 'is-ready');

    if (missing.length === 0) {
      card.classList.add('is-ready');
      textEl.textContent = 'готов к запуску';
    } else if (missing.length < (g.kind === 'modified' ? 2 : 1)) {
      card.classList.add('is-partial');
      textEl.textContent = `ждём: файлы ${missing.join(' и ')}`;
    } else {
      textEl.textContent = 'файлы не загружены';
    }
    refreshMenuStatus();
  }

  function refreshMenuStatus() {
    const ready = GAMES.filter((g) => g.kind !== 'port' && isGameReady(g)).length;
    const el = $('#menu-status');
    const text = $('.menu-status__text', el);
    el.classList.toggle('is-on', ready > 0 || engine.status === 'running');
    const core = {
      idle: 'ядро xash.js не загружено',
      loading: 'запуск ядра xash.js …',
      running: 'движок запущен',
      error: 'ошибка ядра (нужна перезагрузка)',
    }[engine.status] || '';
    text.textContent = ready > 0
      ? `готово к запуску: ${ready} · ${core}`
      : `библиотека пуста — загрузите файлы игры · ${core}`;
  }

  /* ═══════════════ DRAG-AND-DROP (event.dataTransfer) ═══════════════ */
  async function readDropped(dt) {
    const entries = [...(dt.items || [])]
      .filter((i) => i.kind === 'file')
      .map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry())
      .filter(Boolean);

    if (!entries.length) {
      return makeFileSet([...dt.files].map((f) => ({ file: f, path: f.name, size: f.size })));
    }

    const out = [];
    for (const entry of entries) await walkEntry(entry, '', out);
    return makeFileSet(out);
  }

  function walkEntry(entry, dir, out) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(out)) { out = []; }        // защита .push
      if (entry.isFile) {
        entry.file(
          (f) => { out.push({ file: f, path: dir + f.name, size: f.size }); resolve(); },
          reject,
        );
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => reader.readEntries(async (batch) => {
          if (!batch.length) return resolve();
          try {
            for (const child of batch) await walkEntry(child, dir + entry.name + '/', out);
            readBatch();
          } catch (err) { reject(err); }
        }, reject);
        readBatch();
      } else {
        resolve();
      }
    });
  }

  /* ── ЖЁСТКОЕ ИСПРАВЛЕНИЕ ИНПУТОВ (Linux-фикс, все игры) ──────
     Атрибуты webkitdirectory/directory удалены ПОЛНОСТЬЮ — именно
     они блокировали проводник Linux при выборе архивов.
     Во всех модальных окнах — строго одиночный .zip:
       <input type="file" class="game-zip-input" accept=".zip">
     Плюс большая Drop Zone: .zip перехватывается через
     e.dataTransfer.files на любой глубине UX. */
  function makeZipInput(onPick) {
    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'game-zip-input visually-hidden';
    input.setAttribute('accept', '.zip');
    input.removeAttribute('webkitdirectory');
    input.removeAttribute('directory');
    input.multiple = false;
    input.addEventListener('change', () => {
      try {
        const file = input.files && input.files[0];
        if (file) onPick(file);
      } finally { input.value = ''; }
    });
    return input;
  }

  /* ═══════════════ МОДАЛЬНЫЕ ОКНА ═══════════════ */
  const modalRoot = $('#modal-root');

  function mountOverlay(node) {
    modalRoot.appendChild(node);
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add('is-open')));
  }
  function unmountOverlay(node, after) {
    node.classList.remove('is-open');
    setTimeout(() => { node.remove(); if (after) after(); }, 380);
  }

  let uidSeq = 0;

  /* ═══════════════ ОКНО ЗАГРУЗКИ ФАЙЛОВ ИГРЫ ═══════════════ */
  function openGameModal(game) {
    const fs = libEntry(game.id);
    const links = linksFor(game);

    const overlay = html(`
      <div class="overlay" id="overlay-game">
        <div class="modal modal--game" role="dialog" aria-modal="true"
             aria-label="Загрузка файлов: ${escapeHtml(game.title)}" style="--accent:${game.accent}">
          <header class="modal__head">
            <div>
              <div class="modal__eyebrow">Загрузка ресурсов · ${game.kind === 'modified' ? 'game + mod' : 'кэш игры'}</div>
              <h3 class="modal__title">${game.title}</h3>
              <div class="modal__sub">${game.modalSub}</div>
            </div>
            <button class="icon-btn modal__close" data-close aria-label="Закрыть">${I.x}</button>
          </header>
          <div class="modal__body">
            <div class="zones" id="zones"></div>
            <div class="mem-row">
              <label class="mem-label" for="mem-select">Память ядра (Module.TOTAL_MEMORY)</label>
              <select id="mem-select" class="mem-select">
                <option value="0" ${engine.memoryOverrideMB === 0 ? 'selected' : ''}>авто (под размер кэша)</option>
                ${[192, 256, 384, 512, 768, 1024, 1536, 2048].map((mb) => `
                  <option value="${mb}" ${engine.memoryOverrideMB === mb ? 'selected' : ''}>${mb} МБ</option>`).join('')}
              </select>
              <span class="mem-hint" id="mem-hint"></span>
            </div>
            <p class="modal__hint" id="launch-hint"></p>
          </div>
          <footer class="modal__foot">
            <button class="btn btn--bracket btn--launch" id="btn-launch" disabled>ЗАПУСТИТЬ</button>
          </footer>
        </div>
      </div>`);

    mountOverlay(overlay);

    const zonesBox  = $('#zones', overlay);
    const btnLaunch = $('#btn-launch', overlay);
    const hint      = $('#launch-hint', overlay);
    const memSelect = $('#mem-select', overlay);
    const memHint   = $('#mem-hint', overlay);

    const syncMemHint = () => {
      const staged = stagedBytesTotal();
      const mb = computeTotalMemoryMB(staged, engine.memoryOverrideMB);
      memHint.textContent = staged
        ? `применится при запуске · сейчас: ${mb} МБ (кэш ${fmtBytes(staged)})`
        : 'применится при запуске (auto — под размер кэша)';
    };
    memSelect.addEventListener('change', () => {
      saveMemorySetting(Number(memSelect.value));
      syncMemHint();
    });
    syncMemHint();

    const close = () => unmountOverlay(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    $('[data-close]', overlay).addEventListener('click', close);

    const zoneDefs = [{ key: 'game', label: 'Загрузить файлы игры',
      hint: `.zip архив мобильного кэша — папки <b>${game.expect.join('</b> и <b>')}</b> ищутся автоматически<br>
             перетащите архив сюда или нажмите для выбора файла` }];
    if (game.kind === 'modified') {
      zoneDefs.push({ key: 'mod', label: 'Загрузить файлы мода',
        hint: `.zip архив модификации — модели, текстуры, спрайты, карты<br>
               побайтово накладывается поверх кэша игры в Module.FS` });
    }

    zonesBox.appendChild(buildZone(zoneDefs[0]));
    zonesBox.appendChild(buildLinksBlock('where', links.where));
    if (zoneDefs[1]) {
      zonesBox.appendChild(buildZone(zoneDefs[1]));
      zonesBox.appendChild(buildLinksBlock('mods', links.mods));
    }

    function buildLinksBlock(type, cfg) {
      const isWhere = type === 'where';
      const block = html(`
        <div class="links-block">
          <button type="button" class="link-strip" aria-expanded="false" aria-controls="lp-${++uidSeq}">
            <span class="ls-emoji" aria-hidden="true">${isWhere ? '🔍' : '🌐'}</span>
            ${isWhere
              ? '<span>Нет файлов игры? <b>Скачать готовый мобильный кэш</b></span>'
              : '<span><b>Каталог модов</b> — что подойдёт движку</span>'}
            <span class="ls-arrow" aria-hidden="true">▾</span>
          </button>
          <div class="link-panel" id="lp-${uidSeq}">
            <div class="lp-clip">
              <div class="link-panel__box">
                <p class="panel-note">${cfg.note}</p>
                ${cfg.links.map((l) => `
                  <a class="ext-link" href="${l.url}" target="_blank" rel="noopener noreferrer">
                    <span class="ext-link__host">${escapeHtml(l.host)}</span>
                    <span class="ext-link__title">${escapeHtml(l.title)}</span>
                    <span class="ext-link__desc">${escapeHtml(l.desc)}</span>
                  </a>`).join('')}
              </div>
            </div>
          </div>
        </div>`);

      const strip = $('.link-strip', block);
      const panel = $('.link-panel', block);
      strip.addEventListener('click', () => {
        const open = !panel.classList.contains('is-open');
        panel.classList.toggle('is-open', open);
        strip.setAttribute('aria-expanded', String(open));
      });
      return block;
    }

    function buildZone(zd) {
      const zone = html(`
        <div class="upzone" data-zone="${zd.key}" tabindex="0" role="button"
             aria-label="${zd.label}">
          <div class="upzone__content"></div>
        </div>`);

      const zipInput = makeZipInput((file) => handleZipList(zd.key, [file]));
      zone.append(zipInput);

      zone.addEventListener('click', (e) => {
        if (zone.classList.contains('is-busy')) return;
        if (e.target.closest('.upzone__clear')) return;
        zipInput.click();
      });
      zone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); zipInput.click(); }
      });

      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-drag'); });
      zone.addEventListener('dragleave', (e) => {
        if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-drag');
      });
      zone.addEventListener('drop', async (e) => {
        e.preventDefault();
        zone.classList.remove('is-drag');
        if (zone.classList.contains('is-busy')) return;
        try {
          const dt = e.dataTransfer;
          const files = [...(dt.files || [])];
          const zips = pickDropZips(files);
          const hasDir = [...(dt.items || [])].some((i) => {
            const en = i.webkitGetAsEntry && i.webkitGetAsEntry();
            return en && en.isDirectory;
          });
          if (zips.length) {
            if (zips.length !== files.length) toast('Смешанный дроп: обработаны только .zip архивы', 'warn');
            await handleZipList(zd.key, zips);
            return;
          }
          if (hasDir) {
            const set = await readDropped(dt);
            if (set.count) {
              await stageItems(game.id, set.items, zd.key === 'mod' ? modDirName(set) : null);
              acceptFiles(zd.key, set);
              return;
            }
          }
          toast('Перетащите .zip архив мобильного кэша', 'warn');
        } catch (err) {
          toast('Не удалось прочитать файлы: ' + (err && err.message), 'err');
        }
      });

      renderZone(zone, zd, fs[zd.key]);
      return zone;
    }

    /* ── умная распаковка .zip и побайтовая запись в staging-зону ── */
    async function handleZipList(key, files) {
      const zips = ensureArray(files).filter((f) => /\.zip$/i.test((f && f.name) || ''));
      if (!zips.length) { toast('Нужны архивы формата .zip', 'warn'); return; }
      if (zips.length !== files.length) toast('Файлы не .zip пропущены', 'warn');

      const zone = $(`.upzone[data-zone="${key}"]`, overlay);
      const zd = zoneDefs.find((z) => z.key === key);

      if (typeof JSZip === 'undefined') {
        toast('Ошибка: модуль распаковки архивов (JSZip) не загружен', 'err');
        return;
      }

      const merged = [];
      let skipped = 0;
      const multi = zips.length > 1;

      for (let i = 0; i < zips.length; i++) {
        const f = zips[i];
        const suffix = multi ? ` (${i + 1} из ${zips.length})` : '';
        renderZoneBusy(zone, f, suffix);
        try {
          const zip = await JSZip.loadAsync(f);
          const targets = key === 'game' ? game.expect : null;
          const res = await extractZipSet(zip, targets, (pct) => updateZoneProgress(zone, pct));
          if (!res.set || !res.set.count) {
            zone.classList.remove('is-busy');
            renderZone(zone, zd, fs[key]);
            toast('Ошибка: В архиве не найдена папка с файлами игры. Убедитесь, что загружаете правильный мобильный кэш', 'err', 6500);
            return;
          }

          /* ТРЕБОВАНИЕ 3: все файлы (включая .wad и модели v_/p_/w_) идут
             в staging-зону побайтово; в Module.FS пишутся при запуске */
          updateZoneProgress(zone, 100);
          await stageItems(game.id, res.set.items, key === 'mod' ? modDirName(res.set) : null);

          merged.push(...res.set.items);
          skipped += res.skipped;
        } catch (err) {
          zone.classList.remove('is-busy');
          renderZone(zone, zd, fs[key]);
          toast(`Ошибка: не удалось прочитать «${f.name}» — файл повреждён или это не zip`, 'err', 5000);
          return;
        }
      }

      zone.classList.remove('is-busy');
      acceptFiles(key, makeFileSet(merged));
      if (skipped > 0) {
        toast(`Лишних файлов вне целевой папки: ${skipped} — в ФС движка не писались`, 'info', 4200);
      }
      const roots = new Set(merged.map((it) => String(it.path).split('/')[0].toLowerCase()));
      if (game.primary === 'cstrike' && key === 'game' && !roots.has('valve')) {
        toast('В архиве нет базовой папки valve/ — движку нужны gfx.wad/halflife.wad из неё (иначе розовые текстуры). Добавьте её в архив или загрузите вторым файлом.', 'warn', 9000);
      }
    }

    function renderZoneBusy(zone, file, suffix = '') {
      const box = $('.upzone__content', zone);
      zone.classList.add('is-busy');
      box.innerHTML = `
        <div class="upzone__icon">${I.zip}</div>
        <div class="upzone__label"><span class="br">[</span>&nbsp;Распаковка${suffix}: <b class="zip-pct">0</b>%&nbsp;<span class="br">]</span></div>
        <div class="upzone__zipname"><b>${escapeHtml(file.name)}</b> · ${fmtBytes(file.size)}</div>
        <div class="progress progress--s"><div class="progress__fill zip-bar" style="width:0%"></div></div>`;
    }
    function updateZoneProgress(zone, pct) {
      const bar = $('.zip-bar', zone);
      const num = $('.zip-pct', zone);
      if (bar) bar.style.width = `${pct}%`;
      if (num) num.textContent = pct;
    }

    function renderZone(zone, zd, set) {
      const box = $('.upzone__content', zone);
      if (!set) {
        zone.classList.remove('is-filled', 'is-busy');
        box.innerHTML = `
          <div class="upzone__icon">${I.upload}</div>
          <div class="upzone__label"><span class="br">[</span> ${zd.label} <span class="br">]</span></div>
          <div class="upzone__hint">${zd.hint}</div>`;
        return;
      }
      zone.classList.remove('is-busy');
      zone.classList.add('is-filled');

      const chips = [...set.byExt.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([ext, n]) => `<span class="chip chip--accent">${ext} ×${n}</span>`)
        .join('');

      box.innerHTML = `
        <div class="upzone__icon">${I.folder}</div>
        <div class="upzone__label upzone__label--ok">${escapeHtml(set.root || 'выбранные файлы')}</div>
        <div class="upzone__stats">${filesLabel(set.count)} · ${fmtBytes(set.size)}</div>
        <div class="upzone__chips">${chips}</div>
        <button class="upzone__clear" title="Очистить" aria-label="Очистить выбор">${I.x}</button>`;

      $('.upzone__clear', box).addEventListener('click', (e) => {
        e.stopPropagation();
        fs[zd.key] = null;
        renderZone(zone, zd, null);
        updateLaunchState();
        refreshCard(game.id);
      });
    }

    function validateExpectation(key, set) {
      if (key !== 'game') return;
      const okSet = ensureArray(set.items).some((it) =>
        String(it.path).split('/').some((seg) => game.expect.includes(seg.toLowerCase())));
      if (!okSet) {
        toast(`Папка «${game.primary}» не найдена — проверьте, что выбран мобильный кэш игры`, 'warn', 4600);
      }
    }

    function acceptFiles(key, set) {
      fs[key] = set;
      validateExpectation(key, set);
      const zone = $(`.upzone[data-zone="${key}"]`, overlay);
      const zd = zoneDefs.find((z) => z.key === key);
      renderZone(zone, zd, set);
      updateLaunchState();
      syncMemHint();
      refreshCard(game.id);
      toast(`${zd.label.replace('Загрузить ', 'Смонтировано в staging-зону: ')} — ${filesLabel(set.count)}`, 'ok');
    }

    function updateLaunchState() {
      const missing = [];
      if (!fs.game) missing.push('файлы игры');
      if (game.kind === 'modified' && !fs.mod) missing.push('файлы мода');
      const ready = missing.length === 0;

      btnLaunch.disabled = !ready || engine.status === 'running' || engine.status === 'loading' || engine.dirty;
      btnLaunch.classList.toggle('is-live', ready);
      hint.classList.toggle('is-ok', ready);
      hint.innerHTML = (engine.status === 'running' || engine.dirty)
        ? 'движок уже запущен — для новой игры перезагрузите страницу'
        : (ready
          ? 'файлы побайтово смонтируются в Module.FS — нажмите [ ЗАПУСТИТЬ ]'
          : `добавьте <b>${missing.join('</b> и <b>')}</b>, чтобы продолжить`);
    }
    updateLaunchState();

    /* Кнопка [ ЗАПУСТИТЬ ] — одиночный детерминированный запуск движка:
       var Module → xash.html.mem → xash.js → DSO → mount → ENV → main() */
    btnLaunch.addEventListener('click', async () => {
      btnLaunch.disabled = true;
      btnLaunch.textContent = 'ЗАПУСК...';
      try {
        await launchGameEngine(game, { game: fs.game, mod: fs.mod });
        unmountOverlay(overlay);
      } catch (err) {
        btnLaunch.disabled = false;
        btnLaunch.textContent = 'ЗАПУСТИТЬ';
        toast('Движок не запустился: ' + (err && (err.message || err)), 'err', 9000);
        bootShow(true);
      }
    });
  }

  /* ── запись набора файлов в staging-зону ───────────────────── */
  async function bytesOf(item) {
    const f = item.file !== undefined ? item.file : item.data;
    if (f instanceof Uint8Array) return f;
    if (typeof Blob !== 'undefined' && f instanceof Blob) return new Uint8Array(await f.arrayBuffer());
    return toUint8Array(f);
  }

  /** modRoot — каталог мода (если архив мода не valve/cstrike): всё дерево
   *  монтируется в /rodir/<modRoot>/ и запускается через -game <modRoot>. */
  async function stageItems(gameId, items, modRoot) {
    const list = ensureArray(items);
    let total = 0, overwritten = 0;
    for (const item of list) {
      const bytes = await bytesOf(item);
      if (!bytes) continue;
      let abs;
      if (modRoot) {
        const rel = String(item.path || '').replace(/\\/g, '/').split('/').filter(Boolean);
        if (rel[0] && rel[0].toLowerCase() === modRoot.toLowerCase()) rel.shift();
        abs = `${ENGINE_ROOT}/${modRoot}/${rel.join('/')}`;
      } else {
        abs = resolveFSAbsolutePath(gameId, item.path);
      }
      if (!abs) continue;
      if (stagedFiles.has(abs)) overwritten++;
      stagedFiles.set(abs, bytes);
      total++;
    }
    return { total, overwritten };
  }

  /* ── глобальные обработчики ─────────────────────────────────── */
  function bindGlobal() {
    $('#btn-start').addEventListener('click', () => switchScreen(splashScreen, menuScreen));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && splashScreen.classList.contains('is-active') && !modalRoot.children.length) {
        $('#btn-start').click();
      }
      if (e.key === 'Escape') {
        const overlays = modalRoot.querySelectorAll('.overlay');
        if (overlays.length) { unmountOverlay(overlays[overlays.length - 1]); return; }
        if (engineConsole && engineConsole.classList.contains('is-open')) toggleEngineConsole(false);
      }
      if (e.key === '`' || e.key === '~' || e.key === 'ё' || e.key === 'Ё') {
        if (gameScreen.classList.contains('is-active')) toggleEngineConsole();
      }
    });

    $('#btn-exit').addEventListener('click', () => switchScreen(menuScreen, splashScreen));

    /* HUD: консоль движка / мышь / полный экран / выход */
    const hudConsole = $('#hud-console');
    const hudPointer = $('#hud-pointer');
    const hudFull    = $('#hud-full');
    const hudExit    = $('#hud-exit');

    if (hudConsole) hudConsole.addEventListener('click', () => toggleEngineConsole());
    const consoleClose = $('#engine-console-close');
    if (consoleClose) consoleClose.addEventListener('click', () => toggleEngineConsole(false));

    hudPointer.addEventListener('click', () => {
      if (!gameScreen.classList.contains('is-active')) return;
      if (document.pointerLockElement === canvasEl) {
        document.exitPointerLock();
      } else {
        mouseWantsLock = true;     // ручная кнопка — захват всегда разрешён
        tryLockPointer();
      }
    });

    /* ═══ МЫШЬ · ТРЕБОВАНИЕ 2: умный перехватчик ═══
       Захватываем мышь только если пользователь кликнул в процессе игры.
       Состояние движка известно по курсору: в игровом режиме (relative mode)
       движок прячет курсор — style.cursor='none'; в своём меню курсор
       свободен — 'default'. Поэтому в меню клик остаётся обычным
       (наводятся кнопки), а в игре — возвращает захват. */
    canvasEl.addEventListener('click', () => {
      if (!isGameActive || document.pointerLockElement === canvasEl) return;
      if (canvasEl.style.cursor !== 'none') { mouseWantsLock = false; return; }
      mouseWantsLock = true;
      tryLockPointer();
    });

    /* Escape или ` — немедленно освобождаем курсор */
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' || e.key === '`') {
        if (document.pointerLockElement === canvasEl) {
          document.exitPointerLock();
        }
      }
    });

    document.addEventListener('pointerlockchange', () => {
      const on = document.pointerLockElement === canvasEl;
      if (!on) {
        /* Движок ОСВОБОЖДАЕТ курсор в своём меню (style.cursor='default')
           и ДЕРЖИТ его в игре (style.cursor='none'). Если сняли из игры —
           клик по холсту снова захватит мышь; в меню — нет. */
        mouseWantsLock = canvasEl.style.cursor === 'none';
      }
      hudPointer.textContent = on ? 'МЫШЬ ЗАХВАЧЕНА' : 'ЗАХВАТ МЫШИ';
      hudPointer.classList.toggle('is-on', on);
    });

    hudFull.addEventListener('click', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        gameScreen.requestFullscreen({ navigationUI: 'hide' })
          .catch(() => toast('Браузер отклонил полноэкранный режим', 'warn'));
      }
    });
    document.addEventListener('fullscreenchange', () => {
      hudFull.textContent = document.fullscreenElement ? 'СВЕРНУТЬ' : 'ВО ВЕСЬ ЭКРАН';
    });

    hudExit.addEventListener('click', exitGameSession);

    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());

    /* ошибки ядра движка — честно показываем пользователю */
    window.addEventListener('error', (e) => {
      const msg = (e && (e.message || (e.error && e.error.message))) || '';
      if (!msg) return;
      if (/SimulateInfiniteLoop/.test(msg)) return;      // штатный unwind mainloop
      bootLine('window.onerror: ' + msg, 'err');
      if (engine.status !== 'running' && engine.status !== 'loading') {
        engine.status = 'error';
        engine.error = msg;
        bootShow(true);
        bootStepText('ошибка ядра: ' + msg, 100);
      }
    });
    window.addEventListener('unhandledrejection', (e) => {
      const msg = String((e && e.reason && (e.reason.message || e.reason)) || '');
      if (msg) bootLine('unhandledrejection: ' + msg, 'err');
    });

    /* при старте портала курсор свободен и виден (Pointer Lock выключен) */
    setFreeCursor();
  }

  /* ── инициализация портала ──────────────────────────────────── */
  renderCards();
  bindGlobal();
  refreshMenuStatus();
  bootLine(`портал готов · цепочка ядра: ${ENGINE_SCRIPTS.join(' → ')} · ${ENGINE_MEMORY_INITIALIZER} · корень ФС ${ENGINE_ROOT}`);
})();
