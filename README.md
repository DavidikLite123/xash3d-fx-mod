# Hash Online · веб-портал на настоящем движке Xash3D FWGS

Браузерный портал для запуска **Half-Life** и **Counter-Strike 1.6** на
оригинальном скомпилированном движке **Xash3D FWGS** (Emscripten / asm.js
web-порт). Портал работает полностью офлайн: внешних CDN нет, всё ядро лежит
в корне репозитория.

> **Никакого собственного рендерера в проекте нет.** Единственный `<canvas id="canvas">`
> передаётся в Emscripten как `Module.canvas`, и графику игры рисует само
> скомпилированное ядро `xash.js`. Самодельный WebGL-«кит совместимости»
> (`engine/xash.js`) удалён полностью.

## Файлы движка (оригинальный web-порт Xash3D)

| Файл | Размер | Назначение |
|------|--------|------------|
| `xash.js` | ~7 МБ | скомпилированное клиентское ядро Xash3D FWGS (Emscripten glue, asm.js — wasm не нужен) |
| `xash.html.mem` | ~400 КБ | **инициализатор статической памяти ядра** — без него `main()` не запускается вообще |
| `server.js` | ~3 МБ | серверная игровая библиотека → регистрируется в `Module.DLFCN` как `server` |
| `client.js` | ~870 КБ | клиентская игровая библиотека → `Module.DLFCN` как `client` |
| `menu.js` | ~720 КБ | библиотека меню движка → `Module.DLFCN` как `menu` |

`xash.js` и `server.js` — те самые файлы, что были в репозитории; `xash.html.mem`,
`client.js` и `menu.js` — недостающие части **того же самого** web-порта
(Xash3D-Emscripten, build 1145, `emscripten-javascript`), без которых ядро
физически не могло стартовать. Все файлы идентичны оригиналу побайтово
(`git hash-object` совпадает с апстримом).

Движок распространяется под GPLv3 (© FWGS / Xash3D). **Игровые данные
(Half-Life, Counter-Strike) в репозиторий не входят** — пользователь
загружает свой мобильный кэш `.zip`.

## Порядок запуска (детерминированный, одиночный старт)

Ключевая деталь glue ядра: `main()` стартует автоматически, как только
применяется инициализатор памяти `xash.html.mem`. Поэтому `app.js` держит
этот момент под полным контролем «контролируемым»
`Module.memoryInitializerRequest` — объектом без `.response`, на который
glue вешает `addEventListener("load")` и создаёт run-dependency. До вызова
`releaseMemoryRequest()` **`main()` физически не может стартовать** —
иначе (как в старых ревизиях) ядро уезжало в `main()` с пустыми
`Module.arguments` ещё до монтирования файлов и падало с `abort()`.

1. **`var Module = { … }`** — глобальный контракт Emscripten собирается
   `ensureModule()` + `buildModuleConfig()` из `app.js` до загрузки ядра
   (защита от `TypeError: Cannot read properties of undefined (reading
   'push')` — `arguments`/`preRun`/`postRun` гарантированно массивы):
   ```js
   Module.canvas            = document.getElementById('canvas'); // холст напрямую в Emscripten
   Module.arguments         = ['-game','cstrike','+maxplayers','16'];   // строго, ДО ядра
   Module.TOTAL_MEMORY      = <авто-расчёт под размер кэша>;           // asm.js без ALLOW_MEMORY_GROWTH
   Module.websocket.url     = 'wsproxy://<host>/'; // сетевая часть движка
   Module.print / printErr / setStatus / monitorRunDependencies / onRuntimeInitialized
   ```
2. **`/xash.html.mem`** грузится XHR'ом в `ArrayBuffer` и оборачивается в
   *контролируемый* request: `Module.memoryInitializerRequest =
   createControlledMemoryRequest(buffer)` (status 0, без `.response`).
