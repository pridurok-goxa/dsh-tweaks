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

    /* region traffic-light-policy — автокопия tweaks/traffic-light-policy.js; править там, затем обновить здесь */
    /**
     * Правило тарифов DeepSeek API — единый источник для хост- и клиент-половин
     * твика «светофор» (trafficLight) бандла dsh-tweaks.
     *
     * Этот файл — чистые функции без импортов и без глобалов, кроме `Date`:
     *  1. его импортирует хост-половина (`traffic-light-host.js`);
     *  2. его содержимое без ключевого слова `export` вшито в `client.js`
     *     между маркерами `/* region traffic-light-policy *\/` — тест
     *     `test/check-traffic-light.cjs` следит, что копии не разошлись.
     *
     * Действующее правило (сверено с официальной страницей цен
     * https://api-docs.deepseek.com/quick_start/pricing, ред. 2026-09-10):
     *   - пик (дорого, 100% цены): Пн–Пт 09:00–12:00 и 14:00–18:00 по Пекину
     *     (UTC+8, без летнего времени), кроме официальных праздников КНР;
     *   - всё остальное время — вне пика (50% цены): вечера, ночи, выходные
     *     и праздники целиком.
     * Окна — полуинтервалы [начало, конец): граница 12:00 уже вне пика,
     * граница 14:00 — снова пик.
     */

    /** Миллисекунды в минуте и в сутках. */
    const MINUTE_MS = 60_000;
    const DAY_MS = 86_400_000;

    /**
     * Официальные праздники КНР 2026 года, попадающие на будни.
     *
     * Выходные и так целиком вне пика, поэтому субботы/воскресенья (и переносы
     * рабочих дней на выходные) в списке не нужны.
     */
    const HOLIDAYS_2026 = [
      '2026-01-01', // Новый год
      '2026-01-02', // Новый год
      '2026-02-16', // Китайский Новый год
      '2026-02-17', // Китайский Новый год
      '2026-02-18', // Китайский Новый год
      '2026-02-19', // Китайский Новый год
      '2026-02-20', // Китайский Новый год
      '2026-02-23', // Китайский Новый год
      '2026-04-06', // Цинмин
      '2026-05-01', // День труда
      '2026-05-04', // День труда
      '2026-05-05', // День труда
      '2026-06-19', // Праздник драконьих лодок
      '2026-09-25', // Праздник середины осени
      '2026-10-01', // День образования КНР
      '2026-10-02', // День образования КНР
      '2026-10-05', // День образования КНР
      '2026-10-06', // День образования КНР
      '2026-10-07', // День образования КНР
    ];

    /**
     * Политика тарифов по умолчанию.
     *
     * Окна задаются по Пекину (UTC+8), потому что так их публикует DeepSeek;
     * сдвиг фиксированный — летнего времени в Китае нет.
     */
    const DEFAULT_POLICY = Object.freeze({
      /** Сдвиг Пекина от UTC в минутах. */
      utcOffsetMinutes: 480,
      /** Окна пиковой нагрузки: [начало, конец) в минутах от 00:00 по Пекину. */
      peakWindows: Object.freeze([
        Object.freeze([9 * 60, 12 * 60]), // 09:00–12:00
        Object.freeze([14 * 60, 18 * 60]), // 14:00–18:00
      ]),
      /** Даты официальных праздников КНР в формате YYYY-MM-DD. */
      holidays: Object.freeze([...HOLIDAYS_2026]),
      /** Сколько минут до начала пика индикатор горит жёлтым. */
      warningMinutes: 30,
    });

    /** Дополнить число нулём до двух знаков. */
    function pad2(value) {
      return value < 10 ? `0${value}` : `${value}`;
    }

    /**
     * Разобрать пекинское время «HH:MM» в минуты суток.
     * @param {string} value - строка времени.
     * @returns {number | null} минуты от 00:00 либо null для неверного значения.
     */
    function parseClock(value) {
      if (typeof value !== 'string') return null;
      const match = /^([01]\d|2[0-3]):[0-5]\d$/.exec(value.trim());
      if (match === null) return null;
      const hours = Number(match[1]);
      const minutes = Number(value.trim().slice(3, 5));
      return hours * 60 + minutes;
    }

    /**
     * Разложить мгновение на пекинские календарные поля.
     * @param {number} instantMs - миллисекунды эпохи.
     * @param {object} policy - политика тарифов.
     * @returns {object} пекинские дата, время, день недели и границы суток.
     */
    function beijingParts(instantMs, policy = DEFAULT_POLICY) {
      const offset = policy.utcOffsetMinutes * MINUTE_MS;
      const shifted = new Date(instantMs + offset);
      const year = shifted.getUTCFullYear();
      const month = shifted.getUTCMonth() + 1;
      const day = shifted.getUTCDate();
      const hour = shifted.getUTCHours();
      const minute = shifted.getUTCMinutes();
      return {
        year,
        month,
        day,
        hour,
        minute,
        /** 0 = воскресенье … 6 = суббота. */
        weekday: shifted.getUTCDay(),
        minuteOfDay: hour * 60 + minute,
        dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
        dayStartMs: Date.UTC(year, month - 1, day) - offset,
      };
    }

    /** Кэш множеств праздников по объекту политики. */
    const holidaySets = new WeakMap();

    /**
     * Множество дат-ключей праздников политики.
     * @param {object} policy - политика тарифов.
     * @returns {Set<string>} даты праздников.
     */
    function holidaySet(policy) {
      let set = holidaySets.get(policy);
      if (set === undefined) {
        set = new Set(policy.holidays);
        holidaySets.set(policy, set);
      }
      return set;
    }

    /**
     * Тарифицируется ли мгновение по пиковой цене.
     * @param {number} instantMs - миллисекунды эпохи.
     * @param {object} policy - политика тарифов.
     * @returns {boolean} true для буднего дня Пекина внутри окна пика без праздника.
     */
    function isPeakAt(instantMs, policy = DEFAULT_POLICY) {
      const parts = beijingParts(instantMs, policy);
      if (parts.weekday === 0 || parts.weekday === 6) return false;
      if (holidaySet(policy).has(parts.dateKey)) return false;
      for (const [start, end] of policy.peakWindows) {
        if (parts.minuteOfDay >= start && parts.minuteOfDay < end) return true;
      }
      return false;
    }

    /**
     * Ближайшее мгновение, в которое период тарифа меняется.
     * @param {number} instantMs - миллисекунды эпохи.
     * @param {object} policy - политика тарифов.
     * @returns {number | null} следующая граница либо null (окон нет).
     */
    function nextSwitchAt(instantMs, policy = DEFAULT_POLICY) {
      const current = isPeakAt(instantMs, policy);
      const { dayStartMs } = beijingParts(instantMs, policy);
      const candidates = [];
      for (let day = 0; day < 21; day += 1) {
        const base = dayStartMs + day * DAY_MS;
        for (const [start, end] of policy.peakWindows) {
          candidates.push(base + start * MINUTE_MS, base + end * MINUTE_MS);
        }
      }
      candidates.sort((left, right) => left - right);
      for (const at of candidates) {
        if (at <= instantMs) continue;
        if (isPeakAt(at, policy) !== current) return at;
      }
      return null;
    }

    /**
     * Ближайшее начало пикового окна строго после мгновения.
     * @param {number} instantMs - миллисекунды эпохи.
     * @param {object} policy - политика тарифов.
     * @returns {number | null} начало следующего пика либо null (окон нет).
     */
    function nextPeakStartAt(instantMs, policy = DEFAULT_POLICY) {
      const { dayStartMs } = beijingParts(instantMs, policy);
      const candidates = [];
      for (let day = 0; day < 21; day += 1) {
        const base = dayStartMs + day * DAY_MS;
        for (const [start] of policy.peakWindows) {
          candidates.push(base + start * MINUTE_MS);
        }
      }
      candidates.sort((left, right) => left - right);
      for (const at of candidates) {
        if (at <= instantMs) continue;
        if (isPeakAt(at, policy)) return at;
      }
      return null;
    }

    /**
     * Цвет светофора в мгновение: красный в пик, жёлтый в окне предупреждения
     * перед пиком, зелёный в остальное время.
     * @param {number} instantMs - миллисекунды эпохи.
     * @param {object} policy - политика тарифов.
     * @returns {'red' | 'yellow' | 'green'} цвет светофора.
     */
    function lightAt(instantMs, policy = DEFAULT_POLICY) {
      if (isPeakAt(instantMs, policy)) return 'red';
      const next = nextPeakStartAt(instantMs, policy);
      if (next !== null && next - instantMs <= policy.warningMinutes * MINUTE_MS) return 'yellow';
      return 'green';
    }

    /**
     * Собрать политику из значений конфигурации твика, откатившись к дефолтам.
     *
     * Принимает «плоскую» конфигурацию: обычный объект с полями
     * `trafficLightPeakWindows` (массив `{ start, end }` по Пекину),
     * `trafficLightHolidays` (массив дат YYYY-MM-DD) и
     * `trafficLightWarningMinutes` (число). Неверные значения отбрасываются.
     * @param {object} [config] - плоская конфигурация твика.
     * @returns {object} нормализованная политика.
     */
    function normalizePolicy(config) {
      const policy = {
        utcOffsetMinutes: DEFAULT_POLICY.utcOffsetMinutes,
        peakWindows: DEFAULT_POLICY.peakWindows,
        holidays: DEFAULT_POLICY.holidays,
        warningMinutes: DEFAULT_POLICY.warningMinutes,
      };
      if (Array.isArray(config?.trafficLightPeakWindows)) {
        const parsed = [];
        for (const window of config.trafficLightPeakWindows) {
          const start = parseClock(window?.start);
          const end = parseClock(window?.end);
          if (start !== null && end !== null && end > start) parsed.push([start, end]);
        }
        if (parsed.length > 0) policy.peakWindows = parsed;
      }
      if (Array.isArray(config?.trafficLightHolidays)) {
        policy.holidays = config.trafficLightHolidays.filter(
          (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
        );
      }
      const minutes = config?.trafficLightWarningMinutes;
      if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 180) {
        policy.warningMinutes = minutes;
      }
      return policy;
    }
    /* endregion traffic-light-policy */

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
        'tweak.trafficLight': 'Peak-hours traffic light',
        'light.offpeak': 'Cheap hours',
        'light.peak': 'Expensive hours',
        'light.warning': 'Expensive hours soon',
        'light.untilGreen': 'Expensive hours until {{time}}',
        'light.untilRed': 'Expensive hours start at {{time}}',
        'light.untilPeak': 'Cheap hours until {{time}}',
        'light.countdownH': '{{hours}} h {{minutes}} min',
        'light.countdownM': '{{minutes}} min {{seconds}} s',
        'light.countdownS': '{{seconds}} s',
        'light.clockTitle': '24-hour price clock',
        'light.weekdays': 'Mon–Fri',
        'light.holidaysNote': 'Except Chinese public holidays',
        'light.timeZone': 'Current time zone: {{zone}}',
        'light.localTimeNote': 'Times are shown in your time zone',
        'light.currentSlot': 'Now: {{time}}',
        'light.slotLabel': '{{time}} · {{label}}',
        'light.pausedHint': 'Automatic work is paused while the light is red',
        'light.setting.dock': 'Bottom indicator',
        'light.setting.dock.lamp': 'Indicator only',
        'light.setting.dock.time': 'Indicator and time left',
        'light.setting.dock.timeOnly': 'Time only',
        'light.setting.dock.label': 'Indicator, time and tariff label',
        'light.setting.warning': 'Warning',
        'light.setting.warningValue': '{{minutes}} min before',
        'light.setting.hint': 'These settings live in this browser; each developer keeps their own',
        'light.tomorrow': 'tomorrow {{time}}',
        'light.left': '{{value}} left',
        'light.leftTo': '{{value}} left · until {{time}}',
        'light.switchLine': 'Tariff switch: {{time}} (in {{left}})',
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
        'tweak.trafficLight': 'Светофор дорогих часов',
        'light.offpeak': 'Дешёвые часы',
        'light.peak': 'Дорогие часы',
        'light.warning': 'Скоро дорогие часы',
        'light.untilGreen': 'Дорогие часы до {{time}}',
        'light.untilRed': 'Дорогие часы начнутся в {{time}}',
        'light.untilPeak': 'Дешёвые часы до {{time}}',
        'light.countdownH': '{{hours}} ч {{minutes}} мин',
        'light.countdownM': '{{minutes}} мин {{seconds}} с',
        'light.countdownS': '{{seconds}} с',
        'light.clockTitle': 'Часы тарифа на сутки',
        'light.weekdays': 'Пн–Пт',
        'light.holidaysNote': 'Кроме праздников КНР',
        'light.timeZone': 'Текущий часовой пояс: {{zone}}',
        'light.localTimeNote': 'Время — в вашем часовом поясе',
        'light.currentSlot': 'Сейчас: {{time}}',
        'light.slotLabel': '{{time}} · {{label}}',
        'light.pausedHint': 'Автоматическая работа на паузе, пока горит красный',
        'light.setting.dock': 'Нижний индикатор',
        'light.setting.dock.lamp': 'Только индикатор',
        'light.setting.dock.time': 'Индикатор и оставшееся время',
        'light.setting.dock.timeOnly': 'Только время',
        'light.setting.dock.label': 'Индикатор, время и подпись о тарифе',
        'light.setting.warning': 'Предупреждение',
        'light.setting.warningValue': 'за {{minutes}} мин',
        'light.setting.hint': 'Настройки хранятся в этом браузере: у каждого разработчика свои',
        'light.tomorrow': 'завтра {{time}}',
        'light.left': 'ещё {{value}}',
        'light.leftTo': 'ещё {{value}} · до {{time}}',
        'light.switchLine': 'Смена тарифа: {{time}} (через {{left}})',
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
     * модели и прогресс подготовки.
     *
     * Шов к хост-половине — namespace-служба Remote-шины. Клиентская половина
     * голосового ввода (`@deepseek-ai/dsh-experimental-client-ui-voice-input`)
     * монтирует дескрипторы `@deepseek-ai/dsh-experimental-api-speech-to-text`
     * через `ctx.remote.$mount`, а api-gateway кладёт namespace в контекст под
     * ключом `remote.<namespace>` (функция `remoteServiceKey`). Значит, служба
     * распознавания на клиенте — `ctx.get('remote.speech')`. Имена хост-сервисов
     * (`speechToText` у реестра, `speechController` у API-обёртки) клиенту не
     * видны: по ним шов не находится.
     */
    const WHISPER_PROVIDER_ID = 'whisper-local';
    const WHISPER_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '10px' };
    /** Пояснение рядом с кнопкой: токен темы, литеральных цветов нет. */
    const WHISPER_NOTICE_STYLE = { color: 'var(--dsw-alias-label-secondary)' };
    /** Опрос появления шва: 0.5 с × 20 = 10 с, дальше остаётся ручная проверка. */
    const WHISPER_LOOKUP_MS = 500;
    const WHISPER_LOOKUP_TRIES = 20;

    /** Последний снимок каталога распознавания; null — снимок ещё не пришёл. */
    let whisperCatalog = null;
    /** Причина последнего отказа: подготовка не запустилась либо канал молчит. */
    let whisperFailure = '';
    /** Запрос подготовки принят, но состояние из каталога ещё не пришло. */
    let whisperPending = false;
    /** Подписчики состояния кнопки: её перерисовывает любое изменение. */
    const whisperListeners = new Set();
    /** Клиентская служба распознавания (`remote.speech`) либо null. */
    let speechService = null;
    /** Контекст плагина: по нему кнопка «Проверить снова» ищет шов заново. */
    let speechContext = null;
    /** Сигнал отмены потока follow. */
    let speechAbort = null;
    /** Id опроса появления шва; 0 — опроса нет. */
    let speechLookupTimer = 0;

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

    /**
     * Состояние кнопки одним объектом.
     *
     * Новый объект на каждый вызов: React сравнивает состояние по ссылке, и без
     * этого смена причины отказа не перерисовала бы кнопку.
     * @returns {object} каталог, причина отказа, ожидание ответа и наличие шва.
     */
    function whisperState() {
      return {
        catalog: whisperCatalog,
        failure: whisperFailure,
        pending: whisperPending,
        connected: speechService !== null,
      };
    }

    /** Разослать текущее состояние подписчикам кнопки. */
    function whisperNotify() {
      for (const listener of [...whisperListeners]) listener();
    }

    /**
     * Принять новый снимок каталога и уведомить кнопку.
     * @param {object | null} catalog - снимок каталога либо null, если его нет.
     * @returns {void}
     */
    function whisperEmit(catalog) {
      whisperCatalog = catalog;
      whisperPending = false;
      // Снимок с провайдером означает, что мир изменился: прежняя причина отказа
      // его больше не описывает. Снимок без провайдера причину сохраняет — иначе
      // пользователь не увидел бы, почему подготовка не запустилась.
      if (whisperSnapshot(catalog).provider !== null) whisperFailure = '';
      whisperNotify();
    }

    /**
     * Текст ошибки для показа пользователю.
     * @param {*} error - пойманное значение.
     * @returns {string} сообщение.
     */
    function whisperErrorText(error) {
      if (error === null || error === undefined) return 'неизвестная ошибка';
      if (typeof error === 'string') return error;
      return String(error.message ?? error);
    }

    /**
     * Значение прямого Remote-вызова: шина отдаёт обёртку `{ ok, value }`.
     * @param {*} result - ответ вызова либо элемент потока.
     * @returns {*} значение либо null, если вызов отвергнут.
     */
    function whisperValue(result) {
      if (result === null || typeof result !== 'object') return result ?? null;
      if (result.ok === true) return result.value ?? null;
      if (result.ok === false) return null;
      return result;
    }

    /**
     * Причина отказа прямого Remote-вызова.
     *
     * Отвергнутый вызов не бросает исключение, а возвращает `{ ok: false, error }`:
     * без разбора этого поля кнопка молчала бы о причине.
     * @param {*} result - ответ вызова.
     * @returns {string} сообщение либо пустая строка, если вызов принят.
     */
    function whisperRefusal(result) {
      if (result === null || typeof result !== 'object' || result.ok !== false) return '';
      return whisperErrorText(result.error);
    }

    /**
     * Найти клиентскую службу распознавания.
     *
     * Первый доступ — `ctx.get('remote.speech')`: так namespace-службу кладёт
     * api-gateway. Два запасных доступа нужны на случай сборки, где namespace
     * отдан свойством самого сервиса Remote; шов они не подменяют.
     * @param {object | null} ctx - клиентский контекст плагина.
     * @returns {object | null} служба распознавания либо null, если её нет.
     */
    function findSpeechService(ctx) {
      if (typeof ctx?.get !== 'function') return null;
      const readers = [
        () => ctx.get('remote.speech'),
        () => ctx.get('remote')?.speech,
        () => ctx.remote?.speech,
      ];
      for (const read of readers) {
        try {
          const service = read();
          if (service !== null && typeof service === 'object') return service;
        } catch (_error) {
          /* доступ не поддержан сборкой: пробуем следующий */
        }
      }
      return null;
    }

    /** Остановить опрос появления шва. */
    function stopSpeechLookup() {
      if (speechLookupTimer === 0) return;
      window.clearInterval(speechLookupTimer);
      speechLookupTimer = 0;
    }

    /**
     * Подключиться к найденной службе: снимок каталога и живой поток готовности.
     *
     * Прямой вызов отдаёт обёртку `{ ok, value }`, поток `follow` — сами снимки
     * каталога; `whisperValue` принимает оба вида.
     * @param {object} service - служба `remote.speech`.
     * @returns {void}
     */
    function connectSpeech(service) {
      const signal = speechAbort?.signal;
      if (signal === undefined) return;
      speechService = service;
      whisperFailure = '';
      if (typeof service.catalog === 'function') {
        Promise.resolve()
          .then(() => service.catalog())
          .then((result) => {
            const catalog = whisperValue(result);
            if (speechService === service && catalog !== null) whisperEmit(catalog);
          })
          .catch((error) => {
            // Поток follow остаётся основным источником: сбой снимка не приговор.
            if (speechService === service && whisperCatalog === null) {
              whisperFailure = whisperErrorText(error);
              whisperNotify();
            }
          });
      }
      if (typeof service.follow !== 'function') return;
      (async () => {
        try {
          for await (const item of service.follow(signal)) {
            if (signal.aborted) return;
            const catalog = whisperValue(item);
            if (speechService === service && catalog !== null) whisperEmit(catalog);
          }
        } catch (error) {
          if (signal.aborted || speechService !== service) return;
          whisperFailure = whisperErrorText(error);
          whisperNotify();
        }
      })();
    }

    /**
     * Найти шов сейчас и подключиться; при неудаче — опрос до появления службы.
     * @returns {boolean} найден ли шов.
     */
    function lookupSpeechSeam() {
      const service = findSpeechService(speechContext);
      if (service === null) {
        startSpeechLookup();
        whisperNotify();
        return false;
      }
      stopSpeechLookup();
      if (speechService !== service) connectSpeech(service);
      whisperNotify();
      return true;
    }

    /**
     * Опрашивать появление шва.
     *
     * Клиентская половина голосового ввода монтируется асинхронно, поэтому при
     * включённом на старте твике службы может ещё не быть; ручной проверки мало.
     * @returns {void}
     */
    function startSpeechLookup() {
      if (speechLookupTimer !== 0 || speechAbort === null) return;
      if (typeof window.setInterval !== 'function') return;
      let left = WHISPER_LOOKUP_TRIES;
      speechLookupTimer = window.setInterval(() => {
        left -= 1;
        if (left <= 0) {
          stopSpeechLookup();
          return;
        }
        if (findSpeechService(speechContext) === null) return;
        lookupSpeechSeam();
      }, WHISPER_LOOKUP_MS);
    }

    /** Кнопка «Проверить снова»: поиск шва заново, со свежим запасом попыток. */
    function retrySpeechLookup() {
      stopSpeechLookup();
      lookupSpeechSeam();
    }

    /**
     * Подключить клиентскую часть твика: найти шов и слушать подготовку модели.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {object} api - api твика (`own` регистрирует очистки).
     * @returns {void}
     */
    function setupWhisper(ctx, api) {
      const own = typeof api?.own === 'function' ? api.own : () => {};
      speechContext = ctx;
      speechAbort = new AbortController();
      whisperCatalog = null;
      whisperFailure = '';
      whisperPending = false;
      own(teardownWhisper);
      lookupSpeechSeam();
    }

    /** Отключить клиентскую часть твика: снять подписку и очистить состояние. */
    function teardownWhisper() {
      if (speechAbort !== null) speechAbort.abort();
      speechAbort = null;
      stopSpeechLookup();
      speechService = null;
      speechContext = null;
      whisperCatalog = null;
      whisperFailure = '';
      whisperPending = false;
      whisperListeners.clear();
    }

    /**
     * Попросить хост подготовить модель и показать причину, если запрос отвергнут.
     *
     * Отвергнутый Remote-вызов возвращает обёртку `{ ok: false, error }`, а не
     * бросает исключение, поэтому причину разбираем и в ответе, и в исключении.
     * @returns {Promise<void>} завершается после ответа службы.
     */
    async function requestPrepare() {
      const service = speechService;
      if (service === null || typeof service.prepare !== 'function') {
        whisperFailure = 'служба распознавания не подключена';
        whisperNotify();
        return;
      }
      whisperFailure = '';
      whisperPending = true;
      whisperNotify();
      try {
        const result = await service.prepare(WHISPER_PROVIDER_ID);
        if (speechService !== service) return;
        const refusal = whisperRefusal(result);
        if (refusal !== '') {
          whisperFailure = refusal;
          whisperPending = false;
        }
      } catch (error) {
        if (speechService !== service) return;
        whisperFailure = whisperErrorText(error);
        whisperPending = false;
      }
      whisperNotify();
    }

    /**
     * Реакт-хук: состояние кнопки, перерисовка на любое изменение.
     * @returns {object} снимок: каталог, причина отказа, ожидание, наличие шва.
     */
    function useWhisperState() {
      const [state, setState] = React.useState(whisperState());
      React.useEffect(() => {
        const listener = () => setState(whisperState());
        whisperListeners.add(listener);
        return () => whisperListeners.delete(listener);
      }, []);
      return state;
    }

    /** Объём в мегабайтах; при известном общем размере — «X / Y МБ». */
    function formatBytes(bytes, total) {
      const mb = (value) => `${Math.round(value / (1024 * 1024))}`;
      return total === undefined ? `${mb(bytes)} МБ` : `${mb(bytes)} / ${mb(total)} МБ`;
    }

    /**
     * Строка кнопки подготовки: подпись и, если нужно, действие.
     * @param {...object} children - содержимое строки.
     * @returns {object} React-элемент.
     */
    function whisperRow(...children) {
      return React.createElement('div', { style: WHISPER_ROW_STYLE }, ...children);
    }

    /**
     * Подпись состояния.
     * @param {string} value - текст.
     * @param {boolean} [secondary] - показывать как пояснение.
     * @returns {object} React-элемент.
     */
    function whisperText(value, secondary = false) {
      return React.createElement('span', secondary ? { style: WHISPER_NOTICE_STYLE } : null, value);
    }

    /**
     * Кнопка действия.
     * @param {string} label - подпись.
     * @param {Function} onClick - обработчик.
     * @returns {object} React-элемент.
     */
    function whisperButton(label, onClick) {
      return React.createElement('button', { type: 'button', onClick }, label);
    }

    /**
     * Кнопка загрузки модели с прогрессом подготовки.
     *
     * Состояния честные: нет шва — об этом сказано и предложена проверка; нет
     * провайдера — назван он сам; отказ подготовки — названа его причина.
     * @returns {object} React-элемент.
     */
    function WhisperPrepareButton() {
      const { catalog, failure, pending, connected } = useWhisperState();

      if (!connected) {
        return whisperRow(
          whisperText('Служба распознавания не подключена.', true),
          whisperButton('Проверить снова', retrySpeechLookup),
        );
      }
      if (catalog === null) {
        const waiting = [whisperText(pending ? 'Подготовка запущена…' : 'Подключение к службе распознавания…')];
        if (failure !== '') waiting.push(whisperText(`Причина: ${failure}`, true));
        return whisperRow(...waiting);
      }

      const { provider, phase, message, completedBytes, totalBytes } = whisperSnapshot(catalog);
      if (provider === null) {
        const missing = [whisperText(`Провайдер «${WHISPER_PROVIDER_ID}» не зарегистрирован.`)];
        if (failure !== '') missing.push(whisperText(`Причина: ${failure}`, true));
        missing.push(whisperButton('Повторить', requestPrepare));
        return whisperRow(...missing);
      }
      if (phase === 'downloading') {
        return whisperRow(whisperText(`Загрузка модели: ${formatBytes(completedBytes, totalBytes)}`));
      }
      if (phase === 'checking' || phase === 'loading' || phase === 'waking' || phase === 'cancelling') {
        return whisperRow(whisperText('Подготовка модели…'));
      }
      if (phase === 'ready' || phase === 'standby') {
        return whisperRow(whisperText('Модель готова'));
      }
      if (phase === 'failed') {
        return whisperRow(
          whisperText(`Ошибка подготовки: ${message || failure || 'неизвестная'}`),
          whisperButton('Повторить', requestPrepare),
        );
      }
      // unprepared | cancelled: модель ещё не подготовлена.
      const ready = [];
      if (pending) ready.push(whisperText('Подготовка запущена…'));
      if (failure !== '') ready.push(whisperText(`Не удалось запустить: ${failure}`, true));
      if (!pending) ready.push(whisperButton('Скачать модель', requestPrepare));
      return whisperRow(...ready);
    }
    /* #endregion tweak-whisper */

    /* #region tweak-traffic-light */
    /** Период пересчёта индикатора: раз в секунду, чтобы тикал отсчёт. */
    const LIGHT_TICK_MS = 1000;

    /** Цвета лампы из токенов темы: красный — ошибка, жёлтый — предупреждение, зелёный — успех. */
    const LIGHT_COLORS = {
      red: 'var(--dsw-alias-state-error-primary)',
      yellow: 'var(--dsw-alias-state-warn-primary)',
      green: 'var(--dsw-alias-state-success-primary)',
    };

    /** Префикс классов твика — как у меню по правой кнопке. */
    const LIGHT_CLASS = 'dsh-ui-light';

    /** Ключ пер-устройственных настроек твика (как у масштаба: своё значение на браузер). */
    const LIGHT_PREFS_KEY = 'dsh.ui-light.settings.v1';

    /** Режимы нижнего индикатора, по возрастанию подробности. */
    const LIGHT_DOCK_MODES = ['lamp', 'lamp-time', 'time', 'lamp-time-label'];

    /** Варианты предупреждения о приближении пика, в минутах. */
    const LIGHT_WARNING_CHOICES = [10, 20, 30];

    /** Контекст твика и переводчик: ставятся в setup, читаются компонентами. */
    let lightContext = null;
    let lightTranslator = (key) => key;

    /**
     * Настройки твика на устройство: режим нижнего индикатора и время
     * предупреждения. Хранятся в localStorage — они только про показ, поэтому
     * у каждого разработчика свои и хост-половине не нужны.
     */
    const lightPrefs = (() => {
      let storage = null;
      try {
        storage = window.localStorage;
      } catch (_error) {
        storage = null;
      }
      const listeners = new Set();

      /** Прочитать сохранённые настройки, отбросив испорченные значения. */
      function read() {
        try {
          const raw = storage?.getItem(LIGHT_PREFS_KEY);
          const parsed = raw === null || raw === undefined ? null : JSON.parse(raw);
          const prefs = {};
          if (parsed !== null && typeof parsed === 'object') {
            if (LIGHT_DOCK_MODES.includes(parsed.dockMode)) prefs.dockMode = parsed.dockMode;
            if (LIGHT_WARNING_CHOICES.includes(parsed.warningMinutes)) {
              prefs.warningMinutes = parsed.warningMinutes;
            }
          }
          return prefs;
        } catch (_error) {
          return {};
        }
      }

      let value = read();
      return {
        get: () => value,
        /**
         * Записать настройку и уведомить подписчиков.
         * @param {object} patch - поля для записи (undefined снимает поле).
         * @returns {object} применённые настройки.
         */
        set(patch) {
          const next = { ...value };
          for (const [key, field] of Object.entries(patch)) {
            if (field === undefined) delete next[key];
            else next[key] = field;
          }
          value = next;
          try {
            storage?.setItem(LIGHT_PREFS_KEY, JSON.stringify(next));
          } catch (_error) {
            /* приватный режим или запрет записи: настройка живёт до перезагрузки */
          }
          for (const listener of listeners) listener();
          return value;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    })();

    /** Хук настроек устройства: снимок с подпиской на изменения. */
    function useLightPrefs() {
      const [prefs, setPrefs] = React.useState(lightPrefs.get());
      React.useEffect(() => lightPrefs.subscribe(() => setPrefs(lightPrefs.get())), []);
      return prefs;
    }

    /** Общее состояние светофора: политика тарифов и подписчики. */
    const lightHub = (() => {
      let policy = { ...DEFAULT_POLICY };
      const listeners = new Set();
      return {
        getPolicy: () => policy,
        setConfig(value) {
          policy = normalizePolicy(value);
          for (const listener of listeners) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    })();

    /**
     * Политика с учётом настроек устройства.
     *
     * Время предупреждения влияет только на показ (хост-половина различает
     * лишь красный и зелёный), поэтому личная настройка браузера перекрывает
     * значение из конфигурации профиля.
     * @returns {object} политика для расчёта индикатора.
     */
    function effectivePolicy() {
      const policy = lightHub.getPolicy();
      const minutes = lightPrefs.get().warningMinutes;
      if (minutes === undefined) return policy;
      return { ...policy, warningMinutes: minutes };
    }

    /**
     * Статус светофора в мгновение.
     * @param {number} instantMs - миллисекунды эпохи.
     * @returns {object} цвет, границы переходов и отсчёт.
     */
    function lightStatus(instantMs) {
      const policy = effectivePolicy();
      const light = lightAt(instantMs, policy);
      const nextSwitch = nextSwitchAt(instantMs, policy);
      const nextPeak = nextPeakStartAt(instantMs, policy);
      return {
        light,
        nextSwitchAt: nextSwitch,
        nextPeakStartAt: nextPeak,
        msUntilSwitch: nextSwitch === null ? null : Math.max(0, nextSwitch - instantMs),
      };
    }

    /** Дополнить число нулём до двух знаков. */
    function twoDigits(value) {
      return value < 10 ? `0${value}` : `${value}`;
    }

    /** Время суток в местном часовом поясе, «HH:MM». */
    function formatClock(instantMs) {
      const date = new Date(instantMs);
      return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
    }

    /**
     * Подпись момента в местном времени с днём недели, когда он не сегодня:
     * у отсчёта «60 ч» должен быть виден адрес — до какого дня и часа.
     * @param {number} instantMs - целевой момент.
     * @param {number} nowMs - текущий момент.
     * @param {Function} t - переводчик словаря твика.
     * @returns {string} подпись вида «09:00», «завтра 09:00» или «пн 09:00».
     */
    function formatTarget(instantMs, nowMs, t) {
      const target = new Date(instantMs);
      const now = new Date(nowMs);
      const clock = formatClock(instantMs);
      const sameDay =
        target.getFullYear() === now.getFullYear() &&
        target.getMonth() === now.getMonth() &&
        target.getDate() === now.getDate();
      if (sameDay) return clock;
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const isTomorrow =
        target.getFullYear() === tomorrow.getFullYear() &&
        target.getMonth() === tomorrow.getMonth() &&
        target.getDate() === tomorrow.getDate();
      if (isTomorrow) return fillText(t('light.tomorrow'), { time: clock });
      let weekday = '';
      try {
        weekday = target.toLocaleDateString(undefined, { weekday: 'short' });
      } catch (_error) {
        weekday = '';
      }
      return weekday === '' ? clock : `${weekday} ${clock}`;
    }

    /** Часовой пояс браузера; без Intl — UTC. */
    function localTimeZone() {
      try {
        if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return 'UTC';
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch (_error) {
        return 'UTC';
      }
    }

    /** Подпись окна пика в местном времени: «09:00–12:00». */
    function localWindowLabel(window, policy, nowMs) {
      const parts = beijingParts(nowMs, policy);
      const startMs = parts.dayStartMs + window[0] * 60000;
      const endMs = parts.dayStartMs + window[1] * 60000;
      return `${formatClock(startMs)}–${formatClock(endMs)}`;
    }

    /**
     * Статусы 24 местных часов сегодняшних суток по серединам часов.
     *
     * Считается именно пик, а не цвет светофора: на шкале нет жёлтых кружочков —
     * жёлтым мигает только лампа, предупреждая о приближении дорогого времени.
     * Выходные и праздники целиком не пик, поэтому вся полоска зелёная.
     * @param {number} nowMs - текущий момент.
     * @returns {Array<{hour: number, peak: boolean}>} статусы часов.
     */
    function todayHourStatuses(nowMs) {
      const now = new Date(nowMs);
      const base = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const policy = effectivePolicy();
      const statuses = [];
      for (let hour = 0; hour < 24; hour += 1) {
        const instant = base + hour * 3600000 + 1800000;
        statuses.push({ hour, peak: isPeakAt(instant, policy) });
      }
      return statuses;
    }

    /** Ключ подписи цвета в словаре. */
    function lightLabelKey(light) {
      return light === 'red' ? 'light.peak' : light === 'yellow' ? 'light.warning' : 'light.offpeak';
    }

    /** Ключ подписи отсчёта до перехода в словаре. */
    function lightCountdownKey(status) {
      if (status.light === 'red') return 'light.untilGreen';
      if (status.light === 'yellow') return 'light.untilRed';
      return 'light.untilPeak';
    }

    /** Мгновение, до которого идёт отсчёт. */
    function lightCountdownTarget(status) {
      if (status.light === 'red') return status.nextSwitchAt;
      return status.nextPeakStartAt;
    }

    /** Заменить {{ключи}} значениями. */
    function fillText(template, values) {
      let text = template;
      for (const [key, value] of Object.entries(values)) {
        text = text.split(`{{${key}}}`).join(String(value));
      }
      return text;
    }

    /** Отсчёт «X ч MM мин» / «M мин SS с» по словарю. */
    function formatCountdownText(ms, t) {
      const total = Math.max(0, Math.ceil(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (hours > 0) return fillText(t('light.countdownH'), { hours, minutes: twoDigits(minutes) });
      if (minutes > 0) return fillText(t('light.countdownM'), { minutes, seconds: twoDigits(seconds) });
      return fillText(t('light.countdownS'), { seconds });
    }

    /**
     * Хук состояния индикатора: тик раз в секунду, подписка на политику
     * и признак «кто-то работает» из списка сессий.
     * @returns {object} now — текущее время, running — есть ли работа.
     */
    function useLightTick() {
      const [now, setNow] = React.useState(Date.now());
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return undefined;
        const timer = window.setInterval(() => setNow(Date.now()), LIGHT_TICK_MS);
        return () => window.clearInterval(timer);
      }, []);
      const [revision, setRevision] = React.useState(0);
      React.useEffect(() => lightHub.subscribe(() => setRevision((value) => value + 1)), []);
      const [running, setRunning] = React.useState(false);
      React.useEffect(() => {
        let sessions = undefined;
        try {
          sessions = typeof lightContext?.get === 'function' ? lightContext.get('sessions') : undefined;
        } catch (_error) {
          sessions = undefined;
        }
        const list = sessions?.list;
        if (list === undefined) {
          setRunning(false);
          return undefined;
        }
        const read = () => {
          try {
            const snapshot = list.getSnapshot?.();
            const byId = snapshot?.byId ?? {};
            return Object.keys(byId).some((id) => byId[id]?.running === true);
          } catch (_error) {
            return false;
          }
        };
        setRunning(read());
        if (typeof list.subscribe !== 'function') return undefined;
        return list.subscribe(() => setRunning(read()));
      }, []);
      return { now, running, revision };
    }

    /** Ширина панели-тултипа в пикселях. */
    const LIGHT_PANEL_WIDTH = 340;

    /**
     * Позиция панели-тултипа у якоря.
     * @param {object} anchorRef - ref кнопки.
     * @param {object} panelRef - ref панели.
     * @param {boolean} preferUp - предпочитать положение над кнопкой.
     * @returns {object} left/top вьюпортных пикселей.
     */
    function panelPosition(anchorRef, panelRef, preferUp) {
      const rect = anchorRef?.current?.getBoundingClientRect?.();
      const margin = 8;
      if (rect === undefined) return { left: margin, top: margin };
      const width = panelRef?.current?.offsetWidth ?? LIGHT_PANEL_WIDTH;
      const height = panelRef?.current?.offsetHeight ?? 260;
      const viewportWidth =
        typeof window === 'undefined' || !Number.isFinite(window.innerWidth) ? 1024 : window.innerWidth;
      const viewportHeight =
        typeof window === 'undefined' || !Number.isFinite(window.innerHeight) ? 768 : window.innerHeight;
      const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - width / 2, viewportWidth - width - margin));
      const top = preferUp
        ? Math.max(margin, rect.top - height - margin)
        : Math.min(rect.bottom + margin, viewportHeight - height - margin);
      return { left, top };
    }

    /** Геометрия горизонтальной шкалы часов: 24 кружочка от 0 до 24. */
    const STRIP_WIDTH = 316;
    const STRIP_HEIGHT = 46;
    const STRIP_PAD = 8;
    const STRIP_STEP = (STRIP_WIDTH - 2 * STRIP_PAD) / 23;
    const STRIP_Y = 20;
    const STRIP_HOUR_MARKS = [0, 6, 12, 18];

    /**
     * Горизонтальная шкала суток: 24 кружочка от 0 до 24 часов в местном
     * времени. Красные — дорогие часы, зелёные — дешёвые, включая выходные и
     * праздники целиком. Жёлтых кружочков на шкале нет.
     * @param {object} props - now, hover, setHover.
     * @returns {object} SVG-шкала.
     */
    function TrafficHourStrip({ now, hover, setHover }) {
      const statuses = todayHourStatuses(now);
      const currentHour = new Date(now).getHours();
      const xOf = (hour) => STRIP_PAD + hour * STRIP_STEP;
      /**
       * Час под курсором: ближайший кружок к позиции указателя. Зона наведения —
       * вся шкала, поэтому между кружочками нет пробелов и подсветка не мигает.
       * @param {object} event - событие движения мыши.
       * @returns {void}
       */
      const onStripMove = (event) => {
        const rect = typeof event?.currentTarget?.getBoundingClientRect === 'function'
          ? event.currentTarget.getBoundingClientRect()
          : null;
        if (rect === null || !Number.isFinite(rect.width) || rect.width <= 0) return;
        const scale = rect.width / STRIP_WIDTH;
        const x = (event.clientX - rect.left) / scale - STRIP_PAD;
        setHover(Math.max(0, Math.min(23, Math.round(x / STRIP_STEP))));
      };
      const children = [
        // Прозрачная подложка: она и есть зона наведения на всю шкалу.
        React.createElement('rect', {
          key: 'strip',
          x: 0,
          y: 0,
          width: STRIP_WIDTH,
          height: STRIP_HEIGHT,
          fill: 'transparent',
          onMouseMove: onStripMove,
        }),
      ];
      // Отметки часов под шкалой для ориентации.
      for (const hour of STRIP_HOUR_MARKS) {
        children.push(React.createElement('text', {
          key: `mark-${hour}`,
          x: xOf(hour),
          y: STRIP_HEIGHT - 5,
          textAnchor: 'middle',
          fontSize: 9,
          style: { fill: 'var(--dsw-alias-label-tertiary)', userSelect: 'none', pointerEvents: 'none' },
        }, twoDigits(hour)));
      }
      // Кружочки часов: красный — дорого, зелёный — дёшево.
      for (const slot of statuses) {
        const isCurrent = slot.hour === currentHour;
        const active = hover === slot.hour || hover === null || isCurrent;
        children.push(React.createElement('circle', {
          key: `dot-${slot.hour}`,
          cx: xOf(slot.hour),
          cy: STRIP_Y,
          r: isCurrent ? 6.5 : hover === slot.hour ? 6 : 4.6,
          opacity: active ? 1 : 0.4,
          strokeWidth: isCurrent ? 2 : 0,
          style: {
            fill: slot.peak ? LIGHT_COLORS.red : LIGHT_COLORS.green,
            stroke: isCurrent ? 'var(--dsw-alias-bg-overlay)' : 'none',
            pointerEvents: 'none',
            transition: 'r 120ms ease, opacity 120ms ease',
          },
        }));
      }
      // Указатель «сейчас» над текущим часом.
      children.push(React.createElement('path', {
        key: 'now',
        d: `M ${xOf(currentHour) - 3.5} ${STRIP_Y - 11} L ${xOf(currentHour) + 3.5} ${STRIP_Y - 11} L ${xOf(currentHour)} ${STRIP_Y - 5.5} Z`,
        style: { fill: 'var(--dsw-alias-label-primary)', pointerEvents: 'none' },
      }));
      return React.createElement('svg', {
        viewBox: `0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`,
        width: '100%',
        height: STRIP_HEIGHT,
        style: { display: 'block' },
        'aria-hidden': true,
        // Подсветка снимается только при уходе курсора со шкалы.
        onMouseLeave: () => setHover(null),
      }, children);
    }

    /**
     * Панель-тултип: статус, отсчёт, циферблат и правило тарифов.
     * @param {object} props - anchorRef, variant, onClose.
     * @returns {object} панель.
     */
    function TrafficClockPanel({ anchorRef, variant, onClose }) {
      const { now, running } = useLightTick();
      const status = lightStatus(now);
      const [hover, setHover] = React.useState(null);
      const [position, setPosition] = React.useState(null);
      const panelRef = React.useRef(null);
      /**
       * Пересчитать позицию панели по её настоящим размерам.
       *
       * Панель сначала монтируется невидимой (visibility:hidden — размеры при
       * этом измеримы), поэтому она появляется сразу на месте и не прыгает из
       * предварительной позиции, посчитанной по предполагаемым размерам.
       * @returns {void}
       */
      const measure = () => {
        const next = panelPosition(anchorRef, panelRef, variant === 'dock');
        setPosition((current) =>
          current !== null && current.left === next.left && current.top === next.top ? current : next,
        );
      };
      // Замер до первой отрисовки: React выполняет layout-эффект синхронно,
      // поэтому кадр с неверной позицией не успевает попасть на экран.
      const useLayout = React.useLayoutEffect ?? React.useEffect;
      useLayout(() => {
        measure();
      }, []);
      React.useEffect(() => {
        measure();
      }, [now]);
      React.useEffect(() => {
        const onResize = () => measure();
        window.addEventListener('resize', onResize);
        // Прокрутка чата сдвигает якорь нижнего индикатора: панель едет следом.
        document.addEventListener('scroll', onResize, true);
        return () => {
          window.removeEventListener('resize', onResize);
          document.removeEventListener('scroll', onResize, true);
        };
      }, []);
      React.useEffect(() => {
        const onPointer = (event) => {
          const panel = panelRef.current;
          const anchor = anchorRef.current;
          if (panel !== null && panel.contains(event.target)) return;
          if (anchor !== null && anchor.contains(event.target)) return;
          onClose();
        };
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('pointerdown', onPointer, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('pointerdown', onPointer, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [anchorRef, onClose]);
      const t = lightTranslator;
      const target = lightCountdownTarget(status);
      const policy = effectivePolicy();
      const windowsText = policy.peakWindows
        .map((window) => localWindowLabel(window, policy, now))
        .join(' · ');
      const countdown = target === null ? '' : formatCountdownText(target - now, t);
      const hourStatuses = todayHourStatuses(now);
      const hovered = hover === null ? null : hourStatuses.find((slot) => slot.hour === hover) ?? null;
      const slotLine = hovered === null
        ? fillText(t('light.currentSlot'), { time: formatClock(now) })
        : fillText(t('light.slotLabel'), {
            time: `${twoDigits(hovered.hour)}:00–${twoDigits((hovered.hour + 1) % 24)}:00`,
            label: t(hovered.peak ? 'light.peak' : 'light.offpeak'),
          });
      return React.createElement('div', {
        ref: panelRef,
        className: `${LIGHT_CLASS}-panel`,
        style: {
          left: `${position === null ? 0 : position.left}px`,
          top: `${position === null ? 0 : position.top}px`,
          visibility: position === null ? 'hidden' : 'visible',
        },
        role: 'dialog',
        'aria-label': t('light.clockTitle'),
        onMouseLeave: () => setHover(null),
      },
        React.createElement('div', { className: `${LIGHT_CLASS}-head` },
          React.createElement('span', { className: `${LIGHT_CLASS}-lamp`, style: { background: LIGHT_COLORS[status.light] } }),
          React.createElement('span', { className: `${LIGHT_CLASS}-title` }, t(lightLabelKey(status.light))),
          countdown === '' ? null : React.createElement('span', { className: `${LIGHT_CLASS}-count` }, countdown),
        ),
        React.createElement(TrafficHourStrip, { now, hover, setHover }),
        React.createElement('div', { className: `${LIGHT_CLASS}-slot` }, slotLine),
        React.createElement('div', { className: `${LIGHT_CLASS}-rules` },
          target === null
            ? null
            : React.createElement('div', { key: 'switch' },
                fillText(t('light.switchLine'), { time: formatTarget(target, now, t), left: countdown })),
          React.createElement('div', { key: 'days' }, `${t('light.weekdays')} · ${windowsText}`),
          React.createElement('div', { key: 'holidays' }, t('light.holidaysNote')),
          React.createElement('div', { key: 'zone' }, fillText(t('light.timeZone'), { zone: localTimeZone() })),
          React.createElement('div', { key: 'note', className: `${LIGHT_CLASS}-note` }, t('light.localTimeNote')),
        ),
        status.light === 'red' && running
          ? React.createElement('div', { className: `${LIGHT_CLASS}-paused` }, t('light.pausedHint'))
          : null,
      );
    }

    /**
     * Кнопка-светофор: зелёный вне пика, мигающий жёлтый перед пиком,
     * красный в пик; на красном при работающих сессиях — волны вокруг лампы.
     * @param {object} props - variant: 'header' | 'dock'.
     * @returns {object} кнопка с панелью-тултипом.
     */
    function TrafficLightIndicator({ variant }) {
      const { now, running } = useLightTick();
      const prefs = useLightPrefs();
      const status = lightStatus(now);
      const [open, setOpen] = React.useState(false);
      const anchorRef = React.useRef(null);
      const t = lightTranslator;
      const color = LIGHT_COLORS[status.light];
      const blink = status.light === 'yellow';
      const pulse = status.light === 'red' && running;
      const target = lightCountdownTarget(status);
      const label = target === null
        ? t(lightLabelKey(status.light))
        : fillText(t(lightCountdownKey(status)), { time: formatTarget(target, now, t) });
      // В шапке индикатор всегда без текста; у нижнего режим выбирает разработчик.
      const dockMode = variant === 'dock' ? prefs.dockMode ?? 'time' : 'lamp';
      const dot = React.createElement('span', {
        className: `${LIGHT_CLASS}-lamp`,
        style: {
          background: color,
          animation: blink ? `${LIGHT_CLASS}-blink 1s steps(2, start) infinite` : undefined,
        },
      });
      const waves = pulse
        ? [
            React.createElement('span', {
              key: 'wave-a',
              className: `${LIGHT_CLASS}-wave`,
              style: { borderColor: color },
              'aria-hidden': true,
            }),
            React.createElement('span', {
              key: 'wave-b',
              className: `${LIGHT_CLASS}-wave`,
              style: { borderColor: color, animationDelay: '1s' },
              'aria-hidden': true,
            }),
          ]
        : null;
      const content = [];
      // В варианте «только время» лампы нет — остаётся один отсчёт.
      if (dockMode !== 'time') {
        content.push(dot, waves);
      }
      if (dockMode === 'lamp-time-label') {
        content.push(React.createElement('span', { key: 'label', className: `${LIGHT_CLASS}-label` }, t(lightLabelKey(status.light))));
      }
      if (dockMode !== 'lamp' && target !== null) {
        // «Только время» — голый отсчёт; остальные варианты показывают и адрес:
        // «ещё 60 ч 12 мин · до пн 04:00».
        const text = dockMode === 'time'
          ? formatCountdownText(target - now, t)
          : fillText(t('light.leftTo'), {
              value: formatCountdownText(target - now, t),
              time: formatTarget(target, now, t),
            });
        content.push(React.createElement('span', { key: 'time', className: `${LIGHT_CLASS}-count` }, text));
      }
      // Пустой кнопки быть не должно: без отсчёта возвращаем лампу.
      if (content.length === 0) content.push(dot);
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button',
          ref: anchorRef,
          className: `${LIGHT_CLASS}-button`,
          'aria-label': label,
          'data-light': status.light,
          onClick: () => setOpen((value) => !value),
        }, content),
        open
          ? React.createElement(TrafficClockPanel, { anchorRef, variant, onClose: () => setOpen(false) })
          : null,
      );
    }

    /**
     * Настройки твика на странице пакета: превью, режим нижнего индикатора и
     * время предупреждения. Настройки хранятся в браузере, поэтому у каждого
     * разработчика свои и попадают в интерфейс без перезапуска.
     * @param {object} props - переводчики формы флагов (t, translate).
     * @returns {object} превью и два выбора.
     */
    function TrafficLightSettings({ t, translate }) {
      const prefs = useLightPrefs();
      const { now } = useLightTick();
      const status = lightStatus(now);
      const target = lightCountdownTarget(status);

      /**
       * Подпись по ключу словаря: сначала штатный переводчик, затем словарь твика.
       * @param {string} key - ключ словаря.
       * @param {object} [values] - подстановки в шаблон.
       * @returns {string} подпись.
       */
      const copy = (key, values) => {
        const translated = typeof t === 'function' ? t(key) : key;
        const text = translated !== key ? translated : typeof translate === 'function' ? translate(key) : key;
        return values === undefined ? text : fillText(text, values);
      };

      /**
       * Выпадающий список настройки.
       * @param {object} options - value, options и onChange.
       * @returns {object} элемент select.
       */
      const choice = ({ value, options, onChange }) => React.createElement('select', {
        className: `${LIGHT_CLASS}-select`,
        value: String(value),
        onChange: (event) => onChange(event.target.value),
      }, options.map((option) => React.createElement('option', {
        key: String(option.value),
        value: String(option.value),
      }, option.label)));

      const dockMode = prefs.dockMode ?? 'time';
      // Показываем действующее значение: личную настройку, а без неё — значение профиля.
      const profileWarning = lightHub.getPolicy().warningMinutes;
      const currentWarning = prefs.warningMinutes ?? profileWarning;
      const warningChoices = LIGHT_WARNING_CHOICES.includes(currentWarning)
        ? LIGHT_WARNING_CHOICES
        : [...LIGHT_WARNING_CHOICES, currentWarning].sort((left, right) => left - right);
      const preview = target === null
        ? copy(lightLabelKey(status.light))
        : `${copy(lightLabelKey(status.light))} · ${fillText(copy(lightCountdownKey(status)), { time: formatTarget(target, now, lightTranslator) })}`;

      return React.createElement('div', { className: `${LIGHT_CLASS}-settings` },
        React.createElement('div', { className: `${LIGHT_CLASS}-detail` },
          React.createElement('span', { className: `${LIGHT_CLASS}-lamp`, style: { background: LIGHT_COLORS[status.light] } }),
          React.createElement('span', null, preview),
        ),
        React.createElement('label', { className: `${LIGHT_CLASS}-field` },
          React.createElement('span', null, copy('light.setting.dock')),
          choice({
            value: dockMode,
            options: [
              { value: 'lamp', label: copy('light.setting.dock.lamp') },
              { value: 'lamp-time', label: copy('light.setting.dock.time') },
              { value: 'time', label: copy('light.setting.dock.timeOnly') },
              { value: 'lamp-time-label', label: copy('light.setting.dock.label') },
            ],
            onChange: (value) => lightPrefs.set({ dockMode: value }),
          }),
        ),
        React.createElement('label', { className: `${LIGHT_CLASS}-field` },
          React.createElement('span', null, copy('light.setting.warning')),
          choice({
            value: currentWarning,
            options: warningChoices.map((minutes) => ({
              value: minutes,
              label: fillText(copy('light.setting.warningValue'), { minutes }),
            })),
            onChange: (value) => lightPrefs.set({ warningMinutes: Number(value) }),
          }),
        ),
        React.createElement('p', { className: `${LIGHT_CLASS}-hint` }, copy('light.setting.hint')),
      );
    }

    /** Стили твика: токены темы и префиксные классы, как у меню. */
    const LIGHT_STYLE_TEXT = [
      `.${LIGHT_CLASS}-button{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;gap:6px;`,
      'border:none;background:transparent;padding:3px;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-secondary);',
      'font:12px/18px system-ui,sans-serif;font-variant-numeric:tabular-nums}',
      `.${LIGHT_CLASS}-button:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
      `.${LIGHT_CLASS}-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}`,
      `.${LIGHT_CLASS}-lamp{box-sizing:border-box;flex:none;width:16px;height:16px;border-radius:999px;display:block;position:relative;transition:background 250ms ease}`,
      `.${LIGHT_CLASS}-wave{box-sizing:border-box;position:absolute;inset:0;border-radius:999px;border-width:2px;border-style:solid;pointer-events:none;animation:${LIGHT_CLASS}-wave 2s ease-out infinite}`,
      `.${LIGHT_CLASS}-label{white-space:nowrap}`,
      `.${LIGHT_CLASS}-count{color:var(--dsw-alias-label-tertiary)}`,
      `.${LIGHT_CLASS}-panel{box-sizing:border-box;position:fixed;z-index:2147483000;width:340px;padding:12px;`,
      'border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);',
      'backdrop-filter:var(--dsw-menu-backdrop-filter);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);',
      'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:normal;overflow-wrap:anywhere}',
      `.${LIGHT_CLASS}-head{display:flex;align-items:center;gap:6px;margin-bottom:10px;font-weight:500}`,
      `.${LIGHT_CLASS}-title{color:var(--dsw-alias-label-primary)}`,
      `.${LIGHT_CLASS}-head .${LIGHT_CLASS}-lamp{width:10px;height:10px}`,
      `.${LIGHT_CLASS}-head .${LIGHT_CLASS}-count{margin-left:auto;font-weight:400;white-space:nowrap}`,
      `.${LIGHT_CLASS}-slot{text-align:center;color:var(--dsw-alias-label-secondary);margin-top:6px}`,
      `.${LIGHT_CLASS}-rules{color:var(--dsw-alias-label-tertiary);margin-top:10px;text-align:center;line-height:17px;display:flex;flex-direction:column;gap:2px}`,
      `.${LIGHT_CLASS}-note{opacity:.8}`,
      `.${LIGHT_CLASS}-paused{color:var(--dsw-alias-state-business-warning,var(--dsw-alias-label-secondary));margin-top:8px;text-align:center}`,
      `.${LIGHT_CLASS}-detail{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font:12px/18px system-ui,sans-serif}`,
      `.${LIGHT_CLASS}-detail .${LIGHT_CLASS}-lamp{width:10px;height:10px}`,
      `.${LIGHT_CLASS}-settings{display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-secondary);font:12px/18px system-ui,sans-serif}`,
      `.${LIGHT_CLASS}-field{display:flex;align-items:center;justify-content:space-between;gap:10px}`,
      `.${LIGHT_CLASS}-select{max-width:200px;padding:2px 6px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;`,
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}',
      `.${LIGHT_CLASS}-hint{margin:0;color:var(--dsw-alias-label-tertiary)}`,
      `@keyframes ${LIGHT_CLASS}-blink{0%{opacity:1}50%{opacity:.35}100%{opacity:1}}`,
      `@keyframes ${LIGHT_CLASS}-wave{0%{transform:scale(1);opacity:.9}70%{transform:scale(2.4);opacity:0}100%{transform:scale(2.4);opacity:0}}`,
      '@media (prefers-reduced-motion: reduce){'
      + `.${LIGHT_CLASS}-wave{animation:none;display:none}.${LIGHT_CLASS}-lamp{animation:none!important}}`,
    ].join('');

    /**
     * Включить твик: стили, подписка на политику из конфигурации,
     * индикаторы в шапке разговора и под полем ввода.
     *
     * Снимок конфигурации твику отдаёт каркас (хук `refresh` в реестре TWEAKS):
     * своя подписка на форму не нужна — она была бы второй подпиской на тот же
     * документ, а окна политики приходят вместе с флагами.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {object} api - регистратор очисток твика.
     * @returns {void}
     */
    function setupTrafficLight(ctx, api) {
      const own = typeof api?.own === 'function' ? api.own : () => {};
      lightContext = ctx;
      let locale = undefined;
      try {
        locale = typeof ctx?.get === 'function' ? ctx.get('locale') : undefined;
      } catch (_error) {
        locale = undefined;
      }
      lightTranslator = createTranslator(locale);

      const style = document.createElement('style');
      style.textContent = LIGHT_STYLE_TEXT;
      document.head?.appendChild(style);
      own(() => style.remove());

      let slots = undefined;
      try {
        slots = typeof ctx?.get === 'function' ? ctx.get('slots') : undefined;
      } catch (_error) {
        slots = undefined;
      }
      if (typeof slots?.inject === 'function' && typeof slots?.register === 'function') {
        try {
          own(slots.inject('conversation.header.leading', () => slots.register(
            { name: 'conversation.header.leading' },
            (props) => React.createElement(TrafficLightIndicator, { ...props, variant: 'header' }),
          )));
        } catch (error) {
          console.error('dsh-tweaks: индикатор светофора в шапке не подключён', error);
        }
        try {
          own(slots.inject('conversation.composer.dock', () => slots.register(
            { name: 'conversation.composer.dock', id: 'traffic-light', order: 0 },
            (props) => React.createElement(TrafficLightIndicator, { ...props, variant: 'dock' }),
          )));
        } catch (error) {
          console.error('dsh-tweaks: индикатор светофора под полем ввода не подключён', error);
        }
      }
    }

    /** Выключить твик: снять подписки и вернуть политику к дефолту. */
    function teardownTrafficLight() {
      lightContext = null;
      lightTranslator = (key) => key;
      lightHub.setConfig(null);
    }
    /* #endregion tweak-traffic-light */

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
      trafficLight: {
        title: 'Светофор дорогих часов',
        titleKey: 'tweak.trafficLight',
        // Лёгкий твик: индикатор в интерфейсе и пауза автоматической работы
        // в хост-половине (`tweaks/traffic-light-host.js`).
        defaultOn: true,
        activate(ctx, api) {
          setupTrafficLight(ctx, api);
        },
        deactivate() {
          teardownTrafficLight();
        },
        // Каркас зовёт refresh на каждый снимок конфигурации: политика окон
        // (peakWindows, праздники, предупреждение) строится из него.
        refresh({ value }) {
          lightHub.setConfig(value);
        },
        renderDetail(props) {
          return React.createElement(TrafficLightSettings, props);
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
        // Твик может показать рядом со своим переключателем дополнительную строку:
        // например, «речь» — кнопку загрузки модели с прогрессом.
        if (checked && typeof tweak.renderDetail === 'function') {
          rows.push(React.createElement('div', { key: `${id}-detail` }, tweak.renderDetail({ controller, t, translate })));
        }
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
          // Активные твики получают свежий снимок конфигурации: светофор
          // строит по нему политику окон. Своя подписка твику не нужна —
          // каркас и так слушает этот же документ.
          const snapshot = controller?.getSnapshot?.();
          const value =
            snapshot?.status === 'ready' && typeof snapshot.value === 'object' && snapshot.value !== null
              ? snapshot.value
              : null;
          for (const id of [...activeTweaks.keys()]) {
            try {
              TWEAKS[id].refresh?.({ value });
            } catch (error) {
              console.error(`dsh-tweaks: твик «${id}» не принял снимок конфигурации`, error);
            }
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
