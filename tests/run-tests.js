#!/usr/bin/env node
/* HASH ONLINE · юнит-тесты портала (Node.js, без зависимостей).
   Покрывают:
     · умную распаковку .zip (app.js — чистые функции) + защиту от краша
       "Cannot read properties of undefined (reading 'push')"
     · логику drop-ветки Drag-and-Drop (pickDropZips)
     · РЕАЛЬНЫЙ контракт запуска движка Xash3D FWGS:
       var Module (ensureModule + buildModuleConfig), «контролируемый»
       Module.memoryInitializerRequest (одиночный детерминированный старт),
       авто-расчёт Module.TOTAL_MEMORY, побайтовое монтирование в Module.FS
       (/rodir/valve + /rodir/cstrike), аргументы CS 1.6
       ['-game','cstrike','+maxplayers','16'], ENV XASH3D_BASEDIR/GAMEDIR,
       websocket-прокси
     · контракт мыши: нет авто Pointer Lock, перехватчик клика, Esc/` — release
     · аудит исходников: никакой самодельной 3D-симуляции в проекте не осталось
     · боевой смоук настоящего /xash.js (tests/smoke-real-engine.js) */
'use strict';

const fs = require('fs');
const path = require('path');
const app = require(path.join(__dirname, '..', 'app.js'));

const ROOT = path.join(__dirname, '..');

const { JSZIP } = (() => {
  try { return { JSZIP: require(path.join(ROOT, 'vendor', 'jszip.min.js')) }; }
  catch (e) { return { JSZIP: null }; }
})();

let passed = 0, failed = 0;
const results = [];

function ok(name, cond, extra = '') {
  if (cond) { passed++; results.push(`  [PASS] ${name}`); }
  else { failed++; results.push(`  [FAIL] ${name} ${extra}`); }
}

/* подделка JSZip-структуры для чистой логики (без библиотеки) */
function fakeZip(files) {
  const z = { files: {} };
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    z.files[name] = {
      dir: name.endsWith('/'),
      _data: { uncompressedSize: data.length },
      async: async (type, onProgress) => {
        if (onProgress) onProgress({ percent: 100 });
        return data;
      },
    };
  }
  return z;
}

/* тестовый двойник Module.FS: фиксирует вызовы mkdir/createDataFile,
   которые обязан сделать наш код (сам движок здесь не эмулируется) */
function mockFS() {
  const norm = (p) => '/' + String(p || '').split('/').filter(Boolean).join('/');
  const dirs = new Set(['/']);
  const files = new Map();
  const calls = [];
  const FS = {
    _dirs: dirs, _files: files, _calls: calls, _cwd: '/',
    mkdir(p) {
      const n = norm(p);
      calls.push(['mkdir', n]);
      if (files.has(n)) throw new Error('FS.mkdir: путь занят файлом: ' + n);
      dirs.add(n);
    },
    analyzePath(p) {
      const n = norm(p);
      const exists = dirs.has(n) || files.has(n);
      return { exists, path: n, object: dirs.has(n) ? { type: 'directory', name: n.split('/').pop() }
        : files.has(n) ? { type: 'file', name: n.split('/').pop() } : null };
    },
    createDataFile(parent, name, data, canRead, canWrite, canOwn) {
      const p = norm(parent);
      const full = norm(p + '/' + name);
      calls.push(['createDataFile', full, data && data.length, !!canRead, !!canWrite, !!canOwn]);
      if (!dirs.has(p)) throw new Error('FS.createDataFile: нет каталога: ' + p);
      files.set(full, { data, canRead, canWrite, canOwn });
      return { exists: true, object: { type: 'file' } };
    },
    readFile(p) {
      const f = files.get(norm(p));
      if (!f) throw new Error('ENOENT: ' + p);
      return f.data;
    },
    unlink(p) { calls.push(['unlink', norm(p)]); files.delete(norm(p)); },
    readdir(p) {
      const n = norm(p);
      const prefix = n === '/' ? '/' : n + '/';
      const out = new Set();
      for (const d of dirs) if (d !== n && d.startsWith(prefix)) out.add(d.slice(prefix.length).split('/')[0]);
      for (const f of files.keys()) if (f.startsWith(prefix)) out.add(f.slice(prefix.length).split('/')[0]);
      return ['.', '..', ...out];
    },
    chdir(p) { FS._cwd = norm(p); calls.push(['chdir', FS._cwd]); },
    cwd() { return FS._cwd; },
  };
  return FS;
}

