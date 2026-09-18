/* ════════════════════════════════════════════════════════════════
   HASH ONLINE · ЧИТ-МЕНЮ ИГРОКА (Level Select + быстрые читы)
   для настоящего движка Xash3D FWGS (web-порт, Emscripten/asm.js)

   Как это работает (безопасно для игровой сессии):
     · команды НЕ исполняются напрямую в середине кадра движка — они
       ставятся в консольный буфер ядра: Cbuf_InsertText("cmd\n");
       движок выполнит их штатно в начале следующего Host-кадра;
     · если malloc-канал недоступен — фолбэки: Module.ccall('Cbuf_InsertText')
       → прямой _Cmd_ExecuteString (последний — только как крайний случай);
     · меню живёт поверх #screen-game, ввод глушится ТОЛЬКО пока меню
       открыто: capture-страж на window + bubble-стоп на панели;
     · при открытии Pointer Lock отпускается (системный курсор свободен),
       при закрытии захват восстанавливается обычным кликом по холсту —
       как и требует контракт мыши портала.

   Расширение: новые карты/кнопки/тумблеры добавляются ТОЛЬКО
   редактированием объекта CHEAT_CONFIG ниже — код UI не трогаем.
   ════════════════════════════════════════════════════════════════ */
'use strict';

/* ═══════════════ КОНФИГ · ВСЯ НАСТРОЙКА ЗДЕСЬ ═══════════════ */

const CHEAT_CONFIG = {

  ui: {
    title: 'МЕНЮ ИГРОКА',
    hudButtonText: 'ЧИТ-МЕНЮ',
    /* горячая клавиша ОТКРЫТИЯ (null — только кнопка в HUD); закрытие — всегда ESC */
    openHotkey: null,                 // например: 'F2' | 'KeyC' | 'Insert'
    /* показывать только карты, реально найденные в Module.FS (maps/*.bsp) */
    onlyInstalledMaps: false,
    /* каталоги игры в FS движка, где ищем установленные карты */
    mapDirs: ['cstrike', 'valve'],
    rootWithinFS: '/rodir',
  },

  /* Режим смены локации по умолчанию:
     'changelevel' — сменить карту на УЖЕ запущенном сервере;
     'map'         — запустить карту новым listen-сервером (работает всегда). */
  mapMode: 'changelevel',

  /* ── ВЫБОР КАРТЫ: дополняйте список { name, title?, mode? } ── */
  maps: [
    { name: 'de_dust2',    title: 'Dust II' },
    { name: 'de_dust',     title: 'Dust' },
    { name: 'de_inferno',  title: 'Inferno' },
    { name: 'de_nuke',     title: 'Nuke' },
    { name: 'de_aztec',    title: 'Aztec' },
    { name: 'de_cbble',    title: 'Cobble' },
    { name: 'de_train',    title: 'Train' },
    { name: 'de_vertigo',  title: 'Vertigo' },
    { name: 'de_prodigy',  title: 'Prodigy' },
    { name: 'de_survivor', title: 'Survivor' },
    { name: 'cs_office',   title: 'Office' },
    { name: 'cs_assault',  title: 'Assault' },
    { name: 'cs_italy',    title: 'Italy' },
    { name: 'cs_havana',   title: 'Havana' },
    { name: 'cs_militia',  title: 'Militia' },
    { name: 'cs_747',      title: '747' },
    { name: 'cs_backalley',title: 'Back Alley' },
    { name: 'cs_siege',    title: 'Siege' },
    { name: 'as_oilrig',   title: 'Oil Rig' },
  ],

  /* ── ЧЕИТ-РЕЖИМ ── */
  cheats: {
    cvar: 'sv_cheats',
    /* если чит-команда нажата при sv_cheats 0 — сначала послать "sv_cheats 1" */
    autoEnable: true,
  },

  /* ── ПЕРЕКЛЮЧАТЕЛИ (сама команда — триггер сервера, god/noclip сами
        переключают состояние: шлём ОДНУ и ту же команду на вкл и выкл) ── */
  toggles: [
    { id: 'god',    title: 'GOD MODE', hint: 'неуязвимость · команда god',    command: 'god',    requiresCheats: true, resetOnMap: true },
    { id: 'noclip', title: 'NOCLIP',   hint: 'полёт сквозь стены · команда noclip', command: 'noclip', requiresCheats: true, resetOnMap: true },
  ],

  /* ── КНОПКИ ДЕЙСТВИЙ: произвольные последовательности консольных команд ── */
  actions: [
    {
      id: 'arsenal', title: 'ПОЛНЫЙ АРСЕНАЛ', hint: 'impulse 101 + комплект оружия',
      requiresCheats: true,
      commands: [
        'impulse 101',            // CS: $16000 · HL: всё оружие+патроны
        'give weapon_ak47',
        'give weapon_m4a1',
        'give weapon_awp',
        'give weapon_deagle',
        'give weapon_mp5navy',
        'give weapon_knife',
      ],
    },
    {
      id: 'ammo', title: 'ПОПОЛНИТЬ БОЕПРИПАС', hint: 'циклическая выдача патронов всех типов',
      requiresCheats: true,
      /* Вариант для модов с командой givecurrentammo — замените массив на ['givecurrentammo'] */
      commands: [
        'give ammo_9mm',
        'give ammo_45acp',
        'give ammo_50ae',
        'give ammo_556nato',
        'give ammo_762nato',
        'give ammo_57mm',
        'give ammo_338mag',
        'give ammo_buckshot',
        'give ammo_357sig',
      ],
    },
    {
      id: 'restore', title: 'ЗДОРОВЬЕ И БРОНЯ', hint: 'аптечки + бронежилет/батареи',
      requiresCheats: true,
      commands: [
        'give item_assaultsuit',  // CS: кевлар+шлем
        'give item_kevlar',
        'give item_healthkit', 'give item_healthkit', 'give item_healthkit',
        'give item_healthkit', 'give item_healthkit', 'give item_healthkit',
        'give item_battery', 'give item_battery', 'give item_battery',
        'give item_battery', 'give item_battery',
      ],
    },
  ],

  /* технические ограничения протокола */
  proto: {
    maxCommandLen: 240,
    tokenRe: /^[\w.+-]+$/,           // то, что разрешено подставлять в шаблоны команд
    storageKey: 'hash-online.cheatmenu.v1',
  },
};

