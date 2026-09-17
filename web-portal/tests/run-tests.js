/* ════════════════════════════════════════════════════════════════
   Hash Online · юнит/интеграционные тесты ядра и пайплайна.
   Запуск из папки web-portal:  node tests/run-tests.js
   ════════════════════════════════════════════════════════════════ */
'use strict';

const assert = require('node:assert');

const app       = require('../app.js');
const JSZip     = require('../vendor/jszip.min.js');
const XashVFS   = require('../engine/vfs.js');
const XashModule = require('../engine/module.js');
const XashCore  = require('../engine/xash.js');

const { pickZipTargets, isJunkPath, extractZipSet, fmtBytes } = app;

let passed = 0;
function ok(name) { passed++; console.log('  ✔ ' + name); }

(async () => {
  /* ═══ 1. ZIP: фильтрация дерева ═══ */
  console.log('▸ zip-пайплайн');
  {
    const names = [
      'README.txt', 'docs/readme.txt',
      'pack/deep/nested/cstrike/maps/de_dust2.bsp',
      'pack/deep/nested/cstrike/models/v_ak47.mdl',
      'pack/deep/nested/cstrike.cfg',
      'valve/maps/c1a0.bsp',
      'Pack/DATA/CSTRIKE/sound/player/pl_jump1.wav',
    ].filter((n) => !isJunkPath(n));

    let r = pickZipTargets(names, ['cstrike']);
    assert.strictEqual(r.picked.length, 3);
    assert.ok(r.picked.every((p) => p.rel.toLowerCase().startsWith('cstrike/')));
    assert.strictEqual(r.skipped, 4);
    ok('целевая папка находится на любой глубине, регистр не важен');

    r = pickZipTargets(names, null);
    assert.strictEqual(r.picked.length, names.length);
    ok('режим мода (targets=null) сохраняет всё дерево');

    r = pickZipTargets(names, ['no_such_dir']);
    assert.strictEqual(r.picked.length, 0);
    ok('нет целевой папки → пусто (UI покажет ошибку)');

    assert.ok(isJunkPath('__MACOSX/x') && isJunkPath('cstrike/.DS_Store') && isJunkPath('a/Thumbs.db'));
    assert.ok(!isJunkPath('cstrike/models/v_usp.mdl'));
    ok('служебный мусор фильтруется');
  }

  /* ═══ 2. ZIP: интеграционная распаковка с прогрессом ═══ */
  {
    const zip = new JSZip();
    zip.file('инструкция.txt', 'прочти меня');
    zip.file('very/deep/nested/cstrike/maps/cs_office.bsp', new Uint8Array(64 * 1024));
    zip.file('very/deep/nested/cstrike/models/v_m4a1.mdl', new Uint8Array(24 * 1024));
    zip.file('very/deep/nested/cstrike/sound/ambience/wind.wav', new Uint8Array(8 * 1024));
    zip.file('other/stuff/junk.txt', 'мусор вне папки');

    const buf = await zip.generateAsync({ type: 'uint8array' });
    const z2 = await JSZip.loadAsync(buf);
    const pcts = [];
    const { set, skipped } = await extractZipSet(z2, ['cstrike'], (p) => pcts.push(p));

    assert.ok(set && set.count === 3 && set.root === 'cstrike');
    assert.strictEqual(set.size, (64 + 24 + 8) * 1024);
    assert.strictEqual(skipped, 2);
    assert.ok(pcts.length && pcts[pcts.length - 1] === 100);
    ok('extractZipSet: фильтр + прогресс до 100% + отчёт о мусоре');

    const zip2 = new JSZip();
    zip2.file('readme.txt', 'ничего');
    const z3 = await JSZip.loadAsync(await zip2.generateAsync({ type: 'uint8array' }));
    const bad = await extractZipSet(z3, ['cstrike']);
    assert.strictEqual(bad.set, null);
    ok('архив без целевой папки → set=null (ошибка в UI)');

    const z4 = await JSZip.loadAsync(buf);
    const modRes = await extractZipSet(z4, null);
    assert.strictEqual(modRes.set.count, 5);
    ok('мод: всё содержимое архива сохраняется');
  }

  /* ═══ 3. VFS: операции файловой системы ═══ */
  console.log('▸ виртуальная ФС (engine/vfs.js)');
  {
    const vfs = XashVFS.createVFS();
    vfs.createPath('/', 'xash/cstrike/models');
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    vfs.writeFile('/xash/cstrike/models/v_ak47.mdl', payload);
    vfs.writeFile('/xash/cstrike/liblist.gam', 'game "T"\ngamedir "cstrike"\n');

    assert.strictEqual(vfs.readFile('/xash/cstrike/models/v_ak47.mdl').length, 5);
    assert.ok(vfs.readFile('/xash/cstrike/models/v_ak47.mdl').every((b, i) => b === payload[i]));
    ok('writeFile/readFile: байты совпадают побайтово');

    assert.strictEqual(vfs.stat('/xash/cstrike/models/v_ak47.mdl').size, 5);
    assert.deepStrictEqual(vfs.readdir('/xash/cstrike').sort(), ['liblist.gam', 'models']);
    assert.ok(vfs.isDir('/xash/cstrike') && vfs.isFile('/xash/cstrike/liblist.gam'));
    ok('stat/readdir/isDir/isFile');

    assert.ok(vfs.exists('/xash/cstrike/models/v_ak47.mdl'));
    vfs.writeFile('/xash/cstrike/models/v_ak47.mdl', new Uint8Array(9));
    assert.strictEqual(vfs.stat('/xash/cstrike/models/v_ak47.mdl').size, 9);
    ok('перезапись (overlay мода) работает');

    vfs.symlink('/xash/cstrike/models/v_ak47.mdl', '/xash/cstrike_mod/models/v_ak47.mdl');
    assert.strictEqual(vfs.readFile('/xash/cstrike_mod/models/v_ak47.mdl').length, 9);
    const walked = [...vfs.walkFiles('/xash')];
    assert.strictEqual(walked.length, 2, 'ссылки в обход не попадают (байты не дублируются)');
    ok('symlink: чтение сквозь ссылку, walkFiles без дублей');

    const decoded = new TextDecoder().decode(vfs.readFile('/xash/cstrike/liblist.gam'));
    const info = XashCore.parseLiblist(decoded);
    assert.strictEqual(info.title, 'T');
    assert.strictEqual(info.gamedir, 'cstrike');
    ok('parseLiblist из реальных байтов VFS');

    vfs.reset();
    assert.strictEqual(vfs.stats().files, 0);
    ok('reset');
  }

  /* ═══ 4. Module: argv и sanitize ═══ */
  console.log('▸ Module / аргументы запуска');
  {
    assert.deepStrictEqual(XashModule.buildLaunchArgs('hl1'), ['-dev', '3', '-log']);
    assert.deepStrictEqual(XashModule.buildLaunchArgs('cs16'), ['-game', 'cstrike', '-dev', '3', '-log']);
    assert.deepStrictEqual(XashModule.buildLaunchArgs('cs16mod', 'My Pack'), ['-game', 'mypack', '-dev', '3', '-log']);
    assert.deepStrictEqual(XashModule.buildLaunchArgs('hl1mod', null), ['-game', 'valve_mod', '-dev', '3', '-log']);
    ok('argv по ТЗ: HL / CS / модификации с -game');
    assert.strictEqual(XashModule.sanitizeDirName('My Cool Mod!!'), 'mycoolmod');
    assert.strictEqual(XashModule.sanitizeDirName('!!!'), null);
    ok('sanitizeDirName');
  }

  /* ═══ 5. Ядро: полный boot (интеграция) ═══ */
  console.log('▸ boot ядра (engine/xash.js)');
  {
    const vfs = XashVFS.createVFS();
    vfs.createPath('/', 'xash/cstrike/models');
    vfs.writeFile('/xash/cstrike/liblist.gam', 'game "Test Mod Title"\nversion "1.5"\ngamedir "cstrike"\n');
    vfs.writeFile('/xash/cstrike/models/v_usp.mdl', new Uint8Array(4096).fill(7));
    vfs.writeFile('/xash/cstrike/maps/cs_test.bsp', new Uint8Array(8192).fill(3));

    const logs = [], depsSeq = [];
    let ready = false;
    const Module = XashModule.create({
      onLog: (t, kind) => logs.push({ t, kind }),
      onDepsLeft: (l) => depsSeq.push(l),
      onReady: () => { ready = true; },
    });
    Module.arguments = XashModule.buildLaunchArgs('cs16', null);

    const res = await XashCore.run(Module, vfs);
    assert.ok(ready, 'onRuntimeInitialized вызван');
    assert.strictEqual(res.gameDir, 'cstrike');
    assert.strictEqual(res.info.title, 'Test Mod Title');
    assert.strictEqual(res.info.version, '1.5');
    assert.strictEqual(res.stats.files, 3);
    const libBytes = new TextEncoder().encode('game "Test Mod Title"\nversion "1.5"\ngamedir "cstrike"\n').length;
    assert.strictEqual(res.stats.bytes, libBytes + 4096 + 8192);
    assert.ok(res.stats.crc.checked >= 2, 'CRC-скан выполнен');
    assert.strictEqual(depsSeq[depsSeq.length - 1], 0, 'run-dependencies закрыты в ноль');
    assert.ok(Math.max(...depsSeq) > 0);
    assert.ok(logs.some((l) => l.t.includes('argv[') && l.t.includes('-game cstrike')));
    ok('boot: argv, VFS-индекс, CRC, liblist, deps→0, READY');
  }

  /* ═══ 6. Ядро: отмена и ошибки ═══ */
  {
    const vfs = XashVFS.createVFS();
    vfs.createPath('/', 'xash/cstrike');
    for (let i = 0; i < 500; i++) vfs.writeFile(`/xash/cstrike/f${i}.mdl`, new Uint8Array(128));

    let ready = false;
    const Module = XashModule.create({ onLog() {}, onDepsLeft() {}, onReady() { ready = true; } });
    Module.arguments = ['-game', 'cstrike', '-dev', '3', '-log'];

    await assert.rejects(
      XashCore.run(Module, vfs, { shouldAbort: () => true }),
      (e) => e.aborted === true,
    );
    assert.strictEqual(ready, false, 'при отмене READY не наступает');
    ok('отмена корректно прерывает boot без READY');

    const empty = XashVFS.createVFS();
    const M2 = XashModule.create({ onLog() {}, onDepsLeft() {}, onReady() {} });
    M2.arguments = ['-game', 'valve'];
    await assert.rejects(XashCore.run(M2, empty), /не найдена|не смонтирована/i);
    ok('без смонтированной игры — осмысленная ошибка ядра');
  }

  /* ═══ 7. Форматтер ═══ */
  assert.strictEqual(fmtBytes(512), '512 Б');
  assert.strictEqual(fmtBytes(2048), '2.0 КБ');
  assert.strictEqual(fmtBytes(5 * 1024 * 1024), '5.0 МБ');
  ok('fmtBytes');

  console.log(`\n✅ ВСЕ ТЕСТЫ ПРОШЛИ (${passed} групп проверок)`);
})().catch((e) => {
  console.error('\n❌ ТЕСТ УПАЛ:', e);
  process.exit(1);
});
