/* ════════════════════════════════════════════════════════════════
   ХА-КЭШ · engine/vfs.js — виртуальная файловая система VFS
   Emscripten-FS-совместимый API (подмножество): mkdir, createPath,
   writeFile, readFile, readdir, stat, analyzePath, symlink, walkFiles.
   Хранит РЕАЛЬНЫЕ байты файлов (Uint8Array) в памяти браузера.
   Контракт повторяет штатную FS Emscripten, поэтому при замене
   локального ядра на официальный wasm-glue вызывающий код не меняется.
   ════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node-тесты
  root.XashVFS = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

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

  function createVFS() {
    // node: { type:'dir' } | { type:'file', data:Uint8Array, mtime } | { type:'link', target }
    const nodes = new Map([['/', { type: 'dir' }]]);

    const exists = (p) => nodes.has(normalize(p));
    const raw = (p) => nodes.get(normalize(p)) || null;

    // развязывание симлинков (макс. 8 переходов — защита от циклов)
    function resolve(p) {
      let cur = normalize(p);
      for (let i = 0; i < 8; i++) {
        const n = nodes.get(cur);
        if (n && n.type === 'link') { cur = normalize(n.target); continue; }
        return { path: cur, node: n || null };
      }
      return { path: cur, node: null };
    }

    const isDir = (p) => { const n = raw(p); return !!n && n.type === 'dir'; };
    const isFile = (p) => { const r = resolve(p); return !!r.node && r.node.type === 'file'; };
    const isLink = (p) => { const n = raw(p); return !!n && n.type === 'link'; };

    function mkdir(path) {
      const p = normalize(path);
      if (isFile(p)) throw new Error('FS.mkdir: путь занят файлом: ' + p);
      const parent = parentOf(p);
      if (p !== '/' && !exists(parent)) throw new Error('FS.mkdir: нет родительского каталога: ' + parent);
      if (!exists(p)) nodes.set(p, { type: 'dir' });
    }

    // как FS.createPath(base, path): создаёт всю цепочку каталогов
    function createPath(base, path) {
      const full = normalize((base || '') + '/' + (path || ''));
      const segs = full.split('/').filter(Boolean);
      let cur = '';
      for (const s of segs) {
        cur += '/' + s;
        const n = nodes.get(cur);
        if (!n) nodes.set(cur, { type: 'dir' });
        else if (n.type !== 'dir') throw new Error('FS.createPath: конфликт с файлом: ' + cur);
      }
      return full;
    }

    function writeFile(path, data) {
      let bytes;
      if (typeof data === 'string') bytes = new TextEncoder().encode(data);
      else if (data instanceof Uint8Array) bytes = data;
      else if (data && data.buffer) bytes = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
      else throw new Error('FS.writeFile: неподдерживаемый тип данных');
      const p = normalize(path);
      createPath(parentOf(p), '');
      nodes.set(p, { type: 'file', data: bytes, mtime: Date.now() });
    }

    function readFile(path) {
      const { path: rp, node } = resolve(path);
      if (!node || node.type !== 'file') throw new Error('FS.readFile: нет файла: ' + normalize(path));
      if (rp !== normalize(path)) return readFile(rp);
      return node.data;
    }

    function symlink(target, linkPath) {
      const p = normalize(linkPath);
      createPath(parentOf(p), '');
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
      const { node } = resolve(p);
      if (!node) throw new Error('FS.stat: нет пути: ' + p);
      if (node.type === 'link') return stat(node.target);
      return {
        path: p,
        isDir: node.type === 'dir',
        isFile: node.type === 'file',
        size: node.type === 'file' ? node.data.length : 0,
        mtime: node.mtime || 0,
      };
    }

    function analyzePath(path) {
      const p = normalize(path);
      return { exists: nodes.has(p), object: nodes.get(p) || null, path: p, name: baseName(p), parentPath: parentOf(p) };
    }

    function unlink(path) { nodes.delete(normalize(path)); }

    // обход дерева: только реальные файлы (ссылки пропускаем — их байты учтены в целях)
    function* walkFiles(dir) {
      const root = normalize(dir) + '/';
      for (const [p, n] of nodes) {
        if (n.type === 'file' && p.startsWith(root)) yield { path: p, size: n.data.length, mtime: n.mtime };
      }
    }

    function reset() {
      nodes.clear();
      nodes.set('/', { type: 'dir' });
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

    return { normalize, mkdir, createPath, writeFile, readFile, readdir, stat, analyzePath,
             exists, isDir, isFile, isLink, symlink, unlink, walkFiles, reset, stats };
  }

  return { createVFS };
});