/* ═══════════════ ЧИСТЫЕ ФУНКЦИИ (тестируются в Node) ═══════════════ */

/** Нормализация одной консольной команды перед отправкой в движок. */
function normalizeCommand(raw, cfg = CHEAT_CONFIG) {
  const max = (cfg.proto && cfg.proto.maxCommandLen) || 240;
  // никаких переводов строк/управляющих символов — одна команда = одна строка
  const line = String(raw == null ? '' : raw).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.slice(0, max);
}

/** Токен, безопасный для подстановки в шаблон команды (имя карты и т.п.). */
function sanitizeToken(raw, cfg = CHEAT_CONFIG) {
  const s = String(raw == null ? '' : raw).trim();
  const re = (cfg.proto && cfg.proto.tokenRe) || /^[\w.+-]+$/;
  return re.test(s) ? s : '';                          // '' = токен недопустим
}

/** Команда смены локации: buildMapCommand('changelevel','de_dust2') → 'changelevel de_dust2'. */
function buildMapCommand(mode, mapName, cfg = CHEAT_CONFIG) {
  const token = sanitizeToken(mapName, cfg);
  if (!token) throw new Error('недопустимое имя карты: ' + JSON.stringify(mapName));
  const m = mode === 'map' ? 'map' : 'changelevel';
  return m + ' ' + token;
}

/** Стартовое состояние меню из конфига. */
function createCheatsState(cfg = CHEAT_CONFIG) {
  return {
    mapMode: cfg.mapMode === 'map' ? 'map' : 'changelevel',
    svCheats: false,                 // отражаемое значение cvar; true — после наших "sv_cheats 1"
    toggles: Object.fromEntries((cfg.toggles || []).map((t) => [t.id, false])),
  };
}

/** План команд для кнопки действия (чистая функция — что именно пошлём в движок). */
function planActionCommands(cfg, state, action) {
  const cmds = [];
  if (action.requiresCheats && !state.svCheats && cfg.cheats && cfg.cheats.autoEnable) {
    cmds.push((cfg.cheats.cvar || 'sv_cheats') + ' 1');
  }
  return cmds.concat(action.commands || []);
}

/** Применение плана к локальному состоянию (после успешной отправки). */
function applyActionToState(cfg, state, action) {
  if (action.requiresCheats && cfg.cheats && cfg.cheats.autoEnable) state.svCheats = true;
  return state;
}

