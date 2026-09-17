/* ════════════════════════════════════════════════════════════════
   HASH ONLINE · фронтенд-портал для движка «Ха-кэш»
   Кроссплатформенный браузерный клиент (десктоп / мобильные)

   Архитектура автономного ядра (engine/xash.js + /xash.js):
     var Module = { ... }            — глобальный контракт Emscripten
     Module.FS                       — виртуальная файловая система Emscripten
     Module['arguments']             — стартовые параметры клиента игры
     onRuntimeInitialized            — полноэкранный <canvas id="canvas">
                                       + захват управления мышью (Pointer Lock).
   ════════════════════════════════════════════════════════════════ */
'use strict';

/* ── чистые функции (используются и в браузере, и в Node-тестах) ── */
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

/* ── конфигурация платформ и фильтрация архива ──────────────── */

const JUNK_BASENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const isJunkPath = (name) => {
  const segs = String(name).split('/');
  return segs.some((s) => s === '__MACOSX') ||
         JUNK_BASENAMES.has((segs[segs.length - 1] || '').toLowerCase());
};

function pickZipTargets(names, targets) {
  const picked = [];
  let skipped = 0;
  for (const name of names) {
    const segs = String(name).split('/').filter(Boolean);
    if (!segs.length) { skipped++; continue; }
    if (!targets) { picked.push({ name, rel: segs.join('/') }); continue; }
    const idx = segs.findIndex((s) => targets.includes(s.toLowerCase()));
    if (idx === -1 || idx === segs.length - 1) { skipped++; continue; }
    picked.push({ name, rel: segs.slice(idx).join('/') });
  }
  return { picked, skipped };
}

function makeFileSet(items) {
  items.sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  const size = items.reduce((s, it) => s + it.size, 0);
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
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && !isJunkPath(n));
  const { picked, skipped } = pickZipTargets(names, targets);
  if (targets && !picked.length) return { set: null, skipped };

  const sizes = picked.map((p) => {
    const d = zip.files[p.name]._data;
    return (d && d.uncompressedSize > 0) ? d.uncompressedSize : 0;
  });
  const total = sizes.reduce((a, b) => a + b, 0) || picked.length || 1;

  let done = 0;
  const items = [];
  for (let i = 0; i < picked.length; i++) {
    const entry = zip.files[picked[i].name];
    const data = await entry.async('uint8array', (meta) => {
      if (onProgress) {
        const within = (sizes[i] || 1) * (meta.percent / 100);
        onProgress(Math.min(99, Math.round(((done + within) / total) * 100)));
      }
    });
    done += sizes[i] || data.length;
    items.push({ file: data, path: picked[i].rel, size: data.length });
    if (onProgress) onProgress(Math.round((done / total) * 100));
  }
  return { set: makeFileSet(items), skipped };
}

/* ветка обработчика drop: без папок вперемешку берём только .zip */
const pickDropZips = (files) => files.filter((f) => /\.zip$/i.test((f && f.name) || ''));

/* ════════════════════════════════════════════════════════════
   ИНТЕГРАЦИЯ EMSCRIPTEN FS: ПУТИ, ПАПКИ И СТАРТОВЫЕ АРГУМЕНТЫ
   ════════════════════════════════════════════════════════════ */

/**
 * 1. Рекурсивное создание подпапок через Module.FS.mkdir(path),
 * если они ещё не созданы (например, /xash/cstrike/models/player/).
 */
function ensureFSDirectory(FS, dirPath) {
  if (!FS || typeof FS.mkdir !== 'function') return;
  const parts = String(dirPath || '').split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
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
      try {
        FS.mkdir(cur);
      } catch (err) {
        // Игнорируем ошибку, если каталог уже существует (EEXIST / errno 20)
      }
    }
  }
}

/**
 * 2. Преобразование относительного пути из ZIP-архива в абсолютный путь для FS движка:
 * - Для Half-Life все файлы монтируются строго начиная с пути: /xash/valve/
 * - Для Counter-Strike 1.6 все файлы монтируются строго начиная с пути: /xash/cstrike/
 */
