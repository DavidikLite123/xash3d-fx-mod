/* ════════════════════════════════════════════════════════════════
   HASH ONLINE · фронтенд-портал для движка «Ха-кэш»
   Кроссплатформенный браузерный клиент (десктоп / мобильные)

   Архитектура автономного ядра (engine/xash.js):
     var Module = { ... }            — глобальный контракт Emscripten
     Module.FS                       — эмуляция ФС (mkdir / createDataFile)
     XashCore.run(Module)            — boot: argv, индекс, CRC32, liblist
     onRuntimeInitialized            — полноэкранный <canvas id="canvas">
                                       + интерактивный WebGL 3D-цикл.

   Интерфейс работает в тишине: синтезированных звуков нет.
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

  /* ── конфигурация платформ ──────────────────────────────────── */

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


/* ── экспорт для Node и ESM ── */
const __testExports = { pickZipTargets, isJunkPath, extractZipSet, makeFileSet, fmtBytes, pickDropZips };
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = __testExports;
}
export { pickZipTargets, isJunkPath, extractZipSet, makeFileSet, fmtBytes, pickDropZips };

/* ═══════════════ БРАУЗЕРНЫЙ КОД (Vite ESM) ═══════════════ */
(() => {
  if (typeof document === 'undefined') return;

  const $  = (sel, root) => (root || document).querySelector(sel);
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

  /* ── подсказки «где взять файлы» (только легальные источники) ── */
  const LINKS = {
    cs: {
      where: {
        note: 'Мобильный кэш — это папка <b>«cstrike»</b> из установленной игры, упакованная в .zip (обычно 100–190 МБ). Легальный способ: скопируйте папку из своей копии игры → сожмите в .zip → загрузите сюда. Движок примет архив любого размера и сам отфильтрует лишнее.',
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
          { host: 'gamebanana.com', title: 'GameBanana — хаб CS 1.6',
            url: 'https://gamebanana.com/games/4254', desc: 'тысячи карт, моделей и скинов от сообщества' },
          { host: 'moddb.com', title: 'Модификации CS на ModDB',
            url: 'https://www.moddb.com/games/counter-strike/mods', desc: 'крупные моды и тотальные конверсии' },
        ],
      },
    },
    hl: {
      where: {
        note: 'Мобильный кэш — это папка <b>«valve»</b> из установленной игры, упакованная в .zip (обычно 100–190 МБ). Легальный способ: скопируйте папку из своей копии игры → сожмите в .zip → загрузите сюда. Движок примет архив любого размера и сам отфильтрует лишнее.',
        links: [
          { host: 'официальный сайт', title: 'Half-Life — официальная страница серии',
            url: 'https://www.half-life.com/', desc: 'получите игру, затем упакуйте папку valve в .zip' },
          { host: 'moddb.com', title: 'Half-Life на ModDB',
            url: 'https://www.moddb.com/games/half-life', desc: 'сообщество и архив материалов' },
        ],
      },
      mods: {
        note: 'Бесплатные модификации, совместимые с движком «Ха-кэш»: скачайте .zip и загрузите в поле «Файлы мода» — содержимое наложится в памяти поверх оригинального кэша.',
        links: [
          { host: 'moddb.com', title: 'Модификации Half-Life на ModDB',
            url: 'https://www.moddb.com/games/half-life/mods', desc: 'крупнейшая библиотека модов' },
          { host: 'runthinkshootlive.com', title: 'RunThinkShootLive',
            url: 'https://www.runthinkshootlive.com/', desc: 'карты и моды Half-Life с обзорами' },
          { host: 'moddb.com', title: 'They Hunger (трилогия)',
            url: 'https://www.moddb.com/mods/they-hunger', desc: 'культовый хоррор-мод — бесплатно' },
          { host: 'moddb.com', title: 'Poke646: Anniversary Edition',
            url: 'https://www.moddb.com/mods/poke646', desc: 'признанный сюжетный мод — бесплатно' },
        ],
      },
    },
  };
  const linksFor = (game) => LINKS[game.expect[0] === 'cstrike' ? 'cs' : 'hl'];

  /* ═══════════════ УМНАЯ РАСПАКОВКА .ZIP (чистые функции) ═══════════════
     Принимает архив любого размера, сканирует ВСЁ дерево папок на
     любой глубине и оставляет только содержимое целевой папки игры
     (cstrike / valve). Остальной контент игнорируется и вычищается. */




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

  /* ── уведомления ────────────────────────────────────────────── */
  const toastRoot = $('#toast-root');
  function toast(message, type = 'info', ttl = 3600) {
    const note = html(`<div class="toast toast--${type}" role="status">${escapeHtml(message)}</div>`);
    toastRoot.appendChild(note);
    const kill = () => {
      note.classList.add('is-out');
      setTimeout(() => note.remove(), 320);
    };
    setTimeout(kill, ttl);
    note.addEventListener('click', kill);
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
    const chips = g.chips
      .map((c, i) => `<span class="chip ${i === 1 ? 'chip--accent' : ''}">${escapeHtml(c)}</span>`)
      .join('');
    return html(`
      <article class="game-card ${g.kind === 'port' ? 'game-card--wip' : ''}"
               style="--accent:${g.accent}" data-id="${g.id}"
               tabindex="0" role="button" aria-label="${escapeHtml(g.title)}">
        <span class="game-card__scan"></span>
        <div class="game-card__icon">${I[g.icon]}</div>
        <h3 class="game-card__title">${g.title}</h3>
        <p class="game-card__desc">${g.desc}</p>
        <div class="game-card__chips">${chips}</div>
        <div class="game-card__foot">
          <span class="card-status"><i class="dot"></i><span class="card-status__text">файлы не загружены</span></span>
          ${g.badge ? `<span class="badge">${g.badge}</span>` : '<span class="card-arrow" aria-hidden="true">→</span>'}
        </div>
      </article>`);
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

  /* ═══════════════ DRAG-AND-DROP (event.dataTransfer) ═══════════════
     Любой .zip дропается прямо в зону — файлы читаются через
     e.dataTransfer.files. Перетаскивание папки обходится рекурсивно
     через FileSystemEntry API. */

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
    /* ЖЁСТКИЙ фикс Linux: принудительно снимаем атрибуты, блокирующие
       проводник, — на случай инъекций в разметку браузером/плагинами */
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

  /* ═══════════════ МОДАЛЬНЫЕ ОКНА (general) ═══════════════ */
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

      /* единственный инпут модального окна: одиночный .zip
         <input type="file" class="game-zip-input" accept=".zip"> */
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

      /* большая Drop Zone: .zip перехватывается через e.dataTransfer.files,
         папку вдогонку — рекурсивным обходом FileSystemEntry */
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
          const files = [...(dt.files || [])];            // .zip → dataTransfer.files
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
            if (set.count) { acceptFiles(zd.key, set); return; }
          }
          toast('Перетащите .zip архив мобильного кэша', 'warn');
        } catch (err) {
          toast('Не удалось прочитать файлы', 'err');
        }
      });

      renderZone(zone, zd, fs[zd.key]);
      return zone;
    }

    /* ── умная распаковка .zip (один или несколько архивов) ── */
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
          const targets = key === 'game' ? game.expect : null; // мод: всё дерево
          const res = await extractZipSet(zip, targets, (pct) => updateZoneProgress(zone, pct));
          if (!res.set || !res.set.count) {
            zone.classList.remove('is-busy');
            renderZone(zone, zd, fs[key]);
            toast('Ошибка: В архиве не найдена папка с файлами игры. Убедитесь, что загружаете правильный мобильный кэш', 'err', 6500);
            return;
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

      zone.classList.remove('is-busy');
      acceptFiles(key, makeFileSet(merged));
      if (skipped > 0) {
        toast(`Лишних файлов вне целевой папки: ${skipped} — очищены из памяти`, 'info', 4200);
      }
    }

    /* реальные проценты на неоновом прогресс-баре: «Распаковка: X%...» */
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
      toast(`${zd.label.replace('Загрузить ', 'Добавлено: ')} — ${filesLabel(set.count)}`, 'ok');
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
        ? 'всё готово — движок «Ха-кэш» ждёт команды'
        : `добавьте <b>${missing.join('</b> и <b>')}</b>, чтобы продолжить`;
    }
    updateLaunchState();

    btnLaunch.addEventListener('click', () => {
      unmountOverlay(overlay);
      setTimeout(() => openEngineModal(game, { game: fs.game, mod: fs.mod }), 300);
    });
  }

  /* ═══════════════ ОКНО ИНИЦИАЛИЗАЦИИ ДВИЖКА «ХА-КЭШ» ═══════════════ */
  function openEngineModal(game, fs) {
    if (!window.XashCore || !window.Module || !window.Module.FS) {
      toast('Ядро «Ха-кэш» не загружено — проверьте engine/xash.js', 'err', 5200);
      return;
    }

    const base = game.expect[0];
    const modRoot = fs.mod
      ? (window.XashCore.sanitizeDirName(fs.mod.root) || `${base}_mod`)
      : null;
    const args = window.XashCore.buildLaunchArgs(game.id, modRoot);
    const ctx = { base, modRoot, args };

    const overlay = html(`
      <div class="overlay overlay--engine" id="overlay-engine">
        <div class="modal modal--engine" role="dialog" aria-modal="true"
             aria-label="Инициализация движка Ха-кэш">
          <header class="modal__head">
            <div>
              <div class="modal__eyebrow">var Module · Module.FS · glue /xash.js</div>
              <h3 class="modal__title">Инициализация движка</h3>
              <div class="modal__sub">${escapeHtml(game.title)}</div>
            </div>
            <button class="icon-btn modal__close" data-close aria-label="Закрыть">${I.x}</button>
          </header>
          <div class="modal__body">
            <div class="engine__mounts" id="eng-mounts"></div>
            <div class="engine__stage-row">
              <span id="eng-stage">подготовка…</span>
              <span id="eng-pct">0%</span>
            </div>
            <div class="progress" id="eng-progress"><div class="progress__fill" id="eng-bar"></div></div>
            <div class="terminal" id="eng-log" aria-live="polite"></div>
          </div>
          <footer class="modal__foot engine__foot">
            <button class="btn btn--ghost btn--s" id="eng-cancel">ОТМЕНА</button>
            <div class="engine__done hidden" id="eng-done">
              <span class="ok-badge" id="eng-done-badge">${I.check}<span>движок готов</span></span>
              <button class="btn btn--bracket btn--s" id="eng-to-menu">ИГРАТЬ</button>
            </div>
          </footer>
        </div>
      </div>`);

    mountOverlay(overlay);

    const ui = {
      modal:   $('.modal', overlay),
      mounts:  $('#eng-mounts', overlay),
      stage:   $('#eng-stage', overlay),
      pct:     $('#eng-pct', overlay),
      bar:     $('#eng-bar', overlay),
      progress:$('#eng-progress', overlay),
      log:     $('#eng-log', overlay),
      cancel:  $('#eng-cancel', overlay),
      doneBox: $('#eng-done', overlay),
      doneBadge: $('#eng-done-badge', overlay),
      toMenu:  $('#eng-to-menu', overlay),
      closeX:  $('[data-close]', overlay),
    };

    ui.mounts.innerHTML = [
      `<span class="chip chip--accent">/xash/${escapeHtml(base)} · ${filesLabel(fs.game.count)}</span>`,
      fs.mod ? `<span class="chip chip--accent">overlay → ${filesLabel(fs.mod.count)}</span>` : '',
      `<span class="chip">-game ${escapeHtml(modRoot || base)}</span>`,
    ].join('');

    const run = { aborted: false, done: false };

    const tryClose = () => {
      if (!run.done && !run.aborted) {
        toast('Идёт инициализация — дождитесь завершения или нажмите «ОТМЕНА»', 'warn');
        return;
      }
      unmountOverlay(overlay);
    };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) tryClose(); });
    ui.closeX.addEventListener('click', tryClose);
    ui.cancel.addEventListener('click', () => { window.Module.abortedByUser = true; run.aborted = true; });

    overlay._engineRun = run;
    bootEngine(game, fs, ui, run, overlay, ctx);
  }

  /* ═══════════════ ЗАПУСК ЯДРА (Module + Module.FS) ═══════════════
     ТРУБНЫЙ порядок v1.4:
       1) контракт var Module (уже объявлен китом engine/xash.js)
       2) НАСТОЯЩИЙ glue /xash.js — ленивая загрузка, память подменена
          (xash.html.mem нет), noInitialRun → main() не запускается,
          monitorRunDependencies → честные проценты.
       3) побайтовое монтирование распакованных файлов в Module.FS
          через FS.createDataFile — в настоящий MEMFS Emscripten
          (= запасной эмулятор, если glue недоступен).
       4) liblist.gam + витрина мода → готовность → полноэкранный
          тихий WebGL-цикл с именами реальных файлов из FS. */
  async function bootEngine(game, fs, ui, run, overlay, ctx) {
    let proceeded = false;
    const Module = window.Module; // глобальный контракт Emscripten

    const t0 = performance.now();
    const cursorLine = html('<div class="log-line"><span class="t">&nbsp;</span><span class="term-cursor"></span></div>');
    ui.log.appendChild(cursorLine);
    const writeLog = (text, cls = '') => {
      const line = document.createElement('div');
      line.className = 'log-line' + (cls ? ' ' + cls : '');
      const stamp = document.createElement('span');
      stamp.className = 't';
      stamp.textContent = `[T+${((performance.now() - t0) / 1000).toFixed(3).padStart(7, '0')}s]`;
      line.append(stamp, document.createTextNode(text));
      ui.log.insertBefore(line, cursorLine);
      ui.log.scrollTop = ui.log.scrollHeight;
    };

    const setStage = (t) => { ui.stage.textContent = t; };
    const setBar = (pct) => {
      const v = Math.max(0, Math.min(100, pct));
      ui.bar.style.width = `${v}%`;
      ui.pct.textContent = `${Math.round(v)}%`;
    };

    /* этап 1: контракт + окружение */
    setStage('объявление var module');
    writeLog('boot: контракт var Module объявлен · кит ' + window.XashCore.CORE_VERSION, 'sys');
    const gpu = window.XashCore.probeGL();
    writeLog(`env: cpu ×${navigator.hardwareConcurrency || '?'} · gpu: ${gpu.renderer || 'n/a'} (${gpu.kind})`);
    await animateProgress(run, setBar, 0, 8, 620);
    if (run.aborted) return finishAbort();

    /* этап 2: НАСТОЯЩИЙ glue-движок (лениво, с честными run-dependencies) */
    setStage('загрузка ядра /xash.js');
    Module['arguments'] = ctx.args;
    Module['canvas'] = canvasEl;
    let depsMax = 0;
    Module['print'] = (t) => writeLog(t, '');
    Module['printErr'] = (t) => writeLog(t, 'err');
    Module['setStatus'] = (t) => setStage(t);
    Module['monitorRunDependencies'] = (left) => {
      depsMax = Math.max(depsMax, left);
      const frac = depsMax ? 1 - left / depsMax : 1;
      setBar(8 + frac * 28);
      setStage(`ядро: runtime · осталось зависимостей: ${left}`);
    };
    writeLog('argv: ' + ctx.args.join(' '), 'sys');

    let coreFS = null, realCore = false;
    try {
      const glued = await window.XashCore.loadRealGlue({ timeoutMs: 60000 });
      if (run.aborted) return finishAbort();
      coreFS = glued.FS;
      realCore = !!glued.real;
      writeLog('ядро: glue ' + window.XashCore.REAL_ENGINE_SRC + ' · runtime OK · настоящий MEMFS', 'ok');
    } catch (e) {
      if (run.aborted) return finishAbort();
      writeLog('ядро: ' + e.message + ' — перехожу на локальный эмулятор FS (тот же контракт)', 'sys');
      coreFS = Module.FS; // кит-эмулятор MemFS
    }
    Module['monitorRunDependencies'] = () => {};
    setBar(36);

    /* этап 3: побайтовое монтирование распакованных файлов в Module.FS */
    setStage('монтирование module.fs');
    const FS = coreFS;
    if (typeof FS.reset === 'function') FS.reset();
    try {
      await mountIntoFS(FS, ctx, fs, (frac) => setBar(36 + frac * 60), run, writeLog);
    } catch (e) {
      if (e.aborted) return finishAbort();
      writeLog('fs: ошибка монтирования — ' + e.message, 'err');
      toast('Ошибка монтирования файлов: ' + e.message, 'err', 5200);
      return finishAbort();
    }
    if (run.aborted) return finishAbort();

    /* этап 4: метаданные для сессии (liblist + счётчик файлов) */
    setStage('чтение liblist.gam');
    let title = game.title;
    const libPath = '/xash/' + (ctx.modRoot || ctx.base) + '/liblist.gam';
    try {
      if (FS.isFile(libPath)) {
        const parsed = window.XashCore.parseLiblist(FS.readFile(libPath, { encoding: 'utf8' }));
        if (parsed.title) title = parsed.title;
        writeLog(`liblist: game="${parsed.title || '?'}"${parsed.version ? ' · v' + parsed.version : ''}`, 'sys');
      }
    } catch (e) { writeLog('liblist: недоступна (' + e.message + ')', 'sys'); }
    const fileCount = window.XashCore.fsCountFiles(FS, '/xash');
    writeLog(`fs: смонтировано ${filesLabel(fileCount)} · FS: ${realCore ? 'настоящий MEMFS Emscripten' : 'локальный эмулятор'}`, 'ok');
    setBar(100);
    setStage('инициализация завершена');
    writeLog(`boot: движок онлайн · «${title}» · автономный холст без xash.html.mem`, 'ok');
    ui.modal.classList.add('is-done');
    ui.cancel.classList.add('hidden');
    ui.doneBox.classList.remove('hidden');
    run.done = true;

    const proceed = () => {
      if (proceeded) return;
      proceeded = true;
      unmountOverlay(overlay, () =>
        enterGameSession(game, { title, argv: ctx.args, fileCount }, { FS, gpu, realCore }));
    };
    ui.toMenu.onclick = proceed;
    setTimeout(proceed, 900);

    function finishAbort(reason) {
      run.aborted = true;
      setStage(reason || 'прервано пользователем');
      ui.progress.classList.add('is-aborted');
      writeLog('boot: ABORT — последовательность остановлена', 'err');
      ui.cancel.classList.add('hidden');
      ui.doneBox.classList.remove('hidden');
      ui.doneBadge.querySelector('span').textContent = 'прервано';
      ui.doneBadge.style.color = 'var(--amber)';
      ui.toMenu.textContent = 'В МЕНЮ';
      ui.toMenu.onclick = () => unmountOverlay(overlay);
    }
  }

  /* побайтовая запись FileSet'ов в Module.FS (любая реализация FS):
     база → /xash/<base>/, мод — поверх в ту же директорию с честным
     счётчиком перезаписей; каталог мода — symlink + liblist.gam. */
  async function mountIntoFS(FS, ctx, fs, onFrac, run, writeLog) {
    const { base, modRoot } = ctx;

    const totalBytes = (fs.game.size + (fs.mod ? fs.mod.size : 0)) || 1;
    let written = 0, overwritten = 0, lastUi = 0;

    const stripRoot = (set, path) =>
      (set.root && path.startsWith(set.root + '/')) ? path.slice(set.root.length + 1) : path;
    const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

    if (typeof FS.mkdirTree === 'function') FS.mkdirTree('/xash/' + base);
    else if (typeof FS.mkdir === 'function') { FS.mkdir('/xash'); FS.mkdir('/xash/' + base); }

    async function writeSet(set) {
      for (const it of set.items) {
        if (run.aborted) { const e = new Error('ABORT'); e.aborted = true; throw e; }
        const rel = stripRoot(set, it.path);
        if (!rel) { written += it.size; continue; }
        const target = '/xash/' + base + '/' + rel;
        const parent = parentOf(target);

        let bytes = it.file;
        if (!(bytes instanceof Uint8Array)) {
          bytes = new Uint8Array(await bytes.arrayBuffer()); // честные байты File/Blob
        }
        if (typeof FS.mkdirTree === 'function') FS.mkdirTree(parent);         // реальный FS не создаёт папки сам
        if (FS.analyzePath(target).exists) overwritten++;                     // overlay поверх оригинала — честно
        FS.createDataFile(parent, target.split('/').pop(), bytes, true, true, false);

        written += it.size;
        const now = performance.now();
        if (now - lastUi > 60) {
          onFrac(Math.min(1, written / totalBytes));
          lastUi = now;
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    await writeSet(fs.game);
    writeLog(`fs: /xash/${base} ← ${filesLabel(fs.game.count)} (${fmtBytes(fs.game.size)})`, 'ok');

    if (fs.mod) {
      await writeSet(fs.mod);
      writeLog(`fs: overlay → /xash/${base} · ${filesLabel(fs.mod.count)}, перезаписано оригиналов: ${overwritten}`, 'ok');
    }
    onFrac(1);

    if (fs.mod && modRoot) {
      if (typeof FS.mkdirTree === 'function') FS.mkdirTree('/xash/' + modRoot);
      else FS.mkdir('/xash/' + modRoot);
      let linked = 0;
      for (const it of fs.mod.items) {
        const rel = stripRoot(fs.mod, it.path);
        if (!rel) continue;
        const src = '/xash/' + base + '/' + rel;
        const dst = '/xash/' + modRoot + '/' + rel;
        if (FS.isFile(src) && !FS.analyzePath(dst).exists) {
          try { FS.symlink(src, dst); linked++; } catch (e) { /* FS без ссылок — живём */ }
        }
      }
      const libPath = '/xash/' + modRoot + '/liblist.gam';
      if (!FS.isFile(libPath)) {
        let title = fs.mod.root || modRoot;
        const baseLib = '/xash/' + base + '/liblist.gam';
        if (FS.isFile(baseLib)) {
          try {
            const parsed = window.XashCore.parseLiblist(FS.readFile(baseLib, { encoding: 'utf8' }));
            if (parsed.title) title = parsed.title;
          } catch (e) { /* имя папки */ }
        }
        FS.createDataFile('/xash/' + modRoot, 'liblist.gam',
          `// generated by hash-online portal\ngame "${title}"\ngamedir "${modRoot}"\nversion "1.0"\n`, true, true, false);
      }
      writeLog(`fs: /xash/${modRoot} · ссылок: ${linked} · liblist.gam готов`, 'sys');
    }
    return overwritten;
  }

  function animateProgress(run, setBar, from, to, dur) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const frame = (t) => {
        if (run.aborted) return resolve();
        const k = Math.min(1, (t - t0) / dur);
        setBar(from + (to - from) * (1 - Math.pow(1 - k, 3)));
        if (k < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  /* ═══════════════ ИГРОВАЯ СЕССИЯ (canvas на весь экран) ═══════════════ */
  let session = null;

  function enterGameSession(game, info, ctx) {
    // имена ресурсов — реальное содержимое Module.FS (createDataFile)
    const names = window.XashCore.collectResourceNames(ctx.FS, '/xash', 320);
    const renderer = window.XashCore.startRenderLoop(canvasEl, { names });

    $('#hud-title').textContent = info.title || game.title;
    $('#hud-args').textContent =
      `argv: ${info.argv.join(' ')} · gpu: ${(ctx.gpu && ctx.gpu.renderer) || renderer.renderer}` +
      ` · fs: ${info.fileCount} файлов · ${ctx.realCore ? 'real-core' : 'local-core'}`;
    $('#hud-fps').textContent = '— fps';

    session = { renderer };
    session.fpsTimer = setInterval(() => {
      if (session) $('#hud-fps').textContent =
        `${session.renderer.fps} fps · ${ctx.realCore ? 'xash-glue' : window.XashCore.CORE_VERSION}`;
    }, 500);

    switchScreen(menuScreen, gameScreen);
    setTimeout(() => canvasEl.focus({ preventScroll: true }), 420);
    toast(`Движок онлайн: «${info.title || game.title}»`, 'ok', 4200);
  }

  function exitGameSession() {
    if (document.pointerLockElement) document.exitPointerLock();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (session) {
      clearInterval(session.fpsTimer);
      session.renderer.stop();
      session = null;
    }
    $('#hud-fps').textContent = '— fps';
    switchScreen(gameScreen, menuScreen);
    toast('Сессия движка завершена — файлы остаются в библиотеке', 'ok');
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
        const engineRun = top._engineRun;
        if (engineRun && !engineRun.done && !engineRun.aborted) {
          toast('Идёт инициализация — дождитесь завершения или нажмите «ОТМЕНА»', 'warn');
          return;
        }
        unmountOverlay(top);
      }
    });

    $('#btn-exit').addEventListener('click', () => switchScreen(menuScreen, splashScreen));

    /* HUD: мыть / полный экран / выход */
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