/** План смены карты: команда + новое состояние (новый сервер/локация сбрасывают god/noclip). */
function planMapChange(cfg, state, mapName, modeOverride) {
  const entry = (cfg.maps || []).find((m) => m.name === mapName) || {};
  const mode = modeOverride || entry.mode || state.mapMode;
  const cmd = buildMapCommand(mode, mapName, cfg);
  const toggles = { ...state.toggles };
  for (const t of (cfg.toggles || [])) if (t.resetOnMap) toggles[t.id] = false;
  return { cmd, state: { ...state, toggles } };
}

/** Каким каналом доставлять команды в ядро (приоритет — безопасность). */
function pickCommandChannel(M) {
  if (M && typeof M._Cbuf_InsertText === 'function'
      && typeof M._malloc === 'function' && typeof M.writeAsciiToMemory === 'function') return 'cbuf';
  if (M && typeof M.ccall === 'function') return 'ccall';
  if (M && typeof M._Cmd_ExecuteString === 'function'
      && typeof M._malloc === 'function' && typeof M.writeAsciiToMemory === 'function') return 'exec';
  return null;
}

/**
 * Отправка ОДНОЙ команды в движок. Ничего не кидает наружу —
 * возвращает { ok, channel?, error? }; сессию не ломает даже при сбое.
 */
