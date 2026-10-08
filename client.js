/**
 * dsh-tweaks — каркас твиков интерфейса Harness.
 *
 * Твик — запись в реестре TWEAKS: `activate` его включает, `deactivate` выключает.
 * Что включено, решают флаги схемы Config из index.js: их по id записи в
 * cordis.patch.yml (`zoom`) отдаёт клиентский сервис configForms, а форму с
 * галочками рисует сам плагин — в слоте plugins.bundle.config карточки пакета.
 *
 * Пока конфигурация не готова (`configForms` нет или `status !== 'ready'`),
 * работают дефолты реестра: все твики включены. Ресурсы твика регистрируются
 * через `api.own` и снимаются при выключении, поэтому повторное включение
 * безопасно. Твик «масштаб» работает и один: он не зависит от соседей.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tweaks',
  factory(require) {
    const React = require('react');
    // Примитивы — базовый модуль страницы (platform seed): объявлять их отдельно не нужно.
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** Пространство имён словаря; оно же стоит на регистрации формы. */
    const NS = 'dsh-tweaks';
    /** Id записи пакета в cordis.patch.yml: он же namespace конфигурации в configForms. */
    const ROW_ID = 'zoom';
    /** Ключ отметки этапа инициализации в хранилище устройства. */
    const READY_KEY = 'dsh.ui-zoom.ready.v1';
    /**
     * Переменная с текущим масштабом: её читает `calc()` попапов.
     * Живёт на корне документа, поэтому наследуется и слоями в `body`.
     */
    const SCALE_VAR = '--dsh-ui-zoom';

    /**
     * Переключатель из примитивов интерфейса; без примитивов — нативный чекбокс.
     *
     * @param {object} props - состояние, подпись и обработчик переключения.
     * @returns {object} элемент переключателя.
     */
    const Switch =
      typeof primitives?.Switch === 'function'
        ? primitives.Switch
        : function PlainSwitch({ checked, onChange, label, disabled }) {
            return React.createElement(
              'label',
              null,
              React.createElement('input', {
                type: 'checkbox',
                checked,
                disabled,
                onChange: (event) => onChange(event.target.checked),
              }),
              React.createElement('span', null, label),
            );
          };

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

    /** Слова команд, индикатора, меню и формы твиков; локаль без перевода показывает английский. */
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
        'tweak.zoom': 'Interface size',
        'tweak.contextMenu': 'Custom right-click menu',
        'tweak.whisper': 'Russian speech recognition',
        'form.hint': 'A check box turns the tweak on at once, without a restart.',
        'form.unavailable': 'Settings are unavailable: this deployment has no configuration service.',
        'form.readOnly': 'This deployment stores settings read-only.',
        'form.saveFailed': 'The value was not saved. Try again.',
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
        'tweak.zoom': 'Масштаб интерфейса',
        'tweak.contextMenu': 'Своё меню по правой кнопке',
        'tweak.whisper': 'Распознавание русской речи',
        'form.hint': 'Галочка включает твик сразу, без перезапуска.',
        'form.unavailable': 'Настройки недоступны: в этой сборке нет службы конфигурации.',
        'form.readOnly': 'Эта сборка хранит настройки только для чтения.',
        'form.saveFailed': 'Значение не сохранилось. Попробуйте ещё раз.',
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
     * Переводчик словаря плагина.
     *
     * Штатный переводчик отдаёт сам ключ, если словарь ещё не успел подключиться
     * (так бывает при перезагрузке модуля в живую страницу): пользователь видел
     * «menu.copy» вместо «Copy». Поэтому, не получив перевода, берём текст из
     * собственного словаря по активной локали.
     * @param {object} locale - сервис локали либо undefined.
     * @returns {Function} перевод по ключу словаря.
     */
    function createTranslator(locale) {
      const t = typeof locale?.bind === 'function' ? locale.bind(NS) : (key) => key;
      return (key) => {
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
    }

    /**
     * Рамки интерфейса, которым уже подменён замер: рамка → исходный метод.
     *
     * Подмена живёт на уровне пакета, а не твика: рамку патчит каждый экземпляр
     * твика, и без общей памяти повторное включение наложило бы деление дважды.
     */
    const framePatches = new WeakMap();

    /**
     * Текущий масштаб по переменной документа.
     *
     * Значение читается из DOM, а не из хранилища твика: так подменённые замеры
     * и координаты указателя переживают выключение и повторное включение твика.
     * @returns {number} масштаб, 1 если переменная не задана.
     */
    function readScale() {
      const raw = Number.parseFloat(document.documentElement.style.getPropertyValue(SCALE_VAR));
      return Number.isFinite(raw) && raw > 0 ? raw : 1;
    }

    /**
     * Развернуть масштаб: значение, команды, индикатор.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {Function} markReady - отметка этапа инициализации.
     * @param {Function} own - регистратор очисток твика.
     * @returns {void}
     */
    function setup(ctx, markReady, own) {

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
        const translate = createTranslator(locale);

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

        /** Слои, взятые под масштаб: нужны, чтобы пересчитать их при смене размера. */
        const popups = new Set();

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
          if (!frame || framePatches.has(frame)) return;
          const original = frame.getBoundingClientRect.bind(frame);
          framePatches.set(frame, original);
          frame.getBoundingClientRect = () => {
            const rect = original();
            const zoom = readScale();
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
              const zoom = readScale();
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
              code: 'Equal',
              direction: 1,
            },
            {
              id: 'ui-zoom.out',
              labelKey: 'zoom.out',
              aliases: ['zoom out', 'smaller text', 'decrease interface size', 'масштаб', 'мельче'],
              code: 'Minus',
              direction: -1,
            },
            {
              id: 'ui-zoom.reset',
              labelKey: 'zoom.reset',
              aliases: ['zoom reset', 'actual size', 'reset interface size', 'сброс масштаба'],
              code: 'Digit0',
              direction: 0,
            },
          ];
          const registered = [];
          for (const definition of definitions) {
            // Клавиши нумпада сервис не принимает (`Unsupported shortcut code`), и одна
            // такая команда роняла регистрацию всех остальных. Нумпад обрабатывает
            // прямой перехват, а команду заводим только для поддерживаемой клавиши.
            try {
              registered.push(
                shortcuts.register({
                  id: definition.id,
                  label: () => translate(definition.labelKey),
                  aliases: definition.aliases,
                  defaults: binding(definition.code),
                  regions: ['page', 'editable'],
                  modals: [],
                  resolve: () => ({
                    status: 'handled',
                    run: () =>
                      applyZoom(definition.direction === 0 ? 1 : stepZoom(store.get(), definition.direction)),
                  }),
                }),
              );
            } catch (error) {
              console.error(`dsh-tweaks: команда ${definition.id} не зарегистрирована`, error);
            }
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

        // Слои вне корня (попапы, своё меню) получают масштаб только от этого твика,
        // поэтому мост живёт ровно столько, сколько живёт твик.
        /**
         * Вернуть интерфейс к исходному размеру.
         *
         * Значение в хранилище не трогаем: включение твика вернёт прежний масштаб.
         * Переменную масштаба оставляем равной единице, а не удаляем: координаты
         * попапов записаны как `calc(источник / var(--dsh-ui-zoom))`, и без
         * переменной браузер отбросил бы их совсем.
         * @returns {void}
         */
        function releaseView() {
          const host = zoomHost();
          for (const node of knownPopups()) node.style.removeProperty('zoom');
          html.style.setProperty(SCALE_VAR, '1');
          host.style.removeProperty('zoom');
          host.style.removeProperty('transform');
          host.style.removeProperty('transform-origin');
          host.style.removeProperty('width');
          host.style.removeProperty('height');
        }

        // Слои вне корня (попапы, своё меню) получают масштаб только от этого твика,
        // поэтому мост живёт ровно столько, сколько живёт твик.
        zoomBridge.adopt = mark;
        zoomBridge.place = pickUp;
        zoomBridge.reset = releaseView;
        own(() => {
          if (zoomBridge.adopt === mark) zoomBridge.adopt = null;
          if (zoomBridge.place === pickUp) zoomBridge.place = null;
          if (zoomBridge.reset === releaseView) zoomBridge.reset = null;
        });
        own(releaseView);
        own(() => window.clearTimeout(hideTimer));

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
            console.error('dsh-tweaks: команды масштаба не зарегистрированы', error);
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
          console.error('dsh-tweaks: масштаб всплывающих меню не подключён', error);
        }

        if (typeof slots?.inject === 'function') {
          try {
            own(
              slots.inject('shell.overlay', () =>
                slots.register({ name: 'shell.overlay', id: 'dsh-tweaks.hint', order: 20 }, ZoomHint),
              ),
            );
          } catch (error) {
            console.error('dsh-tweaks: плашка размера не подключена', error);
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
          console.error('dsh-tweaks: синхронизация между вкладками не подключена', error);
        }
        markReady('zoom-active');
    }

        /**
     * Твик «своё меню по правой кнопке»: включить перехват правого клика.
     *
     * DSH показывает здесь нативное меню Electron (`Menu.popup` в главном процессе):
     * его рисует система, и `zoom` страницы до него не достаёт. Своё меню — обычный
     * слой в `body`, поэтому получает тот же масштаб, что и остальные попапы (мост
     * к твику «масштаб»), а действия выполняются командами редактирования документа.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {object} api - отметка этапа и регистратор очисток твика.
     * @returns {void}
     */
    /* #region tweak-context-menu */
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
     * Включить своё меню по правой кнопке.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {object} api - отметка этапа и регистратор очисток твика.
     * @returns {void}
     */
    function attachContextMenu(ctx, api) {
      const translate = createTranslator(ctx.get('locale'));
      const own = api.own;
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
      // Слой фиксированный и лежит в body мимо корня приложения: его позицию
      // считает своё меню, а масштаб отдаёт мост к твику «масштаб».
      menu.style.position = 'fixed';
      zoomBridge.adopt?.(menu);

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
          console.error('dsh-tweaks: команда меню не выполнена', error);
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
        zoomBridge.place?.(menu);
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
      api.markReady('context-menu-active');
    }
    /* #endregion tweak-context-menu */

    /**
     * Мост к твику «масштаб».
     *
     * Слои вне корня приложения (попапы, своё меню) получают масштаб только от
     * этого твика, поэтому мост ведёт к его `mark`/`pickUp`, а пока твик выключен,
     * вызовы ничего не делают: интерфейс и так не масштабирован.
     */
    const zoomBridge = {
      /** @type {((node: Element) => void) | null} взять слой под масштаб. */
      adopt: null,
      /** @type {((node: HTMLElement) => void) | null} пересчитать координаты слоя. */
      place: null,
      /** @type {(() => void) | null} вернуть интерфейс к исходному размеру. */
      reset: null,
    };

    /**
     * Ресурсы одного активного твика.
     *
     * Твик отдаёт свои очистки в `api.own`, каркас зовёт их при выключении; повторное
     * включение регистрирует всё заново, а не копит обработчики и подписки.
     * @returns {object} регистратор очисток и их разовая уборка.
     */
    function createScope() {
      const cleanups = [];
      return {
        /**
         * @param {Function} dispose - освобождение ресурса твика.
         * @returns {void}
         */
        own(dispose) {
          if (typeof dispose === 'function') cleanups.push(dispose);
        },
        /** Освободить всё, что зарегистрировал твик. */
        dispose() {
          for (const dispose of cleanups.splice(0)) {
            try {
              dispose();
            } catch (_error) {
              /* очистка одного ресурса не мешает остальным */
            }
          }
        },
      };
    }

    /**
     * Реестр твиков пакета.
     *
     * Ключ — id твика; он же имя флага в схеме Config (index.js), поэтому галочка
     * с этим id включает ровно этот твик. `activate` получает контекст и `api`
     * (`markReady` — отметка этапа, `own` — регистрация очисток); `deactivate`
     * нужен только тем твикам, у которых есть откат помимо `own`. Новый твик
     * добавляется сюда и полем в схему, не трогая соседей.
     */
    /* #region tweak-whisper */
    /**
     * Клиентская часть твика «распознавание русской речи»: кнопка загрузки
     * модели и прогресс подготовки. Состояние читается из хост-сервиса
     * `speechController` (Remote `catalog`/`follow`/`prepare`); доступ к нему —
     * `ctx.get('speechController')`, поэтому твик переживает отсутствие шва.
     */
    const WHISPER_PROVIDER_ID = 'whisper-local';
    const WHISPER_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '10px' };

    /** Последний снимок каталога распознавания либо null. */
    let whisperCatalog = null;
    /** Подписчики снимка: кнопка перерисовывается при смене состояния. */
    const whisperListeners = new Set();
    /** Хост-сервис распознавания; заполняется при включении твика. */
    let speechService = null;
    /** Сигнал отмены потока follow. */
    let speechAbort = null;

    /**
     * Провайдер whisper-local из каталога и его состояние подготовки.
     * @param {object | null} catalog - каталог распознавания.
     * @returns {object} снимок провайдера.
     */
    function whisperSnapshot(catalog) {
      const provider = Array.isArray(catalog?.providers)
        ? catalog.providers.find((entry) => entry.id === WHISPER_PROVIDER_ID) ?? null
        : null;
      const prep = provider?.preparation;
      return {
        provider,
        phase: prep?.phase ?? 'unprepared',
        message: prep?.message ?? '',
        completedBytes: prep?.completedBytes ?? 0,
        totalBytes: prep?.totalBytes,
      };
    }

    /** Разослать новый снимок подписчикам. */
    function whisperEmit(catalog) {
      whisperCatalog = catalog;
      for (const listener of [...whisperListeners]) listener(catalog);
    }

    /**
     * Подключить клиентскую часть твика: подписка на подготовку модели.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {object} api - api твика (`own` регистрирует очистки).
     * @returns {void}
     */
    function setupWhisper(ctx, api) {
      const service = typeof ctx?.get === 'function' ? ctx.get('speechController') : undefined;
      speechService = service !== null && typeof service === 'object' ? service : null;
      const abort = new AbortController();
      speechAbort = abort;
      if (typeof api?.own === 'function') api.own(() => abort.abort());
      if (speechService === null) {
        whisperEmit(null);
        return;
      }
      // Начальный снимок сразу, затем живой поток follow.
      Promise.resolve()
        .then(() => speechService.catalog())
        .then((catalog) => whisperEmit(catalog))
        .catch(() => whisperEmit(null));
      if (typeof speechService.follow === 'function') {
        (async () => {
          try {
            for await (const catalog of speechService.follow(abort.signal)) whisperEmit(catalog);
          } catch (_error) {
            /* поток закрылся: остаётся последний снимок */
          }
        })();
      }
    }

    /** Отключить клиентскую часть твика: снять подписку и очистить состояние. */
    function teardownWhisper() {
      if (speechAbort !== null) speechAbort.abort();
      speechAbort = null;
      speechService = null;
      whisperCatalog = null;
      whisperListeners.clear();
    }

    /**
     * Реакт-хук: перерисовать кнопку при смене снимка каталога.
     * @returns {object | null} текущий снимок каталога.
     */
    function useWhisperCatalog() {
      const [catalog, setCatalog] = React.useState(whisperCatalog);
      React.useEffect(() => {
        whisperListeners.add(setCatalog);
        return () => whisperListeners.delete(setCatalog);
      }, []);
      return catalog;
    }

    /** Объём в мегабайтах; при известном общем размере — «X / Y МБ». */
    function formatBytes(bytes, total) {
      const mb = (value) => `${Math.round(value / (1024 * 1024))}`;
      return total === undefined ? `${mb(bytes)} МБ` : `${mb(bytes)} / ${mb(total)} МБ`;
    }

    /**
     * Кнопка загрузки модели с прогрессом подготовки.
     * @returns {object} React-элемент.
     */
    function WhisperPrepareButton() {
      const catalog = useWhisperCatalog();
      const snapshot = whisperSnapshot(catalog);
      const { phase, message, completedBytes, totalBytes } = snapshot;
      const service = speechService;
      const prepare = () => {
        if (service === null) return;
        try {
          service.prepare(WHISPER_PROVIDER_ID);
        } catch (_error) {
          /* сбой подготовки покажется фазой failed */
        }
      };

      if (phase === 'unprepared' || phase === 'cancelled') {
        return React.createElement('div', { style: WHISPER_ROW_STYLE },
          React.createElement('button', { type: 'button', onClick: prepare }, 'Скачать модель'),
        );
      }
      if (phase === 'downloading') {
        return React.createElement('div', { style: WHISPER_ROW_STYLE },
          React.createElement('span', null, `Загрузка модели: ${formatBytes(completedBytes, totalBytes)}`),
        );
      }
      if (phase === 'checking' || phase === 'loading' || phase === 'waking') {
        return React.createElement('div', { style: WHISPER_ROW_STYLE },
          React.createElement('span', null, 'Подготовка модели…'),
        );
      }
      if (phase === 'ready' || phase === 'standby') {
        return React.createElement('div', { style: WHISPER_ROW_STYLE },
          React.createElement('span', null, 'Модель готова'),
        );
      }
      if (phase === 'failed') {
        return React.createElement('div', { style: WHISPER_ROW_STYLE },
          React.createElement('span', null, `Ошибка: ${message || 'неизвестная'}`),
          React.createElement('button', { type: 'button', onClick: prepare }, 'Повторить'),
        );
      }
      return React.createElement('div', { style: WHISPER_ROW_STYLE },
        React.createElement('span', null, 'Подготовка…'),
      );
    }
    /* #endregion tweak-whisper */

    const TWEAKS = {
      zoom: {
        title: 'Масштаб интерфейса',
        titleKey: 'tweak.zoom',
        defaultOn: true,
        activate(ctx, api) {
          setup(ctx, api.markReady, api.own);
        },
        deactivate() {
          zoomBridge.reset?.();
        },
      },
      contextMenu: {
        title: 'Своё меню по правой кнопке',
        titleKey: 'tweak.contextMenu',
        defaultOn: true,
        activate(ctx, api) {
          attachContextMenu(ctx, api);
        },
      },
      whisper: {
        title: 'Распознавание русской речи',
        titleKey: 'tweak.whisper',
        // Тяжёлый твик: поднимает Python-воркер и качает модель весов,
        // поэтому сам не включается — только галочкой.
        defaultOn: false,
        // Клиентская часть — кнопка загрузки модели с прогрессом (регион
        // tweak-whisper выше); распознавание при этом живёт в хост-половине
        // (`tweaks/whisper-host.js`).
        activate(ctx, api) {
          setupWhisper(ctx, api);
        },
        deactivate() {
          teardownWhisper();
        },
        renderDetail() {
          return React.createElement(WhisperPrepareButton);
        },
      },
    };

    /** Активные твики: id → очистки его ресурсов. */
    const activeTweaks = new Map();

    /**
     * Включить твик, если он ещё не включён.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {string} id - id твика в реестре.
     * @param {Function} markReady - отметка этапа инициализации.
     * @returns {void}
     */
    function enableTweak(ctx, id, markReady) {
      if (activeTweaks.has(id)) return;
      const scope = createScope();
      activeTweaks.set(id, scope);
      try {
        TWEAKS[id].activate(ctx, { markReady, own: scope.own, scope });
      } catch (error) {
        // Сломанный твик не должен мешать соседям: снимаем его ресурсы и идём дальше.
        activeTweaks.delete(id);
        scope.dispose();
        markReady(`failed: ${id}: ${error?.message ?? error}`);
        console.error(`dsh-tweaks: твик «${id}» прерван`, error);
      }
    }

    /**
     * Выключить твик: сначала его собственный откат, потом снятие ресурсов.
     * @param {string} id - id твика в реестре.
     * @returns {void}
     */
    function disableTweak(id) {
      const scope = activeTweaks.get(id);
      if (scope === undefined) return;
      activeTweaks.delete(id);
      try {
        TWEAKS[id].deactivate?.();
      } catch (error) {
        console.error(`dsh-tweaks: твик «${id}» не откатился до конца`, error);
      }
      scope.dispose();
    }

    /**
     * Включён ли твик по значениям снимка конфигурации.
     *
     * Отсутствие поля — это дефолт реестра (`defaultOn`), а не «включено»:
     * у твика, выключенного по умолчанию, пропавшее поле не должно включаться
     * само. Так же читается и незаготовленный снимок (`value === null`).
     * @param {object} tweak - запись реестра твиков.
     * @param {string} id - id твика (он же имя флага в схеме Config).
     * @param {object | null} value - значения флагов из готового снимка либо null.
     * @returns {boolean} включён ли твик.
     */
    function flagOn(tweak, id, value) {
      const declared = value === null || value === undefined ? undefined : value[id];
      if (declared === undefined) return tweak.defaultOn !== false;
      return declared !== false;
    }

    /**
     * Прочитать флаги твиков из снимка конфигурации.
     *
     * Пока конфигурация не готова, работают дефолты реестра: пакет ведёт себя так,
     * как вёл до появления флагов.
     * @param {object | undefined} controller - форма записи сервиса configForms.
     * @returns {object} id твика → включён ли он.
     */
    function readFlags(controller) {
      const snapshot = controller?.getSnapshot?.();
      const value =
        snapshot?.status === 'ready' && typeof snapshot.value === 'object' && snapshot.value !== null
          ? snapshot.value
          : null;
      const flags = {};
      for (const [id, tweak] of Object.entries(TWEAKS)) {
        flags[id] = flagOn(tweak, id, value);
      }
      return flags;
    }

    /** Стиль формы твиков: только токены темы, чтобы она следовала светлой и тёмной схеме. */
    const FORM_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      color: 'var(--dsw-alias-label-primary)',
      font: '400 14px/22px system-ui, sans-serif',
    };
    const FORM_ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
    };
    const FORM_NOTICE_STYLE = { margin: '0', color: 'var(--dsw-alias-label-secondary)' };

    /**
     * Подписаться на снимок конфигурации твиков.
     *
     * Своя подписка, а не `useSyncExternalStore`: каркас обходится теми же
     * `useState`/`useEffect`, что и плашка размера.
     * @param {object | undefined} controller - форма записи сервиса configForms.
     * @returns {object} снимок: status, value, revision, writable.
     */
    function useConfigSnapshot(controller) {
      const read = () => controller?.getSnapshot?.() ?? { status: 'unavailable' };
      const [snapshot, setSnapshot] = React.useState(read());
      React.useEffect(() => {
        if (controller === undefined) return undefined;
        setSnapshot(read());
        return controller.subscribe?.(() => setSnapshot(read()));
      }, [controller]);
      return snapshot;
    }

    /**
     * Записать флаг твика одной операцией `set`.
     *
     * Ревизию берём из снимка: по устаревшей ревизии служба конфигурации запись
     * отвергает и перечитывает документ, а форма сообщает о неудаче.
     * @param {object} controller - форма записи сервиса configForms.
     * @param {string} field - имя флага (id твика).
     * @param {boolean} value - новое значение флага.
     * @returns {Promise<boolean>} приняла ли запись служба конфигурации.
     */
    async function writeFlag(controller, field, value) {
      const revision = controller.getSnapshot?.().revision;
      const accepted = await controller.mutate([{ op: 'set', path: [field], value }], revision);
      return accepted !== false;
    }

    /**
     * Форма твиков на странице пакета: по переключателю на каждый твик.
     * @param {object} props - форма записи из слота, переводчик и `t` словаря.
     * @returns {object} список переключателей и подписи состояния.
     */
    function TweaksForm(props) {
      const { controller, t, translate } = props;
      const snapshot = useConfigSnapshot(controller);
      const [pending, setPending] = React.useState('');
      const [failed, setFailed] = React.useState(false);
      const copy = (key) => {
        const translated = typeof t === 'function' ? t(key) : key;
        if (translated !== key) return translated;
        return typeof translate === 'function' ? translate(key) : key;
      };
      const ready = controller !== undefined && snapshot.status === 'ready';
      const writable = ready && snapshot.writable !== false;
      const rows = [];
      for (const [id, tweak] of Object.entries(TWEAKS)) {
        const label = copy(tweak.titleKey);
        const checked = flagOn(tweak, id, ready ? snapshot.value : null);
        rows.push(
          React.createElement(
            'div',
            { key: id, 'data-tweak': id, style: FORM_ROW_STYLE },
            React.createElement('span', null, label),
            React.createElement(Switch, {
              checked,
              label,
              disabled: !writable || pending !== '',
              onChange: (next) => {
                setFailed(false);
                setPending(id);
                Promise.resolve(writeFlag(controller, id, next)).then(
                  (accepted) => {
                    setPending('');
                    if (!accepted) setFailed(true);
                  },
                  () => {
                    setPending('');
                    setFailed(true);
                  },
                );
              },
            }),
          ),
        );
      }
      const notices = [React.createElement('p', { key: 'hint', style: FORM_NOTICE_STYLE }, copy('form.hint'))];
      if (!ready) {
        notices.push(
          React.createElement('p', { key: 'off', style: FORM_NOTICE_STYLE }, copy('form.unavailable')),
        );
      } else if (!writable) {
        notices.push(
          React.createElement('p', { key: 'readonly', style: FORM_NOTICE_STYLE }, copy('form.readOnly')),
        );
      }
      if (failed) {
        notices.push(
          React.createElement('p', { key: 'failed', style: FORM_NOTICE_STYLE }, copy('form.saveFailed')),
        );
      }
      return React.createElement('div', { style: FORM_STYLE }, ...rows, ...notices);
    }

    return {
      /**
       * Сервис конфигурации: строку пакета DSH держит под id записи в
       * cordis.patch.yml, а служба отдаёт по нему флаги твиков. Без неё пакет
       * ждёт её появления; каркас при этом умеет работать и на дефолтах.
       */
      inject: ['configForms'],

      /**
       * Применить пакет: включить твики по флагам, нарисовать форму флагов и
       * слушать их изменения. Отметки этапов пишутся в хранилище устройства:
       * без них сбой инициализации в браузере неотличим от незагруженного модуля.
       * @param {object} ctx - клиентский контекст плагина.
       * @returns {void}
       */
      apply(ctx) {
        const scope = createScope();
        let storage = null;
        try {
          storage = window.localStorage;
        } catch (_error) {
          storage = null;
        }
        /**
         * Записать этап инициализации в хранилище устройства.
         * @param {string} stage - этап инициализации.
         * @returns {void}
         */
        const markReady = (stage) => {
          try {
            storage?.setItem(
              READY_KEY,
              JSON.stringify({
                version: '2.0.0',
                tweaks: [...activeTweaks.keys()],
                stage,
                at: new Date().toISOString(),
              }),
            );
          } catch (_error) {
            /* хранилище недоступно: отметка не критична для работы */
          }
        };

        const locale = ctx.get('locale');
        if (typeof locale?.register === 'function') {
          for (const [code, dictionary] of Object.entries(DICTIONARIES)) {
            try {
              scope.own(locale.register(NS, code, dictionary));
            } catch (error) {
              // Повторная загрузка модуля в ту же страницу (HMR) оставляет словарь
              // прежнего экземпляра: подписи уже на месте, регистрация не нужна.
              console.warn(`dsh-tweaks: словарь ${code} не зарегистрирован заново`, error);
            }
          }
        }

        const forms = ctx.get('configForms');
        const controller = typeof forms?.get === 'function' ? forms.get(ROW_ID) : undefined;

        const slots = ctx.get('slots');
        if (typeof slots?.inject === 'function') {
          try {
            scope.own(
              slots.inject('plugins.bundle.config', () =>
                slots.register(
                  {
                    name: 'plugins.bundle.config',
                    key: 'dsh-tweaks',
                    locale: NS,
                    inject: () => ({ controller, translate: createTranslator(locale) }),
                  },
                  TweaksForm,
                ),
              ),
            );
          } catch (error) {
            console.error('dsh-tweaks: форма флагов не подключена', error);
          }
        }

        /** Привести набор твиков в соответствие флагам конфигурации. */
        const reconcile = () => {
          for (const [id, on] of Object.entries(readFlags(controller))) {
            if (on) enableTweak(ctx, id, markReady);
            else disableTweak(id);
          }
          // Отметка пишется и здесь, а не только на старте: по ней видно, какие
          // твики активны после каждой правки флагов.
          markReady(`applied: ${[...activeTweaks.keys()].join(',') || 'none'}`);
        };
        reconcile();
        if (typeof controller?.subscribe === 'function') scope.own(controller.subscribe(reconcile));

        try {
          if (typeof ctx.on === 'function') {
            ctx.on('dispose', () => {
              for (const id of Object.keys(TWEAKS)) disableTweak(id);
              scope.dispose();
            });
          }
        } catch (_error) {
          /* контекст без события dispose: очистка произойдёт при выгрузке страницы */
        }
      },
    };
  },
});
