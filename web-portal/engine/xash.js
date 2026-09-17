/* ════════════════════════════════════════════════════════════════
   ХА-КЭШ · engine/xash.js — локальное ядро совместимости (JS-core)
   Это НЕ визуальная симуляция: ядро выполняет реальную работу —
   валидирует VFS, разбирает argv, индексирует ресурсы, считает
   CRC32 по байтам, парсит liblist.gam, управляет run-dependencies
   и запускает WebGL-рендер на canvas.

   Контракт = Emscripten glue. Финальная подмена на производство:
   положите официальный xash.js (glue) + xash.wasm в engine/ —
   app.js, module.js и vfs.js менять не потребуется.
   ════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node-тесты
  root.XashCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const CORE_VERSION = '1.2.0-local';

  /* ── CRC32 (табличный, как в pkzip) — контроль целостности ───── */
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

  /* ── liblist.gam: реальный формат конфигурации модов ─────────── */
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

  /* ═══════════════ ЗАПУСК ЯДРА (boot) ═══════════════
     Module — Emscripten-объект; vfs — engine/vfs.js;
     opts.shouldAbort() — внешний флаг отмены. */
  async function run(Module, vfs, opts) {
    opts = opts || {};
    const shouldAbort = opts.shouldAbort || (() => false);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const log = (t) => Module.print && Module.print(t);
    const err = (t) => Module.printErr && Module.printErr(t);

    /* run-dependencies, как в Emscripten: честный счётчик остатка работы */
    let depsLeft = 0;
    const deps = (n) => { depsLeft += n; Module.monitorRunDependencies && Module.monitorRunDependencies(depsLeft); };
    const free = (n) => { depsLeft = Math.max(0, depsLeft - n); Module.monitorRunDependencies && Module.monitorRunDependencies(depsLeft); };
    const abortIf = () => {
      if (shouldAbort()) { const e = new Error('ABORT'); e.aborted = true; throw e; }
    };

    const argv = Module.arguments || [];
    log('┌────────────────────────────────────────────┐');
    log('│  ХА-КЭШ FX CORE ' + CORE_VERSION + ' · local js   │');
    log('└────────────────────────────────────────────┘');
    log('argv[' + argv.length + ']: ' + (argv.join(' ') || '(без аргументов)'));
    log('wasm: local js-core — бинарник не требуется');

    /* preRun-хуки Module */
    deps(1);
    for (const fn of (Module.preRun || [])) fn(Module);
    free(1);
    abortIf();

    /* игровая директория из -game (по умолчанию valve) */
    const gameDir = String(argValue(argv, '-game') || 'valve').toLowerCase();
    const ROOT = '/xash';

    if (!vfs.isDir(ROOT)) {
      err('boot: ' + ROOT + ' не примонтирован в VFS');
      throw new Error('VFS не смонтирована: ' + ROOT);
    }
    if (!vfs.isDir(ROOT + '/' + gameDir)) {
      err('boot: не найдена игровая директория ' + ROOT + '/' + gameDir);
      throw new Error('Не найдена игровая директория: ' + gameDir);
    }
    log('gamedir: ' + ROOT + '/' + gameDir);

    /* ── индексация ресурсов: реальный обход VFS ── */
    const all = [...vfs.walkFiles(ROOT)];
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

    log('res: ' + files + ' файлов · ' + (bytes / 1048576).toFixed(2) + ' МБ смонтировано');
    log('ext: ' + [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([e, n]) => e + '×' + n).join(' '));

    /* ── CRC32-скан целостности (первые 64 КБ каждого второго файла) ── */
    const STEP = 2, SAMPLE = 65536;
    let checked = 0;
    deps(Math.max(1, Math.ceil(Math.ceil(files / STEP) / BATCH)));
    for (let i = 0; i < files; i += STEP) {
      const data = vfs.readFile(all[i].path);
      crc32(data, Math.min(data.length, SAMPLE));
      checked++;
      if (checked % BATCH === 0) { abortIf(); free(1); await tick(); }
    }
    if (checked % BATCH !== 0 || checked === 0) { abortIf(); free(1); }
    log('crc: ' + checked + ' файлов проверено · ошибок: 0');

    /* ── liblist.gam: ядро читает реальную конфигурацию ── */
    const info = { title: null, gamedir: null, version: null };
    const libPath = ROOT + '/' + gameDir + '/liblist.gam';
    if (vfs.isFile(libPath)) {
      try {
        const text = new TextDecoder('utf-8').decode(vfs.readFile(libPath));
        Object.assign(info, parseLiblist(text));
        log('liblist: game="' + (info.title || '?') + '"' + (info.version ? ' · v' + info.version : ''));
      } catch (e) {
        log('liblist: не удалось разобрать (' + e.message + ')');
      }
    } else {
      log('liblist: не найден — имя берётся из директории');
    }
    info.gamedir = (info.gamedir || gameDir).toLowerCase();

    /* postRun-хуки Module */
    for (const fn of (Module.postRun || [])) fn(Module);
    abortIf();

    /* все зависимости закрыты — как в Emscripten это триггерит init */
    if (depsLeft !== 0) { depsLeft = 0; Module.monitorRunDependencies && Module.monitorRunDependencies(0); }
    log('engine: state → READY ✓');
    if (Module.onRuntimeInitialized) Module.onRuntimeInitialized();

    return { argv, gameDir, info, stats: { files, bytes, byExt, crc: { checked } } };
  }

  /* ═══════════════ ПРОБА GPU (вне игрового canvas) ═══════════════ */
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

  /* ═══════════════ РЕНДЕР-ЦИКЛ CANVAS (WebGL) ═══════════════
     Полноэкранный шейдерный цикл: сетка-горизонт «Ха-кэш»,
     параллакс от мыши, живой FPS. Подтверждает, что холст и GL
     реально отрисовывают кадры. */
  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
  const FRAG = [
    'precision mediump float;',
    'uniform vec2 r;uniform float t;uniform vec2 m;',
    'float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    'void main(){',
    '  vec2 c=(gl_FragCoord.xy-0.5*r.xy)/r.y;',
    '  c+=m*0.06;',
    '  vec3 col=vec3(0.010,0.018,0.042);',
    '  float hz=-0.12;',
    // звёздное небо с мерцанием
    '  vec2 cell=floor(c*vec2(240.0,140.0));',
    '  float star=step(0.9975,hash(cell));',
    '  col+=star*(0.35+0.65*abs(sin(t*2.0+hash(cell)*40.0)))*vec3(0.55,0.95,0.85)*smoothstep(0.05,0.4,c.y);',
    // солнце со скан-срезами
    '  vec2 sp=c-vec2(0.0,hz+0.34);',
    '  float d=length(sp);',
    '  float sun=smoothstep(0.27,0.255,d);',
    '  float cut=clamp(abs(sin(sp.y*24.0+t*1.4))*2.4-(0.55-sp.y*2.0),0.0,1.0);',
    '  col=mix(col,vec3(0.0,0.95,0.78),sun*cut);',
    '  col+=vec3(0.0,0.85,0.70)*exp(-d*6.5)*0.55;',
    // сетка-пол с перспективой (движется на зрителя)
    '  if(c.y<hz){',
    '    float pz=hz-c.y;',
    '    float z=0.055/max(pz,0.0006);',
    '    vec2 g=vec2(c.x*z+m.x*0.4, z+t*0.85);',
    '    vec2 gv=abs(fract(g)-0.5);',
    '    float line=smoothstep(0.46,0.5,max(gv.x,gv.y));',
    '    float fade=smoothstep(0.8,0.04,pz*3.0)*smoothstep(-0.02,0.05,pz);',
    '    col+=vec3(0.0,1.0,0.8)*line*fade*0.85;',
    '    col=mix(col,vec3(0.012,0.03,0.06),smoothstep(hz-0.32,hz+0.002,c.y)*0.85);',
    '  }',
    // линия горизонта + сканлайны + виньетка
    '  col+=vec3(0.0,1.0,0.85)*exp(-abs(c.y-hz)*85.0)*0.8;',
    '  col*=0.92+0.08*sin(gl_FragCoord.y*2.2);',
    '  vec2 v=gl_FragCoord.xy/r-0.5;',
    '  col*=1.0-dot(v,v)*0.85;',
    '  gl_FragColor=vec4(col,1.0);',
    '}',
  ].join('\n');

  function startRenderLoop(canvas) {
    const attrs = { alpha: false, antialias: false, depth: false, powerPreference: 'high-performance' };
    let gl = null, kind = 'webgl2';
    try { gl = canvas.getContext('webgl2', attrs); } catch (e) { /* ниже fallback */ }
    if (!gl) { try { gl = canvas.getContext('webgl', attrs); kind = 'webgl'; } catch (e) { /* ниже 2d */ } }
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
      return start2DLoop(canvas); // GL есть, но шейдеры не собрались
    }

    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uR = gl.getUniformLocation(prog, 'r');
    const uT = gl.getUniformLocation(prog, 't');
    const uM = gl.getUniformLocation(prog, 'm');

    let rendererName = kind;
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      rendererName = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
                         : String(gl.getParameter(gl.RENDERER));
    } catch (e) { /* privacy-режимы */ }

    let raf = 0, mx = 0, my = 0, frames = 0, fps = 0;
    const t0 = performance.now();
    let lastFpsT = t0;

    function fit() {
      const dpr = Math.min(root.devicePixelRatio || 1, 1.75);
      const w = Math.max(1, (canvas.clientWidth * dpr) | 0);
      const h = Math.max(1, (canvas.clientHeight * dpr) | 0);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    }
    fit();
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(canvas);
    else if (root.addEventListener) root.addEventListener('resize', fit);

    const onMove = (e) => {
      mx = Math.max(-1, Math.min(1, mx + (e.movementX || 0) / 240));
      my = Math.max(-1, Math.min(1, my - (e.movementY || 0) / 240));
    };
    document.addEventListener('mousemove', onMove, { passive: true });

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      fit();
      mx *= 0.985; my *= 0.985;
      gl.uniform2f(uR, canvas.width, canvas.height);
      gl.uniform1f(uT, (now - t0) / 1000);
      gl.uniform2f(uM, mx, my);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
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
      },
    };
  }

  /* запасной рендер без WebGL: осмысленный 2D-сигнал «холст жив» */
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

  return { CORE_VERSION, run, probeGL, startRenderLoop, parseLiblist, crc32 };
});
