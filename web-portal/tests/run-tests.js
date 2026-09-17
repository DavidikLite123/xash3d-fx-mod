#!/usr/bin/env node
/* HASH ONLINE · юнит-тесты портала (Node.js, без зависимостей).
   Покрывают:
     · умную распаковку .zip (app.js — чистые функции)
     · логику drop-ветки Drag-and-Drop (pickDropZips)
     · ядро engine/xash.js: Module.FS (mkdir / createDataFile),
       run(), collectResourceNames, аргументы запуска. */
'use strict';

const path = require('path');
const app = require(path.join(__dirname, '..', 'app.js'));
const Engine = require(path.join(__dirname, '..', 'engine', 'xash.js'));

const { JSZIP } = (() => {
  try { return { JSZIP: require(path.join(__dirname, '..', 'vendor', 'jszip.min.js')) }; }
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

(async () => {
  console.log('HASH ONLINE · test suite');
  console.log('═'.repeat(56));

  /* ── 1. pickZipTargets: глубокая вложенность ── */
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

  /* ── 2. регистр и несколько целей ── */
  const r2 = app.pickZipTargets(
    ['root/Valve/Models/A.mdl', 'root/valve/mainui.txt', 'root/CSTRIKE/cl_dlls/c.dll'],
    ['valve', 'cstrike'],
  );
  ok('targets: регистр директорий не важен', r2.picked.length === 3, `got ${r2.picked.length}`);
  ok('targets: ровно один пробел-parent сохраняет исходный регистр',
    r2.picked.find((p) => p.rel === 'Valve/Models/A.mdl') !== undefined);

  /* ── 3. без целевой фильтрации (зона мода) ── */
  const r3 = app.pickZipTargets(['moddir/models/w_rpg.mdl', 'logo.png', 'docs/readme.txt'], null);
  ok('mod-mode: берётся всё дерево', r3.picked.length === 3 && r3.skipped === 0);

  /* ── 4. isJunkPath ── */
  ok('junk: __MACOSX и .DS_Store', app.isJunkPath('a/__MACOSX/x') && app.isJunkPath('b/.DS_Store'));
  ok('junk: обычный файл не мусор', !app.isJunkPath('valve/decals.wad'));

  /* ── 5. extractZipSet на структуре-заглушке ── */
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

  /* ── 6. makeFileSet статистика ── */
  const set = app.makeFileSet([
    { file: null, path: 'valve/models/b.mdl', size: 10 },
    { file: null, path: 'valve/decals.wad', size: 20 },
    { file: null, path: 'valve/liblist.gam', size: 30 },
  ]);
  ok('fileset: сортировка и byExt', set.count === 3 && set.byExt.get('mdl') === 1 && set.items[0].path === 'valve/decals.wad');
  ok('fileset: root', set.root === 'valve');
  ok('fmtBytes', app.fmtBytes(512) === '512 Б' && app.fmtBytes(2048) === '2.0 КБ');

  /* ── 7. DnD: ветка drop с мешаниной берёт только .zip ── */
  const dropFiles = [{ name: 'cache.ZIP' }, { name: 'notes.txt' }, { name: 'x.zip' }, { name: '.zip' }];
  const picked = app.pickDropZips(dropFiles);
  ok('dnd: из смешанного дропа выбраны только .zip',
    picked.length === 3 && picked.every((f) => /\.zip$/i.test(f.name)));

  if (JSZIP) {
    /* ── 8. реальный JSZip: многопапочный архив ── */
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
        !tree.items.some((i) => i.path.includes('cstrike') || i.path.includes('other-app')));

      /* ── 9. большой синтетический архив (проверка «любого размера») ── */
      const z3 = new JSZIP();
      const payload = new Uint8Array(1024 * 64);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
      for (let i = 0; i < 40; i++) z3.file(`d/valve/maps/map_${String(i).padStart(3, '0')}.bsp`, payload.slice(0, 8000 + i * 977));
      z3.file('d/valve/halflife.wad', payload);
      const blob3 = await z3.generateAsync({ type: 'uint8array', compression: 'STORE' });
      const z4 = await JSZIP.loadAsync(blob3);
      const res3 = await app.extractZipSet(z4, ['valve'], () => {});
      ok('jszip: 41 файл крупного архива распакован', res3.set.count === 41, `got ${res3.set.count}`);
      ok('jszip: суммарный размер > 1 МБ', res3.set.size > 1_000_000, `got ${res3.set.size}`);
    } catch (e) {
      failed++;
      results.push(`  [FAIL] jszip: ${e.message}`);
    }
  } else {
    results.push('  [SKIP] реальные JSZip-тесты (vendor не найден)');
  }

  /* ═══════════════ ЯДРО engine/xash.js ═══════════════ */

  /* ── 10. var Module и Module.FS существуют ── */
  ok('core: экспорт создан', !!Engine && Engine.Module && Engine.Module.FS, JSON.stringify(Object.keys(Engine || {})));
  const freshFS = () => Engine.createEmulatedFS();

  /* ── 11. FS.mkdir / mkdirTree / analyzePath ── */
  {
    const FS = freshFS();
    FS.reset();
    FS.mkdirTree('/xash/valve/models/player');
    ok('fs: mkdirTree создаёт дерево', FS.isDir('/xash/valve/models/player') && FS.isDir('/xash/valve'));
    let threw = false;
    try { FS.mkdir('/xash/nope/inside'); } catch (e) { threw = true; }
    ok('fs: mkdir без родителя бросает ошибку', threw);
    ok('fs: analyzePath существует и object есть',
      FS.analyzePath('/xash/valve/models').exists && !!FS.analyzePath('/xash/valve/models').object);
    ok('fs: несуществующий путь', !FS.analyzePath('/xash/cstrike').exists);
  }

  /* ── 12. createDataFile: parent + name, байты, вложенные папки ── */
  {
    const FS = freshFS();
    FS.reset();
    FS.mkdirTree('/xash/valve');
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 66]);
    const r = FS.createDataFile('/xash/valve', 'models/player.mdl', bytes, true, true, false);
    ok('fs: createDataFile(parent,name) с вложенным name', r.exists && r.object && r.object.type === 'file');
    ok('fs: автосоздание models/', FS.isDir('/xash/valve/models'));
    const back = FS.readFile('/xash/valve/models/player.mdl');
    ok('fs: байты записаны/прочитаны побайтово',
      back.length === 6 && back[3] === 250 && back[5] === 66);
    FS.createDataFile('/xash/valve', 'liblist.gam', 'game "HL"\ngamedir "valve"\n', true, true, false);
    ok('fs: строковый контент читается как utf8', FS.readFile('/xash/valve/liblist.gam', { encoding: 'utf8' }).includes('gamedir "valve"'));
    const st = FS.stat('/xash/valve/models/player.mdl');
    ok('fs: stat size/type', st.size === 6 && st.isFile === true);
    for (let i = 0; i < 9; i++) FS.createDataFile('/xash/valve', `maps/m${i}.bsp`, new Uint8Array([i]), true, true, false);
    ok('fs: 9 файлов bsp в папке maps', FS.readdir('/xash/valve/maps').length === 9, FS.readdir('/xash/valve/maps').join());
    /* overlay: перезапись того же пути */
    FS.createDataFile('/xash/valve', 'decals.wad', new Uint8Array([9, 9]), true, true, false);
    FS.createDataFile('/xash/valve', 'decals.wad', new Uint8Array([8, 8, 8]), true, true, false);
    ok('fs: overlay перезапись (3 байта поверх)', FS.stat('/xash/valve/decals.wad').size === 3);

    /* symlink-витрина мода */
    FS.symlink('/xash/valve/models/player.mdl', '/xash/valve_mod/models/player.mdl');
    ok('fs: symlink витрины мода с автодеревом', FS.isFile('/xash/valve_mod/models/player.mdl'));
    const walked = [...FS.walkFiles('/xash')].map((f) => f.path);
    ok('fs: walkFiles не считает symlink файлом', !walked.includes('/xash/valve_mod/models/player.mdl'));
    ok('fs: stats корректны', FS.stats().files >= 12 && FS.stats().links === 1, JSON.stringify(FS.stats()));
  }

  /* ── 13. buildLaunchArgs / sanitizeDirName / parseLiblist / crc32 ── */
  {
    const A = Engine.buildLaunchArgs;
    ok('args: hl', JSON.stringify(A('hl1')) === JSON.stringify(['-dev', '3', '-log']));
    ok('args: cs', JSON.stringify(A('cs16')) === JSON.stringify(['-game', 'cstrike', '-dev', '3', '-log']));
    ok('args: cs-mod', JSON.stringify(A('cs16mod', 'dbz')) === JSON.stringify(['-game', 'dbz', '-dev', '3', '-log']));
    ok('args: hl-mod default', JSON.stringify(A('hl1mod', null)) === JSON.stringify(['-game', 'valve_mod', '-dev', '3', '-log']));
    ok('sanitize: имя папки нормализуется', Engine.sanitizeDirName(' My Mod !! ') === 'mymod', Engine.sanitizeDirName(' My Mod !! '));
    ok('sanitize: мусор → null', Engine.sanitizeDirName('!!!') === null);
    const lib = Engine.parseLiblist('// c\ngame "GUNMAN"\ngamedir "gunman_xl"\nversion "1.0"');
    ok('liblist: парсинг', lib.title === 'GUNMAN' && lib.gamedir === 'gunman_xl');
    ok('crc32: "crc32" → afabd35e (= zlib.crc32)', Engine.crc32(Buffer.from('crc32')).toString(16) === 'afabd35e', Engine.crc32(Buffer.from('crc32')).toString(16));
  }

  /* ── 14. run(): полный boot со смонтированной FS ── */
  {
    const Module = Engine.Module;
    const FS = Module.FS;
    FS.reset();
    FS.mkdirTree('/xash/valve');
    for (let i = 0; i < 10; i++) {
      FS.createDataFile('/xash/valve', `maps/de_map${i}.bsp`, new Uint8Array(32).fill(i), true, true, false);
    }
    FS.createDataFile('/xash/valve', 'liblist.gam', 'game "Half-Life"\ngamedir "valve"\nversion "0.42"\n', true, true, false);
    FS.createDataFile('/xash/valve', 'halflife.wad', new Uint8Array(20).fill(7), true, true, false);

    Module['arguments'] = ['-dev', '3', '-log'];
    const lefts = [];
    let rt = false;
    Module['monitorRunDependencies'] = (l) => { lefts.push(l); };
    Module['onRuntimeInitialized'] = () => { rt = true; };
    Module['print'] = () => {}; Module['printErr'] = () => {}; Module['setStatus'] = () => {};

    const ctx = await Engine.run(Module);
    ok('run: boot завершён', !!ctx && ctx.gameDir === 'valve');
    ok('run: onRuntimeInitialized вызван', rt);
    ok('run: run-dependencies завершились нулём и двигались честно',
      lefts.length >= 4 && lefts[lefts.length - 1] === 0 && Math.max(...lefts) === 1, lefts.join(','));
    ok('run: stats собраны', ctx.stats.files === 12 && ctx.stats.bytes >= 340, JSON.stringify(ctx.stats));
    ok('run: liblist прочитан', ctx.info.gamedir === 'valve' && ctx.info.title === 'Half-Life');
    ok('run: argv по умолчанию', JSON.stringify(ctx.argv) === JSON.stringify(['-dev', '3', '-log']));
  }

  /* ── 15. run(): -game и ошибка без каталога ── */
  {
    const m2 = Engine.Module;
    m2.FS.reset();
    m2.FS.mkdirTree('/xash/cstrike');
    m2['arguments'] = ['-game', 'cstrike', '-dev', '3', '-log'];
    let msg = '';
    m2['printErr'] = (t) => { msg = t; };
    m2['monitorRunDependencies'] = () => {};
    m2['onRuntimeInitialized'] = () => {};
    m2['print'] = () => {}; m2['setStatus'] = () => {};
    const c2 = await Engine.run(m2);
    ok('run: -game cstrike распознан', c2.gameDir === 'cstrike');

    m2['arguments'] = ['-game', 'they-hunger', '-dev', '3', '-log'];
    let err = null;
    try { await Engine.run(m2); } catch (e) { err = e; }
    ok('run: отсутствие каталога мода → честный reject',
      !!err && /they-hunger/.test(err.message), err && err.message);
  }

  /* ── 16. run(): abort — честная остановка ── */
  {
    const m3 = { ...Engine.Module, FS: Engine.createEmulatedFS() };
    m3.FS.mkdirTree('/xash/valve');
    m3['arguments'] = ['-dev', '3', '-log'];
    m3['print'] = () => {}; m3['printErr'] = () => {}; m3['setStatus'] = () => {};
    m3['monitorRunDependencies'] = () => {};
    m3['onRuntimeInitialized'] = () => {};
    const aborted = await Engine.run(m3, { shouldAbort: () => true }).then(
      () => 'resolved', (e) => (e && e.aborted ? 'aborted' : 'other:' + e.message),
    );
    ok('run: soft-abort флага ловится', aborted === 'aborted', aborted);
  }

  /* ── 17. collectResourceNames: дедуп + приоритеты + лимит ── */
  {
    const FS = freshFS();
    FS.reset();
    FS.mkdirTree('/xash/valve');
    const put = (p, n = 4) => FS.createDataFile('/xash/valve', p, new Uint8Array(n), true, true, false);
    put('maps/e1m1.bsp'); put('maps/x.bsp');
    put('models/a.mdl'); put('models/a.mdl'); // дубль перезаписью
    put('models/player.mdl'); put('sprites/glow.spr');
    put('textures/wall.tga'); put('sound/n.wav');
    put('gfx.wad'); put('liblist.gam'); put('engine.cfg');
    for (let i = 0; i < 400; i++) put(`junk/f${i}.tmp`);

    const names = Engine.collectResourceNames(FS, '/xash/valve', 400).map((n) => n.name);
    ok('names: лимит 400 соблюдён', names.length === 400, `${names.length}`);
    ok('names: bsp впереди', names[0] === 'e1m1.bsp' && names[1] === 'x.bsp', names.slice(0, 4).join(','));
    ok('names: приоритетные типы раньше tmp', names.indexOf('wall.tga') < names.indexOf('f0.tmp'));
    const uniq = new Set(names);
    ok('names: basename без дублей', uniq.size === names.length);
  }

  /* ── 18. CORE_VERSION / контракт глобалов ── */
  ok('core: версия 1.3.0-local', Engine.CORE_VERSION === '1.3.0-local', Engine.CORE_VERSION);
  ok('core: Module — объект emscripten-формы',
    ['arguments', 'preRun', 'postRun', 'print', 'printErr', 'setStatus'].every((k) => k in Engine.Module));

  console.log(results.join('\n'));
  console.log('═'.repeat(56));
  console.log(`ИТОГ: ${passed} OK · ${failed} FAIL`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error('CRASH:', e); process.exit(2); });
