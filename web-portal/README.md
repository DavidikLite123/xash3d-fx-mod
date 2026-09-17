# Hash Online · веб-портал

Автономный фронтенд + консолидированное локальное JS-ядро для игрового
портала **Hash Online** — браузерной оболочки движка **«Ха-кэш»**.
Кроссплатформенно: десктопные и мобильные браузеры, Linux в том числе
(см. раздел про инпуты). Работает **полностью офлайн**: внешних CDN нет.

## Структура

| Путь | Назначение |
|------|------------|
| `index.html` | Три экрана: заставка, меню, полноэкранный игровой холст `<canvas id="canvas">` |
| `style.css`  | Неоновая тема, GPU-анимации, HUD холста, 3D-лейблы ресурсов, адаптив |
| `app.js`     | UI-логика + боевой запуск: распаковка, монтирование в `Module.FS`, boot, игровая сессия |
| `engine/xash.js` | **Консолидированное локальное ядро** (v1.3): `var Module + Module.FS`, boot с run-dependencies, CRC32, liblist.gam — и интерактивный WebGL 3D-рендер |
| `server.js`  | Автономный dev-сервер (ноль зависимостей): COOP/COEP, MIME `.wasm` |
| `vendor/jszip.min.js` | Локальная JSZip 3.10.1 — умная распаковка .zip |
| `tests/run-tests.js`  | 62 проверки (Node, без зависимостей): `node tests/run-tests.js` |

## Ядро `engine/xash.js` (v1.3, консолидированное)

Один файл взамен прежних трёх модулей. Экспортирует `window.XashCore` и
настоящий Emscripten-глобал `var Module`:

* `var Module = { arguments, preRun/postRun, print, printErr, setStatus,
  monitorRunDependencies, onRuntimeInitialized, locateFile, wasmBinary }` —
  ровно та точка, куда официальный wasm-glue подключится без правок кода.
* `Module.FS` — эмуляция файловой системы Emscripten:
  `mkdir`, `mkdirTree`, **`createDataFile(parent, name, data, canRead, canWrite, canOwn)`**
  (name с `/` автоматически создаёт промежуточные папки), `readFile`
  (`{ encoding: 'utf8' }`), `readdir`, `stat`, `analyzePath`, `symlink`,
  `unlink`; плюс сервисные `isDir/isFile/exists`, `walkFiles`, `reset`, `stats`.
* `XashCore.run(Module)` — честный boot: argv, валидация `/xash/<gamedir>`,
  индексация ресурсов, CRC32-скан (совпадает с эталоном `zlib.crc32`),
  разбор `liblist.gam`; `monitorRunDependencies(left)` даёт настоящие
  проценты, `onRuntimeInitialized` — вход на холст.
* `XashCore.collectResourceNames(FS, dir, 320)` — реальные имена `.bsp/.wad/.mdl/.spr/.tga/…`
  из FS (дедуп, приоритетные типы впереди).
* `XashCore.startRenderLoop(canvas, { names })` — интерактивный WebGL2/WebGL
  3D-цикл: галька-«орбиты» из имён ресурсов, каркасная сетка-пол,
  Pointer Lock (yaw/pitch с инерцией), дрейф камеры без захвата,
  CPU-проецируемые неоновые лейблы `.res-label *` с циклом показа.
  Без GL — осмысленный 2D-fallback.

## Пайплайн запуска (честный, без симуляций)

1. Карточка → модальное окно: папка или `.zip`
   (раздельные Linux-safe инпуты `webkitdirectory directory` и `accept=".zip"`,
   плюс полноценный drag&drop через `event.dataTransfer` — и папки, и архивы).
2. `.zip` любого размера распаковывается с прогрессом
   «Распаковка игровых ассетов: X%…», целевая папка (`cstrike`/`valve`)
   ищется по ВСЕМУ дереву архива, остальное вычищается из памяти.
3. `[ ЗАПУСТИТЬ ]` → boot-окно: файлы **побайтово** пишутся в `Module.FS`
   через `FS.createDataFile`: `/xash/cstrike/`, `/xash/valve/`; мод
   накладывается поверх в ту же директорию (счётчик перезаписей — реальный),
   каталог мода получает symlink-дерево и сгенерированный `liblist.gam`.
4. `Module['arguments']` строго по ТЗ: `["-dev","3","-log"]`,
   `["-game","cstrike",-dev,3,-log]`, моды — `-game <имя_папки_мода>`.
5. `monitorRunDependencies` гонит честные проценты в прогресс-бар.
6. `onRuntimeInitialized` → модалка плавно скрывается, `<canvas>` на весь
   экран с фокусом; HUD: FPS-метр, захват мыши (Pointer Lock),
   полноэкранный режим, выход в меню. Тишина — без синтеза звука.

## Переход на официальный wasm

Заменить `engine/xash.js` на официальный glue и положить рядом `xash.wasm`
(путь уже разрешён через `Module.locateFile`) — `app.js` править не нужно.
`server.js` уже отдаёт `application/wasm` и изолирующие заголовки
`Cross-Origin-Opener-Policy: same-origin` /
`Cross-Origin-Embedder-Policy: require-corp` (готовность к wasm threads).

## Запуск

```bash
cd web-portal
node server.js            # $PORT по умолчанию 8080, биндинг 0.0.0.0
# открыть http://localhost:8080
```

Тесты: `node tests/run-tests.js` — 62 проверки чистых функций распаковки,
логики drag&drop и ядра `engine/xash.js` (mkdir / createDataFile, boot,
аргументы, лейблы ресурсов).
