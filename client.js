/**
 * ui-zoom — масштаб интерфейса Harness по Ctrl+= / Ctrl+- / Ctrl+0.
 *
 * Механизм: CSS-свойство zoom на корневом элементе документа. Оно масштабирует
 * разом и текст, и геометрию всего интерфейса, включая оверлеи, и остаётся
 * согласованным с попаданием курсора, в отличие от transform: scale.
 *
 * Клиентский фасад контекста даёт только `ctx.get` / `ctx.on` / `ctx.provide`,
 * поэтому сервисы берутся через `ctx.get`, а ресурсы освобождаются через `ctx.on('dispose')`.
 * Значение масштаба живёт на устройстве в localStorage: хосту писать нечего.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ui-tweaks',
  factory(require) {
    const React = require('react');

    /* #region zoom-model */
    /** Границы и шаг масштаба; 1 — исходный размер интерфейса. */
    const ZOOM_MIN = 0.5;
    const ZOOM_MAX = 2;
    const ZOOM_STEP = 0.05;
    /** Ключ хранения: у каждого устройства и профиля свой масштаб. */
    const STORAGE_KEY = 'dsh.ui-zoom.v1';
    /** Сколько миллисекунд висит индикатор после последнего изменения. */
    const HINT_MS = 1200;

    /**
     * Привести масштаб к допустимому диапазону и точности шага.
     * @param {number} value - желаемый масштаб.
     * @returns {number} масштаб в границах ZOOM_MIN..ZOOM_MAX, округлённый до сотых.
     */
    function clampZoom(value) {
      if (!Number.isFinite(value)) return 1;
      const bounded = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
      return Math.round(bounded * 100) / 100;
    }

    /**
     * Следующий масштаб в заданную сторону.
     * @param {number} current - текущий масштаб.
     * @param {number} direction - 1 увеличить, -1 уменьшить.
     * @returns {number} новый масштаб.
     */
    function stepZoom(current, direction) {
      return clampZoom(Math.round((current + direction * ZOOM_STEP) * 100) / 100);
    }

    /**
     * Подпись масштаба для индикатора.
     * @param {number} zoom - текущий масштаб.
     * @returns {string} проценты, например «110%».
     */
    function formatZoom(zoom) {
      return `${Math.round(zoom * 100)}%`;
    }
    /* #endregion zoom-model */

    /** Слова команд, индикатора и меню; локаль без перевода показывает английский. */
    const DICTIONARIES = {
      en: {
        'zoom.in': 'Increase interface size',
        'zoom.out': 'Decrease interface size',
        'zoom.reset': 'Reset interface size (100%)',
        'zoom.hint': 'Interface size',
        'menu.undo': 'Undo',
        'menu.redo': 'Redo',
        'menu.cut': 'Cut',
        'menu.copy': 'Copy',
        'menu.paste': 'Paste',
        'menu.selectAll': 'Select All',
      },
      ru: {
        'zoom.in': 'Увеличить размер интерфейса',
        'zoom.out': 'Уменьшить размер интерфейса',
        'zoom.reset': 'Сбросить размер интерфейса (100%)',
        'zoom.hint': 'Размер интерфейса',
        'menu.undo': 'Отменить',
        'menu.redo': 'Повторить',
        'menu.cut': 'Вырезать',
        'menu.copy': 'Копировать',
        'menu.paste': 'Вставить',
        'menu.selectAll': 'Выделить всё',
      },
    };

    /** Стиль индикатора: только токены темы, поэтому он следует светлой и тёмной схеме. */
    const HINT_STYLE = {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: 2147483000,
      boxSizing: 'border-box',
      minWidth: '64px',
      padding: '8px 14px',
      border: '0.5px solid var(--dsw-alias-border-l2)',
      borderRadius: '12px',
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      font: '400 14px/22px system-ui, sans-serif',
      fontVariantNumeric: 'tabular-nums',
      textAlign: 'center',
      pointerEvents: 'none',
    };

    /**
     * Общее состояние масштаба: чтение, запись, подписчики.
     * @param {Storage | null} storage - хранилище значений или null, если недоступно.
     * @returns {object} контроллер масштаба.
     */
    function createZoomStore(storage) {
      let zoom = read();
      const listeners = new Set();

      /** Прочитать сохранённый масштаб, игнорируя испорченное значение. */
      function read() {
        try {
          const raw = storage?.getItem(STORAGE_KEY);
          if (raw === null || raw === undefined) return 1;
          return clampZoom(Number.parseFloat(raw));
        } catch (_error) {
          return 1;
        }
      }

      return {
        get: () => zoom,
        /**
         * Записать масштаб и уведомить подписчиков.
         * @param {number} next - желаемый масштаб.
         * @returns {number} применённый масштаб.
         */
        set(next) {
          const value = clampZoom(next);
          if (value === zoom) return zoom;
          zoom = value;
          try {
            storage?.setItem(STORAGE_KEY, String(value));
          } catch (_error) {
            /* приватный режим или запрет записи: масштаб остаётся на время сессии */
          }
          for (const listener of listeners) listener();
          return zoom;
        },
        /** Перечитать значение из хранилища, например после правки в другой вкладке. */
        reload() {
          const value = read();
          if (value === zoom) return;
          zoom = value;
          for (const listener of listeners) listener();
        },
        /**
         * Подписаться на изменения.
         * @param {Function} listener - обработчик изменения.
         * @returns {Function} отписка.
         */
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    /**
     * Развернуть масштаб: значение, команды, индикатор.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {Function} markReady - отметка этапа инициализации.
     * @returns {void}
     */
    function setup(ctx, markReady) {
        const html = document.documentElement;
        let storage = null;
        try {
          storage = window.localStorage;
        } catch (_error) {
          storage = null;
        }
        const store = createZoomStore(storage);
        const locale = ctx.get('locale');
        const slots = ctx.get('slots');
        const t = typeof locale?.bind === 'function' ? locale.bind('ui-zoom') : (key) => key;
        const cleanups = [];

        /**
         * Подпись из словаря плагина.
         *
         * Штатный переводчик отдаёт сам ключ, если словарь ещё не успел подключиться
         * (так бывает при перезагрузке модуля в живую страницу): пользователь видел
         * «menu.copy» вместо «Copy». Поэтому, не получив перевода, берём текст из
         * собственного словаря по активной локали.
         * @param {string} key - ключ словаря.
         * @returns {string} подпись для показа.
         */
        const translate = (key) => {
          const translated = t(key);
          if (translated !== key) return translated;
          let active = '';
          try {
            const snapshot = locale?.getLocale?.() ?? locale?.getSnapshot?.();
            active = String(snapshot?.active ?? '');
          } catch (_error) {
            active = '';
          }
          const dictionary = active.toLowerCase().startsWith('ru') ? DICTIONARIES.ru : DICTIONARIES.en;
          return dictionary[key] ?? DICTIONARIES.en[key] ?? key;
        };

        markReady('loaded');

        /* #region zoom-apply */
        /** Движок поддерживает CSS `zoom`; иначе масштаб даётся трансформацией. */
        const zoomSupported =
          typeof CSS === 'undefined' || typeof CSS.supports !== 'function' ? true : CSS.supports('zoom', '1.5');

        /**
         * Контейнер, к которому применяется масштаб.
         *
         * Это корень приложения, а не `body`: носителем интерфейса распоряжается
         * приложение, и подмена его размеров (нужная, чтобы интерфейс вписался
         * в окно) на `body` ломает вёрстку. Попапы, которые приложение монтирует
         * порталами прямо в `body` мимо корня, получают масштаб отдельно
         * (см. `applyPopupZoom`).
         * @returns {Element} элемент-носитель масштаба.
         */
        const zoomHost = () => document.getElementById('root') ?? document.body ?? html;

        /**
         * Применить масштаб к интерфейсу.
         *
         * Значение ставится прямо в inline-стиль: через CSS-переменную
         * (`zoom: var(--… )`) оно не пересчитывается, поэтому интерфейс оставался
         * прежним, хотя отметка размера менялась.
         *
         * Размеры носителя не трогаются: движок сам отдаёт содержимому логическую
         * ширину `ширина / масштаб`, поэтому интерфейс заполняет окно. Проверено
         * в живом приложении: с компенсацией размеров (`calc(100% / k)`) интерфейс
         * при 125% сжимался до 80% окна, а при 90% растягивался до 111%.
         */
        const paint = () => {
          let stage = 'start';
          try {
            const value = store.get();
            const host = zoomHost();
            // Переменную читает calc() попапов, поэтому она стоит на корне документа
            // и обновляется до всего остального.
            html.style.setProperty(SCALE_VAR, String(value));
            stage = 'scale-var';
            if (zoomSupported) {
              host.style.zoom = value === 1 ? '' : String(value);
            } else {
              // Движок без CSS `zoom`: масштабируем трансформацией, попапы — отдельно.
              host.style.transformOrigin = '0 0';
              host.style.transform = value === 1 ? '' : `scale(${value})`;
              host.style.width = value === 1 ? '' : `${100 / value}%`;
              host.style.height = value === 1 ? '' : `${100 / value}%`;
            }
            stage = 'host-zoom';
            applyPopupZoom(value);
            stage = 'popups';
            pinHandles();
            stage = 'handles';
          } catch (error) {
            markReady(`paint-failed: ${stage}: ${error?.message ?? error}`);
          }
        };


        /* #region popup-zoom */
        /**
         * Всплывающие слои живут в `body` мимо корня приложения и позиционируются
         * вьюпортными пикселями: `left`/`top` берутся из rect якоря, а
         * `offsetWidth`/`offsetHeight` — для выравнивания по краю и подгонки под
         * экран (см. `useAnchoredPosition`).
         *
         * Масштаб такому слою ставится свой (общий зум-контекст корня его не
         * задевает), а его координаты делятся на масштаб: внутри зум-контекста
         * CSS-пиксели умножаются, и без этого меню уезжает от своей кнопки на
         * (масштаб − 1) × координата. Метрики, наоборот, отдаются приложению уже
         * в вьюпортных пикселях — иначе оно выравнивает меню по неверной ширине.
         */
        const popupStates = new WeakMap();

        /**
         * Свойства, которые приложение задаёт в вьюпортных пикселях.
         *
         * Внутри зум-контекста эти длины умножаются на масштаб, поэтому их нужно
         * делить на него. `width`/`maxWidth`/`minWidth` ставят инлайном HoverCard
         * и Tooltip — без компенсации карточки и подсказки были бы в k раз шире.
         * `right`/`bottom` примитивы не пишут (все позиционируются через left/top),
         * поэтому в список не входят.
         */
        const VIEWPORT_PROPS = ['left', 'top', 'width', 'maxWidth', 'minWidth', 'maxHeight'];

        /**
         * Переменная с текущим масштабом: её читает `calc()` попапов.
         *
         * Живёт на корне документа, поэтому наследуется и слоями в `body`.
         */
        const SCALE_VAR = '--dsh-ui-zoom';

        /** Слои, взятые под масштаб: нужны, чтобы пересчитать их при смене размера. */
        const popups = new Set();

        /** Рамки интерфейса, которым уже отдаются логические размеры. */
        const framesPatched = new WeakSet();

        /**
         * Порог, ниже которого приложение сворачивает сайдбар
         * (`SIDEBAR_AUTO_COLLAPSE` в `dsh-client-ui-layout`). Логическую ширину рамки
         * не опускаем ниже него, иначе панель исчезает на крупном масштабе.
         */
        const SIDEBAR_MIN_WIDTH = 1024;

        /** Признак запланированного пересчёта позиций. */
        let replacePending = false;

        /**
         * Состояние слоя: что записало приложение и что записал плагин.
         * @param {Element} node - слой попапа.
         * @returns {object} запись состояния.
         */
        function stateFor(node) {
          let state = popupStates.get(node);
          if (state === undefined) {
            state = { viewport: {}, written: {}, patched: false };
            popupStates.set(node, state);
          }
          return state;
        }

        /**
         * Слой ли это приложения, который нужно пересчитывать: не корень и не его
         * потомок, позиционирован как `fixed`.
         * @param {Element} node - проверяемый узел.
         * @returns {boolean} true, если слой нужно взять под масштаб.
         */
        function isPopup(node) {
          if (!node || node.nodeType !== 1) return false;
          if (node.id === 'root') return false;
          const root = document.getElementById('root');
          if (root?.contains(node)) return false;
          return getComputedStyle(node).position === 'fixed';
        }

        /**
         * Имя переменной с исходным вьюпортным значением свойства.
         * @param {string} prop - имя свойства стиля.
         * @returns {string} имя CSS-переменной.
         */
        function sourceVar(prop) {
          return `--dsh-ui-zoom-src-${prop}`;
        }

        /**
         * Забрать координаты приложения в переменную, а деление отдать движку.
         *
         * Приложение пишет `left`/`top` и размеры вьюпортными пикселями. Внутри
         * зум-контекста слоя длины умножаются на масштаб, поэтому исходное значение
         * переезжает в переменную, а само свойство становится
         * `calc(var(--…-src-left) / var(--dsh-ui-zoom))`. Пересчёт при смене масштаба
         * делает CSS: плагину достаточно поменять одну переменную масштаба, и ни одна
         * координата не пересчитывается в JS — дрейфу браться неоткуда.
         * @param {HTMLElement} node - слой попапа.
         * @returns {void}
         */
        function pickUp(node) {
          for (const prop of VIEWPORT_PROPS) {
            const value = node.style[prop];
            // Уже наша запись: строка начинается с calc(.
            if (typeof value === 'string' && value.startsWith('calc(')) continue;
            const parsed = Number.parseFloat(value);
            if (!Number.isFinite(parsed)) {
              // Приложение сняло свойство — снимаем и переменную.
              node.style.removeProperty(sourceVar(prop));
              continue;
            }
            node.style.setProperty(sourceVar(prop), `${parsed}px`);
            node.style[prop] = `calc(var(${sourceVar(prop)}) / var(${SCALE_VAR}))`;
          }
        }

        /**
         * Отдавать приложению размеры слоя в вьюпортных пикселях.
         *
         * `offsetWidth`/`offsetHeight` внутри зум-контекста остаются локальными,
         * поэтому приложение выравнивало меню по краю кнопки и подгоняло его под
         * экран по неверной ширине.
         * @param {HTMLElement} node - слой попапа.
         * @returns {void}
         */
        function patchMetrics(node) {
          const state = stateFor(node);
          if (state.patched) return;
          const metrics = [
            ['offsetWidth', 'width'],
            ['offsetHeight', 'height'],
          ];
          for (const [prop, axis] of metrics) {
            try {
              Object.defineProperty(node, prop, {
                configurable: true,
                get: () => node.getBoundingClientRect()[axis],
              });
            } catch (_error) {
              // Метрику переопределить не удалось: меню останется вьюпортных
              // размеров, но масштаб и координаты всё равно применятся.
            }
          }
          state.patched = true;
        }

        /**
         * Пересчитать слой после того, как приложение переписало его координаты.
         *
         * Деления здесь больше нет: оно целиком в CSS (`calc(… / var(--dsh-ui-zoom))`),
         * поэтому любые правки координат приложением достаточно перехватить один раз.
         * @param {HTMLElement} node - слой попапа.
         * @returns {void}
         */
        function handleStyle(node) {
          if (!node || node.nodeType !== 1 || !popupStates.has(node)) return;
          pickUp(node);
        }

        /**
         * Попросить приложение пересчитать позиции слоёв.
         *
         * Меню встаёт по rect якоря, а он при смене масштаба переезжает; приложение
         * слушает только `resize` и `scroll`, поэтому без этого сигнала уже открытое
         * меню остаётся на старом месте.
         * @returns {void}
         */
        function requestReplace() {
          if (replacePending) return;
          replacePending = true;
          const run = () => {
            replacePending = false;
            window.dispatchEvent(new Event('resize'));
          };
          if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
          else window.setTimeout(run, 16);
        }

        /**
         * Дать слою тот же масштаб, что и интерфейсу, и пересчитать координаты.
         *
         * Слой лежит в `body` мимо корня приложения, поэтому общий зум-контекст его
         * не задевает: масштаб ставится ему самому.
         * @param {HTMLElement} node - слой попапа.
         * @param {number} zoom - текущий масштаб.
         * @returns {void}
         */
        function scalePopup(node, zoom) {
          node.style.zoom = zoom === 1 ? '' : String(zoom);
          pickUp(node);
        }

        /**
         * Взять слой под масштаб: метрики, координаты и слежение за правками.
         * @param {Element} node - добавленный узел.
         * @returns {void}
         */
        function mark(node) {
          if (popupStates.has(node) || !isPopup(node)) return;
          patchMetrics(node);
          popups.add(node);
          scalePopup(node, store.get());
          // Приложение уже посчитало позицию без учёта масштаба — просим пересчитать.
          requestReplace();
        }

        /**
         * Пройтись по известным слоям, забыв отключённые.
         * @returns {Array<HTMLElement>} живые слои.
         */
        function knownPopups() {
          const alive = [];
          for (const node of [...popups]) {
            // isConnected есть у настоящих узлов; заглушки без него считаем живыми.
            if (node.isConnected !== false) alive.push(node);
            else popups.delete(node);
          }
          return alive;
        }

        /**
         * Применить масштаб ко всем открытым слоям.
         *
         * Координаты не пересчитываются: они лежат в переменных, а деление делает
         * CSS по `--dsh-ui-zoom`. Здесь меняется только собственная величина `zoom`
         * слоя (общий зум-контекст корня его не задевает).
         * @param {number} value - текущий масштаб.
         * @returns {void}
         */
        function applyPopupZoom(value) {
          const alive = knownPopups();
          if (alive.length === 0) return;
          for (const node of alive) scalePopup(node, value);
          // Якорь переехал вместе с интерфейсом: просим приложение обновить координаты.
          requestReplace();
        }

        /**
         * Отдавать приложению логическую рамку интерфейса.
         *
         * Раскладку считает `AppFrame`: измеряет себя через `getBoundingClientRect()`
         * и из этой ширины выводит колонки. Под `zoom` движок возвращает ВИЗУАЛЬНУЮ
         * ширину (всегда равную окну), а логическая — та, в которой реально вёрстается
         * сетка — в масштаб раз меньше. Без поправки панели считаются от неверной
         * ширины и занимают не свою долю окна.
         *
         * Ниже порога `1024` не опускаем: по нему приложение сворачивает сайдбар
         * (`SIDEBAR_AUTO_COLLAPSE`), и без этого панель исчезала при увеличении.
         * @returns {void}
         */
        function patchFrameMetrics() {
          const handle = document.querySelector('[data-side="sidebar"], [data-side="rightbar"]');
          const frame = handle?.parentElement ?? null;
          if (!frame || framesPatched.has(frame)) return;
          framesPatched.add(frame);
          const original = frame.getBoundingClientRect.bind(frame);
          frame.getBoundingClientRect = () => {
            const rect = original();
            const zoom = store.get();
            if (zoom === 1) return rect;
            const width = Math.max(rect.width / zoom, SIDEBAR_MIN_WIDTH);
            return {
              x: rect.x / zoom,
              y: rect.y / zoom,
              width,
              height: rect.height / zoom,
              left: rect.left / zoom,
              top: rect.top / zoom,
              right: rect.left / zoom + width,
              bottom: rect.bottom / zoom,
            };
          };
          // Приложение уже измерило рамку по визуальной ширине; раскладку оно
          // пересчитает по ResizeObserver, поэтому сдвигаем рамку и возвращаем.
          const previousWidth = frame.style.width;
          frame.style.width = 'calc(100% - 0.5px)';
          const restore = () => {
            frame.style.width = previousWidth;
          };
          if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restore);
          else window.setTimeout(restore, 16);
        }

        /**
         * Ставить полоски изменения ширины на фактические границы колонок.
         *
         * Свою позицию полоска получает как `left: viewport - rightbar`, а под `zoom`
         * эта ширина расходится с фактической сеткой — полоска уезжала от границы, и
         * взяться за неё было нечем. Границы берём у самих колонок: `offsetLeft` и
         * `offsetWidth` не зависят от масштаба и всегда совпадают с сеткой.
         * @returns {void}
         */
        function pinHandles() {
          for (const handle of document.querySelectorAll('[data-side="sidebar"], [data-side="rightbar"]')) {
            const side = handle.dataset.side;
            const column =
              side === 'sidebar'
                ? document.querySelector('[class*="_sidebarCol"]')
                : document.querySelector('[data-rightbar-col]');
            if (column === null) continue;
            const left = side === 'sidebar' ? column.offsetLeft + column.offsetWidth : column.offsetLeft;
            const next = `${left}px`;
            if (handle.style.left !== next) handle.style.left = next;
          }
        }

        /**
         * Отдавать приложению логический `clientX` при перетаскивании полоски.
         *
         * `DragHandle` считает сдвиг как `e.clientX - origin` и прибавляет его к ширине
         * панели, а ширина живёт в логических пикселях зум-контекста. Координата
         * указателя всегда визуальная: без деления панель на масштабе 150% проходила бы
         * в полтора раза больше, чем курсор, и «уезжала» от него. Делим только события,
         * пришедшие на полоску (`[data-side]`) — остальные потребители координат
         * указателя видят её как раньше.
         * @returns {void}
         */
        function patchPointerCoordinates() {
          const proto = window.PointerEvent?.prototype;
          if (!proto || proto.__dshUiZoomPatched) return;
          const descriptor = Object.getOwnPropertyDescriptor(window.MouseEvent.prototype, 'clientX');
          if (typeof descriptor?.get !== 'function') return;
          proto.__dshUiZoomPatched = true;
          Object.defineProperty(proto, 'clientX', {
            configurable: true,
            get() {
              const raw = descriptor.get.call(this);
              const zoom = store.get();
              if (zoom === 1) return raw;
              const target = this.target;
              const onHandle =
                target !== null && typeof target?.closest === 'function' && target.closest('[data-side]') !== null;
              return onHandle ? raw / zoom : raw;
            },
          });
        }

        /**
         * Следить за слоями, которые приложение добавляет в `body` после загрузки.
         * @returns {void}
         */
        function attachPopupZoom() {
          for (const node of document.body?.children ?? []) mark(node);
          patchFrameMetrics();
          pinHandles();
          patchPointerCoordinates();
          const observer = new MutationObserver((records) => {
            for (const record of records) {
              if (record.type === 'attributes') {
                handleStyle(record.target);
                pinHandles();
                continue;
              }
              for (const node of record.addedNodes) {
                if (!node || node.nodeType !== 1) continue;
                mark(node);
                for (const child of node.querySelectorAll('*')) mark(child);
              }
            }
            pinHandles();
          });
          observer.observe(document.body ?? html, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style'],
          });
          own(() => observer.disconnect());
        }
        /* #endregion popup-zoom */

        /* #region context-menu */
        /** Признак того, что узел принимает текстовый ввод. */
        function isEditable(node) {
          if (!node || node.nodeType !== 1) return false;
          if (node.isContentEditable === true) return true;
          const tag = node.tagName;
          if (tag === 'TEXTAREA') return true;
          if (tag !== 'INPUT') return false;
          const type = String(node.type ?? 'text').toLowerCase();
          return ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(type);
        }

        /** Вставить содержимое буфера: `execCommand('paste')` в Chromium недоступен. */
        function pasteFromClipboard() {
          const read = navigator.clipboard?.readText;
          if (typeof read !== 'function') return;
          read.call(navigator.clipboard).then(
            (text) => {
              if (typeof text === 'string' && text.length > 0) document.execCommand('insertText', false, text);
            },
            () => {
              /* нет доступа к буферу — оставляем как есть */
            },
          );
        }

        /**
         * Своё меню по правой кнопке.
         *
         * DSH показывает здесь нативное меню Electron (`Menu.popup` в главном процессе):
         * его рисует система, и `zoom` страницы до него не достаёт. Своё меню — обычный
         * слой в `body`, поэтому получает тот же масштаб, что и остальные попапы;
         * действия выполняются командами редактирования документа.
         * @returns {void}
         */
        function attachContextMenu() {
          const items = [
            { id: 'undo', key: 'menu.undo', run: () => document.execCommand('undo') },
            { id: 'redo', key: 'menu.redo', run: () => document.execCommand('redo') },
            { separator: true },
            { id: 'cut', key: 'menu.cut', run: () => document.execCommand('cut') },
            { id: 'copy', key: 'menu.copy', run: () => document.execCommand('copy') },
            { id: 'paste', key: 'menu.paste', run: pasteFromClipboard },
            { separator: true },
            { id: 'selectAll', key: 'menu.selectAll', run: () => document.execCommand('selectAll') },
          ];

          const style = document.createElement('style');
          // Только существующие токены темы: непрозрачный фон попапа, граница, текст
          // и подсветка наведения. Токенов вида `--dsw-specific-menu` или
          // `--dsw-elevation-prominent` в теме нет — с ними фон становился прозрачным.
          style.textContent = [
            '.dsh-ui-zoom-menu{position:fixed;left:0;top:0;z-index:2147483000;display:flex;flex-direction:column;',
            'min-width:160px;padding:5px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l2);',
            'border-radius:10px;background:var(--dsw-alias-bg-overlay);',
            'box-shadow:0 8px 28px rgba(0,0,0,.42);',
            'color:var(--dsw-alias-label-primary);font:13px/20px system-ui,sans-serif}',
            '.dsh-ui-zoom-menu[hidden]{display:none}',
            '.dsh-ui-zoom-menu button{display:flex;align-items:center;min-height:30px;padding:4px 10px;border:0;',
            'border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
            '.dsh-ui-zoom-menu button:hover{background:var(--dsw-alias-bg-layer-2)}',
            '.dsh-ui-zoom-menu hr{height:0.5px;margin:3px 2px;border:0;background:var(--dsw-alias-border-l2)}',
          ].join('');
          document.head?.appendChild(style);

          const menu = document.createElement('div');
          menu.className = 'dsh-ui-zoom-menu';
          menu.setAttribute('role', 'menu');
          menu.hidden = true;
          document.body?.appendChild(menu);
          // Берём слой под масштаб сразу: иначе первое измерение ниже прошло бы
          // по ещё не пересчитанному слою.
          mark(menu);

          let restoreFocus = null;

          const hide = () => {
            if (menu.hidden) return;
            menu.hidden = true;
            window.removeEventListener('pointerdown', onOutside, true);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('resize', hide, true);
            window.removeEventListener('scroll', hide, true);
          };

          const runItem = (item) => {
            const target = restoreFocus;
            hide();
            if (target !== null && typeof target.focus === 'function') target.focus({ preventScroll: true });
            try {
              item.run();
            } catch (error) {
              console.error('ui-zoom: команда меню не выполнена', error);
            }
          };

          function onOutside(event) {
            if (!menu.contains(event.target)) hide();
          }

          function onKey(event) {
            if (event.key === 'Escape') hide();
          }

          const show = (x, y, editable) => {
            menu.replaceChildren();
            for (const item of items) {
              if (item.separator === true) {
                if (menu.childElementCount > 0) menu.appendChild(document.createElement('hr'));
                continue;
              }
              // Как в системном меню: правки — для полей ввода, копирование — и для выделения.
              if (!editable && item.id !== 'copy') continue;
              const button = document.createElement('button');
              button.type = 'button';
              button.setAttribute('role', 'menuitem');
              button.textContent = translate(item.key);
              // Иначе фокус уходит из поля и команда редактирования бьёт мимо.
              button.addEventListener('pointerdown', (event) => event.preventDefault());
              button.addEventListener('click', () => runItem(item));
              menu.appendChild(button);
            }
            if (menu.childElementCount === 0) return;
            menu.hidden = false;
            menu.style.left = '0px';
            menu.style.top = '0px';
            // Клампим по фактическим размерам слоя (они уже в вьюпортных пикселях).
            const rect = menu.getBoundingClientRect();
            const margin = 8;
            const left = Math.max(margin, Math.min(x, window.innerWidth - margin - rect.width));
            const top = Math.max(margin, Math.min(y, window.innerHeight - margin - rect.height));
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
            // Деление координат отдаём calc() сразу, не дожидаясь наблюдателя.
            pickUp(menu);
            window.addEventListener('pointerdown', onOutside, true);
            window.addEventListener('keydown', onKey, true);
            window.addEventListener('resize', hide, true);
            window.addEventListener('scroll', hide, true);
          };

          const onContextMenu = (event) => {
            const target = event.target;
            const editable =
              isEditable(target) ||
              (typeof target?.closest === 'function' &&
                target.closest('[contenteditable=""],[contenteditable="true"]') !== null);
            const selection =
              typeof window.getSelection === 'function' ? String(window.getSelection() ?? '') : '';
            if (!editable && selection.length === 0) return;
            event.preventDefault();
            restoreFocus = editable && typeof target.focus === 'function' ? target : null;
            show(event.clientX, event.clientY, editable);
          };

          document.addEventListener('contextmenu', onContextMenu, true);
          own(() => {
            document.removeEventListener('contextmenu', onContextMenu, true);
            hide();
            style.remove();
            menu.remove();
          });
        }
        /* #endregion context-menu */

        paint();
        markReady(zoomSupported ? 'loaded: zoom' : 'loaded: transform');
        /* #endregion zoom-apply */

        /* #region zoom-hint */
        let hideTimer = 0;
        let hintVisible = false;
        const hintListeners = new Set();
        const hintState = {
          get: () => hintVisible,
          subscribe(listener) {
            hintListeners.add(listener);
            return () => hintListeners.delete(listener);
          },
        };

        /** Показать индикатор и перезапустить таймер его скрытия. */
        function showHint() {
          window.clearTimeout(hideTimer);
          if (!hintVisible) {
            hintVisible = true;
            for (const listener of hintListeners) listener();
          }
          hideTimer = window.setTimeout(() => {
            hideTimer = 0;
            hintVisible = false;
            for (const listener of hintListeners) listener();
          }, HINT_MS);
        }
        /* #endregion zoom-hint */

        /**
         * Индикатор размера: живёт в shell.overlay, гаснет сам.
         * @returns {object} элемент индикатора либо null, когда он скрыт.
         */
        function ZoomHint() {
          const [visible, setVisible] = React.useState(hintState.get());
          const [zoom, setZoom] = React.useState(store.get());
          React.useEffect(() => {
            const offHint = hintState.subscribe(() => setVisible(hintState.get()));
            const offZoom = store.subscribe(() => setZoom(store.get()));
            setVisible(hintState.get());
            setZoom(store.get());
            return () => {
              offHint();
              offZoom();
            };
          }, []);
          if (!visible) return null;
          return React.createElement(
            'div',
            {
              style: HINT_STYLE,
              role: 'status',
              'aria-live': 'polite',
              title: translate('zoom.hint'),
            },
            formatZoom(zoom),
          );
        }

        /** Применить новый масштаб, перерисовать документ и показать индикатор. */
        function applyZoom(next) {
          const before = store.get();
          if (store.set(next) === before) return;
          paint();
          showHint();
        }

        /**
         * Зарегистрировать три команды масштаба в сервисе горячих клавиш.
         * @param {object} shortcuts - сервис `shortcuts`.
         * @returns {Array<Function>} очистки регистраций.
         */
        function registerCommands(shortcuts) {
          /**
           * Привязка для каждого устройства. В Web браузер забирает `Ctrl+=` / `Ctrl+-` /
           * `Ctrl+0` себе, поэтому там та же команда доступна и с `Alt`.
           */
          const binding = (code) => ({
            'desktop:macos': { code, modifiers: ['primary'] },
            'desktop:windows': { code, modifiers: ['primary'] },
            'desktop:linux': { code, modifiers: ['primary'] },
            'web:macos': { code, modifiers: ['primary', 'alt'] },
            'web:windows': { code, modifiers: ['primary', 'alt'] },
          });
          /** Определения команд: основная клавиша и клавиша нумпада. */
          const definitions = [
            {
              id: 'ui-zoom.in',
              labelKey: 'zoom.in',
              aliases: ['zoom in', 'larger text', 'increase interface size', 'масштаб', 'крупнее'],
              codes: ['Equal', 'NumpadAdd'],
              direction: 1,
            },
            {
              id: 'ui-zoom.out',
              labelKey: 'zoom.out',
              aliases: ['zoom out', 'smaller text', 'decrease interface size', 'масштаб', 'мельче'],
              codes: ['Minus', 'NumpadSubtract'],
              direction: -1,
            },
            {
              id: 'ui-zoom.reset',
              labelKey: 'zoom.reset',
              aliases: ['zoom reset', 'actual size', 'reset interface size', 'сброс масштаба'],
              codes: ['Digit0'],
              direction: 0,
            },
          ];
          const registered = [];
          for (const definition of definitions) {
            // Сервис принимает одну привязку на профиль, поэтому клавиша нумпада
            // идёт отдельной командой с тем же действием.
            definition.codes.forEach((code, index) => {
              const id = index === 0 ? definition.id : `${definition.id}.numpad`;
              registered.push(
                shortcuts.register({
                  id,
                  label: () => (index === 0 ? translate(definition.labelKey) : `${translate(definition.labelKey)} (NumPad)`),
                  aliases: definition.aliases,
                  defaults: binding(code),
                  regions: ['page', 'editable'],
                  modals: [],
                  resolve: () => ({
                    status: 'handled',
                    run: () =>
                      applyZoom(definition.direction === 0 ? 1 : stepZoom(store.get(), definition.direction)),
                  }),
                }),
              );
            });
          }
          return registered;
        }

        /**
         * Прямой перехват клавиш масштаба.
         *
         * Сервис горячих клавиш отдаёт команде не всякое сочетание (часть уходит
         * системе или полю ввода), поэтому те же клавиши обрабатываются здесь:
         * на capture-фазе, до остальных обработчиков приложения. Регистрация команд
         * в сервисе при этом сохраняется — она даёт настройку, подсказки и меню.
         * @returns {void}
         */
        function attachDirectKeys() {
          /** Физический код клавиши → шаг масштаба (0 — сброс к 100%). */
          const byCode = {
            Equal: 1,
            NumpadAdd: 1,
            Minus: -1,
            NumpadSubtract: -1,
            NumpadDecimal: -1,
            Digit0: 0,
            Numpad0: 0,
          };
          /**
           * Символ клавиши → шаг масштаба. Раскладка и Shift меняют `key`, поэтому
           * `=` и `+` с обычной клавиши распознаются по символу, а не только по коду.
           */
          const bySymbol = { '+': 1, '=': 1, '−': -1, '_': -1, '0': 0 };
          const onKeyDown = (event) => {
            const direction = byCode[event.code] ?? bySymbol[event.key];
            if (direction === undefined) return;
            if (!event.ctrlKey || event.altKey || event.metaKey) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            applyZoom(direction === 0 ? 1 : stepZoom(store.get(), direction));
          };
          window.addEventListener('keydown', onKeyDown, true);
          own(() => window.removeEventListener('keydown', onKeyDown, true));
        }

        /**
         * Масштаб по Ctrl+колёсику мыши.
         *
         * Прокрутка вверх увеличивает, вниз уменьшает — как в браузерах и редакторах.
         * Обработчик на capture-фазе с `passive: false`, чтобы `preventDefault`
         * отменял обычную прокрутку страницы.
         * @returns {void}
         */
        function attachWheelZoom() {
          const onWheel = (event) => {
            if (!event.ctrlKey || event.altKey || event.metaKey) return;
            if (!event.deltaY) return;
            event.preventDefault();
            applyZoom(stepZoom(store.get(), event.deltaY < 0 ? 1 : -1));
          };
          window.addEventListener('wheel', onWheel, { passive: false, capture: true });
          own(() => window.removeEventListener('wheel', onWheel, { capture: true }));
        }

        /**
         * Отдать ресурс владельцу контекста; фасад без `ctx.effect` откатывается
         * на ручную очистку при выгрузке плагина.
         * @param {Function} dispose - освобождение ресурса.
         * @returns {void}
         */
        function own(dispose) {
          if (typeof dispose === 'function') cleanups.push(dispose);
        }

        if (typeof locale?.register === 'function') {
          for (const [code, dictionary] of Object.entries(DICTIONARIES)) {
            try {
              own(locale.register('ui-zoom', code, dictionary));
            } catch (error) {
              // Повторная загрузка модуля в ту же страницу (HMR) оставляет словарь
              // прежнего экземпляра: подписи уже на месте, регистрация не нужна.
              console.warn(`ui-zoom: словарь ${code} не зарегистрирован заново`, error);
            }
          }
        }

        try {
          if (typeof ctx.on === 'function') ctx.on('dispose', () => disposeAll());
        } catch (_error) {
          /* контекст без события dispose: очистка произойдёт при выгрузке страницы */
        }

        /** Освободить всё, что зарегистрировал плагин. */
        function disposeAll() {
          window.clearTimeout(hideTimer);
          for (const dispose of cleanups.splice(0)) {
            try {
              dispose();
            } catch (_error) {
              /* очистка не должна мешать остальным */
            }
          }
        }

        /**
         * Зарегистрировать команды масштаба и запомнить их очистки.
         *
         * В Desktop горячие клавиши обслуживает нативный мост главного процесса:
         * он сохраняет регистрации между перезагрузками страницы, поэтому повторная
         * загрузка модуля находит команды уже существующими. Это нормальный ход —
         * команды живы и работают, новую регистрацию просто пропускаем.
         * @param {object} shortcuts - сервис горячих клавиш.
         * @returns {void}
         */
        function attachCommands(shortcuts) {
          try {
            for (const dispose of registerCommands(shortcuts)) own(dispose);
            markReady('commands-registered');
          } catch (error) {
            const message = String(error?.message ?? error);
            if (message.includes('Duplicate shortcut command')) {
              // Команды уже зарегистрированы прошлой загрузкой модуля и продолжают работать.
              markReady('commands-already-registered');
              return;
            }
            console.error('ui-zoom: команды масштаба не зарегистрированы', error);
            markReady(`register-failed: ${message}`);
          }
        }

        const shortcuts = ctx.get('shortcuts');
        if (typeof shortcuts?.register === 'function') {
          attachCommands(shortcuts);
        } else if (typeof window.setInterval === 'function') {
          // Сервис горячих клавиш может появиться позже загрузки плагина.
          markReady('waiting-for-shortcuts');
          const timer = window.setInterval(() => {
            const late = ctx.get('shortcuts');
            if (typeof late?.register !== 'function') return;
            window.clearInterval(timer);
            attachCommands(late);
          }, 500);
          own(() => window.clearInterval(timer));
        }

        // Прямой перехват ставится всегда: им клавиши доходят независимо от сервиса.
        attachDirectKeys();
        // Ctrl+колёсико — тот же масштаб, что и клавиши.
        attachWheelZoom();
        // Всплывающие слои приходят порталами в body — берём их под тот же масштаб.
        try {
          attachPopupZoom();
        } catch (error) {
          console.error('ui-zoom: масштаб всплывающих меню не подключён', error);
        }

        // Своё меню по правой кнопке: системное не масштабируется вместе с интерфейсом.
        try {
          attachContextMenu();
        } catch (error) {
          console.error('ui-zoom: меню по правой кнопке не подключено', error);
        }

        if (typeof slots?.inject === 'function') {
          try {
            own(
              slots.inject('shell.overlay', () =>
                slots.register({ name: 'shell.overlay', id: 'ui-zoom.hint', order: 20 }, ZoomHint),
              ),
            );
          } catch (error) {
            console.error('ui-zoom: плашка размера не подключена', error);
          }
        }

        try {
          const onStorage = (event) => {
            if (event.key !== null && event.key !== STORAGE_KEY) return;
            store.reload();
            paint();
          };
          window.addEventListener('storage', onStorage);
          own(() => window.removeEventListener('storage', onStorage));
        } catch (error) {
          console.error('ui-zoom: синхронизация между вкладками не подключена', error);
        }
    }

    return {
      /**
       * Подключить масштаб. Отметки этапов пишутся в хранилище устройства: без них
       * сбой инициализации в браузере неотличим от незагруженного модуля.
       * @param {object} ctx - клиентский контекст плагина.
       * @returns {void}
       */
      apply(ctx) {
        let storage = null;
        try {
          storage = window.localStorage;
        } catch (_error) {
          storage = null;
        }
        /**
         * Записать этап инициализации в хранилище устройства.
         * @param {string} stage - этап инициализации.
         */
        const markReady = (stage) => {
          try {
            storage?.setItem(
              'dsh.ui-zoom.ready.v1',
              JSON.stringify({ version: '1.2.0', stage, at: new Date().toISOString() }),
            );
          } catch (_error) {
            /* хранилище недоступно: отметка не критична для работы */
          }
        };
        try {
          setup(ctx, markReady);
        } catch (error) {
          markReady(`failed: ${error?.message ?? error}`);
          console.error('ui-zoom: инициализация прервана', error);
        }
      },
    };
  },
});