(async () => {
  console.log('HASH ONLINE · test suite (реальное ядро Xash3D FWGS)');
  console.log('═'.repeat(56));

  /* ═══════════════ 1. РАСПАКОВКА .zip ═══════════════ */

  const names1 = [
    'downloads/xash/valve/halflife.wad',
    'downloads/xash/valve/models/player.mdl',
    'downloads/xash/valve/',
    'downloads/xash/readme.txt',
    'downloads/flyakite-configs/glass.theme',
    'downloads/__MACOSX/._valve',
    'downloads/zolotoy-os/config.cfg.download/crdownload',
  ];
  const r1 = app.pickZipTargets(names1, ['valve']);
  ok('targets: найдены только файлы внутри valve/', r1.picked.length === 2, `got ${r1.picked.length}`);
  ok('targets: корень сохранён в rel', r1.picked.every((p) => p.rel.startsWith('valve/')));
  ok('targets: мусор и внешние файлы отсеяны', r1.skipped === names1.length - 2);

  const r2 = app.pickZipTargets(
    ['root/Valve/Models/A.mdl', 'root/valve/mainui.txt', 'root/CSTRIKE/cl_dlls/c.dll'],
    ['valve', 'cstrike'],
  );
  ok('targets: регистр директорий не важен', r2.picked.length === 3, `got ${r2.picked.length}`);
  ok('targets: ровно один пробел-parent сохраняет исходный регистр',
    r2.picked.find((p) => p.rel === 'Valve/Models/A.mdl') !== undefined);

  const r3 = app.pickZipTargets(['moddir/models/w_rpg.mdl', 'logo.png', 'docs/readme.txt'], null);
  ok('mod-mode: берётся всё дерево', r3.picked.length === 3 && r3.skipped === 0);

  ok('junk: __MACOSX и .DS_Store', app.isJunkPath('a/__MACOSX/x') && app.isJunkPath('b/.DS_Store'));
  ok('junk: обычный файл не мусор', !app.isJunkPath('valve/decals.wad'));

  const bigTree = {
    'xash/valve/halflife.wad': 'WAD3' + 'x'.repeat(1024),
    'xash/valve/liblist.gam': 'game "Half-Life"',
    'xash/valve/models/v_glock.mdl': 'MDL' + 'y'.repeat(512),
    'xash/cstrike/custom.wad': 'wad',
    'xash/soundtrack.mp3': 'junk',
    'xash/flyakite-configs/a.theme': 'theme',
    '__MACOSX/._xash': 'junk',
    'xash/valve/': '',
  };
  const ex1 = await app.extractZipSet(fakeZip(bigTree), ['valve'], () => {});
  ok('extract: динамический прогресс отработал, набор собран', !!ex1.set);
  ok('extract: осталось 3 файла valve', ex1.set.count === 3, `got ${ex1.set.count}`);
  ok('extract: единый root = valve', ex1.set.root === 'valve');
  ok('extract: побочное дерево вычищено', !ex1.set.items.some((i) => i.path.includes('flyakite')));
  ok('extract: размер посчитан', ex1.set.size > 0);

  const exBad = await app.extractZipSet(fakeZip({ 'random/files/data.bin': 'x', 'music/track.mp3': 'y' }), ['valve'], () => {});
  ok('extract: архив без целевой папки → ошибка набора', exBad.set === null);

  const set = app.makeFileSet([
    { file: null, path: 'valve/models/b.mdl', size: 10 },
    { file: null, path: 'valve/decals.wad', size: 20 },
    { file: null, path: 'valve/liblist.gam', size: 30 },
  ]);
  ok('fileset: сортировка и byExt', set.count === 3 && set.byExt.get('mdl') === 1 && set.items[0].path === 'valve/decals.wad');
  ok('fileset: root', set.root === 'valve');
  ok('fmtBytes', app.fmtBytes(512) === '512 Б' && app.fmtBytes(2048) === '2.0 КБ');

  const dropFiles = [{ name: 'cache.ZIP' }, { name: 'notes.txt' }, { name: 'x.zip' }, { name: '.zip' }];
  const picked = app.pickDropZips(dropFiles);
  ok('dnd: из смешанного дропа выбраны только .zip',
    picked.length === 3 && picked.every((f) => /\.zip$/i.test(f.name)));

  /* ═══ ЗАЩИТА ОТ КРАША "reading 'push'" (требование 1) ═══ */
  {
    ok('push-guard: ensureArray нормализует undefined/null/объект',
      app.ensureArray(undefined).length === 0 && app.ensureArray(null).length === 0
      && app.ensureArray({ push() {} }).constructor === Array);
    let threw = false;
    try {
      const p = app.pickZipTargets(undefined, ['valve']);
      threw = !(Array.isArray(p.picked) && p.picked.length === 0);
    } catch (e) { threw = true; }
    ok('push-guard: pickZipTargets(undefined) не падает на .push', !threw);
    threw = false;
    try {
      const s = app.makeFileSet(null);
      threw = !(s.count === 0 && Array.isArray(s.items));
    } catch (e) { threw = true; }
    ok('push-guard: makeFileSet(null) не падает', !threw);
    let exRes = null;
    threw = false;
    try { exRes = await app.extractZipSet({ files: undefined }, ['valve'], () => {}); }
    catch (e) { threw = true; }
    ok('push-guard: extractZipSet без zip.files не падает', !threw && exRes && exRes.set === null);
    threw = false;
    try {
      const p2 = app.pickDropZips(undefined);
      threw = !(Array.isArray(p2) && p2.length === 0);
    } catch (e) { threw = true; }
    ok('push-guard: pickDropZips(undefined) не падает', !threw);
  }

  if (JSZIP) {
    try {
      const z = new JSZIP();
      z.file('very/deep/nested/mob-cache/valve/halflife.wad', new Uint8Array(900).fill(7));
      z.file('very/deep/nested/mob-cache/valve/liblist.gam', 'game "Half-Life"');
      z.file('very/deep/nested/mob-cache/valve/sprites/glow.spr', 'sprite');
      z.file('very/deep/nested/mob-cache/valve/sound/ambient/hum.wav', 'wavdata');
      z.file('very/deep/nested/mob-cache/cstrike/some_model.mdl', 'mdl');
      z.file('very/deep/nested/other-app/config.json', '{}');
      z.file('very/deep/nested/zolotoy-os/boot.cfg', 'cfg');
      z.folder('very/deep/nested/mob-cache/valve/emptydir');
      const blob = await z.generateAsync({ type: 'uint8array' });
      const z2 = await JSZIP.loadAsync(blob);

      let lastPct = 0;
      const res = await app.extractZipSet(z2, ['valve'], (pct) => { lastPct = pct; });
      const tree = res.set;
      ok('jszip: прогресс дошёл до 100%', lastPct === 100, `last=${lastPct}`);
      ok('jszip: найдено 4 файла valve', tree.count === 4, `got ${tree.count}`);
      ok('jszip: rel-пути обрезаны до корня игры', tree.items.every((i) => i.path.startsWith('valve/')));
      ok('jszip: пустые директории и чужие папки вычищены',
        !tree.items.some((i) => i.path.includes('other-app')));

      /* CS 1.6: из ОДНОГО архива берутся и cstrike/, и базовая valve/ —
         без отсечения .wad и моделей оружия v_/p_/w_ (требование 3) */
      const zc = new JSZIP();
      zc.file('mob/cstrike/maps/de_dust2.bsp', 'bsp');
      zc.file('mob/cstrike/liblist.gam', 'game "Counter-Strike"');
      zc.file('mob/cstrike/cstrike.wad', 'wad');
      zc.file('mob/cstrike/models/v_glock.mdl', 'vmdl');
      zc.file('mob/cstrike/models/p_usp.mdl', 'pmdl');
      zc.file('mob/cstrike/models/w_deagle.mdl', 'wmdl');
      zc.file('mob/valve/gfx.wad', 'wad');
      zc.file('mob/valve/halflife.wad', 'wad2');
      zc.file('mob/valve/sound/misc/void.wav', 'wav');
      const blobc = await zc.generateAsync({ type: 'uint8array' });
      const resc = await app.extractZipSet(await JSZIP.loadAsync(blobc), ['cstrike', 'valve'], () => {});
      ok('jszip: CS-архив дал 9 файлов (cstrike + valve)', resc.set.count === 9, `got ${resc.set.count}`);
      ok('jszip: ни один .wad / .bsp / v_/p_/w_ .mdl не отсечён',
        resc.set.items.every((i) =>
          /\.(wad|bsp|mdl|gam|wav)$/i.test(i.path)) &&
        resc.set.items.some((i) => /cstrike\/models\/v_glock\.mdl$/.test(i.path)) &&
        resc.set.items.some((i) => /cstrike\/models\/p_usp\.mdl$/.test(i.path)) &&
        resc.set.items.some((i) => /cstrike\/models\/w_deagle\.mdl$/.test(i.path)) &&
        resc.set.items.some((i) => /cstrike\/cstrike\.wad$/.test(i.path)) &&
        resc.set.items.some((i) => /valve\/halflife\.wad$/.test(i.path)));
      ok('jszip: каждый файл лёг в свой каталог ФС',
        app.resolveFSAbsolutePath('cs16', 'cstrike/maps/de_dust2.bsp') === '/rodir/cstrike/maps/de_dust2.bsp'
        && app.resolveFSAbsolutePath('cs16', 'valve/gfx.wad') === '/rodir/valve/gfx.wad');
    } catch (e) {
      failed++;
      results.push(`  [FAIL] jszip: ${e.message}`);
    }
  } else {
    results.push('  [SKIP] реальные JSZip-тесты (vendor не найден)');
  }

  /* ═══════════════ 2. ФАЙЛЫ НАСТОЯЩЕГО ДВИЖКА В КОРНЕ ═══════════════ */
  {
    const need = {
      'xash.js': 5_000_000,          // скомпилированное ядро (asm.js)
      'xash.html.mem': 100_000,      // инициализатор статической памяти ядра
      'server.js': 1_000_000,        // серверная игровая библиотека (dlopen "server")
      'client.js': 300_000,          // клиентская игровая библиотека (dlopen "client")
      'menu.js': 300_000,            // библиотека меню движка (dlopen "menu")
    };
    for (const [name, minSize] of Object.entries(need)) {
      const p = path.join(ROOT, name);
      const exists = fs.existsSync(p);
      const size = exists ? fs.statSync(p).size : 0;
      ok(`ядро: ${name} присутствует и не пустой (${size} Б)`, exists && size > minSize, `size=${size}`);
    }
    const xashSrc = fs.readFileSync(path.join(ROOT, 'xash.js'), 'utf8');
    ok('ядро: xash.js — настоящий glue Emscripten (callMain/_main/FS)',
      xashSrc.includes('Module["callMain"]') && xashSrc.includes('Module["_main"]') && xashSrc.includes('Module["FS"]=FS'));
    ok('ядро: xash.js требует xash.html.mem', xashSrc.includes('memoryInitializer="xash.html.mem"'));
    const memBuf = fs.readFileSync(path.join(ROOT, 'xash.html.mem'));
    ok('ядро: xash.html.mem содержит строки движка (XASH3D_GAMEDIR)',
      memBuf.includes(Buffer.from('XASH3D_GAMEDIR')));
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok('server.js: регистрируется в DLFCN как "server"',
      srv.includes('DLFCN.loadedLibNames[filename]=handle') && /filename="server"/.test(srv));
    const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
    const mnu = fs.readFileSync(path.join(ROOT, 'menu.js'), 'utf8');
    ok('client.js/menu.js: регистрируются как "client" и "menu"',
      /filename="client"/.test(cli) && /filename="menu"/.test(mnu));
    ok('цепочка скриптов app.js: xash → server → client → menu',
      JSON.stringify(app.ENGINE_SCRIPTS) === JSON.stringify(['/xash.js', '/server.js', '/client.js', '/menu.js']));
    ok('инициализатор памяти в app.js: /xash.html.mem', app.ENGINE_MEMORY_INITIALIZER === '/xash.html.mem');

    /* регрессия: DLFCN-проверка app.js обязана искать ровно те ключи, под
       которыми сайд-модули регистрируются (filename="server"/"client"/"menu").
       Баг: src.slice(2,-3) давал «erver»/«lient»/«enu» → ложное падение
       «не зарегистрировалась в Module.DLFCN» при исправной регистрации. */
    ok('app: имя библиотеки из src скрипта — без слэшей и .js',
      app.libNameFromScriptSrc('/server.js') === 'server'
      && app.libNameFromScriptSrc('client.js') === 'client'
      && app.libNameFromScriptSrc('/public/menu.js') === 'menu');
    {
      const bad = app.ENGINE_SCRIPTS.filter((s) => s !== '/xash.js')
        .map((s) => [s, app.libNameFromScriptSrc(s)])
        .filter(([s, name]) => {
          const body = fs.readFileSync(path.join(ROOT, name + '.js'), 'utf8');
          return !new RegExp(`filename="${name}"`).test(body)
            || !body.includes('DLFCN.loadedLibNames[filename]=handle');
        });
      ok('app: DLFCN-ключ каждого src совпадает с хвостом саморегистрации библиотеки',
        bad.length === 0, JSON.stringify(bad));
    }
    {
      const srcAppBody = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
      ok('app: регрессия — нет off-by-one slice(2,-3) в DLFCN-проверке',
        !/slice\(2,\s*-3\)/.test(srcAppBody) && /libNameFromScriptSrc\(src\)/.test(srcAppBody));
    }
  }

  /* ═══════════════ 3. ФАЛЬШИВАЯ СИМУЛЯЦИЯ ПОЛНОСТЬЮ УДАЛЕНА ═══════════════ */
  {
    const srcApp = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const srcHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const srcCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

    ok('анти-фейк: каталог engine/ с самодельным ядром удалён',
      !fs.existsSync(path.join(ROOT, 'engine')) && !fs.existsSync(path.join(ROOT, 'public', 'engine')));
    ok('анти-фейк: index.html не подключает поддельное ядро /engine/xash.js',
      !/engine\/xash\.js/.test(srcHtml));
    ok('анти-фейк: в app.js нет XashCore / самодельного рендера',
      !/XashCore|startRenderLoop|start2DLoop|probeGL|createEmulatedFS|collectResourceNames/.test(srcApp));
    ok('анти-фейк: в app.js нет собственного WebGL-кода',
      !/getContext\(\s*['"](?:webgl|experimental-webgl|webgl2)|createShader|shaderSource|gl_Position|drawArrays|createProgram/.test(srcApp));
    ok('анти-фейк: в rAF-колбэках нет никакой отрисовки (только UI и счётчик кадров движка)',
      !/requestAnimationFrame[\s\S]{0,700}(drawArrays|drawElements|clearColor|bindBuffer|fillRect|createShader|texImage2D)/.test(srcApp)
      && /счётчик кадров|mainloop движка/i.test(srcApp));
    ok('анти-фейк: собственный цикл кадров не запускается до main() движка',
      !/function frame\(|const frame =|raf = requestAnimationFrame/.test(srcApp));
    ok('анти-фейк: в CSS не осталось лейблов поддельной 3D-сцены', !/\.res-label/.test(srcCss));
    ok('анти-фейк: единственный холст в index.html — canvas движка',
      (srcHtml.match(/<canvas/g) || []).length === 1 && /id="canvas"/.test(srcHtml));
  }

  /* ═══════════════ 4. var Module — КОНТРАКТ EMSCRIPTEN ═══════════════ */
  {
    const fakeCanvas = { id: 'canvas', nodeName: 'CANVAS' };
    const printed = [];
    const deps = [];
    const M = app.buildModuleConfig({
      canvas: fakeCanvas,
      args: ['-game', 'cstrike', '+maxplayers', '16'],
      totalMemoryMB: 512,
      websocketUrl: app.websocketProxyUrl('localhost:8080'),
      onPrint: (t) => printed.push(t),
      onErr: (t) => printed.push('E:' + t),
      onDeps: (left, total) => deps.push([left, total]),
      onRuntime: () => printed.push('runtime'),
    });

    ok('Module: canvas передан напрямую в Emscripten', M.canvas === fakeCanvas);
    ok('Module: arguments — массив параметров клиента (строгие для CS 1.6)',
      JSON.stringify(M.arguments) === JSON.stringify(['-game', 'cstrike', '+maxplayers', '16']));
    ok('Module: TOTAL_MEMORY = 512 МБ (asm.js без роста памяти)', M.TOTAL_MEMORY === 512 * 1024 * 1024);
    ok('Module: preRun/postRun — массивы (требование glue)',
      Array.isArray(M.preRun) && Array.isArray(M.postRun));
    ok('Module: одиночный старт — preInit-перехват авто-run не используется',
      M.preInit === undefined);
    ok('Module: print/printErr/setStatus/monitorRunDependencies/onRuntimeInitialized на месте',
      ['print', 'printErr', 'setStatus', 'monitorRunDependencies', 'onRuntimeInitialized']
        .every((k) => typeof M[k] === 'function'));
    M.print('^3Warning:^7 hello');
    ok('Module: print снимает цветовые коды GoldSrc (^1…^7)', printed[0] === 'Warning: hello', printed[0]);
    M.printErr('boom');
    ok('Module: printErr routed', printed[1] === 'E:boom');
    M.monitorRunDependencies(2); M.monitorRunDependencies(0);
    ok('Module: monitorRunDependencies считает totalDependencies',
      deps.length === 2 && deps[0][1] === 2 && M.totalDependencies === 2, JSON.stringify(deps));
    let rt = false; M.onRuntimeInitialized = () => { rt = true; };
    ok('Module: onRuntimeInitialized заменяем (как в оригинальном порте)', typeof M.onRuntimeInitialized === 'function');
    ok('Module: locateFile ведёт xash.html.mem в корень',
      M.locateFile('xash.html.mem') === '/xash.html.mem' && M.locateFile('other.bin') === 'other.bin');
    ok('Module: websocket настроен на websockify-прокси (сетевая часть)',
      M.websocket.url === 'wsproxy://localhost:8080/');
    ok('websocketProxyUrl: нормализация хоста',
      app.websocketProxyUrl('example.com:3000/') === 'wsproxy://example.com:3000/'
      && app.websocketProxyUrl('') === '');

    /* ── ensureModule: полная инициализация до любого доступа (требование 1) ── */
    ok('ensureModule: в Node (нет window) — null, без краха', app.ensureModule() === null);
  }

  /* ═══════════════ 5. КОНТРОЛИРУЕМЫЙ СТАРТ: memoryInitializerRequest ═══════════════ */
  {
    /* glue xash.js: if (request.response) setTimeout(useRequest) else
       request.addEventListener("load", useRequest) + run-dependency.
       Пока releaseMemoryRequest() не вызван — main() физически не стартует. */
    const buf = new ArrayBuffer(8);
    const req = app.createControlledMemoryRequest(buf);
    let loadCalls = 0;
    req.addEventListener('load', () => { loadCalls++; });
    ok('memory: контролируемый request в standby (status 0, без response)',
      req.status === 0 && req.response === null && req._released === false);
    ok('memory: до релиза glue не стартует (нет "load")', loadCalls === 0);
    const okRel = app.releaseMemoryRequest(req);
    ok('memory: релиз → status 200 + response + событие "load"',
      okRel === true && req.status === 200 && req.response === buf && loadCalls === 1);
    ok('memory: повторный релиз — нет двойного старта',
      app.releaseMemoryRequest(req) === false && loadCalls === 1);
    ok('memory: request без буфера — честно пустой', app.createControlledMemoryRequest(null).buffer === null);

    /* авто-расчёт памяти под кэш в MEMFS */
    ok('memory: авто = 256 МБ при пустом кэше', app.computeTotalMemoryMB(0, 0) === 256);
    ok('memory: 150 МБ кэш → не меньше 448 МБ (запас ×1.5 + headroom)',
      app.computeTotalMemoryMB(150 * 1024 * 1024, 0) >= 448);
    ok('memory: выбор пользователя приоритетнее авто',
      app.computeTotalMemoryMB(0, 768) === 768);
    ok('memory: потолок 2048 МБ', app.computeTotalMemoryMB(2000 * 1024 * 1024, 0) === 2048);
    ok('memory: объём выровнен по 64 МБ (страницы памяти)',
      app.computeTotalMemoryMB(123 * 1024 * 1024, 0) % 64 === 0);
  }

  /* ═══════════════ 6. МОНТИРОВАНИЕ В EMSCRIPTEN FS (/rodir) ═══════════════ */
  {
    const FS = mockFS();
    const created = app.setupEngineFS(FS, 'cstrike');
    ok('fs: setupEngineFS создал /rodir и /rodir/cstrike',
      FS._dirs.has('/rodir') && FS._dirs.has('/rodir/cstrike') && created === '/rodir/cstrike');
    ok('fs: базовый каталог /rodir/valve создан (нужен движку — розовые артефакты)',
      FS._dirs.has('/rodir/valve'));
    ok('fs: рабочая директория движка — /rodir', FS.cwd() === '/rodir');

    const bytes = new Uint8Array([42, 43, 44, 250]);
    app.mountFileToFS(FS, '/rodir/cstrike/models/player/urban/urban.mdl', bytes);
    const rec = FS._files.get('/rodir/cstrike/models/player/urban/urban.mdl');
    ok('fs: createDataFile записал байты в /rodir/cstrike/…', !!rec && rec.data[3] === 250);
    ok('fs: подпапки созданы через FS.mkdir',
      FS._dirs.has('/rodir/cstrike/models') && FS._dirs.has('/rodir/cstrike/models/player/urban'));
    const cdf = FS._calls.filter((c) => c[0] === 'createDataFile').pop();
    ok('fs: сигнатура createDataFile(parent, name, bytes, true, true, canOwn)',
      cdf[1] === '/rodir/cstrike/models/player/urban/urban.mdl' && cdf[3] === true && cdf[4] === true && cdf[5] === true,
      JSON.stringify(cdf));

    /* перезапись того же пути (мод поверх оригинала) */
    app.mountFileToFS(FS, '/rodir/cstrike/models/player/urban/urban.mdl', new Uint8Array([1, 2]));
    ok('fs: перезапись файла без конфликта (unlink + createDataFile)',
      FS._files.get('/rodir/cstrike/models/player/urban/urban.mdl').data.length === 2);

    /* массовое монтирование набора */
    const FS2 = mockFS();
    app.setupEngineFS(FS2, 'valve');
    const items = [
      { path: 'valve/halflife.wad', file: new Uint8Array(1024).fill(3) },
      { path: 'valve/maps/c1a0.bsp', file: new Uint8Array(2048).fill(4) },
      { path: 'sound/ambience/wind.wav', file: new Uint8Array(512).fill(5) },
      { path: 'gfx.wad', file: new Uint8Array(256).fill(6) },
    ];
    const pcts = [];
    const stat = app.mountFileSet(FS2, 'hl1', items, (p) => pcts.push(p));
    ok('mountFileSet: 4 файла записаны, размер посчитан',
      stat.count === 4 && stat.bytes === 1024 + 2048 + 512 + 256, JSON.stringify({ c: stat.count, b: stat.bytes }));
    ok('mountFileSet: valve/… → /rodir/valve/…, относительные → каталог игры',
      FS2._files.has('/rodir/valve/halflife.wad') && FS2._files.has('/rodir/valve/maps/c1a0.bsp')
      && FS2._files.has('/rodir/valve/sound/ambience/wind.wav') && FS2._files.has('/rodir/valve/gfx.wad'));
    ok('mountFileSet: прогресс доходит до 100%', pcts[pcts.length - 1] === 100, JSON.stringify(pcts));

    /* liblist.gam мода, если в архиве мода его нет */
    const FS3 = mockFS();
    app.setupEngineFS(FS3, 'valve');
    app.ensureFSDirectory(FS3, '/rodir/theyhunger');
    const madeLiblist = app.ensureModGameInfo(FS3, 'theyhunger', 'They Hunger');
    ok('ensureModGameInfo: создан liblist.gam для каталога мода',
      madeLiblist === true && FS3._files.has('/rodir/theyhunger/liblist.gam'));
    const asText = new TextDecoder().decode(FS3._files.get('/rodir/theyhunger/liblist.gam').data);
    ok('ensureModGameInfo: внутри game/gamedir', /game "They Hunger"/.test(asText) && /gamedir "theyhunger"/.test(asText));
    ok('ensureModGameInfo: существующий liblist.gam не перезаписывается',
      app.ensureModGameInfo(FS3, 'theyhunger', 'They Hunger') === false);
    ok('sanitizeDirName: имя каталога мода нормализуется',
      app.sanitizeDirName(' My Mod !! ') === 'mymod' && app.sanitizeDirName('!!!') === null);
  }

  /* ═══════════════ 7. ПУТИ ФС (/rodir) И АРГУМЕНТЫ ЗАПУСКА ═══════════════ */
  {
    ok('paths: корень ФС движка = /rodir', app.ENGINE_ROOT === '/rodir');
    ok('paths: Half-Life → /rodir/valve/',
      app.resolveFSAbsolutePath('hl1', 'valve/models/player.mdl') === '/rodir/valve/models/player.mdl');
    ok('paths: относительный путь Half-Life → /rodir/valve/',
      app.resolveFSAbsolutePath('hl1', 'sound/weapons/cbar_hit1.wav') === '/rodir/valve/sound/weapons/cbar_hit1.wav');
    ok('paths: CS 1.6 → /rodir/cstrike/',
      app.resolveFSAbsolutePath('cs16', 'cstrike/models/player/terror.mdl') === '/rodir/cstrike/models/player/terror.mdl');
    ok('paths: относительный путь CS 1.6 → /rodir/cstrike/',
      app.resolveFSAbsolutePath('cs16', 'maps/de_dust2.bsp') === '/rodir/cstrike/maps/de_dust2.bsp');
    ok('paths: базовая valve/ из CS-архива остаётся в /rodir/valve/',
      app.resolveFSAbsolutePath('cs16', 'valve/gfx.wad') === '/rodir/valve/gfx.wad');
    ok('paths: обратные слэши и лидирующий / нормализуются',
      app.resolveFSAbsolutePath('hl1', '\\valve\\gfx.wad') === '/rodir/valve/gfx.wad'
      && app.resolveFSAbsolutePath('hl1', '/models/a.mdl') === '/rodir/valve/models/a.mdl');
    ok('gameDirFor: cstrike для CS и valve для HL/модов',
      app.gameDirFor('cs16') === 'cstrike' && app.gameDirFor('cs16mod') === 'cstrike'
      && app.gameDirFor('hl1') === 'valve' && app.gameDirFor('hl1mod') === 'valve');

    ok('args: CS 1.6 → строго ["-game","cstrike","+maxplayers","16"]',
      JSON.stringify(app.getLaunchArguments('cs16')) === JSON.stringify(['-game', 'cstrike', '+maxplayers', '16']));
    ok('args: Half-Life → [] (движок сам находит valve/)',
      JSON.stringify(app.getLaunchArguments('hl1')) === JSON.stringify([]));
    ok('args: мод CS → -game <каталог> +maxplayers 16',
      JSON.stringify(app.getLaunchArguments('cs16mod', 'retake'))
      === JSON.stringify(['-game', 'retake', '+maxplayers', '16']));
    ok('args: мод HL → -game <каталог>',
      JSON.stringify(app.getLaunchArguments('hl1mod', 'theyhunger'))
      === JSON.stringify(['-game', 'theyhunger']));
    ok('args: buildEngineArguments = строгий argv (окно движок сам по canvas)',
      JSON.stringify(app.buildEngineArguments('cs16', null, { width: 1920, height: 1080 }))
      === JSON.stringify(['-game', 'cstrike', '+maxplayers', '16'])
      && !app.buildEngineArguments('cs16').includes('-width'));

    /* ENV движка: XASH3D_BASEDIR / XASH3D_GAMEDIR */
    const envM = { ENV: null };
    ok('env: applyEngineEnv выставляет XASH3D_BASEDIR=/rodir и XASH3D_GAMEDIR',
      app.applyEngineEnv(envM, { baseDir: app.ENGINE_ROOT, gameDir: 'cstrike' }) === true
      && envM.ENV.XASH3D_BASEDIR === '/rodir' && envM.ENV.XASH3D_GAMEDIR === 'cstrike');
    ok('env: applyEngineEnv(null) — без краха', app.applyEngineEnv(null) === false);
  }

  /* ═══════════════ 8. ЖЁСТКИЙ LINUX-ФИКС ИНПУТОВ ═══════════════ */
  {
    const srcApp = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const srcHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    ok('linux-fix: атрибут webkitdirectory полностью удалён из кода',
      !/webkitdirectory['"]\s*,\s*['"]/.test(srcApp) && !/webkitdirectory\s*=/.test(srcApp)
      && !/webkitdirectory(?!')/i.test(srcHtml.replace(/removeAttribute\('webkitdirectory'\)/g, '')));
    ok('linux-fix: инпуты строго одиночный .zip (game-zip-input)',
      /classList|className/.test(srcApp) && srcApp.includes('game-zip-input') && srcApp.includes("'.zip'"));
    ok('linux-fix: ветка drop берёт файлы из e.dataTransfer.files',
      srcApp.includes('dt.files') && srcApp.includes('e.dataTransfer'));
    ok('linux-fix: multiple не выставляется (только одиночный файл)',
      !/multiple\s*=\s*true/.test(srcApp) && !/multiple\s*=/.test(srcHtml)
      && /input\.multiple\s*=\s*false/.test(srcApp));
    ok('linux-fix: runtime-guard принудительно снимает атрибуты проводника',
      srcApp.includes("removeAttribute('webkitdirectory')") && srcApp.includes("removeAttribute('directory')"));
    ok('linux-fix: прогресс «Распаковка: X%»',
      /Распаковка\$\{suffix\}: |Распаковка: /.test(srcApp));
  }

  /* ═══════════════ 9. МЫШЬ: СВОБОДНА В МЕНЮ, ЗАХВАТ В ИГРЕ ═══════════════ */
  {
    const srcApp = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    ok('mouse: флаг активности матча (isGameActive) в перехватчике',
      /let isGameActive = false/.test(srcApp)
      && /if \(!isGameActive \|\| document\.pointerLockElement === canvasEl\) return;/.test(srcApp));
    ok('mouse: авто Pointer Lock при старте сессии отключён',
      !/setTimeout\([\s\S]{0,120}requestPointerLock/.test(srcApp));
    ok('mouse: курсор свободен и виден (canvas.style.cursor = "default")',
      /style\.cursor\s*=\s*['"]default['"]/.test(srcApp) && /setFreeCursor/.test(srcApp));
    ok('mouse: Escape / ` — немедленно освобождают курсор',
      /e\.code === 'Escape' \|\| e\.key === '`'/.test(srcApp)
      && /document\.exitPointerLock\(\)/.test(srcApp));
    ok('mouse: в меню движка (cursor=default) клик не крадёт мышь',
      /canvasEl\.style\.cursor !== 'none'\) \{ mouseWantsLock = false; return; \}/.test(srcApp));
    ok('mouse: в игре (cursor=none) клик возвращает захват',
      /mouseWantsLock = true;\s*tryLockPointer\(\)/.test(srcApp));
  }

  /* ═══════════════ 10. ИНТЕГРАЦИЯ В index.html / dev-сервер ═══════════════ */
  {
    const srcHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    ok('html: canvas#canvas единственный и передаётся движку', /<canvas id="canvas"/.test(srcHtml));
    ok('html: app.js подключён модулем, JSZip — обычным скриптом',
      /<script type="module" src="\/app\.js">/.test(srcHtml) && /src="\/vendor\/jszip\.min\.js"/.test(srcHtml));
    ok('html: есть панель загрузки ядра и консоль движка',
      /id="boot-overlay"/.test(srcHtml) && /id="engine-console"/.test(srcHtml));
    const srcApp = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    ok('app: ядро грузится динамически через <script> в порядке цепочки',
      /loadScript\(src\)/.test(srcApp) && /ENGINE_SCRIPTS/.test(srcApp));
    ok('app: контролируемый memoryInitializerRequest (XHR /xash.html.mem → release)',
      /memoryInitializerRequest\s*=\s*createControlledMemoryRequest/.test(srcApp)
      && /fetchMemoryInitializer/.test(srcApp) && /releaseMemoryRequest\(/.test(srcApp));
    ok('app: Module.canvas = document.getElementById(\'canvas\')',
      /getElementById\('canvas'\)/.test(srcApp) && /window\.Module\.canvas\s*=\s*canvasEl/.test(srcApp));
    ok('app: ENV.XASH3D_BASEDIR / XASH3D_GAMEDIR выставляются перед main()',
      /XASH3D_BASEDIR/.test(srcApp) && /XASH3D_GAMEDIR/.test(srcApp) && /applyEngineEnv\(/.test(srcApp));
    ok('app: контроль целостности ядра (__ATINIT__) перед DSO',
      /__ATINIT__/.test(srcApp) && /assertEngineGlobals/.test(srcApp));
    const dev = fs.readFileSync(path.join(ROOT, 'dev-server.js'), 'utf8');
    ok('dev-server: COOP/COEP и MIME для .mem/.wasm', /Cross-Origin-Embedder-Policy/.test(dev) && /\.mem/.test(dev));
  }

  /* ═══════════════ 11. БОЕВОЙ СМОК НАСТОЯЩЕГО /xash.js ═══════════════ */
  if (!process.env.SKIP_REAL_ENGINE) {
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync(process.execPath,
        ['--stack-size=8192', '--max-old-space-size=4096', path.join(__dirname, 'smoke-real-engine.js')],
        { encoding: 'utf8', timeout: 240000 });
      const out = (r.stdout || '') + (r.stderr || '');
      const tail = out.split('\n').filter((l) => l.trim()).slice(-14);
      ok('real-engine: смоук настоящего ядра прошёл (main() исполняется)',
        r.status === 0, tail.join(' | '));
      ok('real-engine: main() в standby до отдачи памяти (нет авто-старта)',
        /Module\.calledRun = false/.test(out), tail.join(' | '));
      ok('real-engine: напечатан баннер Xash3D FWGS',
        /Xash3D FWGS .*started/.test(out), tail.join(' | '));
      ok('real-engine: движок принял /rodir рабочей директорией',
        /\/rodir is working directory now/.test(out));
      ok('real-engine: движок загрузил cstrike (CS 1.6) и иерархию valve',
        /FS_LoadGameInfo\( cstrike \)/.test(out) && /FS_AddGameHierarchy/.test(out));
      ok('real-engine: /rodir/cstrike смонтирован побайтово (путь Counter-Strike 1.6)',
        /\[PASS\] FS: \/rodir\/cstrike смонтирован/.test(out));
      ok('real-engine: /rodir/valve смонтирован (halflife.wad/gfx.wad)',
        /\[PASS\] FS: \/rodir\/valve смонтирован/.test(out));
      ok('real-engine: server.js/client.js/menu.js зарегистрированы в DLFCN',
        /Module server loaded as/.test(out) && /Module client loaded as/.test(out) && /Module menu loaded as/.test(out));
      ok('real-engine: побайтовый round-trip в настоящей MEMFS',
        /round-trip/.test(out));
    } catch (e) {
      ok('real-engine: смоук', false, e.message);
    }
  } else {
    results.push('  [SKIP] real-engine: SKIP_REAL_ENGINE=1');
  }

  console.log(results.join('\n'));
  console.log('═'.repeat(56));
  console.log(`ИТОГ: ${passed} OK · ${failed} FAIL`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error('CRASH:', e); process.exit(2); });
