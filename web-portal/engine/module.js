/* ════════════════════════════════════════════════════════════════
   ХА-КЭШ · engine/module.js — конфигурация Emscripten Module
   Глобальный объект `Module` — стандартный контракт связи браузера
   и скомпилированного C++ ядра. Официальный wasm-glue принимает
   точно такой же объект, поэтому переход на бинарник = подмена
   engine/xash.js без правок остального кода.
   ════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node-тесты
  root.XashModule = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* Имя каталога мода: только xash-совместимые символы (a-z0-9._-).
     Пустой результат → null (подставляется fallback). */
  function sanitizeDirName(name) {
    const s = String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '')
      .replace(/^\.+/, '');
    return s || null;
  }

  /* Аргументы командной строки ядра (Module['arguments']):
       обычная HL        → ["-dev","3","-log"]
       CS 1.6            → ["-game","cstrike","-dev","3","-log"]
       модификации       → ["-game", <имя_папки_мода>, "-dev","3","-log"] */
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

  /* Фабрика Module-объекта. Хуки:
       onLog(text, kind)   — stdout/stderr ядра ('' | 'err')
       onStatus(text)      — setStatus
       onDepsLeft(left)    — monitorRunDependencies (честный прогресс)
       onReady()           — onRuntimeInitialized */
  function create(opts) {
    opts = opts || {};
    const Module = {
      canvas: opts.canvas || null,
      arguments: [],
      preRun: [],
      postRun: [],
      noInitialRun: true,
      wasmBinary: undefined,
      ready: false,

      print(t)     { if (opts.onLog) opts.onLog(String(t), ''); },
      printErr(t)  { if (opts.onLog) opts.onLog(String(t), 'err'); },
      setStatus(t) { if (opts.onStatus) opts.onStatus(String(t)); },

      monitorRunDependencies(left) { if (opts.onDepsLeft) opts.onDepsLeft(left); },

      onRuntimeInitialized() {
        Module.ready = true;
        if (opts.onReady) opts.onReady();
      },

      // где ядру искать свои бинарные ресурсы (локальные пути проекта)
      locateFile(path) {
        if (path === 'xash.wasm') return 'engine/xash.wasm';
        return 'engine/' + path;
      },
    };
    return Module;
  }

  return { create, buildLaunchArgs, sanitizeDirName };
});
