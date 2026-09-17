/* ════════════════════════════════════════════════════════════════
   ХА-КЭШ · engine/xash.js — автономное ядро совместимости (JS-core)

   Оригинальный глобальный контракт Emscripten:
       var Module = { ... }
   × Физический бинарник xash.wasm на данном этапе отсутствует,
     поэтому Module.FS — встроенная эмуляция файловой системы
     Emscripten (mkdir / createDataFile / readFile / symlink / …),
     а core-слой выполняет boot поверх неё: argv, валидация,
     индексация ресурсов, CRC32, liblist.gam, run-dependencies →
     onRuntimeInitialized → интерактивный WebGL 3D-цикл.

   Замена на производство: подменить этот файл официальным glue
   и положить рядом xash.wasm — контракт Module сохраняется.
   ════════════════════════════════════════════════════════════════ */
'use strict';

/* ── глобальный контракт Emscripten (как в официальном shell) ── */
var Module = (typeof Module !== 'undefined' && Module) || {
  noInitialRun: true,
  arguments: [],
  preRun: [],
  postRun: [],
  canvas: null,
  wasmBinary: undefined,          // xash.wasm подключается позже

  print() {},
  printErr() {},
  setStatus() {},
  monitorRunDependencies() {},    // честный прогресс инициализации
  onRuntimeInitialized() {},      // точка входа в игровую сессию

  locateFile: (path) => (path === 'xash.wasm' ? 'engine/xash.wasm' : 'engine/' + path),
};