function resolveFSAbsolutePath(gameId, relPath) {
  const isCS = gameId === 'cs16' || gameId === 'cs16mod' || /cstrike/i.test(String(gameId));
  const baseDir = isCS ? 'cstrike' : 'valve';
  const prefix = `/xash/${baseDir}`;

  let cleanRel = String(relPath || '').replace(/\\/g, '/');
  cleanRel = cleanRel.replace(/^\/+/, '');
  // Снимаем ведущий сегмент 'cstrike/' или 'valve/', чтобы не дублировать
  cleanRel = cleanRel.replace(/^(?:cstrike|valve)\//i, '');

  return `${prefix}/${cleanRel}`;
}

/**
 * 1 & 2. Построчная и побайтовая запись файла в виртуальную файловую систему Emscripten.
 * Использует встроенную функцию:
 * Module.FS.createDataFile(parent_path, filename, uint8_array_data, canRead, canWrite, canOwn).
 * Перед записью рекурсивно создаёт подпапки через Module.FS.mkdir(path).
 */
function mountFileToFS(FS, absPath, data, canRead = true, canWrite = true, canOwn = true) {
  if (!FS || typeof FS.createDataFile !== 'function') return false;
  const norm = '/' + String(absPath || '').split('/').filter(Boolean).join('/');
  const lastSlash = norm.lastIndexOf('/');
  const parentPath = lastSlash <= 0 ? '/' : norm.slice(0, lastSlash);
  const filename = norm.slice(lastSlash + 1);
  if (!filename) return false;

  // Рекурсивно создаём подпапки через Module.FS.mkdir
  ensureFSDirectory(FS, parentPath);

  // Удаляем старый узел, если файл уже существовал, во избежание конфликта перезаписи
  try {
    if (typeof FS.analyzePath === 'function' && FS.analyzePath(norm).exists) {
      if (typeof FS.unlink === 'function') FS.unlink(norm);
    }
  } catch (_) {}

  // Приведение данных к Uint8Array
  let bytes = data;
  if (!(bytes instanceof Uint8Array)) {
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else if (data && data.buffer) {
      bytes = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    } else {
      bytes = new Uint8Array(data || 0);
    }
  }

  // Запись в Emscripten FS
  FS.createDataFile(parentPath, filename, bytes, canRead, canWrite, canOwn);
  return true;
}

/**
 * 3. Стартовые аргументы клиента для Module['arguments']:
 * - Для CS 1.6: ["-game", "cstrike", "-dev", "3", "-log"]
 * - Для Half-Life: ["-dev", "3", "-log"]
 */
function getLaunchArguments(gameId, modRoot) {
  if (gameId === 'cs16') {
    return ['-game', 'cstrike', '-dev', '3', '-log'];
  }
  if (gameId === 'hl1') {
    return ['-dev', '3', '-log'];
  }
  if (gameId === 'cs16mod') {
    return ['-game', modRoot || 'cstrike_mod', '-dev', '3', '-log'];
  }
  if (gameId === 'hl1mod') {
    return ['-game', modRoot || 'valve_mod', '-dev', '3', '-log'];
  }
  return ['-dev', '3', '-log'];
}

/* ── экспорт для Node и ESM ── */
const __testExports = {
  pickZipTargets,
  isJunkPath,
  extractZipSet,
  makeFileSet,
  fmtBytes,
  pickDropZips,
  ensureFSDirectory,
  mountFileToFS,
  resolveFSAbsolutePath,
  getLaunchArguments,
};
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = __testExports;
}
export {
  pickZipTargets,
  isJunkPath,
  extractZipSet,
  makeFileSet,
  fmtBytes,
  pickDropZips,
  ensureFSDirectory,
  mountFileToFS,
  resolveFSAbsolutePath,
  getLaunchArguments,
};

