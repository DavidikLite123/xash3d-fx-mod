/* ════════════════════════════════════════════════════════════════
   HASH ONLINE · фронтенд-портал для движка «Ха-кэш»
   Кроссплатформенный браузерный клиент (десктоп / мобильные)

   Модули: toast → screens → cards → files (папки + умный .zip) →
           game-modal (динамические зоны + подсказки-ссылки) →
           engine-modal (boot-последовательность)

   Интерфейс работает в тишине: синтезированных звуков нет.
   Звук можно подключить позже штатными HTML5 <audio>-тегами,
   когда в проекте появятся реальные аудиофайлы.
   ════════════════════════════════════════════════════════════════ */
'use strict';

(() => {

  /* ── утилиты ────────────────────────────────────────────────── */
  const $  = (sel, root) => (root || document).querySelector(sel);
  const html = (markup) => {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstElementChild;
  };

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

  /* ── подсказки «где взять файлы» (только легальные источники) ──
     Для игр — официальные страницы + инструкция сборки кэша из
     собственной копии. Для модов — свободно распространяемые
     модификации и хабы сообществ. Все ссылки — target="_blank". */
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
        note: 'Бесплатные модификации, совместимые с движком «Ха-кэш»: скачайте .zip и загрузите в поле «Файлы мода» — содержимое наложится поверх оригинального кэша.',
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
        note: 'Бесплатные модификации, совместимые с движком «Ха-кэш»: скачайте .zip и загрузите в поле «Файлы мода» — содержимое наложится поверх оригинального кэша.',
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

  const JUNK_BASENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
  const isJunkPath = (name) => {
    const segs = String(name).split('/');
    return segs.some((s) => s === '__MACOSX') ||
           JUNK_BASENAMES.has((segs[segs.length - 1] || '').toLowerCase());
  };

  /* names: string[] путей из архива; targets: string[]|null целевые
     папки (null — оставить всё). Возвращает { picked:[{name,rel}], skipped } */
  function pickZipTargets(names, targets) {
    const picked = [];
    let skipped = 0;
    for (const name of names) {
      const segs = String(name).split('/').filter(Boolean);
      if (!segs.length) { skipped++; continue; }
      if (!targets) { picked.push({ name, rel: segs.join('/') }); continue; }
      const idx = segs.findIndex((s) => targets.includes(s.toLowerCase()));
      // целевая папка найдена И внутри неё есть хотя бы один файл
      if (idx === -1 || idx === segs.length - 1) { skipped++; continue; }
      picked.push({ name, rel: segs.slice(idx).join('/') });
    }
    return { picked, skipped };
  }

  /* Последовательная распаковка с динамическим прогрессом по байтам.
     zip — объект JSZip; onProgress(percent 0..100). */
  async function extractZipSet(zip, targets, onProgress) {
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && !isJunkPath(n));
    const { picked, skipped } = pickZipTargets(names, targets);
    if (targets && !picked.length) return { set: null, skipped }; // целевая папка не найдена

    // суммарный объём распаковки для точных процентов
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

  /* ── экспорт для Node-юнит-тестов (в браузере игнорируется) ──── */
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') {
      module.exports = { pickZipTargets, isJunkPath, extractZipSet, makeFileSet, fmtBytes };
    }
    return;
  }

  /* ═══════════════ НИЖЕ — ТОЛЬКО БРАУЗЕРНЫЙ КОД ═══════════════ */

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

  /* ── состояние библиотеки { gameId: { game: FileSet, mod: FileSet } } ── */
  const library = new Map();
  const libEntry = (id) => {
    if (!library.has(id)) library.set(id, { game: null, mod: null });
    return library.get(id);
  };

  const isGameReady = (g) => {
    const fs = libEntry(g.id);
    return g.kind === 'modified'
      ? !!(fs.game && fs.mod)
      : !!fs.game;
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

  /* ── переключение экранов ───────────────────────────────────── */
  const splashScreen = $('#screen-splash');
  const menuScreen   = $('#screen-menu');

  function switchScreen(from, to) {
    from.classList.remove('is-active');
    from.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      to.classList.add('is-active');
      to.removeAttribute('aria-hidden');
    }, 380); // мягкий кроссфейд
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

    // плитка [ ЕЩЁ ] — рядом с основными карточками
    mainGrid.appendChild(html(`
      <button class="game-card game-card--more" id="btn-more" aria-expanded="false" aria-controls="extra-wrap">
        <span class="game-card__scan"></span>
        <span class="more-plus" aria-hidden="true">+</span>
        <span class="more-label" id="more-label">ЕЩЁ</span>
        <span class="more-hint">модификации и порты</span>
      </button>`));

    for (const g of GAMES.filter((x) => x.place === 'extra')) extraGrid.appendChild(cardTpl(g));

    // события карточек
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

  /* ═══════════════ РАБОТА С ФАЙЛАМИ ═══════════════
     FileSet = { items:[{file,path,size}], count, size, root, byExt } */

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
    return {
      items,
      count: items.length,
      size,
      root: roots.size === 1 ? [...roots][0] : null,
      byExt,
    };
  }

  // выбор через системный диалог (папка целиком)
  function filesFromInput(fileList) {
    const items = [...fileList].map((f) => ({
      file: f,
      path: f.webkitRelativePath || f.name,
      size: f.size,
    }));
    return makeFileSet(items);
  }

  // рекурсивный обход перетаскиваемых директорий (Chromium FileSystemEntry API)
  async function readDropped(dt) {
    const entries = [...(dt.items || [])]
      .filter((i) => i.kind === 'file')
      .map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry())
      .filter(Boolean);

    if (!entries.length) {
      // запасной путь: плоский список файлов
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
          if (!batch.length) return resolve(); // readEntries отдаёт ≤100 за вызов
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

    /* ── динамический состав окна:
          обычная игра     → одна зона [ Загрузить файлы игры ]
          модифицированная → + вторая зона [ Загрузить файлы мода ] ── */
    const zoneDefs = [{ key: 'game', label: 'Загрузить файлы игры',
      hint: `папка мобильного кэша — <b>${game.expect[0]}/</b> · или .zip архив целиком<br>
             перетащите сюда, нажмите для выбора папки или
             <button type="button" class="zip-trigger">выберите .zip</button>` }];
    if (game.kind === 'modified') {
      zoneDefs.push({ key: 'mod', label: 'Загрузить файлы мода',
        hint: `ресурсы модификации — модели, текстуры, спрайты<br>
               папка или .zip архив мода · накладывается поверх кэша игры` });
    }

    // порядок: зона игры → подсказка «где скачать» → (зона мода → каталог)
    zonesBox.appendChild(buildZone(zoneDefs[0]));
    zonesBox.appendChild(buildLinksBlock('where', links.where));
    if (zoneDefs[1]) {
      zonesBox.appendChild(buildZone(zoneDefs[1]));
      zonesBox.appendChild(buildLinksBlock('mods', links.mods));
    }

    /* блоки-подсказки со ссылками (плавное раскрытие) */
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

      // системный выбор папки
      const dirInput = document.createElement('input');
      dirInput.type = 'file';
      dirInput.multiple = true;
      dirInput.className = 'visually-hidden';
      dirInput.setAttribute('webkitdirectory', '');
      dirInput.webkitdirectory = true;
      zone.appendChild(dirInput);

      // отдельный скрытый input под .zip архивы
      const zipInput = document.createElement('input');
      zipInput.type = 'file';
      zipInput.accept = '.zip,application/zip,application/x-zip-compressed';
      zipInput.className = 'visually-hidden';
      zone.appendChild(zipInput);

      dirInput.addEventListener('change', () => {
        if (!dirInput.files.length) return;
        acceptFiles(zd.key, filesFromInput(dirInput.files));
        dirInput.value = ''; // позволяет выбрать ту же папку повторно
      });
      zipInput.addEventListener('change', () => {
        if (!zipInput.files.length) return;
        handleZip(zd.key, zipInput.files[0]);
        zipInput.value = '';
      });

      zone.addEventListener('click', (e) => {
        if (e.target.closest('.upzone__clear')) return;
        if (e.target.closest('.zip-trigger')) { zipInput.click(); return; }
        dirInput.click();
      });
      zone.addEventListener('keydown', (e) => {
        if (e.target.closest('.zip-trigger')) return; // у кнопки свой Enter
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dirInput.click(); }
      });

      // drag & drop: папка — рекурсивный обход, одиночный .zip — распаковка
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-drag'); });
      zone.addEventListener('dragleave', (e) => {
        if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-drag');
      });
      zone.addEventListener('drop', async (e) => {
        e.preventDefault();
        zone.classList.remove('is-drag');
        try {
          const dropped = [...(e.dataTransfer.files || [])];
          if (dropped.length === 1 && /\.zip$/i.test(dropped[0].name)) {
            await handleZip(zd.key, dropped[0]);
            return;
          }
          const set = await readDropped(e.dataTransfer);
          if (set.count) acceptFiles(zd.key, set);
          else toast('Перетащите папку с файлами игры или .zip архив', 'warn');
        } catch (err) {
          toast('Не удалось прочитать файлы', 'err');
        }
      });

      renderZone(zone, zd, fs[zd.key]);
      return zone;
    }

    /* ── умная распаковка .zip любого размера ── */
    async function handleZip(key, file) {
      const zone = $(`.upzone[data-zone="${key}"]`, overlay);
      const zd = zoneDefs.find((z) => z.key === key);

      if (typeof JSZip === 'undefined') {
        toast('Ошибка: модуль распаковки архивов не загружен', 'err');
        return;
      }

      renderZoneBusy(zone, file);
      try {
        const zip = await JSZip.loadAsync(file);
        const targets = key === 'game' ? game.expect : null; // мод: оставляем всё
        const { set, skipped } = await extractZipSet(zip, targets, (pct) => {
          const bar = $('.zip-bar', zone);
          const num = $('.zip-pct', zone);
          if (bar) bar.style.width = `${pct}%`;
          if (num) num.textContent = pct;
        });

        zone.classList.remove('is-busy');

        if (!set || !set.count) {
          renderZone(zone, zd, fs[key]);
          toast('Ошибка: В архиве не найдена папка с файлами игры. Убедитесь, что загружаете правильный мобильный кэш', 'err', 6500);
          return;
        }

        acceptFiles(key, set);
        if (skipped > 0) {
          toast(`Лишних файлов вне целевой папки: ${skipped} — очищены из памяти`, 'info', 4200);
        }
      } catch (err) {
        zone.classList.remove('is-busy');
        renderZone(zone, zd, fs[key]);
        toast('Ошибка: не удалось прочитать .zip-архив — файл повреждён или это не zip', 'err', 5000);
      }
    }

    /* прогресс распаковки внутри зоны: «Распаковка архива: X%…» */
    function renderZoneBusy(zone, file) {
      const box = $('.upzone__content', zone);
      zone.classList.add('is-busy');
      box.innerHTML = `
        <div class="upzone__icon">${I.zip}</div>
        <div class="upzone__label"><span class="br">[</span>&nbsp;Распаковка архива: <b class="zip-pct">0</b>%&nbsp;<span class="br">]</span></div>
        <div class="upzone__zipname"><b>${escapeHtml(file.name)}</b> · ${fmtBytes(file.size)}</div>
        <div class="progress progress--s"><div class="progress__fill zip-bar" style="width:0%"></div></div>`;
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

      // топ-4 типа ресурсов для чипов (по количеству файлов)
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

    // мягкая валидация: подсказываем, если папка не похожа на мобильный кэш
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

    // кнопка ЗАПУСТИТЬ активна только при заполненных зонах
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
      setTimeout(() => openEngineModal(game, { ...fs }), 300);
    });
  }

  /* ═══════════════ ОКНО ИНИЦИАЛИЗАЦИИ ДВИЖКА «ХА-КЭШ» ═══════════════ */
  function openEngineModal(game, fs) {
    const overlay = html(`
      <div class="overlay overlay--engine" id="overlay-engine">
        <div class="modal modal--engine" role="dialog" aria-modal="true"
             aria-label="Инициализация движка Ха-кэш">
          <header class="modal__head">
            <div>
              <div class="modal__eyebrow">Ха-кэш · fx build · wasm/web</div>
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
              <button class="btn btn--bracket btn--s" id="eng-to-menu">В МЕНЮ</button>
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

    // чипы смонтированных томов — реальные данные выбранных папок
    const mountChips = [`<span class="chip">target: ${escapeHtml(game.id)}</span>`];
    mountChips.push(`<span class="chip chip--accent">/${escapeHtml(fs.game.root || 'game')} · ${filesLabel(fs.game.count)}</span>`);
    if (fs.mod) mountChips.push(`<span class="chip chip--accent">/${escapeHtml(fs.mod.root || 'mod')} · ${filesLabel(fs.mod.count)}</span>`);
    ui.mounts.innerHTML = mountChips.join('');

    const run = { aborted: false, done: false };

    // закрытие: только когда завершено или прервано
    const tryClose = () => {
      if (!run.done && !run.aborted) {
        toast('Идёт инициализация — дождитесь завершения или нажмите «ОТМЕНА»', 'warn');
        return;
      }
      unmountOverlay(overlay);
    };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) tryClose(); });
    ui.closeX.addEventListener('click', tryClose);
    ui.toMenu.addEventListener('click', tryClose);
    ui.cancel.addEventListener('click', () => { run.aborted = true; });

    overlay._engineRun = run;
    runSequence(game, fs, ui, run);
  }

  /* жизненный цикл загрузки: этапы используют реальные данные FileSet */
  function buildStages(game, fs) {
    const resInfo = (set) => ['wad', 'mdl', 'bsp', 'spr', 'wav']
      .map((e) => `${e}×${set.byExt.get(e) || 0}`).join(' ');

    const gl2 = (() => {
      try { return !!document.createElement('canvas').getContext('webgl2'); }
      catch { return false; }
    })();

    return [
      { to: 9,   dur: 750,  label: 'Инициализация ядра «Ха-кэш»',   cls: 'sys',
        log: 'xa-cache fx core · wasm bridge v1.1 · web abi' },
      { to: 17,  dur: 650,  label: 'Проверка окружения',
        log: `env: web runtime · ${navigator.hardwareConcurrency || '?'} cpu cores · webgl2 ${gl2 ? 'ok' : 'unavailable'}` },
      { to: 36,  dur: 1200, label: 'Монтирование виртуальной ФС',   cls: 'ok',
        log: `vfs: /${fs.game.root || 'game'} → ${filesLabel(fs.game.count)} (${fmtBytes(fs.game.size)})`,
        extra: fs.mod ? `vfs: /${fs.mod.root || 'mod'} → ${filesLabel(fs.mod.count)} (${fmtBytes(fs.mod.size)})` : null,
        extraCls: '' },
      { to: 55,  dur: 1100, label: 'Сканирование игровых ресурсов',
        log: `res[game]: ${resInfo(fs.game)}`,
        extra: fs.mod ? `res[mod]:  ${resInfo(fs.mod)}` : null },
      { to: 74,  dur: 1300, label: 'Кэширование текстур в видеопамять',
        log: 'gpu: texture cache warming … streaming ok' },
      { to: 88,  dur: 850,  label: 'Звуковая подсистема (html5 audio)',
        log: 'snd: 48 kHz stereo · voice pipeline ok' },
      { to: 97,  dur: 750,  label: 'Проверка целостности кэша',
        log: 'crc: verifying chunks … ok' },
      { to: 100, dur: 500,  label: 'Финализация',                   cls: 'ok',
        log: 'engine: state → READY ✓' },
    ];
  }

  async function runSequence(game, fs, ui, run) {
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

    writeLog(`target: ${game.title} (${game.id})`, 'sys');
    writeLog('boot: sequence started', '');

    let cur = 0;
    for (const st of buildStages(game, fs)) {
      if (run.aborted) return finishAbort();
      ui.stage.textContent = st.label;
      writeLog(typeof st.log === 'function' ? st.log() : st.log, st.cls || '');
      if (st.extra) writeLog(st.extra, st.extraCls != null ? st.extraCls : (st.cls || ''));
      cur = await animateProgress(ui, cur, st.to, st.dur, run);
      if (run.aborted) return finishAbort();
    }
    finishOk();

    function finishOk() {
      run.done = true;
      ui.modal.classList.add('is-done');
      ui.stage.textContent = 'инициализация завершена';
      writeLog('boot: виртуальная ФС смонтирована, движок в состоянии READY', 'ok');
      writeLog('hint: подключите wasm-сборку «Ха-кэш» для старта игровой сессии', 'sys');
      ui.cancel.classList.add('hidden');
      ui.doneBox.classList.remove('hidden');
    }

    function finishAbort() {
      ui.stage.textContent = 'прервано пользователем';
      ui.progress.classList.add('is-aborted');
      writeLog('boot: ABORT — последовательность остановлена', 'err');
      ui.cancel.classList.add('hidden');
      ui.doneBadge.querySelector('span').textContent = 'прервано';
      ui.doneBadge.style.color = 'var(--amber)';
      ui.doneBox.classList.remove('hidden');
    }
  }

  /* плавная анимация прогресс-бара между этапами */
  function animateProgress(ui, from, to, dur, run) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const frame = (t) => {
        if (run.aborted) return resolve(from + (to - from) * Math.min(1, (t - t0) / dur));
        const k = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - k, 3);
        const v = from + (to - from) * eased;
        ui.bar.style.width = `${v}%`;
        ui.pct.textContent = `${Math.round(v)}%`;
        if (k < 1) requestAnimationFrame(frame);
        else resolve(to);
      };
      requestAnimationFrame(frame);
    });
  }

  /* ── глобальные обработчики ─────────────────────────────────── */
  function bindGlobal() {
    // [ НАЧАТЬ ]
    $('#btn-start').addEventListener('click', () => {
      switchScreen(splashScreen, menuScreen);
    });

    // Enter на заставке / Escape закрывает верхнее окно
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

    // [ ВЫХОД ] → обратно на заставку
    $('#btn-exit').addEventListener('click', () => {
      switchScreen(menuScreen, splashScreen);
    });

    // запрет навигации при случайном дропе файлов мимо зон
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());
  }

  /* ── инициализация ──────────────────────────────────────────── */
  renderCards();
  bindGlobal();

})();