3. **`<script src="/xash.js">`** → затем **`/server.js` → `/client.js` →
   `/menu.js`** — цепочка ядра и библиотек движка. После каждого скрипта —
   контроль целостности (`__ATINIT__`, `Module.FS`, `Module.DLFCN`): если
   ядро не досчитало глобалов, библиотеки не упадут с крашем `.push`.
4. **Побайтовое монтирование в `Module.FS`** (настоящая MEMFS Emscripten):
   ОБЯЗАТЕЛЬНЫ две директории — базовые ассеты и игра:
   ```js
   FS.mkdir('/rodir/valve');                            // halflife.wad, gfx.wad, шрифты, звуки
   FS.mkdir('/rodir/cstrike');                          // cstrike.wad, maps/, models/, sound/
   FS.createDataFile('/rodir/cstrike/models/player', 'urban.mdl', uint8Array, true, true, true);
   FS.chdir('/rodir');
   ENV.XASH3D_BASEDIR = '/rodir';                       // движок chdir'ится туда
   ENV.XASH3D_GAMEDIR = 'cstrike';                      // или 'valve' / каталог мода
   ```
5. **Кнопка `[ ЗАПУСТИТЬ ]`** → `releaseMemoryRequest()`: glue применяет
   `xash.html.mem`, снимает run-dependency и сам вызывает `run()` →
   `main()` — единственный и корректный старт с полным argv. Движок создаёт
   WebGL-контекст на `#canvas`, выравнивает окно по холсту и запускает свой
   mainloop.

### Мышь: свободна в меню, захвачена в игре

* При старте и в меню Pointer Lock **не** включается автоматически —
  системный курсор свободен и виден (`canvas.style.cursor = 'default'`),
  кнопки меню (портала и движка) кликаются как обычно.
* Умный перехватчик: клик по холсту захватывает мышь **только** если матч
  активен (`isGameActive`) и движок сам её держит (`style.cursor ===
  'none'`, игровой режим). В меню движка (курсор `default`) клик остаётся
  обычным — мышь не крадётся.
* `Escape` или `` ` `` — курсор освобождается немедленно
  (`document.exitPointerLock()`).
* Кнопка HUD «ЗАХВАТ МЫШИ» — ручной захват/освобождение.

Вывод `Module.print` / `Module.printErr` показывается в панели загрузки и в
«Консоли движка» (кнопка в HUD или клавиша `` ` ``) — это настоящий лог ядра.

## Структура репозитория

| Путь | Назначение |
|------|------------|
| `index.html` | Три экрана: заставка, меню, игровой холст `<canvas id="canvas">` + консоль движка + панель инициализации ядра |
| `style.css`  | Тема портала, HUD, консоль движка, панель загрузки ядра (графики игры не касается) |
| `app.js`     | UI портала + боевой запуск настоящего ядра: распаковка `.zip`, побайтовое монтирование в `Module.FS` (`/rodir/valve` + `/rodir/cstrike`), `Module['arguments']`, контролируемый старт `main()` |
| `vendor/`    | `jszip.min.js` — локальная JSZip 3.10.1 (распаковка кэша) |
| `tests/`     | `run-tests.js` (132 проверки) + `smoke-real-engine.js` (боевой смоук настоящего `xash.js`, поток CS 1.6) |
| `dev-server.js` | Автономный dev-сервер (ноль зависимостей): COOP/COEP, MIME для `.mem`/`.wasm` |
| `public/`    | Те же файлы ядра для сборки `vite build` |

## Запуск

```bash
node dev-server.js        # корень репозитория → http://localhost:8080 (биндинг 0.0.0.0)
node tests/run-tests.js   # 132 проверки, включая боевой смоук настоящего /xash.js
```