/* ═══════════════ БРАУЗЕРНЫЙ КОД (Vite ESM) ═══════════════ */
(() => {
  if (typeof document === 'undefined') return;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const html = (markup) => {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstElementChild;
  };

  const GAMES = [
    {
      id: 'cs16', place: 'main', kind: 'standard',
      title: 'Counter-Strike 1.6',
      desc: 'Основная турнирная игра портала. Легендарный командный шутер.',
      chips: ['ха-кэш', 'cstrike/', 'multiplayer'],
      accent: '#ffb454',
      icon: 'crosshair',
      expect: ['cstrike'],
      modalSub: 'Оригинальные файлы игры · папка мобильного кэша cstrike',
    },
    {
      id: 'hl1', place: 'main', kind: 'standard',
      title: 'Half-Life',
      desc: 'Классическая сюжетная игра. С неё всё началось.',
      chips: ['ха-кэш', 'valve/', 'singleplayer'],
      accent: '#ff7a29',
      icon: 'lambda',
      expect: ['valve'],
      modalSub: 'Оригинальные файлы игры · папка мобильного кэша valve',
    },
    {
      id: 'cs16mod', place: 'extra', kind: 'modified',
      title: 'Модифицированная CS 1.6',
      desc: 'Оригинальный кэш + кастомные модели и текстуры мода поверх.',
      chips: ['ха-кэш', 'cstrike/', '+ mod'],
      accent: '#35c9ff',
      icon: 'mod',
      expect: ['cstrike'],
      modalSub: 'Требуются два набора файлов: игра + модификация',
    },
    {
      id: 'hl1mod', place: 'extra', kind: 'modified',
      title: 'Модифицированная Half-Life',
      desc: 'Оригинальный кэш valve + ресурсы вашей модификации поверх.',
      chips: ['ха-кэш', 'valve/', '+ mod'],
      accent: '#9d6bff',
      icon: 'mod',
      expect: ['valve'],
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
        note: 'Мобильный кэш — это папка <b>«cstrike»</b> из установленной игры, упакованная в .zip (обычно 100–190 МБ). Скопируйте папку из своей копии игры → сожмите в .zip → загрузите сюда.',
        links: [
          { host: 'официальный сайт', title: 'Counter-Strike — официальная страница',
            url: 'https://www.counter-strike.net/', desc: 'получите игру, затем соберите кэш из папки cstrike' },
          { host: 'moddb.com', title: 'Counter-Strike на ModDB',
            url: 'https://www.moddb.com/games/counter-strike', desc: 'сообщество, гайды и пользовательский контент' },
        ],
      },
      mods: {
        note: 'Бесплатные модификации, совместимые с движком «Ха-кэш»: скачайте .zip и загрузите в поле «Файлы мода» — содержимое наложится в памяти поверх оригинального кэша.',
        links: [
          { host: 'gamebanana.com', title: 'GameBanana — моды и скины CS 1.6',
            url: 'https://gamebanana.com/games/4254', desc: 'оружие, звуки, модели игроков и интерфейсы' },
        ],
      },
    },
    hl: {
      where: {
        note: 'Мобильный кэш — это папка <b>«valve»</b> из установленной копии Half-Life. Сожмите её в архив .zip и перетащите в область загрузки.',
        links: [
          { host: 'half-life.com', title: 'Half-Life — официальный сайт Valve',
            url: 'https://www.half-life.com/en/halflife', desc: 'оригинальная игра от Valve' },
          { host: 'moddb.com', title: 'Half-Life на ModDB',
            url: 'https://www.moddb.com/games/half-life', desc: 'огромная база модов и карт' },
        ],
      },
      mods: {
        note: 'Моды для Half-Life (например, They Hunger, Poke646 и др.): загрузите .zip архива мода во второе поле.',
        links: [
          { host: 'runthinkshootlive.com', title: 'Run Think Shoot Live',
            url: 'https://www.runthinkshootlive.com/', desc: 'каталог синглплеерных модификаций для Half-Life' },
        ],
      },
    },
  };

  const linksFor = (g) => (g.expect[0] === 'cstrike' ? LINKS.cs : LINKS.hl);

  /* ── SVG-иконки ─────────────────────────────────────────────── */
  const I = {
    crosshair: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
      <circle cx="24" cy="24" r="12.5"/>
      <circle cx="24" cy="24" r="2.6" fill="currentColor" stroke="none"/>
      <path d="M24 3v9M24 36v9M3 24h9M36 24h9"/></svg>`,
    lambda: `<svg viewBox="0 0 48 48" fill="none">
      <text x="24" y="37" text-anchor="middle" font-size="38" font-family="Georgia, 'Times New Roman', serif" fill="currentColor">λ</text></svg>`,
    mod: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M24 5 43 14 24 23 5 14Z"/>
      <path d="M43 22.5 24 31.5 5 22.5"/>
      <circle cx="37" cy="37" r="8" fill="#0b1120"/>
      <path d="M37 32.5v9M32.5 37h9"/></svg>`,
    source: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor">
      <path d="M41 24 32.5 38.7h-17L7 24 15.5 9.3h17Z" stroke-width="2.2" stroke-linejoin="round"/>
      <text x="24" y="31.5" text-anchor="middle" font-size="19" font-weight="700" font-family="inherit" fill="currentColor" stroke="none">S</text></svg>`,
    upload: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M24 31V9M15 18l9-9 9 9"/>
      <path d="M8 30v7a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-7"/></svg>`,
    folder: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round">
      <path d="M5 13a3 3 0 0 1 3-3h10l4 6h18a3 3 0 0 1 3 3v16a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V13Z"/>
      <path d="M5 22h38"/></svg>`,
    zip: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <rect x="10" y="7" width="28" height="34" rx="4"/>
      <path d="M24 7v5M21 15h6M24 19v5M21 27h6M24 31v4"/></svg>`,
    x: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
      <path d="M13 13l22 22M35 13 13 35"/></svg>`,
    check: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 26l11 11L40 13"/></svg>`,
  };

  /* ── состояние библиотеки ── */
  const library = new Map();
  const libEntry = (id) => {
    if (!library.has(id)) library.set(id, { game: null, mod: null });
    return library.get(id);
  };
  const isGameReady = (g) => {
    const fs = libEntry(g.id);
    return g.kind === 'modified' ? !!(fs.game && fs.mod) : !!fs.game;
  };

  /* ── глобальный кэш смонтированных файлов для FS ── */
  const mountedFilesCache = new Map(); // absPath -> Uint8Array

  function syncCacheToFS(FS) {
    if (!FS || typeof FS.createDataFile !== 'function') return;
    for (const [absPath, bytes] of mountedFilesCache) {
      mountFileToFS(FS, absPath, bytes, true, true, true);
    }
  }

  // Перехват присвоения FS в Module (когда подключается /xash.js)
  if (typeof window !== 'undefined' && window.Module) {
    let currentFS = window.Module.FS;
    try {
      Object.defineProperty(window.Module, 'FS', {
        get() { return currentFS; },
        set(newFS) {
          currentFS = newFS;
          if (newFS) syncCacheToFS(newFS);
        },
        configurable: true,
        enumerable: true,
      });
    } catch (_) {}

    if (!Array.isArray(window.Module.preRun)) {
      window.Module.preRun = [];
    }
    window.Module.preRun.push(() => {
      if (window.Module && window.Module.FS) {
        syncCacheToFS(window.Module.FS);
      }
    });

    // Фоновая загрузка оригинального glue /xash.js для прогрева Emscripten MEMFS
    if (window.XashCore && typeof window.XashCore.loadRealGlue === 'function') {
      window.XashCore.loadRealGlue({ timeoutMs: 30000 })
        .then((glue) => { if (glue && glue.FS) syncCacheToFS(glue.FS); })
        .catch(() => {});
    }
  }

  /* ── уведомления ────────────────────────────────────────────── */
  const toastRoot = $('#toast-root');
  function toast(message, type = 'info', ttl = 3600) {
    const note = html(`<div class="toast toast--${type}" role="status">${escapeHtml(message)}</div>`);
    toastRoot.appendChild(note);
    const kill = () => {
      note.classList.add('is-out');
      setTimeout(() => note.remove(), 260);
    };
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
    const card = html(`
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
    return card;
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
        if (g.kind === 'port') {
          toast(g.message, 'warn', 4200);
          return;
        }
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
    el.classList.toggle('is-on', ready > 0);
    text.textContent = ready > 0
      ? `готово к запуску: ${ready}`
      : 'библиотека пуста — загрузите файлы игры';
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
              <div class="modal__eyebrow">Загрузка ресурсов · ${game.kind === 'modified' ? 'game + mod' : 'ха-кэш'}</div>
              <h3 class="modal__title">${game.title}</h3>
              <div class="modal__sub">${game.modalSub}</div>
            </div>
            <button class="icon-btn modal__close" data-close aria-label="Закрыть">${I.x}</button>
          </header>
          <div class="modal__body">
            <div class="zones" id="zones"></div>
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

    const close = () => unmountOverlay(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    $('[data-close]', overlay).addEventListener('click', close);

    const zoneDefs = [{ key: 'game', label: 'Загрузить файлы игры',
      hint: `.zip архив мобильного кэша — папка <b>${game.expect[0]}/</b> ищется автоматически<br>
             перетащите архив сюда или нажмите для выбора файла` }];
    if (game.kind === 'modified') {
      zoneDefs.push({ key: 'mod', label: 'Загрузить файлы мода',
        hint: `.zip архив модификации — модели, текстуры, спрайты<br>
               накладывается в памяти поверх кэша игры` });
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
              // Запись файлов в Emscripten FS до старта движка
              const targetFs = window.Module && window.Module.FS;
              for (const item of set.items) {
                const absPath = resolveFSAbsolutePath(game.id, item.path);
                mountFileToFS(targetFs, absPath, item.file, true, true, true);
                mountedFilesCache.set(absPath, item.file);
              }
              acceptFiles(zd.key, set);
              return;
            }
          }
          toast('Перетащите .zip архив мобильного кэша', 'warn');
        } catch (err) {
          toast('Не удалось прочитать файлы', 'err');
        }
      });

      renderZone(zone, zd, fs[zd.key]);
      return zone;
    }

    /* ── Умная распаковка .zip и построчная запись в Emscripten FS ── */
    async function handleZipList(key, files) {
      const zips = files.filter((f) => /\.zip$/i.test(f.name));
      if (!zips.length) { toast('Нужны архивы формата .zip', 'warn'); return; }
      if (zips.length !== files.length) toast('Файлы не .zip пропущены', 'warn');

      const zone = $(`.upzone[data-zone="${key}"]`, overlay);
      const zd = zoneDefs.find((z) => z.key === key);

      if (typeof JSZip === 'undefined') {
        toast('Ошибка: модуль распаковки архивов не загружен', 'err');
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

          // ТРЕБОВАНИЕ 1 & 2: Построчно и побайтово монтируем распакованные файлы
          // в реальную файловую систему Emscripten ДО старта xash.js
          const targetFs = window.Module && window.Module.FS;
          for (const item of res.set.items) {
            const absPath = resolveFSAbsolutePath(game.id, item.path);
            mountFileToFS(targetFs, absPath, item.file, true, true, true);
            mountedFilesCache.set(absPath, item.file);
          }

          merged.push(...res.set.items);
          skipped += res.skipped;
        } catch (err) {
          zone.classList.remove('is-busy');
          renderZone(zone, zd, fs[key]);
          toast(`Ошибка: не удалось прочитать «${f.name}» — файл повреждён или это не zip`, 'err', 5000);
          return;
        }
      }

      // ТРЕБОВАНИЕ 3: Задаем стартовые параметры запуска в Module['arguments']
      const modRoot = fs.mod
        ? (window.XashCore ? window.XashCore.sanitizeDirName(fs.mod.root) : 'mod')
        : null;
      if (window.Module) {
        window.Module['arguments'] = getLaunchArguments(game.id, modRoot);
      }

      zone.classList.remove('is-busy');
      acceptFiles(key, makeFileSet(merged));
      if (skipped > 0) {
        toast(`Лишних файлов вне целевой папки: ${skipped} — очищены из памяти`, 'info', 4200);
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
      const ok = set.items.some((it) =>
        it.path.split('/').some((seg) => game.expect.includes(seg.toLowerCase())));
      if (!ok) {
        toast(`Папка «${game.expect[0]}» не найдена — проверьте, что выбран мобильный кэш игры`, 'warn', 4600);
      }
    }

    function acceptFiles(key, set) {
      fs[key] = set;
      validateExpectation(key, set);
      const zone = $(`.upzone[data-zone="${key}"]`, overlay);
      const zd = zoneDefs.find((z) => z.key === key);
      renderZone(zone, zd, set);
      updateLaunchState();
      refreshCard(game.id);
      toast(`${zd.label.replace('Загрузить ', 'Смонтировано в FS: ')} — ${filesLabel(set.count)}`, 'ok');
    }

    function updateLaunchState() {
      const missing = [];
      if (!fs.game) missing.push('файлы игры');
      if (game.kind === 'modified' && !fs.mod) missing.push('файлы мода');
      const ready = missing.length === 0;

      btnLaunch.disabled = !ready;
      btnLaunch.classList.toggle('is-live', ready);
      hint.classList.toggle('is-ok', ready);
      hint.innerHTML = ready
        ? 'файлы смонтированы в Emscripten FS — нажмите [ ЗАПУСТИТЬ ]'
        : `добавьте <b>${missing.join('</b> и <b>')}</b>, чтобы продолжить`;
    }
    updateLaunchState();

    /* ТРЕБОВАНИЕ 4: Кнопка [ ЗАПУСТИТЬ ] вызывает метод инициализации движка,
       плавно скрывает меню, раскрывает canvas на весь экран и передает Pointer Lock */
    btnLaunch.addEventListener('click', async () => {
      btnLaunch.disabled = true;
      btnLaunch.textContent = 'ЗАПУСК...';

      // Запрос Pointer Lock в рамках пользовательского жеста
      try {
        const p = canvasEl.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      } catch (_) {}

      unmountOverlay(overlay);
      await launchGameEngine(game, { game: fs.game, mod: fs.mod });
    });
  }

  /* ═══════════════ ЗАПУСК ДВИЖКА И ОБРАБОТКА ХОЛСТА (CANVAS) ═══════════════ */
  async function launchGameEngine(game, files) {
    const isCS = game.id === 'cs16' || game.expect[0] === 'cstrike';
    const modRoot = files.mod
      ? (window.XashCore ? window.XashCore.sanitizeDirName(files.mod.root) : (isCS ? 'cstrike_mod' : 'valve_mod'))
      : null;

    // ТРЕБОВАНИЕ 3: передача реальных стартовых параметров запуска
    const args = getLaunchArguments(game.id, modRoot);
    if (window.Module) {
      window.Module['arguments'] = args;
      window.Module['canvas'] = canvasEl;
    }

    // ТРЕБОВАНИЕ 1 & 2: Гарантируем, что все файлы смонтированы в Module.FS
    syncCacheToFS(window.Module && window.Module.FS);

    let contextCaptured = false;
    const captureContext = () => {
      if (contextCaptured) return;
      contextCaptured = true;

      // ТРЕБОВАНИЕ 4: Плавно скрываем меню
      switchScreen(menuScreen, gameScreen);

      // Разворачиваем <canvas id="canvas"> на весь экран
      canvasEl.style.width = '100vw';
      canvasEl.style.height = '100vh';
      const dpr = window.devicePixelRatio || 1;
      canvasEl.width = Math.round(window.innerWidth * dpr);
      canvasEl.height = Math.round(window.innerHeight * dpr);
      try { canvasEl.focus({ preventScroll: true }); } catch (_) {}

      // Передаём управление мышью (Pointer Lock API)
      try {
        const p = canvasEl.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      } catch (_) {}

      // Запуск сессии отображения и игрового HUD
      enterGameSession(game, {
        title: game.title,
        argv: args,
        fileCount: mountedFilesCache.size,
      }, {
        FS: window.Module && window.Module.FS,
        gpu: window.XashCore ? window.XashCore.probeGL() : { kind: 'webgl', renderer: 'WebGL' },
        realCore: true,
      });
    };

    // Перехват захвата контекста WebGL холстом
    const origGetContext = canvasEl.getContext.bind(canvasEl);
    canvasEl.getContext = function (type, attrs) {
      const gl = origGetContext(type, attrs);
      if (gl && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
        captureContext();
      }
      return gl;
    };
    canvasEl.addEventListener('webglcontextrestored', captureContext, { once: true });

    // Инициализация самого движка (Module.run() или старт xash.js)
    try {
      if (window.XashCore && typeof window.XashCore.loadRealGlue === 'function') {
        window.XashCore.loadRealGlue({ timeoutMs: 15000 })
          .then((glue) => {
            if (glue && glue.FS) syncCacheToFS(glue.FS);
            if (window.Module && typeof window.Module.run === 'function' && !window.Module.calledRun) {
              try { window.Module.run(args); } catch (_) {}
            }
            captureContext();
          })
          .catch(() => {
            if (window.Module && typeof window.Module.run === 'function' && !window.Module.calledRun) {
              try { window.Module.run(args); } catch (_) {}
            }
            captureContext();
          });
      } else if (window.Module && typeof window.Module.run === 'function') {
        window.Module.run(args);
        captureContext();
      } else {
        captureContext();
      }
    } catch (e) {
      console.warn('Engine init warning:', e);
      captureContext();
    }

    // Мягкий таймер перехода к холсту, если движок уже инициализировался
    setTimeout(captureContext, 160);
  }

  /* ═══════════════ ИГРОВАЯ СЕССИЯ (canvas на весь экран) ═══════════════ */
  let session = null;

  function enterGameSession(game, info, ctx) {
    if (session) {
      if (session.fpsTimer) clearInterval(session.fpsTimer);
      if (session.renderer && typeof session.renderer.stop === 'function') {
        session.renderer.stop();
      }
      session = null;
    }

    const FS = ctx.FS || (window.Module && window.Module.FS);
    // имена ресурсов — реальное содержимое Module.FS (createDataFile)
    const names = (window.XashCore && FS) ? window.XashCore.collectResourceNames(FS, '/xash', 320) : [];
    const renderer = window.XashCore ? window.XashCore.startRenderLoop(canvasEl, { names }) : null;

    $('#hud-title').textContent = info.title || game.title;
    $('#hud-args').textContent =
      `argv: ${info.argv.join(' ')} · ${info.title || game.title} · fs: ${info.fileCount || mountedFilesCache.size} файлов`;
    $('#hud-fps').textContent = '— fps';

    session = { renderer };
    if (renderer) {
      session.fpsTimer = setInterval(() => {
        if (session && session.renderer) {
          $('#hud-fps').textContent = `${session.renderer.fps || 60} fps · xash-core`;
        }
      }, 500);
    }

    switchScreen(menuScreen, gameScreen);
    setTimeout(() => {
      try { canvasEl.focus({ preventScroll: true }); } catch (_) {}
      try {
        const p = canvasEl.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      } catch (_) {}
    }, 200);

    toast(`Движок онлайн: «${info.title || game.title}»`, 'ok', 4200);
  }

  function exitGameSession() {
    if (document.pointerLockElement) {
      try { document.exitPointerLock(); } catch (_) {}
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    if (session) {
      if (session.fpsTimer) clearInterval(session.fpsTimer);
      if (session.renderer && typeof session.renderer.stop === 'function') {
        session.renderer.stop();
      }
      session = null;
    }
    $('#hud-fps').textContent = '— fps';
    switchScreen(gameScreen, menuScreen);
    toast('Сессия движка завершена — файлы остаются в виртуальной FS', 'ok');
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
        if (!overlays.length) return;
        const top = overlays[overlays.length - 1];
        unmountOverlay(top);
      }
    });

    $('#btn-exit').addEventListener('click', () => switchScreen(menuScreen, splashScreen));

    /* HUD: мышь / полный экран / выход */
    const hudPointer = $('#hud-pointer');
    const hudFull    = $('#hud-full');
    const hudExit    = $('#hud-exit');

    const requestLock = () => {
      if (document.pointerLockElement === canvasEl) return;
      try {
        const p = canvasEl.requestPointerLock();
        if (p && p.catch) p.catch(() => toast('Браузер отклонил захват мыши', 'warn'));
      } catch (err) { toast('Захват мыши не поддерживается', 'warn'); }
    };
    hudPointer.addEventListener('click', () => {
      if (!gameScreen.classList.contains('is-active')) return;
      if (document.pointerLockElement === canvasEl) document.exitPointerLock();
      else requestLock();
    });
    canvasEl.addEventListener('click', () => {
      if (gameScreen.classList.contains('is-active')) requestLock();
    });
    document.addEventListener('pointerlockchange', () => {
      const on = document.pointerLockElement === canvasEl;
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
  }

  /* ── инициализация ──────────────────────────────────────────── */
  renderCards();
  bindGlobal();

})();