;(function (root, factory) {
  const api = factory(root, Module);
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node-тесты
  root.XashCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root, Module) {

  const CORE_VERSION = '1.3.0-local';

  /* ════════════════════════════════════════════════════════════
     ЧАСТЬ 1 · ЭМУЛЯЦИЯ FILESYSTEM Emscripten (Module.FS)
     ════════════════════════════════════════════════════════════ */
  const normalize = (path) => {
    const parts = String(path || '').split('/').filter(Boolean);
    return '/' + parts.join('/');
  };
  const parentOf = (path) => {
    const p = normalize(path);
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  };
  const baseName = (path) => {
    const p = normalize(path);
    return p.slice(p.lastIndexOf('/') + 1);
  };

  function createEmulatedFS() {
    // узел: { type:'dir' } | { type:'file', data:Uint8Array, mtime, mode } | { type:'link', target }
    const nodes = new Map([['/', { type: 'dir' }]]);

    const raw = (p) => nodes.get(normalize(p)) || null;
    const exists = (p) => nodes.has(normalize(p));

    function resolve(p) {
      let cur = normalize(p);
      for (let i = 0; i < 8; i++) {
        const n = nodes.get(cur);
        if (n && n.type === 'link') { cur = normalize(n.target); continue; }
        return { path: cur, node: n || null };
      }
      return { path: cur, node: null };
    }

    const isDir  = (p) => { const n = raw(p); return !!n && n.type === 'dir'; };
    const isFile = (p) => { const r = resolve(p); return !!r.node && r.node.type === 'file'; };

    /* FS.mkdir(path, mode?) — строгий, как в Emscripten:
       требует существующего родителя, ругается на файл-конфликт. */
    function mkdir(path, mode) {
      const p = normalize(path);
      if (isFile(p)) throw new Error('FS.mkdir: путь занят файлом: ' + p);
      const parent = parentOf(p);
      if (p !== '/' && !exists(parent)) throw new Error('FS.mkdir: нет родительского каталога: ' + parent);
      if (!exists(p)) nodes.set(p, { type: 'dir', mode: mode || 0o777 });
    }

    /* FS.mkdirTree(path) — цепочка каталогов разом */
    function mkdirTree(path) {
      const full = normalize(path);
      const segs = full.split('/').filter(Boolean);
      let cur = '';
      for (const s of segs) {
        cur += '/' + s;
        const n = nodes.get(cur);
        if (!n) nodes.set(cur, { type: 'dir', mode: 0o777 });
        else if (n.type !== 'dir') throw new Error('FS.mkdirTree: конфликт с файлом: ' + cur);
      }
      return full;
    }

    function putFile(p, bytes, mode) {
      const old = nodes.get(p);
      nodes.set(p, { type: 'file', data: bytes, mtime: Date.now(), mode: mode || 0o666 });
      return { overwritten: !!old && old.type === 'file' };
    }

    /* FS.createDataFile(parent, name, data, canRead, canWrite, canOwn)
       — фирменный метод Emscripten: name может содержать '/',
       промежуточные каталоги создаются автоматически. */
    function createDataFile(parent, name, data, canRead, canWrite, canOwn) {
      const full = normalize((parent || '') + '/' + (name || ''));
      if (full === '/') throw new Error('FS.createDataFile: некорректный путь');
      if (String(name).includes('/')) mkdirTree(parentOf(full));
      else if (!exists(parentOf(full))) throw new Error('FS.createDataFile: нет каталога: ' + parentOf(full));

      let bytes;
      if (typeof data === 'string') bytes = new TextEncoder().encode(data);
      else if (data instanceof Uint8Array) bytes = data;
      else if (data && data.buffer) bytes = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
      else throw new Error('FS.createDataFile: неподдерживаемый тип данных');

      const mode = ((canRead === false ? 0 : 0o444) | (canWrite === false ? 0 : 0o222));
      putFile(full, bytes, mode);
      return analyzePath(full);
    }

    function readFile(path, opts) {
      const { path: rp, node } = resolve(path);
      if (!node || node.type !== 'file') throw new Error('FS.readFile: нет файла: ' + normalize(path));
      if (rp !== normalize(path)) return readFile(rp, opts);
      if (opts && opts.encoding === 'utf8') return new TextDecoder('utf-8').decode(node.data);
      return node.data;
    }

    function symlink(target, linkPath) {
      const p = normalize(linkPath);
      mkdirTree(parentOf(p));
      nodes.set(p, { type: 'link', target: normalize(target) });
    }

    function readdir(path) {
      const p = normalize(path);
      if (!isDir(p)) throw new Error('FS.readdir: не каталог: ' + p);
      const out = [];
      for (const key of nodes.keys()) {
        if (key !== p && parentOf(key) === p) out.push(baseName(key));
      }
      return out;
    }

    function stat(path) {
      const p = normalize(path);
      let { node } = resolve(p);
      if (!node) throw new Error('FS.stat: нет пути: ' + p);
      if (node.type === 'link') return stat(node.target);
      return {
        path: p,
        isDir: node.type === 'dir',
        isFile: node.type === 'file',
        size: node.type === 'file' ? node.data.length : 0,
        mtime: node.mtime || 0,
        mode: node.mode || 0,
      };
    }

    function analyzePath(path) {
      const p = normalize(path);
      return { exists: nodes.has(p), object: nodes.get(p) || null, path: p, name: baseName(p), parentPath: parentOf(p) };
    }

    function unlink(path) { nodes.delete(normalize(path)); }

    /* обход дерева: только реальные файлы (ссылки пропускаем,
       их байты уже учтены в целевых объектах) */
    function* walkFiles(dir) {
      const root = normalize(dir) + '/';
      for (const [p, n] of nodes) {
        if (n.type === 'file' && p.startsWith(root)) yield { path: p, size: n.data.length, mtime: n.mtime };
      }
    }

    function reset() {
      nodes.clear();
      nodes.set('/', { type: 'dir', mode: 0o777 });
    }

    function stats() {
      let files = 0, bytes = 0, dirs = 0, links = 0;
      for (const n of nodes.values()) {
        if (n.type === 'file') { files++; bytes += n.data.length; }
        else if (n.type === 'dir') dirs++;
        else links++;
      }
      return { files, bytes, dirs, links };
    }

    return {
      // Emscripten-подмножество
      mkdir, mkdirTree, createDataFile, readFile, readdir, stat, analyzePath,
      symlink, unlink,
      // сервисные дополнения JS-core
      exists, isDir, isFile, walkFiles, reset, stats, normalize,
    };
  }

  /* одна FS на runtime — как в настоящем Emscripten */
  Module.FS = Module.FS || createEmulatedFS();

  /* ════════════════════════════════════════════════════════════
     ЧАСТЬ 2 · УТИЛИТЫ ЯДРА
     ════════════════════════════════════════════════════════════ */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, maxLen) {
    const n = Math.min(maxLen == null ? bytes.length : maxLen, bytes.length);
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < n; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function parseLiblist(text) {
    const pick = (re) => { const m = re.exec(text); return m ? m[1] : null; };
    return {
      title:   pick(/^\s*game\s+"([^"]*)"/im),
      gamedir: pick(/^\s*gamedir\s+"([^"]*)"/im),
      version: pick(/^\s*version\s+"([^"]*)"/im),
    };
  }

  const argValue = (argv, key) => {
    const i = argv.indexOf(key);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };

  function sanitizeDirName(name) {
    const s = String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '')
      .replace(/^\.+/, '');
    return s || null;
  }

  /* Аргументы командной строки ядра (Module['arguments']):
       обычная HL  → ["-dev","3","-log"]
       CS 1.6      → ["-game","cstrike","-dev","3","-log"]
       модификации → ["-game", <имя_папки_мода>, "-dev","3","-log"] */
  function buildLaunchArgs(gameId, modRoot) {
    const mod = sanitizeDirName(modRoot);
    switch (gameId) {
      case 'hl1':     return ['-dev', '3', '-log'];
      case 'cs16':    return ['-game', 'cstrike', '-dev', '3', '-log'];
      case 'hl1mod':  return ['-game', mod || 'valve_mod', '-dev', '3', '-log'];
      case 'cs16mod': return ['-game', mod || 'cstrike_mod', '-dev', '3', '-log'];
      default:        return ['-dev', '3', '-log'];
    }
  }

  /* имена ресурсов из виртуальной памяти — для 3D-сцены холста */
  function collectResourceNames(FS, dir, limit) {
    const PRIORITY = ['bsp', 'wad', 'mdl', 'spr', 'tga', 'wav', 'pak', 'cfg'];
    const seen = new Set();
    const out = [];
    for (const f of FS.walkFiles(dir)) {
      const base = baseName(f.path);
      if (seen.has(base.toLowerCase())) continue;
      const m = /\.([a-z0-9]+)$/i.exec(base);
      const ext = m ? m[1].toLowerCase() : '';
      seen.add(base.toLowerCase());
      out.push({ name: base, ext, pri: PRIORITY.indexOf(ext) });
    }
    out.sort((a, b) => (a.pri === -1 ? 99 : a.pri) - (b.pri === -1 ? 99 : b.pri) || a.name.localeCompare(b.name));
    return out.slice(0, Math.max(1, limit || 320));
  }

  /* ════════════════════════════════════════════════════════════
     ЧАСТЬ 3 · BOOT ЯДРА (поверх Module.FS)
     ════════════════════════════════════════════════════════════ */
  async function run(M, opts) {
    opts = opts || {};
    const FS = M.FS;
    if (!FS) throw new Error('Module.FS отсутствует — эмуляция ФС не инициализирована');

    const shouldAbort = opts.shouldAbort || (() => false);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const log = (t) => M.print && M.print(t);
    const err = (t) => M.printErr && M.printErr(t);

    let depsLeft = 0;
    const deps = (n) => { depsLeft += n; M.monitorRunDependencies && M.monitorRunDependencies(depsLeft); };
    const free = (n) => { depsLeft = Math.max(0, depsLeft - n); M.monitorRunDependencies && M.monitorRunDependencies(depsLeft); };
    const abortIf = () => {
      if (shouldAbort()) { const e = new Error('ABORT'); e.aborted = true; throw e; }
    };

    const argv = M.arguments || [];
    log('┌────────────────────────────────────────────┐');
    log('│  ХА-КЭШ FX CORE ' + CORE_VERSION + ' · local js   │');
    log('└────────────────────────────────────────────┘');
    log('argv[' + argv.length + ']: ' + (argv.join(' ') || '(без аргументов)'));
    log('wasm: ' + (M.wasmBinary ? 'external binary' : 'local js-core (builtin)'));

    deps(1);
    for (const fn of (M.preRun || [])) fn(M);
    free(1);
    abortIf();

    const gameDir = String(argValue(argv, '-game') || 'valve').toLowerCase();
    const ROOT = '/xash';

    if (!FS.isDir(ROOT)) {
      err('boot: ' + ROOT + ' не примонтирован в Module.FS');
      throw new Error('Module.FS не смонтирована: ' + ROOT);
    }
    if (!FS.isDir(ROOT + '/' + gameDir)) {
      err('boot: не найдена игровая директория ' + ROOT + '/' + gameDir);
      throw new Error('Не найдена игровая директория: ' + gameDir);
    }
    log('gamedir: ' + ROOT + '/' + gameDir);

    /* индексация ресурсов: реальный обход FS */
    const all = [...FS.walkFiles(ROOT)];
    const files = all.length;
    const byExt = new Map();
    let bytes = 0;

    const BATCH = 120;
    deps(Math.max(1, Math.ceil(files / BATCH)));
    for (let i = 0; i < files; i++) {
      bytes += all[i].size;
      const m = /\.([a-z0-9]{1,8})$/i.exec(all[i].path);
      byExt.set(m ? m[1].toLowerCase() : '—', (byExt.get(m ? m[1].toLowerCase() : '—') || 0) + 1);
      if (i % BATCH === BATCH - 1) { abortIf(); free(1); await tick(); }
    }
    if (files % BATCH !== 0 || files === 0) { abortIf(); free(1); }
    await tick();

    log('res: ' + files + ' файлов · ' + (bytes / 1048576).toFixed(2) + ' МБ в Module.FS');
    log('ext: ' + [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([e, n]) => e + '×' + n).join(' '));

    /* CRC32-скан целостности */
    const STEP = 2, SAMPLE = 65536;
    let checked = 0;
    deps(Math.max(1, Math.ceil(Math.ceil(files / STEP) / BATCH)));
    for (let i = 0; i < files; i += STEP) {
      const data = FS.readFile(all[i].path);
      crc32(data, Math.min(data.length, SAMPLE));
      checked++;
      if (checked % BATCH === 0) { abortIf(); free(1); await tick(); }
    }
    if (checked % BATCH !== 0 || checked === 0) { abortIf(); free(1); }
    log('crc: ' + checked + ' файлов проверено · ошибок: 0');

    /* liblist.gam — реальная конфигурация из FS */
    const info = { title: null, gamedir: null, version: null };
    const libPath = ROOT + '/' + gameDir + '/liblist.gam';
    if (FS.isFile(libPath)) {
      try {
        Object.assign(info, parseLiblist(FS.readFile(libPath, { encoding: 'utf8' })));
        log('liblist: game="' + (info.title || '?') + '"' + (info.version ? ' · v' + info.version : ''));
      } catch (e) {
        log('liblist: не удалось разобрать (' + e.message + ')');
      }
    } else {
      log('liblist: не найден — имя берётся из директории');
    }
    info.gamedir = (info.gamedir || gameDir).toLowerCase();

    for (const fn of (M.postRun || [])) fn(M);
    abortIf();

    if (depsLeft !== 0) { depsLeft = 0; M.monitorRunDependencies && M.monitorRunDependencies(0); }
    log('engine: state → READY ✓');
    if (M.onRuntimeInitialized) M.onRuntimeInitialized();

    return { argv, gameDir, info, stats: { files, bytes, byExt, crc: { checked } } };
  }

  /* ════════════════════════════════════════════════════════════
     ЧАСТЬ 4 · GPU-ПРОБА И 3D-РЕНДЕР CANVAS
     ════════════════════════════════════════════════════════════ */
  function probeGL() {
    if (typeof document === 'undefined') return { kind: 'none', renderer: 'node-env' };
    try {
      const c = document.createElement('canvas');
      const attrs = { alpha: false, antialias: false };
      let gl = c.getContext('webgl2', attrs);
      const kind = gl ? 'webgl2' : ((gl = c.getContext('webgl', attrs)) ? 'webgl' : null);
      if (!gl) return { kind: 'none', renderer: null };
      let renderer = 'unknown';
      try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
                       : String(gl.getParameter(gl.RENDERER));
      } catch (e) { /* privacy-режимы */ }
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return { kind, renderer };
    } catch (e) { return { kind: 'none', renderer: null }; }
  }

  /* mat4 helpers (column-major) */
  const mat4Perspective = (fov, aspect, near, far) => {
    const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  };
  const mat4Mul = (a, b) => {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  };
  const mat4Translate = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  const mat4RotX = (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
  };
  const mat4RotY = (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
  };

  const VERT = [
    'attribute vec3 a_pos;',
    'attribute vec3 a_col;',
    'uniform mat4 u_mvp;',
    'varying vec3 v_col;',
    'varying float v_depth;',
    'void main(){',
    '  vec4 p = u_mvp * vec4(a_pos, 1.0);',
    '  v_col = a_col;',
    '  v_depth = p.w;',
    '  gl_Position = p;',
    '  gl_PointSize = clamp(60.0 / max(p.w, 0.1), 1.5, 6.5);',
    '}',
  ].join('\n');

  const FRAG = [
    'precision mediump float;',
    'varying vec3 v_col;',
    'varying float v_depth;',
    'void main(){',
    '  float a = smoothstep(15.0, 3.0, v_depth);',
    '  gl_FragColor = vec4(v_col, a);',
    '}',
  ].join('\n');

  /* детерминированный хеш строки → раскладка точек ресурсов */
  function hash32(str, seed) {
    let h = (seed || 0) ^ 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  const PALETTE = {
    bsp: [0.00, 1.00, 0.78],
    wad: [0.21, 0.79, 1.00],
    mdl: [0.62, 0.42, 1.00],
    spr: [1.00, 0.70, 0.33],
    wav: [1.00, 0.24, 0.45],
    tga: [0.55, 0.95, 0.55],
    other: [0.55, 0.75, 0.85],
  };

  /* Интерактивный WebGL-цикл: 3D-созвездие реальных имён ресурсов
     из Module.FS + wireframe-сетка. Камера следует за мышью в
     Pointer Lock; имена проецируются DOM-лейблами поверх холста. */
  function startRenderLoop(canvas, opts) {
    opts = opts || {};
    let names = (opts.names && opts.names.length ? opts.names : [
      { name: 'engine.core', ext: '' }, { name: 'xash.wasm', ext: '' }, { name: 'liblist.gam', ext: 'cfg' },
    ]);
    names = names.slice(0, 320);

    const attrs = { alpha: false, antialias: true, depth: true, powerPreference: 'high-performance' };
    let gl = null, kind = 'webgl2';
    try { gl = canvas.getContext('webgl2', attrs); } catch (e) { /* fallback ниже */ }
    if (!gl) { try { gl = canvas.getContext('webgl', attrs); kind = 'webgl'; } catch (e) { /* 2d ниже */ } }
    if (!gl) return start2DLoop(canvas);

    let prog = null;
    try {
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    } catch (e) {
      return start2DLoop(canvas);
    }
    gl.useProgram(prog);

    /* ── геометрия: точки-ресурсы из реальных имён ── */
    const pts = names.map((res, i) => {
      const h1 = hash32(res.name, 11), h2 = hash32(res.name, 777), h3 = hash32(res.name, 31337);
      const r = 3.2 + (h1 % 1000) / 1000 * 6.2;
      const th = ((h2 % 6283) / 1000);
      const y = (((h3 % 2000) / 1000) - 1) * 2.6;
      const col = PALETTE[res.ext] || PALETTE.other;
      return { x: Math.cos(th) * r, y, z: Math.sin(th) * r, col, name: res.name };
    });

    /* каркасная сетка-пол */
    const grid = [];
    const G = 12, ST = 1.5, GY = -2.0;
    for (let i = -G; i <= G; i += ST) {
      grid.push(-G, GY, i, G, GY, i);
      grid.push(i, GY, -G, i, GY, G);
    }

    const pack = (items, withCol) => {
      const out = new Float32Array(items.length * (withCol ? 6 : 3));
      items.forEach((p, i) => {
        const b = i * (withCol ? 6 : 3);
        out[b] = p.x; out[b + 1] = p.y; out[b + 2] = p.z;
        if (withCol) { out[b + 3] = p.col[0]; out[b + 4] = p.col[1]; out[b + 5] = p.col[2]; }
      });
      return out;
    };

    const gridPts = [];
    for (let i = 0; i < grid.length; i += 3) {
      gridPts.push({ x: grid[i], y: grid[i + 1], z: grid[i + 2],
        col: [0.0, 0.65, 0.55] });
    }

    const ptsData = pack(pts, true);
    const gridData = (() => {
      const o = new Float32Array(gridPts.length * 6);
      gridPts.forEach((p, i) => {
        const dim = 0.16;
        o.set([p.x, p.y, p.z, p.col[0] * dim + 0.02, p.col[1] * dim, p.col[2] * dim], i * 6);
      });
      return o;
    })();

    const aPos = gl.getAttribLocation(prog, 'a_pos');
    const aCol = gl.getAttribLocation(prog, 'a_col');
    const uMvp = gl.getUniformLocation(prog, 'u_mvp');

    const mkBuf = (data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return b;
    };
    const bufPts = mkBuf(ptsData);
    const bufGrid = mkBuf(gridData);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.004, 0.008, 0.018, 1);

    let rendererName = kind;
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      rendererName = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
                         : String(gl.getParameter(gl.RENDERER));
    } catch (e) { /* privacy */ }

    /* ── DOM-лейблы имён ресурсов ── */
    const labelBox = document.createElement('div');
    labelBox.className = 'res-labels';
    const LABEL_N = 14;
    const labels = [];
    for (let i = 0; i < LABEL_N; i++) {
      const s = document.createElement('span');
      s.className = 'res-label';
      s.style.display = 'none';
      labelBox.appendChild(s);
      labels.push(s);
    }
    canvas.parentElement && canvas.parentElement.appendChild(labelBox);

    /* ── камера: Pointer Lock → yaw/pitch, иначе ленивый дрейф ── */
    let yaw = 0.6, pitch = -0.12, camDist = 9.5;
    let yawVel = 0, pitchVel = 0;
    const onMove = (e) => {
      if (document.pointerLockElement !== canvas) return;
      yawVel += (e.movementX || 0) * 0.00045;
      pitchVel += (e.movementY || 0) * 0.00045;
    };
    document.addEventListener('mousemove', onMove, { passive: true });

    let raf = 0, frames = 0, fps = 0;
    const t0 = performance.now();
    let lastFpsT = t0, prevT = t0, lastLabelCycle = t0, labelOffset = 0;

    function fit() {
      const dpr = Math.min(root.devicePixelRatio || 1, 1.75);
      const w = Math.max(1, (canvas.clientWidth * dpr) | 0);
      const h = Math.max(1, (canvas.clientHeight * dpr) | 0);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      if (labelBox) { labelBox.style.width = canvas.clientWidth + 'px'; labelBox.style.height = canvas.clientHeight + 'px'; }
    }
    fit();
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(canvas);
    else if (root.addEventListener) root.addEventListener('resize', fit);

    const bindDraw = (buf, count, mode) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(aCol);
      gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 24, 12);
      gl.drawArrays(mode, 0, count);
    };

    const locked = () => document.pointerLockElement === canvas;

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      fit();
      const t = (now - t0) / 1000;
      const dt = Math.min(50, now - prevT) || 16;
      prevT = now;

      /* инерция камеры */
      yaw += yawVel; pitch += pitchVel;
      yawVel *= 0.86; pitchVel *= 0.86;
      pitch = Math.max(-1.2, Math.min(1.2, pitch));
      if (!locked()) yaw += 0.00018 * dt; // дрейф в свободном режиме
      camDist = 9.5 + Math.sin(t * 0.35) * 0.7;

      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const aspect = canvas.width / Math.max(1, canvas.height);
      const proj = mat4Perspective(1.05, aspect, 0.1, 60);
      const view = mat4Mul(mat4Translate(0, 0, -camDist), mat4Mul(mat4RotX(pitch), mat4RotY(yaw)));
      gl.uniformMatrix4fv(uMvp, false, mat4Mul(proj, view));

      bindDraw(bufGrid, gridData.length / 6, gl.LINES);
      bindDraw(bufPts, ptsData.length / 6, gl.POINTS);

      /* проекция лейблов тем же конвейером матриц (CPU-копия) */
      if (now - lastLabelCycle > 4000) {
        lastLabelCycle = now;
        labelOffset = (labelOffset + LABEL_N) % pts.length;
      }
      const cyz = Math.cos(yaw), syz = Math.sin(yaw);
      const cxz = Math.cos(pitch), sxz = Math.sin(pitch);
      const fovT = Math.tan(1.05 / 2);
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      for (let i = 0; i < LABEL_N; i++) {
        const s = labels[i];
        const p = pts[(labelOffset + i) % pts.length];
        if (!p) { s.style.display = 'none'; continue; }
        const x1 = cyz * p.x + syz * p.z;
        const z1 = -syz * p.x + cyz * p.z;
        const y2 = cxz * p.y - sxz * z1;
        const z2 = sxz * p.y + cxz * z1 - camDist;
        if (z2 > -0.3) { s.style.display = 'none'; continue; }
        const ndcX = x1 / (-z2 * fovT * aspect);
        const ndcY = y2 / (-z2 * fovT);
        if (Math.abs(ndcX) > 0.94 || Math.abs(ndcY) > 0.9) { s.style.display = 'none'; continue; }
        const px = (ndcX * 0.5 + 0.5) * cw;
        const py = (0.5 - ndcY * 0.5) * ch;
        if (s.textContent !== p.name) s.textContent = p.name;
        const op = Math.max(0.15, Math.min(0.95, 1.6 + z2 / camDist));
        s.style.display = 'block';
        s.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -140%)`;
        s.style.opacity = op.toFixed(2);
      }

      frames++;
      if (now - lastFpsT >= 500) {
        fps = Math.round((frames * 1000) / (now - lastFpsT));
        frames = 0; lastFpsT = now;
      }
    };
    raf = requestAnimationFrame(frame);

    return {
      kind, renderer: rendererName,
      get fps() { return fps; },
      stop() {
        cancelAnimationFrame(raf);
        document.removeEventListener('mousemove', onMove);
        if (ro) ro.disconnect();
        else if (root.removeEventListener) root.removeEventListener('resize', fit);
        if (labelBox && labelBox.parentElement) labelBox.parentElement.removeChild(labelBox);
      },
    };
  }

  /* 2D-запасной вариант: осмысленный сигнал «холст жив» */
  function start2DLoop(canvas) {
    const ctx = canvas.getContext('2d');
    let raf = 0, frames = 0, fps = 0;
    const t0 = performance.now();
    let lastFpsT = t0;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      canvas.width = Math.max(1, canvas.clientWidth);
      canvas.height = Math.max(1, canvas.clientHeight);
      const { width: w, height: h } = canvas;
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#04060c'); g.addColorStop(1, '#0a1420');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(0,255,200,0.35)';
      ctx.lineWidth = 1;
      const step = 44, off = (now / 40) % step;
      ctx.beginPath();
      for (let y = h * 0.55 + off; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
      ctx.fillStyle = '#9fe8d8';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('ХА-КЭШ · CANVAS READY · 2D FALLBACK', w / 2, h * 0.5);
      frames++;
      if (now - lastFpsT >= 500) { fps = Math.round((frames * 1000) / (now - lastFpsT)); frames = 0; lastFpsT = now; }
    };
    raf = requestAnimationFrame(frame);
    return {
      kind: '2d', renderer: 'canvas-2d',
      get fps() { return fps; },
      stop() { cancelAnimationFrame(raf); },
    };
  }

  /* ── экспортируемая поверхность JS-core ── */
  return {
    CORE_VERSION,
    Module,
    createEmulatedFS,
    run,
    probeGL,
    startRenderLoop,
    parseLiblist,
    crc32,
    buildLaunchArgs,
    sanitizeDirName,
    collectResourceNames,
  };
});