Смоук (`tests/smoke-real-engine.js`) грузит оригинальные `xash.js` +
`xash.html.mem` + `server.js`/`client.js`/`menu.js` в Node со стабом DOM и
проверяет, что ядро **реально исполняется**: после загрузки всех скриптов
`Module.calledRun === false` (детерминированный standby — авто-старт с
пустыми аргументами исключён), затем `releaseMemoryRequest()` стартует
`main()` один раз со строгими аргументами CS 1.6; ядро печатает баннер
`Xash3D FWGS (build 1145, emscripten-javascript) started`, принимает
`/rodir` рабочей директорией и строит search path
`cstrike + valve` (`FS_AddGameHierarchy`). WebGL в Node нет, поэтому на
инициализации видео смоук останавливается — в браузере этот этап проходит
штатно.

## Что нужно знать про игровые данные

* **Half-Life**: архив с папкой `valve/` (включая `pak0.pak`, `gfx.wad`,
  `halflife.wad`, `liblist.gam`, `models/`, `sound/`, `maps/`).
* **Counter-Strike 1.6**: архив с папкой `cstrike/` **и** базовой папкой
  `valve/` (движку нужны `gfx.wad`, `halflife.wad` и шрифты из неё). Портал
  ищет обе папки по всему дереву архива и монтирует каждую в свой каталог ФС.
* **Моды**: второй архив накладывается побайтово поверх кэша игры; если
  корень архива не `valve/`/`cstrike/`, каталог мода монтируется как
  `/rodir/<имя_мода>` и запускается через `-game <имя_мода>` (при отсутствии
  `liblist.gam` портал создаёт минимальный).
* **Игровые библиотеки**: в поставку web-порта входят JS-библиотеки
  **Half-Life** (`server.js`/`client.js`). Нативные `dlls/cs.so` и
  `cl_dlls/client.so` из кэша CS 1.6 браузер загрузить не может, поэтому при
  `-game cstrike` движок запускается и загружает карты, но игровая логика
  берётся из доступной HL-библиотеки. Для полноценной логики CS нужны
  собранные под Emscripten библиотеки CS.
* **Память**: asm.js-ядро собирается без `ALLOW_MEMORY_GROWTH`, объём задаётся
  до старта (`Module.TOTAL_MEMORY`). По умолчанию считается автоматически
  от размера кэша (MEMFS держит все файлы побайтово: запас ×1.5 + 192 МБ
  headroom, минимум 256 МБ, потолок 2048 МБ); вручную — в окне загрузки
  игры (192 МБ … 2 ГБ) или через `#mem=512` в адресной строке.
* **Сеть**: `Module.websocket.url` указывает на websockify-прокси
  (`wsproxy://<host>/`). Локальный сервер (одиночная игра) работает без
  прокси; для подключения к внешним серверам нужен запущенный websockify.
* **Выход в меню**: asm.js-ядро нельзя корректно остановить без перезагрузки
  страницы — кнопка «В МЕНЮ» честно предлагает перезагрузку.

## Жёсткий фикс инпутов (Linux)

Атрибуты `webkitdirectory`/`directory` удалены **полностью** из проекта —
именно они блокировали проводник Linux. Инпут загрузки строго одиночный:

```html
<input type="file" class="game-zip-input" accept=".zip">
```

Плюс runtime-guard (`removeAttribute('webkitdirectory')`, `multiple = false`)
и большие Drop Zone: `.zip` любого размера перехватывается через
`e.dataTransfer.files`, папки — рекурсивным обходом `FileSystemEntry`.

## Умная распаковка .zip

1. Архив читается локальной JSZip (офлайн) независимо от размера.
2. Прогресс на неоновом баре: «Распаковка: X%» — по реальным байтам записей.
3. Целевые папки ищутся по всему дереву: `cstrike/` и `valve/` (CS 1.6) или
   `valve/` (Half-Life); мусор (`__MACOSX`, `.DS_Store`, чужие деревья) отсеивается.
4. Если папка не найдена: «Ошибка: В архиве не найдена папка с файлами игры.
   Убедитесь, что загружаете правильный мобильный кэш».