function execWithModule(M, rawCmd, cfg = CHEAT_CONFIG) {
  const cmd = normalizeCommand(rawCmd, cfg);
  if (!cmd) return { ok: false, error: 'пустая команда' };
  const channel = pickCommandChannel(M);
  if (!channel) return { ok: false, error: 'движок не готов: нет Cbuf_InsertText/ccall' };
  const line = cmd + '\n';                             // Cbuf: команда завершается '\n'
  try {
    if (channel === 'ccall') {
      M.ccall('Cbuf_InsertText', 'void', ['string'], [line]);
      return { ok: true, channel };
    }
    const fn = channel === 'cbuf' ? '_Cbuf_InsertText' : '_Cmd_ExecuteString';
    const ptr = M._malloc(4 * line.length + 8);        // 4 байта/символ — запас под UTF-8
    try { M.writeAsciiToMemory(line, ptr); M[fn](ptr); }
    finally { if (typeof M._free === 'function') M._free(ptr); }
    return { ok: true, channel };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/** Слияние карт из конфига с найденными в FS картами (maps/*.bsp), без дублей. */
function mergeMapList(cfgMaps, discoveredNames, cfg = CHEAT_CONFIG) {
  const out = [];
  const seen = new Set();
  const push = (name, title) => {
    const token = sanitizeToken(name, cfg);
    if (!token || seen.has(token)) return;
    seen.add(token);
    out.push(title ? { name: token, title } : { name: token });
  };
  for (const m of (cfgMaps || [])) push(m.name, m.title);
  for (const n of (discoveredNames || [])) push(String(n).replace(/\.bsp$/i, ''));
  return out;
}

/* ═══════════════ БРАУЗЕРНАЯ ЧАСТЬ (UI поверх #screen-game) ═══════════════ */

function initCheatMenu(cfg = CHEAT_CONFIG) {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const gameScreen = $('#screen-game');
  const hudRight = $('.game-hud__right', gameScreen || document);
  const canvasEl = $('#canvas');
  if (!gameScreen || !hudRight) return null;           // страница без игрового экрана

  const state = createCheatsState(cfg);
  const ui = { open: false, guard: null, closeTimer: 0, lastFocus: null };

  /* ── хранилище состояния sv_cheats между сессиями страницы ── */
  const store = {
    load() {
      try { const j = JSON.parse(localStorage.getItem(cfg.proto.storageKey) || '{}');
        if (typeof j.svCheats === 'boolean') state.svCheats = j.svCheats; } catch (e) {}
    },
    save() {
      try { localStorage.setItem(cfg.proto.storageKey, JSON.stringify({ svCheats: state.svCheats })); } catch (e) {}
    },
  };
  store.load();

  /* ── статус-строка меню ── */
  let statusEl = null;
  const say = (text, isErr) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('xcheat__status--err', !!isErr);
  };

  /* ── мост в движок: серия команд с честным отчётом ── */
  const engineExecAll = (cmds, label) => {
    const M = window.Module;
    let done = 0, firstErr = null;
    for (const c of cmds) {
      const r = execWithModule(M, c, cfg);
      if (!r.ok && !firstErr) firstErr = r.error;
      else if (r.ok) done++;
    }
    if (firstErr) say((label || 'команда') + ': ' + firstErr, true);
    else say('→ ' + (label || cmds[cmds.length - 1] || 'ok'));
    return !firstErr;
  };

  /* ── построение DOM (один раз) ── */
  const root = document.createElement('div');
  root.id = 'xcheat';
  root.className = 'xcheat';
  root.hidden = true;
  root.innerHTML = `
    <div class="xcheat__backdrop" data-xcheat-close></div>
    <div class="xcheat__panel" role="dialog" aria-modal="true" aria-labelledby="xcheat-title">
      <header class="xcheat__head">
        <div class="xcheat__title" id="xcheat-title">${cfg.ui.title}</div>
        <button class="xcheat__close" type="button" data-xcheat-close aria-label="Закрыть (ESC)">✕</button>
      </header>

      <div class="xcheat__body">
        <section class="xcheat__section">
          <div class="xcheat__section-head">
            <span>ВЫБОР КАРТЫ</span>
            <select class="xcheat__mode" data-xcheat="mapmode" title="Режим запуска карты">
              <option value="changelevel">changelevel · на текущем сервере</option>
              <option value="map">map · новый сервер</option>
            </select>
          </div>
          <input class="xcheat__filter" data-xcheat="filter" type="text"
                 placeholder="фильтр карт… (de_dust2)" autocomplete="off" spellcheck="false" />
          <div class="xcheat__maps" data-xcheat="maps"></div>
        </section>

        <section class="xcheat__section">
          <div class="xcheat__section-head"><span>ЧИТ-РЕЖИМ</span></div>
          <label class="xcheat-switch">
            <input type="checkbox" data-xcheat="svcheats" />
            <span class="xcheat-switch__track"><span class="xcheat-switch__thumb"></span></span>
            <span class="xcheat-switch__label">${cfg.cheats.cvar} <em data-xcheat="svcheats-val">0</em></span>
          </label>
          <div class="xcheat__toggles" data-xcheat="toggles"></div>
        </section>

        <section class="xcheat__section">
          <div class="xcheat__section-head"><span>СНАРЯЖЕНИЕ И ПАТРОНЫ</span></div>
          <div class="xcheat__actions" data-xcheat="actions"></div>
        </section>
      </div>

      <footer class="xcheat__foot">
        <span class="xcheat__status" data-xcheat="status">готово · ESC — закрыть</span>
      </footer>
    </div>`;
  document.body.appendChild(root);
  const panel = $('.xcheat__panel', root);
  statusEl = $('[data-xcheat="status"]', root);

  /* карты: сетка кнопок по конфигу (+ автопоиск в FS при открытии) */
  const mapsBox = $('[data-xcheat="maps"]', root);
  let mapButtons = [];
  const rebuildMaps = () => {
    const discovered = discoverMapsInFS();
    const list = (cfg.ui.onlyInstalledMaps && discovered.length)
      ? discovered.map((n) => ({ name: n }))
      : mergeMapList(cfg.maps, discovered, cfg);
    mapsBox.innerHTML = '';
    mapButtons = list.map((m) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'xcheat__map'; b.dataset.map = m.name;
      b.innerHTML = `<span class="xcheat__map-title">${m.title || m.name}</span><span class="xcheat__map-name">${m.name}</span>`;
      mapsBox.appendChild(b);
      return b;
    });
    applyFilter($('[data-xcheat="filter"]', root).value);
  };
  const discoverMapsInFS = () => {
    const out = [];
    const M = window.Module;
    try {
      if (M && M.FS && typeof M.FS.readdir === 'function') {
        for (const dir of (cfg.ui.mapDirs || [])) {
          try {
            for (const f of M.FS.readdir(`${cfg.ui.rootWithinFS}/${dir}/maps`)) {
              if (/\.bsp$/i.test(f)) out.push(f.replace(/\.bsp$/i, ''));
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    return [...new Set(out)];
  };

  /* переключатели god/noclip */
  const togglesBox = $('[data-xcheat="toggles"]', root);
  for (const t of cfg.toggles) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'xcheat__toggle'; b.dataset.toggle = t.id;
    b.innerHTML = `<span class="xcheat__toggle-led"></span><span class="xcheat__toggle-title">${t.title}</span><span class="xcheat__toggle-hint">${t.hint}</span>`;
    togglesBox.appendChild(b);
  }
  const paintToggles = () => {
    togglesBox.querySelectorAll('.xcheat__toggle').forEach((b) => {
      b.classList.toggle('is-on', !!state.toggles[b.dataset.toggle]);
    });
  };
  togglesBox.addEventListener('click', (e) => {
    const b = e.target.closest('.xcheat__toggle');
    if (!b) return;
    const t = cfg.toggles.find((x) => x.id === b.dataset.toggle);
    if (!t) return;
    const cmds = [];
    if (t.requiresCheats && !state.svCheats && cfg.cheats.autoEnable) {
      cmds.push(cfg.cheats.cvar + ' 1');
    }
    cmds.push(t.command);
    if (engineExecAll(cmds, `${t.title}: ${cmds[cmds.length - 1]}`)) {
      if (t.requiresCheats && cfg.cheats.autoEnable) { state.svCheats = true; paintCheats(); store.save(); }
      state.toggles[t.id] = !state.toggles[t.id];
      paintToggles();
    }
  });

  /* кнопки действий (арсенал/патроны/восстановление) */
  const actionsBox = $('[data-xcheat="actions"]', root);
  for (const a of cfg.actions) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'xcheat__action'; b.dataset.action = a.id;
    b.innerHTML = `<span class="xcheat__action-title">${a.title}</span><span class="xcheat__action-hint">${a.hint}</span>`;
    actionsBox.appendChild(b);
  }
  actionsBox.addEventListener('click', (e) => {
    const b = e.target.closest('.xcheat__action');
    if (!b) return;
    const a = cfg.actions.find((x) => x.id === b.dataset.action);
    if (!a) return;
    const cmds = planActionCommands(cfg, state, a);
    if (engineExecAll(cmds, a.title)) {
      applyActionToState(cfg, state, a);           // авто-включённый sv_cheats → отражаем
      paintCheats(); store.save();
    }
  });

  /* sv_cheats-тумблер */
  const svBox = $('[data-xcheat="svcheats"]', root);
  const svVal = $('[data-xcheat="svcheats-val"]', root);
  const paintCheats = () => { svBox.checked = state.svCheats; svVal.textContent = state.svCheats ? '1' : '0'; };
  svBox.addEventListener('change', () => {
    const on = svBox.checked;
    if (engineExecAll([`${cfg.cheats.cvar} ${on ? 1 : 0}`], `${cfg.cheats.cvar} ${on ? 1 : 0}`)) {
      state.svCheats = on; paintCheats(); store.save();
    } else {
      paintCheats();                                   // вернуть переключатель при сбое
    }
  });

  /* режим запуска карт */
  const modeSel = $('[data-xcheat="mapmode"]', root);
  modeSel.value = state.mapMode;
  modeSel.addEventListener('change', () => { state.mapMode = modeSel.value; });

  /* фильтр карт */
  const filterEl = $('[data-xcheat="filter"]', root);
  const applyFilter = (q) => {
    const needle = String(q || '').trim().toLowerCase();
    for (const b of (mapButtons || [])) {
      const hit = !needle || b.dataset.map.toLowerCase().includes(needle)
        || (b.querySelector('.xcheat__map-title').textContent || '').toLowerCase().includes(needle);
      b.hidden = !hit;
    }
  };
  filterEl.addEventListener('input', () => applyFilter(filterEl.value));
  filterEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = mapButtons.find((b) => !b.hidden);
      if (first) first.click();
      e.preventDefault();
    }
  });

  /* клик по карте */
  mapsBox.addEventListener('click', (e) => {
    const b = e.target.closest('.xcheat__map');
    if (!b) return;
    try {
      const plan = planMapChange(cfg, state, b.dataset.map, null);
      if (engineExecAll([plan.cmd], plan.cmd)) {
        Object.assign(state, plan.state);
        paintToggles();
      }
    } catch (err) { say(err.message, true); }
  });

  /* чтение реального sv_cheats из движка при открытии (если ядро это позволяет) */
  const syncCheatsFromEngine = () => {
    const M = window.Module;
    if (!M || typeof M._Cvar_VariableValue !== 'function'
        || typeof M._malloc !== 'function' || typeof M.writeAsciiToMemory !== 'function') return;
    const name = cfg.cheats.cvar + '\0';
    const ptr = M._malloc(name.length);
    try {
      M.writeAsciiToMemory(cfg.cheats.cvar, ptr);
      state.svCheats = M._Cvar_VariableValue(ptr) !== 0;
    } catch (e) { /* чтение недоступно — остаёмся на локальном состоянии */ }
    finally { if (typeof M._free === 'function') M._free(ptr); }
  };

  /* ── страж ввода: пока меню открыто, движок не получает клавиатуру ── */
  const installInputGuard = () => {
    if (ui.guard) return;
    const guard = (e) => {
      if (e.type === 'keydown' && (e.key === 'Escape' || e.key === 'Esc')) {
        e.preventDefault(); e.stopImmediatePropagation();
        close();                                       // ESC — закрытие, движку клавиша не уходит
        return;
      }
      if (panel.contains(e.target)) return;            // внутри меню — работает штатно
      e.stopImmediatePropagation();                    // снаружи — глушим (не попадает в SDL)
    };
    for (const t of ['keydown', 'keyup', 'keypress']) window.addEventListener(t, guard, true);
    /* клавиши, родившиеся ВНУТРИ панели, не должны всплывать до слушателей движка */
    const stopBubble = (e) => { if (e.key !== 'Escape' && e.key !== 'Esc') e.stopPropagation(); };
    for (const t of ['keydown', 'keyup', 'keypress']) panel.addEventListener(t, stopBubble);
    ui.guard = () => {
      for (const t of ['keydown', 'keyup', 'keypress']) window.removeEventListener(t, guard, true);
      for (const t of ['keydown', 'keyup', 'keypress']) panel.removeEventListener(t, stopBubble);
      ui.guard = null;
    };
  };

  /* ── открытие/закрытие ── */
  const open = () => {
    if (ui.open) return;
    ui.open = true;
    ui.lastFocus = document.activeElement;
    if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) {} }
    rebuildMaps();
    syncCheatsFromEngine();
    paintCheats();
    paintToggles();
    root.hidden = false;
    requestAnimationFrame(() => root.classList.add('xcheat--open'));
    installInputGuard();
    filterEl.focus({ preventScroll: true });
  };
  const close = () => {
    if (!ui.open) return;
    ui.open = false;
    root.classList.remove('xcheat--open');
    clearTimeout(ui.closeTimer);
    ui.closeTimer = setTimeout(() => { root.hidden = true; }, 160);
    if (ui.guard) ui.guard();
    const back = (ui.lastFocus && document.contains(ui.lastFocus)) ? ui.lastFocus : canvasEl;
    if (back && back.focus) { try { back.focus({ preventScroll: true }); } catch (e) {} }
  };
  root.addEventListener('click', (e) => { if (e.target.closest('[data-xcheat-close]')) close(); });

  /* ── кнопка вызова в HUD игрового экрана ── */
  const hudBtn = document.createElement('button');
  hudBtn.type = 'button';
  hudBtn.className = 'hud-btn';
  hudBtn.id = 'hud-cheats';
  hudBtn.textContent = cfg.ui.hudButtonText;
  const exitBtn = $('#hud-exit', hudRight);
  hudRight.insertBefore(hudBtn, exitBtn || null);
  hudBtn.addEventListener('click', open);

  /* опциональная горячая клавиша открытия (закрытие — всегда ESC из стража) */
  if (cfg.ui.openHotkey) {
    window.addEventListener('keydown', (e) => {
      if (e.code === cfg.ui.openHotkey && !ui.open && gameScreen.classList.contains('is-active')) {
        e.preventDefault();
        open();
      }
    }, true);
  }

  /* меню имеет смысл только на игровом экране: следим за переключением экранов */
  const syncWithScreen = () => {
    const inGame = gameScreen.classList.contains('is-active');
    hudBtn.hidden = !inGame;
    if (!inGame) close();
  };
  new MutationObserver(syncWithScreen).observe(gameScreen, { attributes: true, attributeFilter: ['class'] });
  syncWithScreen();

  return { open, close, isOpen: () => ui.open, state };
}

/* авто-инициализация в браузере (в Node — только чистые функции) */
if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById) {
  const boot = () => { try { window.CheatMenu = initCheatMenu(CHEAT_CONFIG); } catch (e) {
    console.error('[cheat-menu] инициализация не удалась:', e);
  } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

/* ── экспорт для Node-тестов и ESM (паттерн как в app.js) ── */
const __cheatTestExports = {
  CHEAT_CONFIG, normalizeCommand, sanitizeToken, buildMapCommand,
  createCheatsState, planActionCommands, applyActionToState, planMapChange,
  pickCommandChannel, execWithModule, mergeMapList,
};
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = __cheatTestExports;
}
export {
  CHEAT_CONFIG, normalizeCommand, sanitizeToken, buildMapCommand,
  createCheatsState, planActionCommands, applyActionToState, planMapChange,
  pickCommandChannel, execWithModule, mergeMapList, initCheatMenu,
};
