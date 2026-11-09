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
    /** Портал панели светофора в body: вне зум-контекста #root. */
    const ReactDOM = (() => {
      try {
        return require('react-dom');
      } catch (_error) {
        return null;
      }
    })();

    /** Пространство имён словаря; оно же стоит на регистрации формы. */
    const NS = 'dsh-tweaks';
    /** Id записи пакета в cordis.patch.yml: он же namespace конфигурации в configForms. */
    const ROW_ID = 'zoom';
    /** Ключ отметки этапа инициализации в хранилище устройства. */
    const READY_KEY = 'dsh.ui-zoom.ready.v1';
    /**
     * Ключ диагностического выключателя всех твиков в хранилище устройства.
     *
     * Выключатель нужен, чтобы на телефоне отличить зависание приложения от
     * зависания, которое даёт наш слой: `?tweaks=off` гасит все твики разом,
     * `?tweaks=on` возвращает их. Значение переживает перезагрузку страницы,
     * рестарт профиля не нужен.
     */
    const SWITCH_KEY = 'dsh.tweaks.disabled.v1';
    /** Значение выключателя в хранилище: твики выключены. */
    const SWITCH_OFF = '1';
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
      warningMinutes: 10,
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
        'tweak.mobileComposer': 'Mobile composer: Enter inserts a newline',
        'tweak.queueEditor': 'Queue: edit messages with attachments',
        'tweak.fileDownload': 'Files: download from chat and tabs',
        'tweak.mobileSidebar': 'Mobile menu: slide-out sidebar',
        'mobileSidebar.open': 'Open menu',
        'mobilePanels.open': 'More',
        'session.copyId': 'Copy session ID',
        'tweak.zoom': 'Interface size',
        'tweak.contextMenu': 'Custom right-click menu',
        'tweak.whisper': 'Russian speech recognition',
        'tweak.trafficLight': 'Peak-hours traffic light',
        'tweak.imageModelFallback': 'Send images with a vision model',
        'tweak.freePanels': 'Free panel resize',
        'version.mobileComposer': 'For 0.2.1-rc.5 and 0.2.2-rc.1.',
        'version.queueEditor': 'For 0.2.1-rc.5 and 0.2.2-rc.1.',
        'version.fileDownload': 'For 0.2.1-rc.5 and 0.2.2-rc.1.',
        'version.mobileSidebar': 'For 0.2.1-rc.5; 0.2.2-rc.1 has the mobile shell built in.',
        'version.zoom': 'For 0.2.1-rc.5 and 0.2.2-rc.1.',
        'version.contextMenu': 'For 0.2.1-rc.5 and 0.2.2-rc.1.',
        'version.whisper': 'For 0.2.1-rc.5 and 0.2.2-rc.1.',
        'version.trafficLight': 'For 0.2.1-rc.5 and 0.2.2-rc.1.',
        'version.freePanels': 'Panel resize: 0.2.1-rc.5 and 0.2.2-rc.1. Center expansion: only 0.2.1-rc.5.',
        'version.imageModelFallback': 'For 0.2.1-rc.5 and 0.2.2-rc.1.',
        'form.core': 'Core: {{version}}',
        'settings.open': 'Tweaks',
        'settings.title': 'Volna tweaks',
        'settings.close': 'Close tweaks',
        'settings.switchOff': 'All tweaks are off: this browser was opened with ?tweaks=off.',
        'settings.enableAll': 'Turn all tweaks on',
        'imageFallback.text': 'This model does not support images. Send this message with a model that does.',
        'imageFallback.actionPrefix': 'Send with',
        'imageFallback.busy': 'Switching model…',
        'imageFallback.errorPrefix': 'Model switch failed:',
        'imageFallback.dismiss': 'Dismiss',
        'light.offpeak': 'Cheap hours',
        'light.peak': 'Expensive hours',
        'light.warning': 'Expensive hours soon',
        'light.untilGreen': 'Expensive hours until {{time}}',
        'light.untilRed': 'Expensive hours start at {{time}}',
        'light.untilPeak': 'Cheap hours until {{time}}',
        'light.countdownH': '{{hours}} h {{minutes}} min',
        'light.countdownM': '{{minutes}} min',
        'light.countdownS': '< 1 min',
        'light.clockTitle': '24-hour price clock',
        'light.weekdays': 'Mon–Fri',
        'light.holidaysNote': 'Except Chinese public holidays',
        'light.timeZone': 'Current time zone: {{zone}}',
        'light.localTimeNote': 'Times are shown in your time zone',
        'light.slotLabel': '{{time}} · {{label}}',
        'light.pausedHint': 'Automatic work is paused while the light is red',
        'light.setting.dock': 'Bottom indicator',
        'light.setting.dock.lamp': 'Indicator only',
        'light.setting.dock.time': 'Indicator and time left',
        'light.setting.dock.timeOnly': 'Indicator and time',
        'light.setting.dock.label': 'Indicator, time and tariff',
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
        'form.switchOff': 'All tweaks are off: page opened with ?tweaks=off. Good for checking whether freezes come from our layer; ?tweaks=on turns them back on.',
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
        'tweak.mobileComposer': 'Мобильный ввод: Enter переносит строку',
        'tweak.queueEditor': 'Очередь: редактирование с вложениями',
        'tweak.fileDownload': 'Файлы: скачивание из чата и вкладок',
        'tweak.mobileSidebar': 'Мобильное меню: выдвижная панель',
        'mobileSidebar.open': 'Открыть меню',
        'mobilePanels.open': 'More',
        'session.copyId': 'Копировать ID сессии',
        'tweak.zoom': 'Масштаб интерфейса',
        'tweak.contextMenu': 'Своё меню по правой кнопке',
        'tweak.whisper': 'Распознавание русской речи',
        'tweak.trafficLight': 'Светофор дорогих часов',
        'tweak.imageModelFallback': 'Отправка картинок через модель со зрением',
        'tweak.freePanels': 'Свободный размер панелей',
        'version.mobileComposer': 'Для 0.2.1-rc.5 и 0.2.2-rc.1.',
        'version.queueEditor': 'Для 0.2.1-rc.5 и 0.2.2-rc.1.',
        'version.fileDownload': 'Для 0.2.1-rc.5 и 0.2.2-rc.1.',
        'version.mobileSidebar': 'Для 0.2.1-rc.5; в 0.2.2-rc.1 мобильный shell уже в ядре.',
        'version.zoom': 'Для 0.2.1-rc.5 и 0.2.2-rc.1.',
        'version.contextMenu': 'Для 0.2.1-rc.5 и 0.2.2-rc.1.',
        'version.whisper': 'Для 0.2.1-rc.5 и 0.2.2-rc.1.',
        'version.trafficLight': 'Для 0.2.1-rc.5 и 0.2.2-rc.1.',
        'version.freePanels': 'Размер панелей — 0.2.1-rc.5 и 0.2.2-rc.1; расширение центра — только 0.2.1-rc.5.',
        'version.imageModelFallback': 'Для 0.2.1-rc.5 и 0.2.2-rc.1.',
        'form.core': 'Ядро: {{version}}',
        'settings.open': 'Твики',
        'settings.title': 'Волна твик',
        'settings.close': 'Закрыть твики',
        'settings.switchOff': 'Все твики выключены: браузер открывали с ?tweaks=off.',
        'settings.enableAll': 'Включить все твики',
        'imageFallback.text': 'Эта модель не видит изображения. Отправить сообщение моделью, которая их видит?',
        'imageFallback.actionPrefix': 'Отправить с',
        'imageFallback.busy': 'Меняю модель…',
        'imageFallback.errorPrefix': 'Не удалось сменить модель:',
        'imageFallback.dismiss': 'Скрыть',
        'light.offpeak': 'Дешёвые часы',
        'light.peak': 'Дорогие часы',
        'light.warning': 'Скоро дорогие часы',
        'light.untilGreen': 'Дорогие часы до {{time}}',
        'light.untilRed': 'Дорогие часы начнутся в {{time}}',
        'light.untilPeak': 'Дешёвые часы до {{time}}',
        'light.countdownH': '{{hours}} ч {{minutes}} мин',
        'light.countdownM': '{{minutes}} мин',
        'light.countdownS': 'меньше минуты',
        'light.clockTitle': 'Часы тарифа на сутки',
        'light.weekdays': 'Пн–Пт',
        'light.holidaysNote': 'Кроме праздников КНР',
        'light.timeZone': 'Текущий часовой пояс: {{zone}}',
        'light.localTimeNote': 'Время — в вашем часовом поясе',
        'light.slotLabel': '{{time}} · {{label}}',
        'light.pausedHint': 'Автоматическая работа на паузе, пока горит красный',
        'light.setting.dock': 'Нижний индикатор',
        'light.setting.dock.lamp': 'Только индикатор',
        'light.setting.dock.time': 'Индикатор и оставшееся время',
        'light.setting.dock.timeOnly': 'Индикатор и время',
        'light.setting.dock.label': 'Индикатор, время и тариф',
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
        'form.switchOff': 'Все твики выключены: страница открыта с ?tweaks=off. Так проверяют, не зависание ли это нашего слоя; ?tweaks=on включает твики обратно.',
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
            // Панель светофора живёт вне #root и пересчитывает себя сама.
            try {
              window.dispatchEvent?.(new Event('dsh-ui-zoom-change'));
            } catch (_error) {
              /* событие необязательно */
            }
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
          // Панель светофора сама ставит transform и считает вьюпортные размеры;
          // общий popup-zoom её не трогает, иначе масштаб применится дважды.
          if (node.hasAttribute?.('data-dsh-light-panel')) return false;
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
          // Пишем только при изменении: наблюдатель следит и за своими слоями,
          // а запись «того же значения» рождает новую запись и лишний круг
          // observer → style → observer.
          const next = zoom === 1 ? '' : String(zoom);
          if (node.style.zoom !== next) node.style.zoom = next;
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
            const logicalWidth = rect.width / zoom;
            // Нативный drawer/узкий экран: не раздуваем рамку до 1024, иначе
            // старое ядро выбирает десктопную сетку и центр становится узким.
            const width = nativeSidebarDrawer() || logicalWidth < SIDEBAR_MIN_WIDTH
              ? logicalWidth
              : Math.max(logicalWidth, SIDEBAR_MIN_WIDTH);
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
          // Список полосок кэшируется: он же нужен наблюдателю, чтобы отличить
          // правку стиля слоя раскладки от сотни правок в поддереве приложения.
          handleCache = [...document.querySelectorAll('[data-side="sidebar"], [data-side="rightbar"]')];
          for (const handle of handleCache) {
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

        /** Полоски, найденные последним `pinHandles`: нужны проверке записей стиля. */
        let handleCache = [];

        /**
         * Правка стиля пришла от узла раскладки, а не от содержимого чата.
         *
         * Полоски стоят на границах колонок внутри рамки, поэтому пересчёт нужен,
         * когда стиль поменялся у самой полоски, у рамки или у её предка. Проверка
         * поднимается по родителям полосок (короткий путь) и не трогает дерево
         * чата — иначе каждая правка стиля в ленте дёргала бы раскладку.
         * @param {Element} node - узел, у которого поменялся стиль.
         * @returns {boolean} да или нет.
         */
        function touchesHandles(node) {
          if (node === null || node === undefined) return false;
          for (const handle of handleCache) {
            if (handle === node) return true;
            let parent = handle.parentElement ?? null;
            while (parent !== null && parent !== undefined && parent !== document.body) {
              if (parent === node) return true;
              parent = parent.parentElement ?? null;
            }
          }
          return false;
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
         * Сколько узлов слоя осматривать за один проход.
         *
         * Слои приложения (меню, подсказки, панели) маленькие, а корень
         * приложения — нет. Предел не даёт одному неожиданно огромному слою
         * съесть кадр: остальное досмотрят следующие проходы.
         */
        const LAYER_SCAN_LIMIT = 1500;

        /** Корень приложения: слои порталов лежат мимо него. */
        let appRootCache = null;

        /**
         * Корень приложения, если он уже отрисован.
         * @returns {Element | null} корень либо null до первого рендера.
         */
        function appRootNode() {
          if (appRootCache === null || appRootCache.isConnected === false) {
            appRootCache = document.getElementById('root') ?? null;
          }
          return appRootCache;
        }

        /**
         * Добавленный узел лежит в корне приложения.
         *
         * Всё, что появляется внутри `#root`, слоем попапа быть не может (это
         * проверяет `isPopup`), поэтому такие записи наблюдатель пропускает
         * сразу: именно они идут сотнями при отрисовке чата на телефоне.
         * @param {Element} node - добавленный узел.
         * @returns {boolean} да или нет.
         */
        function insideAppRoot(node) {
          const root = appRootNode();
          if (root === null) return false;
          if (root === node) return true;
          return typeof root.contains === 'function' && root.contains(node);
        }

        /** Служебные теги: слоями попапов они не бывают. */
        function isLayerTag(node) {
          const tag = String(node?.tagName ?? '');
          return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'TEMPLATE' || tag === 'META';
        }

        /**
         * Взять слой и его потомков под масштаб.
         *
         * Обход только внутри слоя. Раньше `querySelectorAll('*')` вызывался на
         * каждый добавленный узел всего документа, то есть отрисовка длинной
         * ленты давала квадратичную работу по числу узлов кадра — на телефоне
         * это и есть полное зависание.
         * @param {Element} node - узел слоя.
         * @returns {number} сколько узлов просмотрено (для общего предела прохода).
         */
        function scanLayer(node) {
          if (node === null || node === undefined || node.nodeType !== 1 || isLayerTag(node)) return 0;
          mark(node);
          if (typeof node.querySelectorAll !== 'function') return 1;
          const descendants = node.querySelectorAll('*');
          const limit = Math.min(descendants.length, LAYER_SCAN_LIMIT);
          for (let index = 0; index < limit; index += 1) mark(descendants[index]);
          return descendants.length + 1;
        }

        /**
         * Пройти по слоям в `body`: его дети — корни порталов приложения.
         * @returns {void}
         */
        function scanLayers() {
          const root = appRootNode();
          let budget = LAYER_SCAN_LIMIT * 2;
          for (const node of document.body?.children ?? []) {
            if (node === root || budget <= 0) continue;
            budget -= scanLayer(node);
          }
        }

        /**
         * Следить за слоями, которые приложение добавляет в `body` после загрузки.
         *
         * Наблюдатель видит весь `body` (иначе не поймать слой, вложенный в
         * контейнер портала), но реагирует только на то, что может быть слоем:
         * добавленные узлы вне `#root`, и правки стиля самих слоёв или раскладки.
         * Работа по добавленным узлам отложена в кадр и идёт по одному разу:
         * покадровое слияние вместо обработки каждой записи.
         * @returns {void}
         */
        function attachPopupZoom() {
          scanLayers();
          patchFrameMetrics();
          pinHandles();
          patchPointerCoordinates();
          let observing = false;
          let disposed = false;
          let scanFrame = 0;
          let scanPending = false;

          /** Догнать изменения после паузы: один проход по слоям. */
          function runScan() {
            scanFrame = 0;
            scanPending = false;
            if (disposed) return;
            scanLayers();
            // Полоски нужны только под масштабом: на 100% приложение ставит их само.
            if (readScale() !== 1) pinHandles();
          }

          /** Попросить пересмотр слоёв в следующем кадре, не чаще раза в кадр. */
          function requestScan() {
            if (scanPending || disposed) return;
            scanPending = true;
            if (typeof window.requestAnimationFrame === 'function') scanFrame = window.requestAnimationFrame(runScan);
            else scanFrame = window.setTimeout(runScan, 16);
          }

          /** Включить наблюдение и один раз догнать изменения. */
          function connectObserver() {
            if (observing === true) return;
            observing = true;
            observer.observe(document.body ?? html, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['style'],
            });
            requestScan();
          }

          /** Выключить наблюдение, пока вкладка скрыта. */
          function disconnectObserver() {
            if (observing === false) return;
            observing = false;
            observer.disconnect();
          }

          const observer = new MutationObserver((records) => {
            let nested = false;
            for (const record of records) {
              if (record.type === 'attributes') {
                const target = record.target;
                if (target === null || target === undefined) continue;
                // Слой сам поменял координаты — это наша работа, здесь она короткая.
                handleStyle(target);
                // Раскладка поехала — полоски переставляются. На 100% это не нужно.
                if (readScale() !== 1 && touchesHandles(target)) pinHandles();
                continue;
              }
              for (const node of record.addedNodes ?? []) {
                if (!node || node.nodeType !== 1) continue;
                if (insideAppRoot(node)) continue;
                if (node.parentElement === document.body) {
                  // Слой приложения рождается прямо в body — берём сразу.
                  scanLayer(node);
                } else {
                  // Вложенный слой досмотрит общий проход в кадре.
                  nested = true;
                }
              }
            }
            if (nested) requestScan();
          });

          const stopWatchingVisibility = pauseWhenHidden(document, connectObserver, disconnectObserver);
          connectObserver();
          own(() => {
            disposed = true;
            disconnectObserver();
            stopWatchingVisibility();
            if (scanFrame !== 0) {
              if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(scanFrame);
              else window.clearTimeout?.(scanFrame);
              scanFrame = 0;
            }
          });
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
    /* #region layout-capabilities */

    /** Полные версии ядра, на которые рассчитаны твики. */
    const CORE_LEGACY = '0.2.1-rc.5';
    const CORE_MODERN = '0.2.2-rc.1';

    /** Рамка приложения. */
    function layoutFrame() {
      return document.querySelector('[class*="_frame"]');
    }

    /**
     * Версия ядра из boot-данных страницы.
     * @returns {string} версия или `unknown`.
     */
    function coreVersion() {
      const release = typeof window === 'object' && window !== null ? window.__DSH_BOOT__?.release : undefined;
      const version = typeof release?.version === 'string' ? release.version.trim() : '';
      return version === '' ? 'unknown' : version;
    }

    /**
     * Разобрать версию с prerelease-хвостом (`0.2.1-rc.5`).
     * @param {string} value - версия.
     * @returns {{major:number,minor:number,patch:number,pre:string}|null} части.
     */
    function parseCoreVersion(value) {
      const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? ''));
      if (match === null) return null;
      return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? '' };
    }

    /**
     * Сравнить версии как semver, включая prerelease.
     * @param {string} left - левая версия.
     * @param {string} right - правая версия.
     * @returns {number} -1, 0 или 1.
     */
    function compareCoreVersion(left, right) {
      const a = parseCoreVersion(left);
      const b = parseCoreVersion(right);
      if (a === null || b === null) return 0;
      for (const key of ['major', 'minor', 'patch']) {
        if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
      }
      if (a.pre === b.pre) return 0;
      if (a.pre === '') return 1;
      if (b.pre === '') return -1;
      const pa = a.pre.split('.');
      const pb = b.pre.split('.');
      for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
        if (pa[index] === undefined) return -1;
        if (pb[index] === undefined) return 1;
        if (pa[index] === pb[index]) continue;
        const na = /^\d+$/.test(pa[index]);
        const nb = /^\d+$/.test(pb[index]);
        if (na && nb) return Number(pa[index]) < Number(pb[index]) ? -1 : 1;
        return pa[index] < pb[index] ? -1 : 1;
      }
      return 0;
    }

    /**
     * Возможности текущего ядра, влияющие на твики.
     * @returns {{version:string,modern:boolean,modernShell:boolean,nativeComposerDock:boolean,legacyComposerDock:boolean}} флаги.
     */
    function coreFeatures() {
      const version = coreVersion();
      const parsed = parseCoreVersion(version);
      const modern = parsed !== null && compareCoreVersion(version, CORE_MODERN) >= 0;
      // Слот conversation.input.dock появился уже в 0.2.1-rc.5: старый
      // conversation.composer.dock есть только у более ранних сборок.
      const inputDock = parsed !== null && compareCoreVersion(version, CORE_LEGACY) >= 0;
      const modernShell = modern || nativeSidebarDrawer();
      return {
        version,
        modern,
        modernShell,
        nativeComposerDock: inputDock || document.querySelector('[data-slot="conversation.input.dock"]') !== null,
        legacyComposerDock: document.querySelector('[data-slot="conversation.composer.dock"]') !== null,
      };
    }

    /**
     * Умеет ли ядро нативный drawer левой панели.
     *
     * В 0.2.2 появились `data-sidebar-drawer` и `drawerMask`; в 0.2.1 их нет,
     * и мобильную панель рисует наш слой. Проверяем возможности DOM, а не
     * номер версии: маска есть только в drawer-режиме, attr — на рамке.
     * @returns {boolean} да, если drawer ведёт ядро.
     */
    function nativeSidebarDrawer() {
      const frame = layoutFrame();
      if (frame?.hasAttribute?.('data-sidebar-drawer')) return true;
      return document.querySelector('[class*="_drawerMask"]') !== null;
    }

    /* #endregion layout-capabilities */

    /* #region free-panels */
    /** Ключ хранения ширины панелей: у каждого устройства свои значения. */
    const PANELS_KEY = 'dsh.ui-panels.v1';
    /** Минимальная ширина панели, которую можно вытянуть мышью. */
    const PANEL_MIN = 120;
    /** Минимальная ширина центральной колонки: её не даём схлопнуть в ноль. */
    const PANEL_MIN_CENTER = 120;
    /** Потолок ширины сайдбара: 760 логических пикселей. */
    const PANEL_MAX_SIDEBAR = 760;

    /** Мост к твику «свободный размер панелей» для выключения. */
    const freePanelsBridge = { reset: null };

    /**
     * Текущий масштаб интерфейса: координаты указателя визуальные, а ширины
     * панелей живут в логических пикселях зум-контекста.
     * @returns {number} масштаб (1 — без масштабирования).
     */
    function panelsScale() {
      const raw = Number.parseFloat(document.documentElement.style.getPropertyValue(SCALE_VAR));
      return Number.isFinite(raw) && raw > 0 ? raw : 1;
    }

    /**
     * Развернуть твик «свободный размер панелей».
     *
     * Штатный драг приложения клампит ширины: сайдбар 264–420, правая панель
     * 300 – 0.7·окно, центр не уже 400 px. Из-за этого панель упирается и ручка
     * уезжает от курсора. Здесь перетаскивание перехватывается в capture-фазе до
     * приложения (его DragHandle не получает событие), ширина пишется прямо в
     * сетку рамки, а ручки ставятся на фактические границы колонок.
     *
     * Работает и в браузере, и в настольном приложении: используются только
     * data-атрибуты DSH и суффиксы классов, без привязки к хешам сборки.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {Function} markReady - отметка этапа инициализации.
     * @param {Function} own - регистратор очисток твика.
     * @returns {void}
     */
    function setupFreePanels(ctx, markReady, own) {
      const frameOf = () => document.querySelector('[class*="_frame"]');
      const sidebarOf = () => document.querySelector('[class*="_sidebarCol"]');
      const rightbarOf = () => document.querySelector('[data-rightbar-col]');
      const panelOpenOf = () => document.querySelector('[data-sidebar-right-open]');

      // Инлайн-ширина места правой панели приходит пропсом приложения; сетка у
      // нас своя, поэтому содержимому разрешаем заполнять колонку целиком.
      const style = document.createElement('style');
      style.dataset.dshFreePanels = 'root';
      // Содержимое правой панели заполняет нашу колонку; ширина чата внутри
      // центральной колонки сохраняет нижнюю границу DSH (680 px), из-за которой
      // при сужении центра чат уезжал за колонку и «скрывался». Ослабляем её,
      // личную ширину чата (если её выставили ручкой) не трогаем.
      // На 0.2.2 центральную колонку расширяет само ядро: наш CSS там дублирует
      // его и на мобиле может сузить ленту.
      const modernCenter = coreFeatures().modernShell;
      style.textContent = [
        '[data-sidebar-right-panel]:not([data-sidebar-right-panel="fullscreen"]){width:100%!important}',
        // Колонка сайдбара тянется, а его содержимое приложение держит в 280 px
        // инлайновой шириной: без компенсации панель выглядела «не растягивается».
        '[class*="_sidebarCol"] [data-slot] > *{width:100%!important}',
        modernCenter
          ? ''
          : '[class*="_body"]{--dsh-chat-content-width:var(--dsh-chat-user-width,clamp(240px,calc(var(--dsh-conversation-column-width, 0px) * .64),920px))!important}',
      ].join('\n');
      document.head?.appendChild(style);

      /**
       * Прочитать сохранённые ширины панелей.
       * @returns {{sidebar: number|null, rightbar: number|null}} ширины или null.
       */
      function readPanels() {
        try {
          const raw = window.localStorage?.getItem(PANELS_KEY);
          if (raw === null || raw === undefined) return { sidebar: null, rightbar: null };
          const parsed = JSON.parse(raw);
          return {
            sidebar: Number.isFinite(parsed?.sidebar) ? Math.round(parsed.sidebar) : null,
            rightbar: Number.isFinite(parsed?.rightbar) ? Math.round(parsed.rightbar) : null,
          };
        } catch (_error) {
          return { sidebar: null, rightbar: null };
        }
      }

      /**
       * Сохранить ширины панелей.
       * @returns {void}
       */
      function savePanels() {
        try {
          window.localStorage?.setItem(PANELS_KEY, JSON.stringify(widths));
        } catch (_error) {
          /* приватный режим: ширины живут до перезагрузки */
        }
      }

      /**
       * Свести ширины к допустимым: панели не уже PANEL_MIN, центр не уже
       * PANEL_MIN_CENTER; иначе панели «съедают» друг друга и ручку не поймать.
       * @param {{sidebar: number|null, rightbar: number|null}} value - желаемые ширины.
       * @param {number} frameWidth - логическая ширина рамки.
       * @returns {{sidebar: number, rightbar: number}} допустимые ширины.
       */
      function clampPanels(value, frameWidth) {
        const sidebar = Math.max(PANEL_MIN, Math.min(PANEL_MAX_SIDEBAR, Math.round(value.sidebar ?? 280)));
        const maxRightbar = Math.max(PANEL_MIN, frameWidth - sidebar - PANEL_MIN_CENTER);
        const rightbar = Math.max(PANEL_MIN, Math.min(maxRightbar, Math.round(value.rightbar ?? 300)));
        return { sidebar, rightbar };
      }

      /**
       * Поставить ручки рамки на фактические границы колонок.
       * @returns {void}
       */
      function pinHandles() {
        const sidebarCol = sidebarOf();
        const rightbarCol = rightbarOf();
        const sidebarHandle = document.querySelector('[data-side="sidebar"]');
        const rightbarHandle = document.querySelector('[data-side="rightbar"]');
        if (!nativeSidebarDrawer() && sidebarCol !== null && sidebarHandle !== null) {
          const left = `${sidebarCol.offsetLeft + sidebarCol.offsetWidth}px`;
          if (sidebarHandle.style.left !== left) sidebarHandle.style.left = left;
        }
        if (rightbarCol !== null && rightbarHandle !== null) {
          const left = `${rightbarCol.offsetLeft}px`;
          if (rightbarHandle.style.left !== left) rightbarHandle.style.left = left;
        }
      }

      /**
       * Применить ширины к сетке рамки. Свернутый сайдбар и закрытую/полноэкранную
       * правую панель не трогаем — там шириной распоряжается приложение.
       * @returns {void}
       */
      function apply() {
        const frame = frameOf();
        if (frame === null) return;
        const frameWidth = Math.max(0, Math.round(frame.offsetWidth));
        if (frameWidth === 0) return;
        const nativeDrawer = nativeSidebarDrawer();
        if (nativeDrawer) {
          // В нативном drawer сайдбар абсолютный, его ширина не колонка сетки.
          // Первый трек всегда 0, иначе центр сжимается до остатка окна.
          const panelOpen = panelOpenOf() !== null;
          const fullscreen = document.querySelector('[data-rightbar-fullscreen]') !== null;
          const appRightbar = Math.round(rightbarOf()?.offsetWidth ?? 0);
          const rightbar = panelOpen && !fullscreen ? appRightbar : 0;
          const grid = `0px minmax(0px, 1fr) ${rightbar}px`;
          lastApplied = grid;
          if (frame.style.gridTemplateColumns !== grid) frame.style.gridTemplateColumns = grid;
          if (frame.style.getPropertyValue('--dsh-windows-sidebar-width') !== '') {
            frame.style.setProperty('--dsh-windows-sidebar-width', '0px');
          }
          pinHandles();
          return;
        }
        const sidebarCol = sidebarOf();
        const appSidebar = sidebarCol === null ? 0 : Math.round(sidebarCol.offsetWidth);
        const collapsed = appSidebar === 0 || appSidebar <= 64;
        const fullscreen = document.querySelector('[data-rightbar-fullscreen]') !== null;
        const panelOpen = panelOpenOf() !== null;
        if (!customized) {
          if (!collapsed && appSidebar > 0) widths.sidebar = appSidebar;
          if (panelOpen) {
            const appRightbar = Math.round(rightbarOf()?.offsetWidth ?? 0);
            if (appRightbar > 0) widths.rightbar = appRightbar;
          }
        }
        const clamped = clampPanels(widths, frameWidth);
        // Свернутым сайдбаром и закрытой/полноэкранной панелью распоряжается
        // приложение: свои ширины помним, но в сетку их сейчас не пишем.
        const sidebar = collapsed ? appSidebar : clamped.sidebar;
        const rightbar = panelOpen && !fullscreen ? clamped.rightbar : 0;
        const grid = `${sidebar}px minmax(0px, 1fr) ${rightbar}px`;
        lastApplied = grid;
        if (frame.style.gridTemplateColumns !== grid) frame.style.gridTemplateColumns = grid;
        // В настольном приложении шапка окна выравнивается по этой переменной.
        if (frame.style.getPropertyValue('--dsh-windows-sidebar-width') !== '') {
          frame.style.setProperty('--dsh-windows-sidebar-width', `${sidebar}px`);
        }
        pinHandles();
      }

      let widths = readPanels();
      // Пока пользователь не тянул панели сам, их ширину берём у приложения:
      // иначе первое открытие панели подставляло бы наш минимум вместо 45% окна.
      let customized = widths.sidebar !== null || widths.rightbar !== null;
      let dragging = null;
      let lastApplied = '';
      let appGrid = null;
      let raf = 0;

      /**
       * Пересчитать сетку и ручки в следующем кадре.
       * @returns {void}
       */
      function schedule() {
        if (raf !== 0) return;
        raf = window.requestAnimationFrame?.(() => {
          raf = 0;
          apply();
        }) ?? 0;
        if (raf === 0) apply();
      }

      /**
       * Начать перетаскивание ручки рамки.
       * @param {PointerEvent} event - событие нажатия.
       * @returns {void}
       */
      function onPointerDown(event) {
        if (event.button !== 0 || event.defaultPrevented) return;
        const handle = event.target?.closest?.('[data-side="sidebar"], [data-side="rightbar"]');
        if (handle === null || handle === undefined) return;
        if (handle.closest('[data-width-handle]') !== null) return;
        const side = handle.dataset.side;
        if (side === 'sidebar' && nativeSidebarDrawer()) return;
        const frame = frameOf();
        const column = side === 'sidebar' ? sidebarOf() : rightbarOf();
        if (frame === null || column === null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        dragging = {
          side,
          pointerId: event.pointerId,
          startX: event.clientX,
          startSidebar: sidebarOf()?.offsetWidth ?? 0,
          startRightbar: rightbarOf()?.offsetWidth ?? 0,
        };
        try {
          handle.setPointerCapture?.(event.pointerId);
        } catch (_error) {
          /* захват не обязателен: слушаем window */
        }
        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('pointercancel', onPointerUp, true);
      }

      /**
       * Тянуть ширину панели за курсором.
       * @param {PointerEvent} event - движение указателя.
       * @returns {void}
       */
      function onPointerMove(event) {
        if (dragging === null || event.pointerId !== dragging.pointerId) return;
        event.preventDefault();
        // Координату указателя на ручках рамки уже делит твик «масштаб» (capture
        // на `[data-side]`), поэтому сдвиг здесь сразу в логических пикселях.
        const dx = event.clientX - dragging.startX;
        const frame = frameOf();
        if (frame === null) return;
        customized = true;
        const frameWidth = Math.max(0, Math.round(frame.offsetWidth));
        if (dragging.side === 'rightbar') {
          widths = { ...widths, rightbar: Math.round(dragging.startRightbar - dx) };
        } else {
          widths = { ...widths, sidebar: Math.round(dragging.startSidebar + dx) };
        }
        widths = clampPanels(widths, frameWidth);
        schedule();
      }

      /**
       * Закончить перетаскивание и запомнить ширины.
       * @returns {void}
       */
      function onPointerUp() {
        if (dragging === null) return;
        dragging = null;
        window.removeEventListener('pointermove', onPointerMove, true);
        window.removeEventListener('pointerup', onPointerUp, true);
        window.removeEventListener('pointercancel', onPointerUp, true);
        apply();
        savePanels();
      }

      const observer = new MutationObserver((records) => {
        let touched = false;
        for (const record of records) {
          if (record.type === 'attributes' && record.attributeName === 'style') touched = true;
        }
        if (!touched) return;
        const frame = frameOf();
        if (frame === null) return;
        const grid = frame.style.gridTemplateColumns;
        if (grid === '' || grid === lastApplied) return;
        // Это запись приложения (смена вёрстки, свёрнутый сайдбар, окно): запоминаем
        // её для отката при выключении твика и возвращаем свою сетку.
        appGrid = grid;
        schedule();
      });

      // Ширины по умолчанию — из текущей раскладки приложения.
      const firstApply = () => {
        const frame = frameOf();
        if (frame === null) return;
        const appGridValue = frame.style.gridTemplateColumns;
        if (appGridValue !== '') appGrid = appGridValue;
        if (widths.sidebar === null) widths.sidebar = Math.round(sidebarOf()?.offsetWidth ?? 280);
        if (widths.rightbar === null) widths.rightbar = Math.round(rightbarOf()?.offsetWidth ?? 300);
        apply();
      };

      markReady?.('free-panels: ready');
      firstApply();
      // Наблюдатель уже привязан к рамке, поэтому пауза при скрытой вкладке
      // не теряет изменений: при возврате включение идёт с пересчёта сетки.
      let observing = false;
      let observedFrame = null;

      /** Включить наблюдение за рамкой и пересчёт по изменению окна. */
      const connectObserver = () => {
        if (observing) return;
        observing = true;
        const frame = frameOf();
        if (frame !== null && frame !== observedFrame) {
          if (observedFrame !== null) observer.disconnect();
          observer.observe(frame, { attributes: true, attributeFilter: ['style'] });
          observedFrame = frame;
        }
        window.addEventListener('resize', schedule);
        schedule();
      };

      /** Выключить наблюдение, пока вкладка скрыта. */
      const disconnectObserver = () => {
        if (!observing) return;
        observing = false;
        observer.disconnect();
        observedFrame = null;
        window.removeEventListener('resize', schedule);
      };

      // Ждём отрисовку рамки, если плагин поднялся раньше приложения.
      const startTimer = window.setTimeout(() => {
        firstApply();
        connectObserver();
      }, 60);
      const stopWatchingVisibility = pauseWhenHidden(document, connectObserver, disconnectObserver);
      window.addEventListener('pointerdown', onPointerDown, true);

      /** Откатить твик: снять слушатели, вернуть сетку приложения. */
      freePanelsBridge.reset = () => {
        window.clearTimeout(startTimer);
        stopWatchingVisibility();
        disconnectObserver();
        window.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('resize', schedule);
        window.removeEventListener('pointermove', onPointerMove, true);
        window.removeEventListener('pointerup', onPointerUp, true);
        window.removeEventListener('pointercancel', onPointerUp, true);
        observer.disconnect();
        style.remove?.();
        const frame = frameOf();
        if (frame !== null && appGrid !== null) frame.style.gridTemplateColumns = appGrid;
        dragging = null;
      };
      own?.(() => {
        freePanelsBridge.reset?.();
        freePanelsBridge.reset = null;
      });
    }
    /* #endregion free-panels */

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

    /* #region tweak-watch-helpers */

    /**
     * Наблюдать за документом, только пока вкладка видима.
     *
     * На телефоне страница часто уходит в фон, а наблюдатели продолжают
     * получать записи и будить кадр: работа идёт, интерфейса не видно, батарея
     * и CPU тратятся. При возврате наблюдатели включаются заново и догоняют
     * изменения одним проходом — поведение твика от паузы не меняется.
     * @param {object} doc - документ страницы.
     * @param {Function} connect - включить наблюдение (идемпотентно).
     * @param {Function} disconnect - выключить наблюдение.
     * @returns {Function} снятие подписки на видимость.
     */
    function pauseWhenHidden(doc, connect, disconnect) {
      if (typeof doc?.addEventListener !== 'function') return () => {};
      const onVisibility = () => {
        // Заглушки без visibilityState считаются видимой страницей.
        if (doc.visibilityState === 'hidden') disconnect();
        else connect();
      };
      doc.addEventListener('visibilitychange', onVisibility);
      return () => doc.removeEventListener('visibilitychange', onVisibility);
    }

    /**
     * Стоит ли реагировать на запись наблюдателя: узел внутри известного корня.
     *
     * Дешёвая проверка `closest` по предкам вместо обхода добавленного поддерева:
     * на телефоне в кадре появляются сотни узлов чата, и обходить каждый незачем.
     * @param {object} node - узел из записи наблюдателя.
     * @param {string} selector - селектор корня, изменения которого интересны.
     * @returns {boolean} да или нет.
     */
    function touchesRoot(node, selector) {
      if (node === null || node === undefined || node.nodeType !== 1) return false;
      if (typeof node.closest === 'function') return node.closest(selector) !== null;
      const root = typeof document?.querySelector === 'function' ? document.querySelector(selector) : null;
      return root === null ? false : root.contains?.(node) === true;
    }

    /**
     * Прочитать диагностический выключатель твиков.
     *
     * Порядок: сохранённое в устройстве значение, затем параметр адреса.
     * `?tweaks=off` выключает все твики разом и запоминает это, `?tweaks=on`
     * снимает отметку. Параметр действует сразу при загрузке страницы: рестарт
     * профиля DSH для диагностики не нужен, живой прод не трогаем.
     * @param {object | null} storage - хранилище устройства.
     * @returns {boolean} выключены ли все твики.
     */
    function readTweaksSwitch(storage) {
      let disabled = false;
      try {
        disabled = storage?.getItem?.(SWITCH_KEY) === SWITCH_OFF;
      } catch (_error) {
        disabled = false;
      }
      const location = typeof window === 'undefined' ? undefined : window.location;
      const search = typeof location?.search === 'string' ? location.search : '';
      // Разбор без URLSearchParams: адресная строка бывает и в тестовой заглушке.
      const match = /[?&]tweaks=(off|on)(?:&|#|$)/i.exec(search);
      if (match !== null) {
        const off = match[1].toLowerCase() === 'off';
        disabled = off;
        try {
          if (off) storage?.setItem?.(SWITCH_KEY, SWITCH_OFF);
          else storage?.removeItem?.(SWITCH_KEY);
        } catch (_error) {
          /* хранилище недоступно: значение действует до перезагрузки */
        }
      }
      return disabled;
    }

    /* #endregion tweak-watch-helpers */

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

    /* #region header-leading-seat */

    /**
     * Общий слот `conversation.header.leading`.
     *
     * Слот одинарный, а нам нужны сразу меню, светофор и название. Поэтому
     * части складываются сюда, а слой регистрируется один раз; когда частей не
     * осталось — регистрация снимается и слот возвращается приложению.
     */
    const headerLeadingSeat = (() => {
      const parts = new Map();
      const listeners = new Set();
      let scope = null;

      /** Перерисовать подписчиков после смены частей. */
      function notify() {
        for (const listener of listeners) listener();
      }

      /**
       * Слой слота: части по возрастанию ранга.
       * @param {object} props - стандартные пропсы слота.
       * @returns {object} фрагмент с частями.
       */
      function HeaderLeadingSeat(props) {
        const [, force] = React.useState(0);
        React.useEffect(() => {
          listeners.add(force);
          return () => listeners.delete(force);
        }, []);
        const children = [];
        for (const [id, part] of [...parts.entries()].sort((left, right) => left[1].rank - right[1].rank)) {
          children.push(React.createElement(React.Fragment, { key: id }, part.render(props)));
        }
        return React.createElement(React.Fragment, null, ...children);
      }

      /**
       * Зарегистрировать слот при первой части.
       * @param {object} ctx - клиентский контекст плагина.
       * @returns {void}
       */
      function mount(ctx) {
        if (scope !== null) return;
        let slots = undefined;
        try {
          slots = typeof ctx?.get === 'function' ? ctx.get('slots') : undefined;
        } catch (_error) {
          slots = undefined;
        }
        if (typeof slots?.inject !== 'function' || typeof slots?.register !== 'function') return;
        scope = createScope();
        scope.own(slots.inject('conversation.header.leading', () => slots.register(
          { name: 'conversation.header.leading' },
          HeaderLeadingSeat,
        )));
      }

      return {
        /**
         * @param {object} ctx - контекст.
         * @param {string} id - ключ части.
         * @param {number} rank - порядок (меньше — левее).
         * @param {Function} render - (props) => элемент.
         * @returns {void}
         */
        set(ctx, id, rank, render) {
          parts.set(id, { rank, render });
          mount(ctx);
          notify();
        },
        /**
         * @param {string} id - ключ части.
         * @returns {void}
         */
        clear(id) {
          if (!parts.delete(id)) return;
          notify();
          if (parts.size === 0 && scope !== null) {
            scope.dispose();
            scope = null;
          }
        },
      };
    })();

    /**
     * Название текущего чата в шапке: на телефоне штатные крошки скрыты,
     * а здесь название стоит сразу за светофором.
     * @param {object} props - стандартные пропсы слота (useSessions, usePanelInfo).
     * @returns {object | null} название или null.
     */
    function MobileHeaderTitle({ useSessions, usePanelInfo }) {
      const activePanel = typeof usePanelInfo === 'function'
        ? usePanelInfo((info) => info.activePanelId ?? null)
        : null;
      const title = typeof useSessions === 'function'
        ? useSessions((state) => {
            const byId = state?.byId ?? {};
            const current = Object.values(byId).find((item) => (item?.retainedBy?.mainView ?? 0) > 0);
            return typeof current?.title === 'string' && current.title !== '' ? current.title : null;
          })
        : null;
      if (activePanel !== null || title === null) return null;
      return React.createElement('span', { className: 'dsh-tweaks-header-title', title }, title);
    }

    /* #endregion header-leading-seat */

    /* #region tweak-traffic-light */
    /** Период пересчёта индикатора: раз в минуту (секундный тик грузил CPU). */
    const LIGHT_TICK_MS = 60000;

    /** Цвета лампы из токенов темы: красный — ошибка, жёлтый — предупреждение, зелёный — успех. */
    const LIGHT_COLORS = {
      red: 'var(--dsw-alias-state-error-primary)',
      yellow: 'var(--dsw-alias-state-warn-primary)',
      green: 'var(--dsw-alias-state-success-primary)',
    };

    /**
     * Признак красного света на корне документа: по нему красятся в красный
     * и пульсируют вместе с лампой индикаторы работы в списке сессий
     * (`StateDot` приложения с `data-state="ongoing"`).
     */
    const LIGHT_RED_ATTR = 'data-dsh-light-red';

    /** Префикс классов твика — как у меню по правой кнопке. */
    const LIGHT_CLASS = 'dsh-ui-light';

    /** Ключ пер-устройственных настроек твика (как у масштаба: своё значение на браузер). */
    const LIGHT_PREFS_KEY = 'dsh.ui-light.settings.v1';

    /** Режимы нижнего индикатора, по возрастанию подробности. */
    const LIGHT_DOCK_MODES = ['lamp', 'time', 'lamp-time', 'lamp-time-label'];

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

    /** Отсчёт «X ч MM мин» / «M мин» по словарю, минутная точность (тик раз в минуту). */
    function formatCountdownText(ms, t) {
      const total = Math.max(0, Math.ceil(ms / 60000));
      const hours = Math.floor(total / 60);
      const minutes = total % 60;
      if (hours > 0) return fillText(t('light.countdownH'), { hours, minutes: twoDigits(minutes) });
      if (minutes > 0) return fillText(t('light.countdownM'), { minutes });
      return t('light.countdownS');
    }

    /**
     * Хук состояния индикатора: тик раз в секунду, подписка на политику
     * и признак «кто-то работает» из списка сессий.
     * @returns {object} now — текущее время, running — есть ли работа.
     */
    function useLightTick() {
      const [now, setNow] = React.useState(Date.now());
      React.useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        if (typeof window.setInterval !== 'function' || typeof window.setTimeout !== 'function') return undefined;
        // Первый тик — в начале следующей минуты, дальше раз в минуту: секундная
        // перерисовка в софтверном рендере (headless Chrome) жгла ядро CPU.
        const alignMs = 60000 - (Date.now() % 60000);
        let interval = undefined;
        const first = window.setTimeout(() => {
          setNow(Date.now());
          interval = window.setInterval(() => setNow(Date.now()), LIGHT_TICK_MS);
        }, alignMs);
        return () => {
          window.clearTimeout(first);
          if (interval !== undefined) window.clearInterval(interval);
        };
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
    const LIGHT_PANEL_WIDTH = 364;
    /** Минимальная высота панели-тултипа: меньше не сжимаем — включаем прокрутку. */
    const LIGHT_PANEL_MIN_HEIGHT = 200;
    /** Отступ панели от краёв окна. */
    const LIGHT_PANEL_MARGIN = 8;
    /** Зазор между лампой и панелью/стрелкой. */
    const LIGHT_PANEL_GAP = 8;

    /**
     * Видимая область окна. В обычном браузере это layout viewport; в
     * мобильном с клавиатурой/pinch — visualViewport, чтобы панель не уезжала
     * под клавиатуру и не вылезала за видимую часть.
     * @returns {{left: number, top: number, width: number, height: number}} границы.
     */
    function lightViewport() {
      if (typeof window === 'undefined') return { left: 0, top: 0, width: 1024, height: 768 };
      const view = window.visualViewport;
      const fallbackWidth = Number.isFinite(window.innerWidth) ? window.innerWidth : 1024;
      const fallbackHeight = Number.isFinite(window.innerHeight) ? window.innerHeight : 768;
      const left = Number.isFinite(view?.offsetLeft) ? Math.round(view.offsetLeft) : 0;
      const top = Number.isFinite(view?.offsetTop) ? Math.round(view.offsetTop) : 0;
      const width = Number.isFinite(view?.width) ? Math.round(view.width) : fallbackWidth;
      const height = Number.isFinite(view?.height) ? Math.round(view.height) : fallbackHeight;
      return { left, top, width: Math.max(1, width), height: Math.max(1, height) };
    }

    /**
     * Чистая геометрия панели во вьюпортных (визуальных) пикселях.
     *
     * Панель всегда садится низом над якорем. Если содержимое длиннее
     * свободного места, высота ограничивается — внутри включается прокрутка.
     * Ширина прижимается к окну и центрируется по лампе в допустимых границах.
     * @param {object} input - anchorRect, viewport, scale, contentHeight.
     * @returns {object} left/top/width/maxHeight и scale для локальных стилей.
     */
    function computeLightPanelGeometry({ anchorRect, viewport, scale, contentHeight }) {
      const margin = LIGHT_PANEL_MARGIN;
      const gap = LIGHT_PANEL_GAP;
      const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
      const width = Math.max(1, Math.min(LIGHT_PANEL_WIDTH, viewport.width - 2 * margin));
      const viewportRight = viewport.left + viewport.width;
      const viewportBottom = viewport.top + viewport.height;
      const availableAbove = Math.max(0, anchorRect.top - viewport.top - gap - margin);
      const availableBelow = Math.max(0, viewportBottom - anchorRect.bottom - gap - margin);
      const placement = availableAbove < LIGHT_PANEL_MIN_HEIGHT && availableBelow > availableAbove
        ? 'below'
        : 'above';
      const available = placement === 'below' ? availableBelow : availableAbove;
      const height = Math.max(1, Math.min(Math.max(1, contentHeight), Math.max(1, available)));
      const top = placement === 'below'
        ? anchorRect.bottom + gap
        : anchorRect.top - gap - height;
      const center = anchorRect.left + anchorRect.width / 2;
      const rightAligned = anchorRect.left + anchorRect.width - width;
      const left = Math.max(
        viewport.left + margin,
        Math.min(
          anchorRect.left + width <= viewportRight - margin
            ? anchorRect.left
            : rightAligned >= viewport.left + margin
              ? rightAligned
              : center - width / 2,
          viewportRight - width - margin,
        ),
      );
      const arrowLeft = Math.max(12, Math.min(width - 12, center - left));
      return { left, top, width, maxHeight: height, scale: safeScale, placement, arrowLeft };
    }

    /**
     * Позиция панели-тултипа у якоря.
     *
     * Панель живёт в `body` через портал и масштабируется собственным
     * `transform: scale()`, поэтому возвращаемые left/top — уже вьюпортные
     * пиксели. Локальные width/maxHeight считаются от них делением на scale
     * в рендере.
     * @param {object} anchorRef - ref кнопки.
     * @param {object} panelRef - ref панели.
     * @returns {object | null} геометрия или null, пока нет якоря.
     */
    function panelPosition(anchorRef, panelRef) {
      const rect = anchorRef?.current?.getBoundingClientRect?.();
      if (rect === undefined || rect === null) return null;
      const scale = readScale();
      const viewport = lightViewport();
      const width = Math.max(1, Math.min(LIGHT_PANEL_WIDTH, viewport.width - 2 * LIGHT_PANEL_MARGIN));
      const panel = panelRef?.current ?? null;
      if (panel !== null) {
        // Ширина и transform нужны до чтения scrollHeight: от них зависит перенос строк.
        panel.style.transformOrigin = '0 0';
        panel.style.transform = scale === 1 ? '' : `scale(${scale})`;
        panel.style.width = `${width / scale}px`;
      }
      const contentHeight = Math.max(1, (panel?.scrollHeight ?? LIGHT_PANEL_MIN_HEIGHT) * scale);
      return computeLightPanelGeometry({ anchorRect: rect, viewport, scale, contentHeight });
    }

    /** Геометрия горизонтальной шкалы часов: 24 кружочка от 0 до 24. */
    const STRIP_WIDTH = 316;
    const STRIP_HEIGHT = 46;
    const STRIP_PAD = 8;
    const STRIP_STEP = (STRIP_WIDTH - 2 * STRIP_PAD) / 23;
    const STRIP_Y = 20;

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
      // Подписи часов под каждым кружочком: видны постоянно, в обеих панелях и
      // не зависят от наведения. Часы, открывающие зелёный диапазон (после
      // дорогого окна или с начала суток), выделены жирнее — по ним читается
      // структура дня.
      for (const slot of statuses) {
        const startsGreen = !slot.peak && (slot.hour === 0 || statuses[slot.hour - 1].peak);
        children.push(React.createElement('text', {
          key: `mark-${slot.hour}`,
          x: xOf(slot.hour),
          y: STRIP_HEIGHT - 4,
          textAnchor: 'middle',
          fontSize: 8.5,
          fontWeight: startsGreen ? 600 : 400,
          style: { fill: 'var(--dsw-alias-label-secondary)', userSelect: 'none', pointerEvents: 'none' },
        }, twoDigits(slot.hour)));
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
     * @param {object} props - anchorRef (лампа), buttonRef, variant, onClose.
     * @returns {object} панель.
     */
    function TrafficClockPanel({ anchorRef, buttonRef, variant, onClose }) {
      const { now, running } = useLightTick();
      const status = lightStatus(now);
      const [hover, setHover] = React.useState(null);
      const [position, setPosition] = React.useState(null);
      const panelRef = React.useRef(null);
      const bodyRef = React.useRef(null);
      /**
       * Пересчитать позицию панели по её настоящим размерам.
       *
       * Панель сначала монтируется невидимой (visibility:hidden — размеры при
       * этом измеримы), поэтому она появляется сразу на месте и не прыгает из
       * предварительной позиции, посчитанной по предполагаемым размерам.
       * @returns {void}
       */
      const measure = () => {
        // Перед замером снимаем ограничение прокрутки: panel.scrollHeight
        // должен видеть весь контент, а не только текущий maxHeight.
        const body = bodyRef.current;
        const previousMaxHeight = body?.style?.maxHeight;
        if (body !== null && body !== undefined) body.style.maxHeight = 'none';
        const next = panelPosition(anchorRef, panelRef);
        if (body !== null && body !== undefined && previousMaxHeight !== undefined) {
          body.style.maxHeight = previousMaxHeight;
        }
        if (next === null) return;
        setPosition((current) =>
          current !== null &&
          current.left === next.left &&
          current.top === next.top &&
          current.width === next.width &&
          current.maxHeight === next.maxHeight &&
          current.scale === next.scale &&
          current.placement === next.placement &&
          current.arrowLeft === next.arrowLeft
            ? current
            : next,
        );
      };
      // Замер до первой отрисовки: React выполняет layout-эффект синхронно,
      // поэтому кадр с неверной позицией не успевает попасть на экран.
      const useLayout = React.useLayoutEffect ?? React.useEffect;
      useLayout(() => {
        measure();
      }, []);
      React.useEffect(() => {
        let frame = null;
        let settleTimer = null;
        const schedule = () => {
          if (frame !== null) return;
          const run = () => {
            frame = null;
            measure();
          };
          if (typeof window.requestAnimationFrame === 'function') frame = window.requestAnimationFrame(run);
          else frame = window.setTimeout(run, 0);
          // После смены масштаба #root перестраивает сетку не в том же кадре:
          // добиваем замер, когда якорь уже доехал до нового места.
          if (settleTimer !== null) window.clearTimeout(settleTimer);
          settleTimer = window.setTimeout(run, 140);
        };
        const onResize = () => schedule();
        window.addEventListener('resize', onResize);
        // Смена масштаба твика: #root перестраивается, панель должна догнать.
        window.addEventListener('dsh-ui-zoom-change', onResize);
        // Прокрутка чата сдвигает якорь нижнего индикатора: панель едет следом.
        document.addEventListener('scroll', onResize, true);
        const visual = window.visualViewport;
        visual?.addEventListener?.('resize', onResize);
        visual?.addEventListener?.('scroll', onResize);
        let observer = null;
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(schedule);
          if (panelRef.current !== null) observer.observe(panelRef.current);
          if (anchorRef.current !== null) observer.observe(anchorRef.current);
          if (buttonRef?.current !== null && buttonRef?.current !== undefined) observer.observe(buttonRef.current);
        }
        return () => {
          window.removeEventListener('resize', onResize);
          window.removeEventListener('dsh-ui-zoom-change', onResize);
          document.removeEventListener('scroll', onResize, true);
          visual?.removeEventListener?.('resize', onResize);
          visual?.removeEventListener?.('scroll', onResize);
          observer?.disconnect();
          if (frame !== null) {
            if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
            else window.clearTimeout(frame);
          }
          if (settleTimer !== null) window.clearTimeout(settleTimer);
        };
      }, []);
      React.useEffect(() => {
        measure();
      }, [now]);
      React.useEffect(() => {
        const onPointer = (event) => {
          const panel = panelRef.current;
          const anchor = anchorRef.current;
          const button = buttonRef?.current;
          if (panel !== null && panel.contains(event.target)) return;
          if (anchor !== null && anchor.contains(event.target)) return;
          if (button !== null && button !== undefined && button.contains(event.target)) return;
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
      }, [anchorRef, buttonRef, onClose]);
      const t = lightTranslator;
      const target = lightCountdownTarget(status);
      const policy = effectivePolicy();
      const windowsText = policy.peakWindows
        .map((window) => localWindowLabel(window, policy, now))
        .join(' · ');
      const countdown = target === null ? '' : formatCountdownText(target - now, t);
      const hourStatuses = todayHourStatuses(now);
      // В покое подпись показывает текущий час, при наведении — час под курсором:
      // формат один и тот же, поэтому при наведении ничего не «появляется».
      const shownHour = hover === null ? new Date(now).getHours() : hover;
      const shown = hourStatuses.find((slot) => slot.hour === shownHour) ?? null;
      const slotLine = shown === null
        ? t(lightLabelKey(status.light))
        : fillText(t('light.slotLabel'), {
            time: `${twoDigits(shown.hour)}:00–${twoDigits((shown.hour + 1) % 24)}:00`,
            label: t(shown.peak ? 'light.peak' : 'light.offpeak'),
          });
      return React.createElement('div', {
        ref: panelRef,
        className: `${LIGHT_CLASS}-panel`,
        'data-dsh-light-panel': '',
        'data-placement': position === null ? 'above' : position.placement,
        style: {
          left: `${position === null ? 0 : position.left}px`,
          top: `${position === null ? 0 : position.top}px`,
          width: position === null ? undefined : `${position.width / position.scale}px`,
          '--dsh-light-arrow-left': `${position === null ? 24 : position.arrowLeft}px`,
          transform: position === null || position.scale === 1 ? 'none' : `scale(${position.scale})`,
          transformOrigin: '0 0',
          overflow: 'visible',
          visibility: position === null ? 'hidden' : 'visible',
        },
        role: 'dialog',
        'aria-label': t('light.clockTitle'),
        onMouseLeave: () => setHover(null),
      },
        React.createElement('div', {
          ref: bodyRef,
          className: `${LIGHT_CLASS}-panelBody`,
          style: { maxHeight: position === null ? 'none' : `${position.maxHeight / position.scale}px` },
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
        ),
      );
    }

    /**
     * Вынести панель в body. Портал убирает её из зум-контекста `#root`, из-за
     * которого `position: fixed` считался от масштабированного предка.
     * @param {object | null} panel - панель или null.
     * @returns {object | null} портал либо исходный элемент в тестовой среде.
     */
    function renderLightPortal(panel) {
      if (panel === null) return null;
      if (ReactDOM?.createPortal !== undefined && typeof document !== 'undefined' && document.body !== null) {
        return ReactDOM.createPortal(panel, document.body);
      }
      return panel;
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
      const buttonRef = React.useRef(null);
      const lampRef = React.useRef(null);
      const t = lightTranslator;
      const color = LIGHT_COLORS[status.light];
      // Индикаторы работы сессий в сайдбаре краснеют вместе с лампой.
      React.useEffect(() => {
        const root = document.documentElement;
        if (root === undefined || root === null) return undefined;
        if (status.light === 'red') {
          if (typeof root.setAttribute === 'function') root.setAttribute(LIGHT_RED_ATTR, '');
        } else if (typeof root.removeAttribute === 'function') {
          root.removeAttribute(LIGHT_RED_ATTR);
        }
        return () => {
          if (typeof root.removeAttribute === 'function') root.removeAttribute(LIGHT_RED_ATTR);
        };
      }, [status.light]);
      const target = lightCountdownTarget(status);
      const label = target === null
        ? t(lightLabelKey(status.light))
        : fillText(t(lightCountdownKey(status)), { time: formatTarget(target, now, t) });
      // В шапке индикатор всегда без текста; у нижнего режим выбирает разработчик.
      const dockMode = variant === 'dock' ? prefs.dockMode ?? 'time' : 'lamp';
      const dot = React.createElement('span', {
        key: 'lamp',
        className: `${LIGHT_CLASS}-lamp`,
        // Лампа статична: бесконечные blink/pulse-анимации постоянно
        // перерисовывали кадр в софтверном рендере и грузили CPU.
        style: { background: color },
      });
      const lampNode = React.createElement('span', {
        key: 'lamp-wrap',
        ref: lampRef,
        className: `${LIGHT_CLASS}-lamp-wrap`,
      }, dot);
      const content = [lampNode];
      if (dockMode === 'lamp-time-label') {
        content.push(React.createElement('span', { key: 'label', className: `${LIGHT_CLASS}-label` }, t(lightLabelKey(status.light))));
      }
      if (dockMode !== 'lamp') {
        // Вместо секундного отсчёта — текущее системное время в часовом поясе
        // пользователя (браузера); обновляется раз в минуту вместе с лампой.
        content.push(React.createElement('span', { key: 'time', className: `${LIGHT_CLASS}-count` }, formatClock(now)));
      }
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button',
          ref: buttonRef,
          className: `${LIGHT_CLASS}-button`,
          'aria-label': label,
          'data-light': status.light,
          onClick: () => setOpen((value) => !value),
        }, content),
        open
          ? renderLightPortal(React.createElement(TrafficClockPanel, {
              anchorRef: lampRef,
              buttonRef,
              variant,
              onClose: () => setOpen(false),
            }))
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
        : `${copy(lightLabelKey(status.light))} · ${fillText(copy('light.leftTo'), {
            value: formatCountdownText(target - now, copy),
            time: formatTarget(target, now, lightTranslator),
          })}`;

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
              { value: 'time', label: copy('light.setting.dock.timeOnly') },
              { value: 'lamp-time', label: copy('light.setting.dock.time') },
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
      `.${LIGHT_CLASS}-lamp-wrap{position:relative;display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center}`,
      `.${LIGHT_CLASS}-lamp{box-sizing:border-box;flex:none;width:16px;height:16px;border-radius:999px;display:block;transition:background 250ms ease}`,
      `.${LIGHT_CLASS}-wave{box-sizing:border-box;position:absolute;inset:0;border-radius:999px;border:1.5px solid;`,
      `pointer-events:none;opacity:0;animation:${LIGHT_CLASS}-wave 2s ease-out infinite}`,
      `.${LIGHT_CLASS}-label{white-space:nowrap}`,
      `.${LIGHT_CLASS}-count{color:var(--dsw-alias-label-tertiary)}`,
      `.${LIGHT_CLASS}-panel{box-sizing:border-box;position:fixed;z-index:2147483000;width:364px;`,
      'border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);',
      'backdrop-filter:var(--dsw-menu-backdrop-filter);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);',
      'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:normal;overflow-wrap:anywhere;',
      'overflow:visible}',
      `.${LIGHT_CLASS}-panelBody{box-sizing:border-box;padding:12px;overflow-y:auto;overscroll-behavior:contain}`,
      `.${LIGHT_CLASS}-panel::before{content:"";position:absolute;left:var(--dsh-light-arrow-left,24px);width:0;height:0;margin-left:-7px;border:7px solid transparent;z-index:1;pointer-events:none}`,
      `.${LIGHT_CLASS}-panel[data-placement="above"]::before{top:100%;border-top-color:var(--dsw-specific-menu);border-bottom:0}`,
      `.${LIGHT_CLASS}-panel[data-placement="below"]::before{bottom:100%;border-bottom-color:var(--dsw-specific-menu);border-top:0}`,
      `@keyframes ${LIGHT_CLASS}-panel-in{from{opacity:0;translate:0 4px}to{opacity:1;translate:0 0}}`,
      `.${LIGHT_CLASS}-panel{animation:${LIGHT_CLASS}-panel-in 120ms ease-out}`,
      `@media (prefers-reduced-motion:reduce){.${LIGHT_CLASS}-panel{animation:none}}`,
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
      // Такт 2 секунды: лампа уменьшена, плавно растёт до своего нормального
      // размера к 60% цикла — в этот момент от её края уходит волна, — затем
      // снова уменьшается, и такт повторяется.
      `@keyframes ${LIGHT_CLASS}-pulse{0%{transform:scale(.85);opacity:.8}60%{transform:scale(1);opacity:1}100%{transform:scale(.85);opacity:.8}}`,
      `@keyframes ${LIGHT_CLASS}-wave{0%,55%{transform:scale(1);opacity:0}62%{opacity:.5}100%{transform:scale(2.6);opacity:0}}`,
      // Индикатор работы в списке сессий (StateDot с data-state="ongoing"):
      // на красном свете — красный, без пульсации (бесконечная анимация жгла CPU).
      `html[${LIGHT_RED_ATTR}] [class*="_sessionRow"] svg[data-state="ongoing"]{`,
      'color:var(--dsw-alias-state-error-primary);}',
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
          // Начиная с 0.2.1-rc.5 dock-слот называется conversation.input.dock;
          // старый conversation.composer.dock у более ранних сборок, поэтому
          // светофор раньше не появлялся на обоих актуальных ядрах.
          const dockSlot = coreFeatures().nativeComposerDock
            ? 'conversation.input.dock'
            : 'conversation.composer.dock';
          // Отрицательный order ставит светофор первым в строке дока: у системных
          // записей порядок 0, а сортировка идёт по возрастанию.
          own(slots.inject(dockSlot, () => slots.register(
            { name: dockSlot, id: 'traffic-light', order: -1000 },
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

    /* #region tweak-image-model-fallback */

    /**
     * Куда переключать модель, если выбранная не видит картинки.
     *
     * Значения приходят из Config (index.js) через `refresh` каркаса: поле
     * `imageFallbackProvider` / `imageFallbackModel` / `imageFallbackLabel`.
     * Дефолты совпадают с раскладкой профиля: DeepSeek Account + DeepSeek-V41-Flash.
     */
    const imageFallbackConfig = {
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      label: 'Flash',
    };

    /** Стиль плашки: только токены темы, поэтому она следует светлой и тёмной схеме. */
    const IMAGE_FALLBACK_STYLE_TEXT =
      '.dsh-tweaks-imf{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;' +
      'padding:8px 12px;margin:0 0 8px;border:0.5px solid var(--dsw-alias-border-l2);' +
      'border-radius:12px;background:var(--dsw-alias-bg-overlay);' +
      'color:var(--dsw-alias-label-primary);font:400 13px/18px system-ui,sans-serif}' +
      '.dsh-tweaks-imf-text{flex:1 1 auto;min-width:0}' +
      '.dsh-tweaks-imf-action{flex:none;cursor:pointer;padding:4px 10px;border-radius:8px;' +
      'border:0.5px solid var(--dsw-alias-border-l2);background:transparent;' +
      'color:var(--dsw-alias-label-primary);font:500 13px/18px system-ui,sans-serif}' +
      '.dsh-tweaks-imf-action:disabled{opacity:.6;cursor:default}' +
      '.dsh-tweaks-imf-close{flex:none;cursor:pointer;padding:2px 4px;border:0;background:transparent;' +
      'color:inherit;opacity:.7;font:400 16px/1 system-ui,sans-serif}' +
      '.dsh-tweaks-imf-close:hover{opacity:1}';

    /**
     * Выбранная модель сессии из проекции `modelSelection`.
     * @param {unknown} value - снимок проекции или undefined.
     * @returns {object | null} текущий выбор (provider/model/reasoningEffort).
     */
    function currentModelSelection(value) {
      if (value === undefined || value === null || typeof value !== 'object') return null;
      const next = value.next ?? value.lastUsed ?? null;
      return next !== null && typeof next === 'object' ? next : null;
    }

    /**
     * Плашка над полем ввода: ошибка «модель не видит изображения» + кнопка
     * повторной отправки моделью со зрением.
     *
     * Появляется только когда сервер отверг отправку с причиной
     * MODEL_DOES_NOT_SUPPORT_IMAGES: к этому моменту неудавшаяся отправка уже
     * восстановлена в поле ввода (текст и вложения), поэтому кнопка меняет
     * модель и повторяет ту же отправку через публичный `inputActions.submit()`.
     *
     * @param {object} props - слот-пропсы дока и внедрённое окружение (host).
     * @returns {object | null} элемент плашки либо null, когда показывать нечего.
     */
    function ImageModelFallback(props) {
      const host = props?.host ?? {};
      const t = typeof host.t === 'function' ? host.t : (key) => key;
      const sessionId = props?.sessionId;
      const useSession = props?.useSession;
      const useInput = props?.useInput;
      const useProjection = props?.useProjection;
      const inputActions = props?.inputActions;
      const promptError = typeof useSession === 'function' ? useSession((snapshot) => snapshot.promptError) ?? null : null;
      const input = typeof useInput === 'function' ? useInput((state) => state) : undefined;
      const selection =
        typeof useProjection === 'function'
          ? useProjection('modelSelection', currentModelSelection)
          : null;
      const [dismissed, setDismissed] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      // Новый отказ (или его сброс) — плашка начинается с чистого состояния.
      React.useEffect(() => {
        setBusy(false);
        setFailure(null);
      }, [promptError]);
      const reason = promptError?.error?.details?.reason;
      const supported = reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES';
      const draft = typeof input?.draft === 'string' ? input.draft : '';
      const attachmentCount = Array.isArray(input?.attachmentIds) ? input.attachmentIds.length : 0;
      const hasContent = draft.trim() !== '' || attachmentCount > 0;
      const hidden = !supported || promptError === dismissed || !hasContent;
      if (hidden) return null;
      const target = imageFallbackConfig;
      /**
       * Сменить модель и повторить отправку восстановленного черновика.
       * @returns {Promise<void>} завершение операции.
       */
      const apply = async () => {
        if (busy) return;
        setBusy(true);
        setFailure(null);
        try {
          const ctx = host.ctx;
          // Штатный сервис выбора модели: у него уже внедрён `remote.session`,
          // поэтому не трогаем ctx.remote напрямую (без inject он падает).
          if (sessionId === undefined) throw new Error('session identity is unavailable');
          const directories = typeof ctx?.get === 'function' ? ctx.get('modelDirectories') : undefined;
          const request = { provider: target.provider, model: target.model };
          const effort = selection?.reasoningEffort;
          if (typeof effort === 'string' && effort !== '') request.reasoningEffort = effort;
          let result;
          if (typeof directories?.directoryFor === 'function') {
            const directory = directories.directoryFor(sessionId);
            if (typeof directory?.select !== 'function') throw new Error('model selection is unavailable');
            result = await directory.select(request);
          } else {
            // Совместимость со старым ядром: remote требует inject, поэтому
            // используется только как последний резерв.
            const remote = typeof ctx?.get === 'function' ? ctx.get('remote') : undefined;
            const selectModel = remote?.session?.selectModel;
            if (typeof selectModel !== 'function') throw new Error('model directory API is unavailable');
            result = await selectModel({ sessionId, ...request });
          }
          if (result === undefined || result === null || result.ok !== true) {
            const error = result?.error;
            throw new Error(
              typeof error?.message === 'string' && error.message !== ''
                ? `${error.message} (${String(error.code ?? 'error')})`
                : 'selectModel failed',
            );
          }
          if (typeof inputActions?.submit === 'function') inputActions.submit();
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };
      return React.createElement(
        'div',
        { className: 'dsh-tweaks-imf', role: 'status' },
        React.createElement(
          'span',
          { className: 'dsh-tweaks-imf-text' },
          failure === null ? t('imageFallback.text') : `${t('imageFallback.errorPrefix')} ${failure}`,
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-tweaks-imf-action',
            disabled: busy,
            onClick: apply,
          },
          busy ? t('imageFallback.busy') : `${t('imageFallback.actionPrefix')} ${target.label}`,
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-tweaks-imf-close',
            'aria-label': t('imageFallback.dismiss'),
            title: t('imageFallback.dismiss'),
            onClick: () => setDismissed(promptError),
          },
          '×',
        ),
      );
    }

    /**
     * Включить твик: плашка в доке над полем ввода.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {object} api - регистратор очисток твика.
     * @returns {void}
     */
    function setupImageModelFallback(ctx, api) {
      const own = typeof api?.own === 'function' ? api.own : () => {};
      let locale = undefined;
      try {
        locale = typeof ctx?.get === 'function' ? ctx.get('locale') : undefined;
      } catch (_error) {
        locale = undefined;
      }
      const translate = createTranslator(locale);
      const style = document.createElement('style');
      style.textContent = IMAGE_FALLBACK_STYLE_TEXT;
      document.head?.appendChild(style);
      own(() => style.remove());
      let slots = undefined;
      try {
        slots = typeof ctx?.get === 'function' ? ctx.get('slots') : undefined;
      } catch (_error) {
        slots = undefined;
      }
      if (typeof slots?.inject !== 'function' || typeof slots?.register !== 'function') return;
      own(
        slots.inject('conversation.input.dock', () =>
          slots.register(
            { name: 'conversation.input.dock', id: 'image-model-fallback', order: 100 },
            (props) => React.createElement(ImageModelFallback, { ...props, host: { ctx, t: translate } }),
          ),
        ),
      );
    }

    /** Выключить твик: ресурсы (стиль и слот) снимает реестр через own(). */
    function teardownImageModelFallback() {
      // Собственных подписок нет: стиль и слот живут в очистках твика.
    }

    /* #endregion tweak-image-model-fallback */

    /* #region tweak-mobile-composer */

    /** Публичные действия активного композера (setDraft и т.п.). */
    let mobileComposerActions = null;

    function mobileComposerDevice(view) {
      return view?.matchMedia?.('(pointer: coarse)').matches === true || view?.navigator?.userAgentData?.mobile === true;
    }
    function mobileComposerText(text) { return text.replace(/\r\n?/g, '\n'); }
    function leadingComposerCommand(text) { return /^\/[\w-]+(?=\s|$)/.exec(text)?.[0]; }

    /** Detached parsing: Notes may provide HTML only, or plain text truncated to its first paragraph. */
    function mobileClipboardText(data, view) {
      const plain = mobileComposerText(data?.getData?.('text/plain') || '');
      const html = data?.getData?.('text/html') || '';
      if (!html || !view?.DOMParser) return plain;
      const doc = new view.DOMParser().parseFromString(html, 'text/html');
      const render = (node) => {
        if (node.nodeType === 3) return node.nodeValue || '';
        const tag = node.nodeName?.toUpperCase();
        if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tag)) return '';
        if (tag === 'BR') return '\n';
        let text = Array.from(node.childNodes || []).map(render).join('');
        if (tag === 'P') text += '\n\n';
        else if (['DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3'].includes(tag) && !text.endsWith('\n')) text += '\n';
        return text;
      };
      const converted = mobileComposerText(render(doc.body)).replace(/\n{1,2}$/, '');
      return !plain || (!plain.includes('\n') && converted.startsWith(plain + '\n')) ? converted : plain;
    }

    /** Native command claims supply mode, persistence, submission and guards. No custom send path. */
    function mobileCommandBridge(ctx, sessionId) {
      try {
        const sessions = ctx?.get?.('sessions'), triggers = ctx?.get?.('inputTriggers');
        const conversation = ctx?.get?.('conversation');
        const actx = sessions?.scope?.(sessionId);
        if (!actx || !triggers?.sessionOf || !conversation?.input?.for) return undefined;
        const input = conversation.input.for(actx), controller = triggers.sessionOf(actx);
        return {
          snapshot: () => input.state.getSnapshot(),
          resolve: (token, signal) => controller.resolveClaim(token, signal),
          claim: (claim, span) => actx.bail(actx, 'slash/input-begin-command', { claim, span }) === true,
          clear() {
            const state = input.state.getSnapshot();
            if (!state.claim) return;
            const token = state.claim.token.trimEnd();
            const separator = state.draft[token.length] === ' ' ? 1 : 0;
            actx.bail(actx, 'slash/input-consume-token', { guard: { kind: 'span', span: { start: 0, end: 1 + separator, draftRev: state.draftRev } } });
          },
          toggle() {
            const state = input.state.getSnapshot();
            // Native beginCommand replaces [0, span.end), so caret/end-of-body is unsafe.
            const end = state.claim ? 1 : leadingComposerCommand(state.draft)?.length || 0;
            controller.toggleSource('command', { trigger: '/', query: '', quoted: false, position: 'leading', span: { start: 0, end, draftRev: state.draftRev } });
          },
          /**
           * Не давать набранному `/` открывать меню. Тир `claimed` в детекторе
           * триггеров отключает только слэш; `@` остаётся живым.
           * @returns {Function} снятие патча.
           */
          guardSlash() {
            if (typeof controller.track !== 'function' || controller.track.__dshNoSlash === true) return () => {};
            const original = controller.track;
            const patched = function (draft, caret, guard, rev) {
              const next = guard?.tier === 'plain' ? { ...guard, tier: 'claimed' } : guard;
              return original.call(this, draft, caret, next, rev);
            };
            patched.__dshNoSlash = true;
            try {
              controller.track = patched;
            } catch (_error) {
              return () => {};
            }
            return () => {
              if (controller.track === patched) controller.track = original;
            };
          },
          /**
           * Открыть меню ссылок `@` программно, если нативный триггер не успел.
           * Источник `reference` даёт файлы/папки и сессии — то же основное
           * меню, что и у набранной собаки.
           * @returns {boolean} попытка отправлена.
           */
          /** Закрыть открытое меню триггеров (после blur оно не всегда само уходит). */
          dismissMenu() {
            try {
              controller.dismiss();
              return true;
            } catch (_error) {
              return false;
            }
          },
        };
      } catch (_error) { return undefined; }
    }

    /**
     * На сколько прокрутить скроллпорт, чтобы каретка стала видна.
     * @param {object} caret - прямоугольник каретки.
     * @param {object} box - прямоугольник скроллпорта.
     * @returns {number} сдвиг scrollTop.
     */
    function caretScrollDelta(caret, box) {
      if (caret.bottom > box.bottom) return caret.bottom - box.bottom;
      if (caret.top < box.top) return caret.top - box.top;
      return 0;
    }

    /**
     * Показать каретку внутри `[data-input-scroll]`: после программной вставки
     * браузер сам не прокручивает черновик.
     * @param {object} card - карточка композера.
     * @param {object} view - окно устройства.
     * @returns {void}
     */
    function revealComposerCaret(card, view) {
      const root = card?.querySelector?.('[data-composer-input]');
      const doc = root?.ownerDocument;
      if (!root || !doc) return;
      if (doc.activeElement !== root) root.focus?.({ preventScroll: true });
      const scroll = root.closest?.('[data-input-scroll]');
      if (!scroll) return;
      const selection = doc.getSelection?.();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      // Пустой перенос: у схлопнутого range в пустом абзаце может не быть
      // высоты. Тогда каретка в конце — прокручиваем черновик до низа,
      // иначе берём ближайший блок.
      const rectOfRange = range.getBoundingClientRect?.();
      if (!rectOfRange || (rectOfRange.width === 0 && rectOfRange.height === 0)) {
        let atEnd = false;
        try {
          const tail = doc.createRange();
          tail.setStart(range.endContainer, range.endOffset);
          tail.setEnd(root, root.childNodes.length);
          atEnd = tail.toString().replace(/\u200b/g, '').trim() === '';
        } catch (_error) {
          atEnd = false;
        }
        if (atEnd) {
          scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
          return;
        }
        const anchor = range.startContainer;
        const element = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
        const block = element?.closest?.('p, li, div, br') ?? element;
        const rect = block?.getBoundingClientRect?.();
        const box = scroll.getBoundingClientRect?.();
        if (rect && box && rect.height > 0) {
          const delta = caretScrollDelta(rect, box);
          if (delta !== 0) scroll.scrollTop += delta;
        }
        return;
      }
      const box = scroll.getBoundingClientRect?.();
      const delta = rectOfRange && box ? caretScrollDelta(rectOfRange, box) : 0;
      if (delta !== 0) scroll.scrollTop += delta;
    }

    /**
     * Показать каретку после программной вставки. Пустой перенос строки
     * дорисовывается не к следующему кадру (Lexical добавляет пустой блок),
     * поэтому повторяем прокрутку ещё пару раз, когда DOM уже устоялся.
     * @param {object} card - карточка композера.
     * @param {object} view - окно устройства.
     * @returns {void}
     */
    function revealComposerSoon(card, view) {
      const run = () => revealComposerCaret(card, view);
      if (typeof view?.requestAnimationFrame === 'function') view.requestAnimationFrame(run);
      else if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') window.setTimeout(run, 0);
      else run();
      const later = (ms) => {
        if (typeof view?.setTimeout === 'function') view.setTimeout(run, ms);
        else if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') window.setTimeout(run, ms);
      };
      later(50);
      later(160);
    }

    /** Write whole clipboard payload atomically through the public revision-guarded facade. */
    function bindMobileComposer(card, actions, view, command) {
      if (!card || typeof actions?.captureInsertion !== 'function' || typeof actions?.insertText !== 'function') return () => {};
      let disposed = false, pendingNative = null, composing = false, composingUntil = 0;
      let pendingCompositionEnter = null;
      const abort = new AbortController();
      const countNewlines = (text) => (String(text).match(/\n/g) ?? []).length;

      /**
       * Первый Enter во время IME-композиции обычно только фиксирует слово.
       * После `compositionend` добавляем перенос сами, если клавиатура его не
       * вставила: иначе для пустого списка нужно два Enter.
       * @returns {void}
       */
      const finishCompositionEnter = () => {
        const pending = pendingCompositionEnter;
        if (pending === null || disposed) return;
        pendingCompositionEnter = null;
        const run = () => {
          if (disposed) return;
          const draft = command?.snapshot?.()?.draft ?? '';
          if (countNewlines(draft) > pending.newlines) return;
          insertText('\n');
        };
        if (typeof view?.setTimeout === 'function') view.setTimeout(run, 30);
        else if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') window.setTimeout(run, 30);
        else run();
      };
      const unguardSlash = mobileComposerDevice(view) && typeof command?.guardSlash === 'function' ? command.guardSlash() : null;
      const targetOf = (event) => {
        const target = event.target?.closest?.('[data-composer-input]');
        return target && card.contains(target) && target.getAttribute('contenteditable') === 'true' && target.getAttribute('aria-disabled') !== 'true' ? target : null;
      };
      const stop = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
      const insertText = (text, span = actions.captureInsertion()) => {
        let clean = mobileComposerText(text);
        const state = command?.snapshot?.();
        // A preselected empty mode chip must not gain a duplicate literal /plan.
        if (state?.claim && state.draft.trim() === state.claim.token.trim()) {
          const token = state.claim.token.trim();
          if (clean.startsWith(token) && /\s/.test(clean[token.length] || '')) clean = clean.slice(token.length).replace(/^ /, '');
        }
        if (!actions.insertText(clean, span)) return false;
        revealComposerSoon(card, view);
        const next = command?.snapshot?.();
        const token = next?.phase === 'plain' ? leadingComposerCommand(next.draft) : null;
        if (token && command?.resolve && command?.claim) {
          const draftRev = next.draftRev;
          Promise.resolve(command.resolve(token, abort.signal)).then((claim) => {
            if (disposed || !claim || command.snapshot().draftRev !== draftRev) return;
            const caret = actions.captureInsertion();
            const extraSeparator = next.draft[token.length] === ' ' ? 0 : claim.token.slice(claim.token.trimEnd().length).length;
            if (command.claim(claim, { start: 0, end: token.length, draftRev }) && caret.start === caret.end) {
              // Native claim insertion parks the caret at the chip. Restore a collapsed
              // paste caret using a no-text public edit, never replacing a selected range.
              const at = caret.start <= token.length ? 1 : caret.start + 1 - token.length + extraSeparator;
              actions.insertText('', { start: at, end: at, draftRev: command.snapshot().draftRev });
            }
          }).catch(() => { /* Catalog unavailable: keep the full text, never send. */ });
        }
        return true;
      };
      let revealFrame = null;
      /** Держать каретку в видимой части черновика при обычном наборе. */
      const followCaret = () => {
        if (!mobileComposerDevice(view) || revealFrame !== null) return;
        const run = () => {
          revealFrame = null;
          if (disposed) return;
          revealComposerCaret(card, view);
        };
        if (typeof view?.requestAnimationFrame === 'function') revealFrame = view.requestAnimationFrame(run);
        else run();
      };
      const onSelectionChange = () => {
        const doc = view?.document;
        // Только когда редактор уже в фокусе: программный focus внутри
        // reveal снова шлёт selectionchange и может зациклить rAF.
        if (!isComposerInput(doc?.activeElement)) return;
        const selection = doc?.getSelection?.();
        const node = selection?.anchorNode;
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        if (!element || !card.contains(element)) return;
        followCaret();
      };
      const onViewportResize = () => {
        if (isComposerInput(view?.document?.activeElement)) followCaret();
      };
      const insert = (event, text) => { stop(event); insertText(text); };
      const inComposition = (event) => event.isComposing || event.keyCode === 229 || composing || Date.now() < composingUntil;
      const onCompositionStart = (event) => { if (targetOf(event)) composing = true; };
      const onCompositionEnd = (event) => {
        if (!targetOf(event)) return;
        composing = false;
        composingUntil = Date.now() + 10;
        finishCompositionEnter();
      };
      const onKeyDown = (event) => {
        if (event.defaultPrevented || event.key !== 'Enter' || !targetOf(event) || !mobileComposerDevice(view)) return;
        if (inComposition(event)) {
          event.stopImmediatePropagation();
          const draft = command?.snapshot?.()?.draft ?? '';
          pendingCompositionEnter = { newlines: countNewlines(draft) };
          return;
        }
        insert(event, '\n');
      };
      const onBeforeInput = (event) => {
        if (event.defaultPrevented || !targetOf(event)) return;
        const mobile = mobileComposerDevice(view);
        if (mobile && ['insertParagraph', 'insertLineBreak'].includes(event.inputType)) {
          if (inComposition(event)) {
            event.stopImmediatePropagation();
            pendingCompositionEnter = { newlines: countNewlines(command?.snapshot?.()?.draft ?? '') };
            return;
          }
          insert(event, '\n');
        } else if (['insertFromPaste', 'insertFromPasteAsQuotation'].includes(event.inputType)) {
          if (Array.from(event.dataTransfer?.items || []).some((item) => item.kind === 'file')) return;
          const text = mobileClipboardText(event.dataTransfer, view) || event.data;
          if (typeof text === 'string' && text !== '' && (mobile || leadingComposerCommand(text))) insert(event, text);
        } else if (mobile && ['insertText', 'insertCompositionText', 'insertFromComposition'].includes(event.inputType) &&
          typeof event.data === 'string' && (/\r|\n/.test(event.data) || /^\/[\w-]+\s[\s\S]+/.test(event.data))) {
          // Android clipboard keyboards can send a multi-paragraph paste as text/composition.
          if (event.cancelable === false) {
            pendingNative = { text: event.data, span: actions.captureInsertion() };
            event.stopImmediatePropagation();
          } else insert(event, event.data);
        }
      };
      const onInput = (event) => {
        if (mobileComposerDevice(view) && targetOf(event)) followCaret();
        if (!pendingNative || !targetOf(event)) return;
        const pending = pendingNative; pendingNative = null;
        event.stopImmediatePropagation();
        insertText(pending.text, pending.span);
      };
      const onPaste = (event) => {
        if (event.defaultPrevented || !targetOf(event)) return;
        const data = event.clipboardData;
        if (!data || Array.from(data.items || []).some((item) => item.kind === 'file')) return;
        const text = mobileClipboardText(data, view);
        if (text !== '' && (mobileComposerDevice(view) || leadingComposerCommand(text))) insert(event, text);
      };
      const handlers = { compositionstart: onCompositionStart, compositionend: onCompositionEnd, keydown: onKeyDown, beforeinput: onBeforeInput, input: onInput, paste: onPaste };
      for (const [name, fn] of Object.entries(handlers)) card.addEventListener(name, fn, true);
      const doc = view?.document;
      doc?.addEventListener?.('selectionchange', onSelectionChange);
      view?.visualViewport?.addEventListener?.('resize', onViewportResize);
      return () => {
        disposed = true; abort.abort(); pendingNative = null;
        unguardSlash?.();
        if (revealFrame !== null) view?.cancelAnimationFrame?.(revealFrame);
        revealFrame = null;
        doc?.removeEventListener?.('selectionchange', onSelectionChange);
        view?.visualViewport?.removeEventListener?.('resize', onViewportResize);
        for (const [name, fn] of Object.entries(handlers)) card.removeEventListener(name, fn, true);
      };
    }

    /** Bounded mobile scrollport and visualViewport-aware menu anchoring. */
    function bindMobileComposerLayout(card, view, command) {
      if (typeof card?.querySelector !== 'function') return () => {};
      const saved = new Map();
      const plus = () => card.querySelector('button[aria-haspopup="listbox"]');
      const setMenu = (menu, name, value) => {
        if (!saved.has(menu)) saved.set(menu, new Map());
        if (!saved.get(menu).has(name)) saved.get(menu).set(name, [menu.style.getPropertyValue(name), menu.style.getPropertyPriority(name)]);
        menu.style.setProperty(name, value, 'important');
      };
      const restoreMenus = () => {
        for (const [menu, props] of saved) for (const [name, [value, priority]] of props) {
          if (value) menu.style.setProperty(name, value, priority); else menu.style.removeProperty(name);
        }
        saved.clear();
      };
      /** Разрешённые подписи меню «+»: остальное живёт в других панелях. */
      const PLUS_MENU_LABELS = new Set(['File', 'Goal', 'Plan', '文件', '目标', '计划']);
      let plusMenuOpen = false;
      let plusMenuSeen = false;

      /** Первая строка подписи опции. */
      function plusOptionLabel(option) {
        const text = String(option?.innerText ?? option?.textContent ?? '').trim();
        return text.split('\n')[0].trim();
      }

      /**
       * Оставить в плюс-меню только File/Goal/Plan. Скрываем и секцию Commands,
       * если под ней не осталось видимых пунктов.
       * @returns {void}
       */
      function filterPlusMenu() {
        if (!plusMenuOpen || !mobileComposerDevice(view)) return;
        const menu = card.querySelector('[data-trigger-menu]');
        if (menu === null) {
          if (plusMenuSeen) { plusMenuOpen = false; plusMenuSeen = false; }
          return;
        }
        plusMenuSeen = true;
        const options = [...menu.querySelectorAll('button[role="option"]')];
        for (const option of options) {
          option.style.display = PLUS_MENU_LABELS.has(plusOptionLabel(option)) ? '' : 'none';
        }
        const titles = [...menu.querySelectorAll('[role="presentation"]')];
        for (const title of titles) {
          let node = title.nextElementSibling;
          let visible = false;
          while (node !== null && !titles.includes(node)) {
            if (node.getAttribute?.('role') === 'option' && node.style.display !== 'none') visible = true;
            node = node.nextElementSibling;
          }
          title.style.display = visible ? '' : 'none';
        }
      }

      const position = () => {
        if (!mobileComposerDevice(view)) { card.removeAttribute('data-mobile-composer'); restoreMenus(); return; }
        filterPlusMenu();
        const vp = view.visualViewport, height = vp?.height || view.innerHeight, width = vp?.width || view.innerWidth;
        const top = vp?.offsetTop || 0, left = vp?.offsetLeft || 0;
        // The existing zoom tweak scales #root: visual viewport lengths must become local CSS lengths.
        const zoom = typeof readScale === 'function' ? readScale() : 1;
        card.setAttribute('data-mobile-composer', '');
        const editor = card.querySelector?.('[data-composer-input]');
        if (editor !== null && editor !== undefined) {
          if (editor.getAttribute?.('spellcheck') !== 'false') editor.setAttribute('spellcheck', 'false');
          if (editor.getAttribute?.('autocorrect') !== 'off') editor.setAttribute('autocorrect', 'off');
        }
        card.style.setProperty('--dsh-mobile-text-cap', Math.max(36, Math.floor(height * 0.2)) / zoom + 'px');
        const menu = card.querySelector('[data-trigger-menu]'), button = plus();
        if (!menu || !button) return;
        const anchor = button.getBoundingClientRect();
        const above = Math.max(0, anchor.top - top - 12), below = Math.max(0, top + height - anchor.bottom - 12);
        const up = above >= Math.min(160, below);
        const cap = Math.max(36, Math.min(320, up ? above : below));
        const h = Math.min(cap, menu.scrollHeight * zoom || menu.getBoundingClientRect().height || cap), w = Math.min(360, Math.max(40, width - 16));
        const x = Math.max(left + 8, Math.min(anchor.left, left + width - w - 8));
        const y = Math.max(top + 8, Math.min(up ? anchor.top - h - 4 : anchor.bottom + 4, top + height - h - 8));
        for (const [name, value] of Object.entries({ position: 'fixed', left: x / zoom + 'px', top: y / zoom + 'px', right: 'auto', bottom: 'auto', width: w / zoom + 'px', 'min-width': '0', 'max-height': cap / zoom + 'px', 'overflow-y': 'auto', 'z-index': '1200' })) setMenu(menu, name, value);
      };
      let frame = null;
      const schedule = () => {
        if (frame !== null) return;
        if (!view.requestAnimationFrame) { position(); return; }
        frame = view.requestAnimationFrame(() => { frame = null; position(); });
      };
      const isPlus = (event) => !!command && event.target?.closest?.('button[aria-haspopup="listbox"]') === plus();
      const onDown = (event) => {
        // On all platforms the menu selects a mode without stealing the editor selection.
        if (!isPlus(event)) return;
        event.preventDefault(); event.stopImmediatePropagation();
      };
      const onClick = (event) => {
        if (!isPlus(event)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (mobileComposerDevice(view)) {
          plusMenuOpen = true;
          plusMenuSeen = false;
        }
        command.toggle();
        schedule();
      };
      card.addEventListener('pointerdown', onDown, true);
      card.addEventListener('mousedown', onDown, true);
      card.addEventListener('click', onClick, true);
      // После скрытия клавиатуры меню триггеров иногда остаётся открытым и
      // перекрывает поле. Закрываем его тапом вне меню и Escape.
      const menuOf = () => card.querySelector('[data-trigger-menu]');
      const onOutsidePointer = (event) => {
        const menu = menuOf();
        if (menu === null || menu.contains(event.target)) return;
        command?.dismissMenu?.();
      };
      const onEscape = (event) => {
        if (event.key !== 'Escape' || menuOf() === null) return;
        command?.dismissMenu?.();
      };
      document.addEventListener?.('pointerdown', onOutsidePointer, true);
      document.addEventListener?.('keydown', onEscape, true);
      view.addEventListener?.('resize', schedule);
      view.visualViewport?.addEventListener?.('resize', schedule);
      view.visualViewport?.addEventListener?.('scroll', schedule);
      const media = view.matchMedia?.('(pointer: coarse)'); media?.addEventListener?.('change', schedule);
      const observer = view.MutationObserver ? new view.MutationObserver(schedule) : null;
      observer?.observe(card, { childList: true, subtree: true });
      // Scale changes are published on html by the same plugin. Do not observe our own inline menu writes.
      if (card.ownerDocument?.documentElement) observer?.observe(card.ownerDocument.documentElement, { attributes: true, attributeFilter: ['style'] });
      position();
      return () => {
        observer?.disconnect(); if (frame !== null) view.cancelAnimationFrame?.(frame);
        card.removeEventListener('pointerdown', onDown, true); card.removeEventListener('mousedown', onDown, true); card.removeEventListener('click', onClick, true);
        document.removeEventListener?.('pointerdown', onOutsidePointer, true);
        document.removeEventListener?.('keydown', onEscape, true);
        view.removeEventListener?.('resize', schedule); view.visualViewport?.removeEventListener?.('resize', schedule); view.visualViewport?.removeEventListener?.('scroll', schedule); media?.removeEventListener?.('change', schedule);
        card.removeAttribute('data-mobile-composer'); card.style.removeProperty('--dsh-mobile-text-cap'); restoreMenus();
        plusMenuOpen = false; plusMenuSeen = false;
      };
    }

    /**
     * Enter в редакторе отложенного сообщения на touch-устройстве.
     *
     * Очередь рисует примитив `InlineEditor` — `<textarea>`, где Enter без Shift
     * штатно вызывает сохранение. На телефоне Enter должен остаться переводом
     * строки: обработчик гасит синтетический keydown, но НЕ preventDefault,
     * поэтому перенос строки делает сам браузер, а сохранение — кнопка-галочка.
     * @param {object} event - событие keydown.
     * @param {object} view - окно устройства.
     * @returns {boolean} нужно ли остановить всплытие.
     */
    function queueEditorEnter(event, view) {
      if (!event || event.defaultPrevented || event.key !== 'Enter') return false;
      if (event.isComposing || event.keyCode === 229) return false;
      const target = event.target;
      if (target?.tagName !== 'TEXTAREA' || typeof target.closest !== 'function') return false;
      if (target.closest('[data-queue-dock]') === null) return false;
      return mobileComposerDevice(view);
    }

    /**
     * Подписаться на Enter в редакторе очереди.
     * @param {object} doc - документ.
     * @param {object} view - окно устройства.
     * @returns {Function} снятие подписки.
     */
    function bindQueueEditorEnter(doc, view) {
      const onKeyDown = (event) => {
        if (!queueEditorEnter(event, view)) return;
        // Только всплытие: перевод строки остаётся браузеру, React не сохраняет.
        event.stopPropagation();
      };
      doc?.addEventListener?.('keydown', onKeyDown, true);
      return () => doc?.removeEventListener?.('keydown', onKeyDown, true);
    }

    /**
     * Enter в любом textarea на touch — перенос строки, а не submit/next.
     * Специальные поля (очередь, goal) больше не теряют перенос из-за
     * собственных keydown-обработчиков приложения.
     * @param {object} event - keydown.
     * @param {object} view - окно.
     * @returns {boolean} наш ли Enter.
     */
    function textareaEnterNewline(event, view) {
      if (!event || event.defaultPrevented || event.key !== 'Enter') return false;
      if (event.isComposing || event.keyCode === 229) return false;
      if (event.target?.tagName !== 'TEXTAREA') return false;
      return mobileComposerDevice(view);
    }

    /**
     * Подписаться на Enter во всех textarea.
     * @param {object} doc - документ.
     * @param {object} view - окно.
     * @returns {Function} снятие подписки.
     */
    function bindTextareaEnterNewline(doc, view) {
      const onKeyDown = (event) => {
        if (!textareaEnterNewline(event, view)) return;
        // Только всплытие: перенос строки остаётся браузеру, submit не срабатывает.
        event.stopPropagation();
      };
      doc?.addEventListener?.('keydown', onKeyDown, true);
      return () => doc?.removeEventListener?.('keydown', onKeyDown, true);
    }

    /**
     * Enter в редакторе goal должен вставлять перенос строки, а не сохранять:
     * на мобильном сохраняет кнопка-галочка.
     * @param {object} event - keydown.
     * @param {object} view - окно.
     * @returns {boolean} наш ли Enter.
     */
    function goalEditorEnter(event, view) {
      if (!event || event.defaultPrevented || event.key !== 'Enter') return false;
      if (event.isComposing || event.keyCode === 229) return false;
      const target = event.target;
      if (target?.tagName !== 'TEXTAREA' || typeof target.closest !== 'function') return false;
      if (target.closest('[data-goal-bar]') === null) return false;
      return mobileComposerDevice(view);
    }

    /**
     * Подписаться на Enter в редакторе goal.
     * @param {object} doc - документ.
     * @param {object} view - окно.
     * @returns {Function} снятие подписки.
     */
    function bindGoalEditorEnter(doc, view) {
      const onKeyDown = (event) => {
        if (!goalEditorEnter(event, view)) return;
        // Только всплытие: перенос строки остаётся браузеру.
        event.stopPropagation();
      };
      doc?.addEventListener?.('keydown', onKeyDown, true);
      return () => doc?.removeEventListener?.('keydown', onKeyDown, true);
    }

    function MobileComposerBinding({ inputActions, commandBridge }) {
      const marker = React.useRef(null);
      React.useEffect(() => {
        const card = marker.current?.closest('[data-composer-card]'), view = card?.ownerDocument?.defaultView;
        const offInput = bindMobileComposer(card, inputActions, view, commandBridge);
        const offLayout = bindMobileComposerLayout(card, view, commandBridge);
        return () => { offInput(); offLayout(); };
      }, [inputActions, commandBridge]);
      React.useEffect(() => {
        mobileComposerActions = inputActions;
        return () => { if (mobileComposerActions === inputActions) mobileComposerActions = null; };
      }, [inputActions]);
      return React.createElement('span', { ref: marker, hidden: true, 'data-mobile-composer-binding': '' });
    }
    /**
     * Убрать поиск из маленьких меню на touch: он нужен большим спискам,
     * а в меню прав/команд только занимает место. Скрытый input не получает
     * фокус — фокус уходит на первый пункт.
     * @param {object} view - окно устройства.
     * @returns {Function} снятие подписки.
     */
    function installSmallMenuSearchHider(view) {
      if (!mobileComposerDevice(view) || typeof view?.MutationObserver !== 'function') return () => {};
      const doc = view.document;
      if (!doc) return () => {};
      /**
       * Скрыть поиск, если в меню не больше шести пунктов.
       * @param {object} menu - узел меню.
       * @returns {void}
       */
      function hide(menu) {
        const inputs = [...menu.querySelectorAll('input')].filter((input) =>
          input.getAttribute('data-dsh-tweaks-search-hidden') === null
          && (input.type === 'search' || /search|搜索/i.test(input.getAttribute('placeholder') || '')));
        if (inputs.length === 0) return;
        const items = menu.querySelectorAll('button, [role="option"], [role="menuitem"]').length;
        if (items === 0 || items > 6) return;
        for (const input of inputs) {
          input.setAttribute('data-dsh-tweaks-search-hidden', '');
          input.style.display = 'none';
          input.setAttribute('aria-hidden', 'true');
          const parent = input.parentElement;
          if (parent !== null && parent !== menu && parent.children.length <= 2 && parent.querySelectorAll('input').length === 1) {
            parent.style.display = 'none';
          }
        }
      }
      /** Селектор меню, которые обходит твик. */
      const MENU_SELECTOR = '[role="menu"], [role="listbox"], [data-trigger-menu]';
      /**
       * Пройти по всем открытым меню.
       * @returns {void}
       */
      function sweep() {
        if (disposed) return;
        for (const menu of doc.querySelectorAll(MENU_SELECTOR)) hide(menu);
      }
      let frame = null;
      let scheduled = false;
      let observing = false;
      let disposed = false;
      const run = () => {
        frame = null;
        scheduled = false;
        sweep();
      };
      const schedule = () => {
        if (scheduled || disposed) return;
        scheduled = true;
        if (typeof view.requestAnimationFrame === 'function') frame = view.requestAnimationFrame(run);
        else frame = view.setTimeout(run, 0);
      };
      const observer = new view.MutationObserver((records) => {
        // Интересуют только узлы меню: чат перерисовывается постоянно, и каждая
        // его запись иначе заказывала бы проход по всем меню документа.
        for (const record of records) {
          for (const node of record.addedNodes ?? []) {
            if (touchesRoot(node, MENU_SELECTOR)) {
              schedule();
              return;
            }
          }
        }
      });
      /** Включить наблюдение и один раз пройти по меню. */
      const connectObserver = () => {
        if (observing) return;
        observing = true;
        observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });
        schedule();
      };
      /** Выключить наблюдение, пока вкладка скрыта. */
      const disconnectObserver = () => {
        if (!observing) return;
        observing = false;
        observer.disconnect();
      };
      const stopWatchingVisibility = pauseWhenHidden(doc, connectObserver, disconnectObserver);
      const onFocus = (event) => {
        const input = event.target;
        if (input?.getAttribute?.('data-dsh-tweaks-search-hidden') === null) return;
        const menu = input.closest?.(MENU_SELECTOR);
        menu?.querySelector('button, [role="option"], [role="menuitem"]')?.focus?.();
      };
      doc.addEventListener('focusin', onFocus, true);
      connectObserver();
      return () => {
        disposed = true;
        disconnectObserver();
        stopWatchingVisibility();
        doc.removeEventListener('focusin', onFocus, true);
        if (frame !== null) view.cancelAnimationFrame?.(frame);
      };
    }

    /**
     * Вернуть застрявший pending-echo очереди в поле ввода. Приложение держит
     * такие строки в `Sending...` с выключенными действиями, пока хост не
     * подтвердит постановку в очередь; при writer-локе/обрыве это навсегда.
     * Через 2.5 с разрешаем карандаш: он снимает локальный echo и кладёт его
     * текст в композер, чтобы сообщение можно было отредактировать и отправить.
     * @param {object} ctx - клиентский контекст.
     * @param {object} api - очистки твика.
     * @returns {void}
     */
    function installStuckQueueRecovery(ctx, api) {
      if (typeof window === 'undefined' || !mobileComposerDevice(window)) return;
      const own = typeof api?.own === 'function' ? api.own : () => {};
      const doc = window.document;
      const seen = new WeakMap();
      const enabled = new Set();
      let disposed = false;
      let timer = null;
      let scheduled = false;

      /** Найти текущую сессию и её snapshot. */
      const sessionNow = () => {
        try {
          const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined;
          const id = doc.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session');
          if (!id || typeof sessions?.scope !== 'function' || typeof sessions?.sessionOf !== 'function') return undefined;
          const actx = sessions.scope(id);
          if (actx === undefined) return undefined;
          const session = sessions.sessionOf(actx);
          return session && typeof session.getSnapshot === 'function' ? session : undefined;
        } catch (_error) {
          return undefined;
        }
      };

      /** Подходящий pending-echo: без вложений, есть штатный retire. */
      const pendingFor = (row, session) => {
        const snapshot = session?.getSnapshot?.();
        const pending = (snapshot?.pendingSubmissions ?? []).filter((item) => item.placement === 'queued');
        if (pending.length === 0) return undefined;
        const preview = row.querySelector('[class*="_preview"]')?.textContent?.trim() ?? '';
        return pending.find((item) => preview !== '' && (item.text.startsWith(preview) || preview.startsWith(item.text))) ?? pending[0];
      };

      /**
       * Разрешить карандаш у застрявшей строки.
       * @param {object} row - pending-строка.
       * @returns {void}
       */
      const enableRow = (row) => {
        const button = row.querySelector('[class*="_actions"] button');
        if (button === null || button === undefined) return;
        const session = sessionNow();
        if (session === undefined || typeof session.retireFailedSubmission !== 'function') return;
        const item = pendingFor(row, session);
        if (item === undefined || (Array.isArray(item.attachments) && item.attachments.length > 0)) return;
        if (typeof mobileComposerActions?.setDraft !== 'function') return;
        button.disabled = false;
        button.removeAttribute('title');
        button.setAttribute('data-dsh-tweaks-pending-edit', '');
        if (enabled.has(button)) return;
        enabled.add(button);
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          try {
            mobileComposerActions.setDraft(item.text);
            session.retireFailedSubmission(item.requestId);
            const editor = doc.querySelector('[data-composer-input]');
            editor?.focus?.({ preventScroll: false });
          } catch (_error) {
            button.disabled = true;
          }
        }, true);
      };

      const sweep = () => {
        if (disposed) return;
        const now = Date.now();
        for (const row of doc.querySelectorAll('[data-submission-echo]')) {
          if (!seen.has(row)) {
            seen.set(row, now);
            continue;
          }
          if (now - seen.get(row) < 2500) continue;
          enableRow(row);
        }
      };

      const schedule = () => {
        if (disposed || scheduled) return;
        scheduled = true;
        const run = () => { scheduled = false; sweep(); };
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
        else window.setTimeout(run, 50);
      };

      const observer = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
        // Застрявшая строка живёт в доке очереди, а не в любом узле ленты:
        // без этого фильтра каждая отрисовка чата заказывала бы проход.
        for (const record of records) {
          for (const node of record.addedNodes ?? []) {
            if (touchesRoot(node, '[data-queue-dock], [data-submission-echo]')) {
              schedule();
              return;
            }
          }
        }
      }) : null;
      /** Включить наблюдение и опрос, пока вкладка видима. */
      const connectObserver = () => {
        if (disposed || timer !== null) return;
        observer?.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });
        timer = window.setInterval(sweep, 1500);
        schedule();
      };
      /** Выключить наблюдение и опрос, пока вкладка скрыта. */
      const disconnectObserver = () => {
        observer?.disconnect();
        if (timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
      };
      const stopWatchingVisibility = pauseWhenHidden(doc, connectObserver, disconnectObserver);
      connectObserver();
      own(() => {
        disposed = true;
        stopWatchingVisibility();
        disconnectObserver();
        for (const button of enabled) {
          button.removeAttribute('data-dsh-tweaks-pending-edit');
          button.disabled = true;
        }
      });
    }

    function setupMobileComposer(ctx, api) {
      // Редактор очереди живёт вне карточки композера: своя подписка на документ
      // работает и без слота, поэтому ставим её до проверки службы слотов.
      api?.own?.(bindQueueEditorEnter(document, window));
      api?.own?.(bindGoalEditorEnter(document, window));
      api?.own?.(bindTextareaEnterNewline(document, window));
      api?.own?.(installSmallMenuSearchHider(window));
      installStuckQueueRecovery(ctx, api);
      const slots = typeof ctx?.get === 'function' ? ctx.get('slots') : undefined;
      if (typeof slots?.inject !== 'function' || typeof slots?.register !== 'function') return;
      const style = document.createElement('style');
      style.textContent = '[data-mobile-composer] [data-input-scroll]{max-height:var(--dsh-mobile-text-cap)!important;overflow-y:auto!important;overscroll-behavior:contain;min-height:0}[data-mobile-composer]>div:last-child{flex-shrink:0}[data-mobile-composer] [data-composer-input]{-webkit-composition-fill-color:transparent!important;-webkit-composition-frame-color:transparent!important}';
      document.head?.appendChild(style); api.own(() => style.remove());
      const inject = (sessionId) => ({ commandBridge: mobileCommandBridge(ctx, sessionId) });
      api.own(slots.inject('conversation.input.overlay', () => slots.register(
        { name: 'conversation.input.overlay', id: 'mobile-composer-newlines', order: -1000, inject },
        (props) => React.createElement(MobileComposerBinding, props),
      )));
    }

    /* #endregion tweak-mobile-composer */

    /* #region tweak-mobile-sidebar */

    /** Порог приложения `SIDEBAR_AUTO_COLLAPSE`: ниже него сайдбар узкий. */
    const MOBILE_DRAWER_BREAKPOINT = 1024;
    /** Атрибут на `<html>`: включён выдвижной режим левой панели. */
    const MOBILE_DRAWER_ATTR = 'data-dsh-tweaks-mobile-drawer';
    /** Атрибут на `<html>`: ящик уже уезжает, приложение ещё считает его открытым. */
    const MOBILE_DRAWER_LEAVING_ATTR = 'data-dsh-tweaks-drawer-leaving';
    /** Атрибут на `<html>`: открыт всплывающий список глобальных панелей. */
    const MOBILE_PANEL_MENU_ATTR = 'data-dsh-tweaks-panel-menu';
    /** Сколько ждём жеста пользователя, чтобы снять подавление фокуса композера. */
    const MOBILE_FOCUS_SUPPRESS_MS = 5000;
    /** Длительность выезда ящика: как у правой панели (`--ds-transition-duration-slow`). */
    const MOBILE_DRAWER_SLIDE_MS = 300;

    /** Рамка интерфейса, как её находит твик свободных панелей. */
    function mobileDrawerFrame() {
      return document.querySelector('[class*="_frame"]');
    }

    /** Колонка левой панели: без неё режим не включаем, чтобы не прятать панель навсегда. */
    /**
     * Состояние ящика: реальный DOM отдаёт `hasAttribute`, тестовые заглушки —
     * `getAttribute`. Отсутствие атрибута везде значит «открыт».
     * @param {object} frame - рамка.
     * @returns {boolean} свернут ли ящик.
     */
    function mobileDrawerCollapsed(frame) {
      if (frame === null || frame === undefined) return true;
      if (typeof frame.hasAttribute === 'function') return frame.hasAttribute('data-sidebar-collapsed');
      const value = typeof frame.getAttribute === 'function' ? frame.getAttribute('data-sidebar-collapsed') : undefined;
      return value !== null && value !== undefined;
    }

    function mobileDrawerSidebar() {
      return document.querySelector('[class*="_sidebarCol"]');
    }

    /**
     * Разложить `grid-template-columns` приложения на треки верхнего уровня.
     * Пробелы внутри `minmax(...)` не разделяют треки.
     * @param {string} value - значение inline-стиля.
     * @returns {string[]} треки.
     */
    function mobileDrawerTracks(value) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text === '' || text === 'none') return [];
      const tracks = [];
      let depth = 0;
      let start = 0;
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === '(') depth += 1;
        else if (char === ')') depth = Math.max(0, depth - 1);
        else if (/\s/.test(char) && depth === 0) {
          if (index > start) tracks.push(text.slice(start, index));
          start = index + 1;
        }
      }
      if (start < text.length) tracks.push(text.slice(start));
      return tracks.filter((track) => track !== '');
    }

    /**
     * Сетка выдвижного режима: место сайдбара нулевое, центр гибкий,
     * трек правой панели сохраняется, чтобы не сломать её на планшете.
     * @param {string} value - текущая сетка приложения.
     * @returns {string} сетка режима.
     */
    function mobileDrawerGrid(value) {
      const tracks = mobileDrawerTracks(value);
      const rightbar = tracks.length > 2 ? tracks[2] : 'minmax(0px, 0px)';
      return `0px minmax(0px, 1fr) ${rightbar}`;
    }

    /**
     * Куда ведёт клик внутри левой панели.
     * @param {object} target - цель клика.
     * @returns {'close'|'keep'|null} закрыть ящик, оставить или не наше событие.
     */
    function mobileSidebarIntent(target) {
      if (target === null || target === undefined || typeof target.closest !== 'function') return null;
      // «Три точки» и кнопки строки: привычное меню открывается, ящик остаётся.
      if (target.closest('[class*="_rowActions"]') !== null) return 'keep';
      if (target.closest('[data-row-key^="session:"]') !== null) return 'close';
      // Результаты поиска по чатам в той же панели тоже открывают чат.
      if (target.closest('[class*="_searchResultRow"]') !== null) return 'close';
      if (target.closest('[class*="_panelRow"]') !== null) return 'close';
      if (target.closest('[class*="_newSession"]') !== null) return 'close';
      // Плюс на строке workspace: «New session in <проект>».
      const labelled = target.closest('button[aria-label]');
      if (labelled !== null) {
        const label = labelled.getAttribute('aria-label') || '';
        if (/^New session in\b/i.test(label) || /Новая сессия в/i.test(label) || /Новый чат в/i.test(label)) return 'close';
      }
      return null;
    }

    /**
     * Элемент — поле ввода композера (Lexical-редактор)?
     * @param {object} element - узел DOM.
     * @returns {boolean} да или нет.
     */
    function isComposerInput(element) {
      if (element === null || element === undefined) return false;
      if (element?.hasAttribute?.('data-composer-input') === true) return true;
      return typeof element?.closest === 'function' && element.closest('[data-composer-input]') !== null;
    }

    /**
     * Подавление программного фокуса композера после выбора чата в ящике.
     * @param {Function} [now] - часы (для тестов).
     * @returns {object} arm/clear/armed/shouldSwallow.
     */
    function createMobileFocusSuppressor(now = () => Date.now()) {
      let until = 0;
      return {
        arm(ms = MOBILE_FOCUS_SUPPRESS_MS) {
          until = now() + ms;
        },
        clear() {
          until = 0;
        },
        armed() {
          return until !== 0 && now() < until;
        },
        shouldSwallow(element) {
          return this.armed() && isComposerInput(element);
        },
      };
    }

    /**
     * Подменить `focus` на время твика: программный фокус композера глотается,
     * когда взведено подавление. Нативные тапы по полю браузер фокусирует сам,
     * поэтому ввод остаётся доступен.
     * @param {object} view - окно.
     * @param {object} suppressor - подавитель.
     * @returns {Function} возврат оригинала.
     */
    function installMobileFocusPatch(view, suppressor) {
      const proto = view?.HTMLElement?.prototype;
      if (proto === undefined || proto === null || typeof proto.focus !== 'function') return () => {};
      const original = proto.focus;
      function patchedFocus(...args) {
        if (suppressor.shouldSwallow(this)) return undefined;
        return original.apply(this, args);
      }
      proto.focus = patchedFocus;
      return () => {
        if (proto.focus === patchedFocus) proto.focus = original;
      };
    }

    /**
     * CSS режима: ящик за краем, первый трек сетки нулевой, полная ширина чата,
     * объединённая шапка, точки строки и панели из нижней иконки.
     * @param {string} [rightbar] - трек правой панели из сетки приложения.
     * @returns {string} текст правила.
     */
    function mobileDrawerStyleText(rightbar = 'minmax(0px, 0px)') {
      const root = `html[${MOBILE_DRAWER_ATTR}="on"]`;
      const slide = 'var(--ds-transition-duration-slow) var(--ds-ease-in-out)';
      return [
        `${root} [class*="_frame"]{grid-template-columns:${mobileDrawerGrid(`280px minmax(0px, 1fr) ${rightbar}`)}!important}`,
        // Колонка панели вышла из потока: центр и правая панель не должны
        // авто-разместиться в освободившемся первом треке.
        `${root} [class*="_frame"] > [class*="_centerCol"]{grid-column:2;grid-row:1}`,
        `${root} [class*="_frame"] > [data-rightbar-col]{grid-column:3;grid-row:1}`,
        `${root} [class*="_body"]{--dsh-chat-content-width:100%!important;--dsh-composer-side-clearance:4px!important;--dsh-chat-flow-gap:4px!important}`,
        // Чуть компактнее и шире: меньше боковых полей в ленте, шире сообщения,
        // компактнее пузырь. Центральная панель занимает почти всю ширину.
        `${root} [class*="_scroll"]:has(> [class*="_column"]){padding:8px 8px!important}`,
        `${root} [class*="_userStack"]{max-width:96%!important}`,
        `${root} [class*="_stack"]:has(> [class*="_bubble"]){max-width:94%!important}`,
        `${root} [class*="_bubble"]{padding:8px 12px!important}`,
        `${root} [class*="_sidebarCol"]{position:fixed!important;top:var(--dsh-windows-titlebar-height,0px);bottom:0;left:0;width:280px!important;max-width:86vw;` +
          'z-index:19;background:var(--dsw-specific-sidebar-fill);border-right:0.5px solid var(--dsw-alias-border-l3);' +
          'box-shadow:var(--dsw-elevation-prominent);transform:translateX(-102%);visibility:hidden;' +
          `transition:transform ${slide},visibility 0s linear var(--ds-transition-duration-slow);will-change:transform}`,
        `${root} [class*="_frame"]:not([data-sidebar-collapsed]) [class*="_sidebarCol"]{` +
          `transform:translateX(0);visibility:visible;transition:transform ${slide}}`,
        `${root}[${MOBILE_DRAWER_LEAVING_ATTR}="leaving"] [class*="_sidebarCol"]{transform:translateX(-102%)!important;visibility:visible!important;transition:transform ${slide}!important}`,
        `${root} [class*="_sidebarCol"] [data-slot] > *{width:100%!important}`,
        `${root} [data-side="sidebar"]{display:none!important}`,
        `${root} [class*="_sessionRow"] [class*="_rowActions"],${root} [class*="_searchResultRow"] [class*="_rowActions"]{display:inline-flex!important}`,
        `${root} [class*="_sessionRow"] [class*="_time"],${root} [class*="_sessionRow"] [class*="_pinIndicator"]{display:none!important}`,
        // В строке чата оставляем только «три точки» и прижимаем их к правому
        // краю: вложенная кнопка (корзина/архив) уже есть в меню.
        `${root} [class*="_sessionRow"] [class*="_rowActions"]{gap:0!important;margin-left:auto!important;padding-left:2px;padding-right:0}`,
        `${root} [class*="_sessionRow"] [class*="_rowActions"] > *:not(:first-child){display:none!important}`,
        // Вложенные чаты чуть левее: глубина остаётся, но общий сдвиг меньше на 4px.
        `${root} [class*="_sessionRow"]{padding-inline-start:calc(8px + var(--dsh-workspace-indent,0px) - 4px)!important;padding-inline-end:4px!important}`,

        // Шапка: крошки приложения скрыты, название рисует наша часть слота.
        `${root} [class*="_titleCluster"] [class*="_crumbs"]{display:none!important}`,
        `${root} .dsh-tweaks-header-title{max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
          'color:var(--dsw-alias-label-primary);font-weight:500;font-size:14px;line-height:20px}',
        // Второстепенные действия и утилиты уходят в верхнее «…»; их кнопки
        // остаются невидимыми анкорами у правого верхнего края.
        `${root} [data-slot="conversation.session.header.actions"] > *{position:fixed;top:44px;right:8px;width:0;height:0;opacity:0;` +
          'pointer-events:none;overflow:visible;z-index:-1}',
        `${root} [data-slot="conversation.session.header.utilities"] > *{position:fixed;top:44px;right:8px;width:0;height:0;opacity:0;` +
          'pointer-events:none;overflow:visible;z-index:-1}',
        `${root} [data-slot="conversation.session.header.utilities"] > *:has([class*="_moreButton"]){position:static;width:auto;height:auto;opacity:1;pointer-events:auto;overflow:visible;z-index:auto}`,
        `${root} [class*="_viewsMoreAnchor"]{position:fixed;top:44px;right:8px;width:0;height:0;opacity:0;pointer-events:none;overflow:visible;z-index:-1}`,
        `${root} [class*="_viewsMoreMenu"]{display:none!important}`,
        '[data-dsh-mobile-sidebar-toggle]{display:none}',
        `${root} [data-dsh-mobile-sidebar-toggle]{display:inline-flex;align-items:center;justify-content:center;` +
          'width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;' +
          'color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
        `${root} [data-dsh-mobile-sidebar-toggle]:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
        `${root} [data-dsh-mobile-sidebar-toggle] svg{width:15px;height:15px;display:block}`,
        // Панели: список скрыт, открывается поповером из нижней иконки.
        // Вкладки правой панели: выбор не должен плавно прокручивать полосу
        // (выглядело как анимация «не в ту сторону»).
        `${root} [data-dockkit-strip-tabs]{scroll-behavior:auto!important}`,
        // Вопросник (ask_user_question): на всю ширину и одним скроллом.
        // Заголовок-вопрос больше не отнимает экран отдельно от вариантов:
        // скроллится вся карточка, футер с Skip/Next закреплён снизу.
        `${root} [data-question-key]{padding:6px 0 10px!important;justify-content:stretch!important}`,
        `${root} [data-question-key] > section{width:100%!important;max-width:100%!important;border-radius:0!important;max-height:min(72vh,600px)!important;overflow-y:auto!important;overscroll-behavior:contain}`,
        `${root} [data-question-key] > section > [data-question-scroll]{overflow:visible!important;flex:0 0 auto!important;min-height:0}`,
        `${root} [data-question-key] > section > footer{position:sticky!important;bottom:0!important;z-index:2;background:var(--dsw-specific-input-major);box-shadow:0 -1px 0 var(--dsw-alias-border-l2)}`,
        // Редактор goal: на всю ширину, кнопки справа вертикально
        // (крестик сверху, галочка снизу), textarea заметно выше.
        `${root} [data-goal-bar]{width:100vw!important;max-width:100vw!important;margin-left:calc(50% - 50vw)!important;margin-right:calc(50% - 50vw)!important;padding:0!important}`,
        `${root} [data-goal-bar] > div{width:100%!important;max-width:100%!important;border-radius:0!important}`,
        `${root} [data-goal-bar] > div:has(textarea){align-items:stretch!important;height:auto!important;min-height:0!important;padding:6px 6px 6px 10px!important;gap:6px!important}`,
        `${root} [data-goal-bar] > div:has(textarea) > div:last-child{flex-direction:column-reverse!important;align-items:center!important;gap:6px!important;padding:2px 0!important}`,
        `${root} [data-goal-bar] textarea{width:100%!important;min-height:120px!important;max-height:36vh!important;resize:none!important}`,

        `${root} [data-dockkit-split-button],${root} [data-sidebar-right-mode]{display:none!important}`,
        `${root} [data-dsh-tweaks-tab-hold]{opacity:.72;transform:scale(.97);transition:transform 120ms ease-out,opacity 120ms ease-out}`,
        `${root} [class*="_panelList"]{display:none!important}`,
        `${root} [class*="_panelList"] button[aria-label="More"]{display:none!important}`,
        '[data-dsh-tweaks-account-inline]{display:flex;flex-direction:column;gap:2px;padding-top:4px;margin-top:2px;border-top:.5px solid var(--dsw-alias-border-l2)}',
        '[data-dsh-tweaks-account-inline] button{box-sizing:border-box;width:100%;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);text-align:left;font:inherit;font-size:13px;line-height:18px;padding:8px;cursor:pointer}',
        '[data-dsh-tweaks-account-inline] button:hover,[data-dsh-tweaks-account-inline] button:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
        `${root}[${MOBILE_PANEL_MENU_ATTR}="open"] [class*="_panelList"]{display:flex!important;position:absolute;left:8px;right:8px;` +
          'bottom:calc(var(--dsh-tweaks-footer-height,64px) + 8px);flex-direction:column;gap:2px;padding:6px;z-index:40;' +
          'max-height:calc(100% - var(--dsh-tweaks-footer-height,64px) - 16px);overflow:auto;border-radius:var(--dsw-radius-lg);' +
          'background:Canvas!important;backdrop-filter:none!important;box-shadow:var(--dsw-elevation-prominent)}',
        `${root} [class*="_footArea"]{flex-direction:row;align-items:center;gap:4px}`,
        `${root} [class*="_settingsArea"]{flex:1;min-width:0}`,
        `${root} [class*="_footerActions"]{flex:none;order:1;width:auto}`,
        '[data-dsh-tweaks-panel-toggle]{display:none}',
        `${root} [data-dsh-tweaks-panel-toggle]{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;` +
          'padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
        `${root} [data-dsh-tweaks-panel-toggle]:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
        `${root} [data-dsh-tweaks-panel-toggle] svg{width:16px;height:16px;display:block}`,
        // Единственный вход в меню — строка «Signed in …»; отдельный кружок
        // с тремя точками больше не нужен.
        `${root} [data-dsh-tweaks-panel-toggle]{display:none!important}`,
        `@media (prefers-reduced-motion:reduce){${root} [class*="_sidebarCol"]{transition:none!important}}`,
      ].join('\n');
    }

    /** Иконка «панель слева» для кнопки в шапке: та же, что у правой панели, в 15 px. */
    function MobileSidebarIcon() {
      const Icon = primitives?.IconPanelLeftOutlineRegular;
      if (typeof Icon === 'function') return React.createElement(Icon, { size: 15 });
      return React.createElement(
        'svg',
        { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        React.createElement('rect', { x: 2, y: 3, width: 12, height: 10, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        React.createElement('path', { d: 'M6 3.4v9.2', stroke: 'currentColor', strokeWidth: 1.2 }),
      );
    }

    /** Иконка нижней кнопки панелей. */
    function MobilePanelMenuIcon() {
      const Icon = primitives?.IconEllipsisOutlineRegular;
      if (typeof Icon === 'function') return React.createElement(Icon, { size: 16 });
      return React.createElement(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        ...[3, 8, 13].map((cx) => React.createElement('circle', { key: cx, cx, cy: 8, r: 1.1, fill: 'currentColor' })),
      );
    }

    /**
     * Кнопка «открыть меню» в шапке чата. Как и кнопка правой панели, видна
     * только пока панель закрыта.
     * @param {object} props - слот-пропсы и host с подписью и действием.
     * @returns {object} кнопка.
     */
    function MobileSidebarToggle({ host }) {
      const label = typeof host?.label === 'function' ? host.label() : 'Меню';
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-tweaks-mobile-sidebar-toggle',
          'data-dsh-mobile-sidebar-toggle': '',
          title: label,
          'aria-label': label,
          onClick: (event) => {
            event.preventDefault();
            host?.open?.();
          },
        },
        React.createElement(MobileSidebarIcon, null),
      );
    }

    /**
     * Нижняя кнопка глобальных панелей рядом с «Signed in…».
     * @param {object} props - слот-пропсы и host с состоянием и переключением.
     * @returns {object} кнопка.
     */
    function MobilePanelMenuToggle({ host }) {
      const [open, setOpen] = React.useState(host.isOpen());
      React.useEffect(() => host.subscribe(setOpen), [host]);
      const label = host.label();
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-tweaks-panel-toggle',
          'data-dsh-tweaks-panel-toggle': '',
          title: label,
          'aria-label': label,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            host.toggle();
          },
        },
        React.createElement(MobilePanelMenuIcon, null),
      );
    }

    /**
     * Включить твик: выдвижная левая панель, объединённая шапка и панели внизу.
     *
     * Панель не перерисовывается и не дублируется: приложению отдаётся его же
     * состояние (`layout.toggleSidebar`), а CSS переносит колонку за край и
     * обнуляет её трек в сетке. Сетку приложения читаем из inline-стиля, поэтому
     * трек правой панели сохраняется, а `freePanels` не конфликтует: свои
     * значения пишем правилом `!important`, а не в тот же inline.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {object} api - регистратор очисток твика.
     * @returns {void}
     */
    function setupMobileSidebar(ctx, api) {
      const own = typeof api?.own === 'function' ? api.own : () => {};
      // Старое ядро (0.2.2) умеет нативный drawer. Не накладываем на него
      // собственные fixed-правила и анимацию: это ломало сетку и оставляло
      // подложку. Независимые части (вкладки, overlay-рамка, шапка-меню)
      // продолжают работать.
      if (nativeSidebarDrawer()) {
        own(setupMobileRightTabs(ctx, api));
        own(setupTabActions());
        own(setupMobileOverlays());
        return;
      }
      let locale = undefined;
      try {
        locale = typeof ctx?.get === 'function' ? ctx.get('locale') : undefined;
      } catch (_error) {
        locale = undefined;
      }
      const translate = createTranslator(locale);
      const html = document.documentElement;
      const suppressor = createMobileFocusSuppressor();

      const style = document.createElement('style');
      style.dataset.dshMobileSidebar = 'rules';
      style.textContent = mobileDrawerStyleText();
      document.head?.appendChild(style);
      own(() => style.remove());

      own(installMobileFocusPatch(typeof window === 'undefined' ? undefined : window, suppressor));
      own(setupMobileRightTabs(ctx, api));
      own(setupTabActions());
      own(setupMobileOverlays());

      let disposed = false;
      let leaving = false;
      let leavingTimer = null;
      let panelOpen = false;
      let mergingAccount = false;
      let accountTrigger = null;
      let accountRoot = null;
      let accountInline = null;
      const panelListeners = new Set();

      /** Открыть/закрыть панель штатным действием приложения. */
      function toggleSidebar() {
        try {
          ctx?.get?.('layout')?.toggleSidebar?.();
        } catch (_error) {
          /* служба раскладки ещё не поднялась: кнопка просто ничего не делает */
        }
      }

      /** Вернуть пункты аккаунта на место и убрать встроенный блок. */
      function restoreAccountInline() {
        if (accountInline === null) return;
        const buttons = [...accountInline.querySelectorAll('button')];
        for (const button of buttons) {
          if (accountRoot?.isConnected) accountRoot.appendChild(button);
          else button.remove();
        }
        accountInline.remove();
        accountInline = null;
        if (accountRoot?.isConnected) accountRoot.style.display = 'none';
        accountRoot = null;
        if (accountTrigger?.getAttribute?.('aria-expanded') === 'true') {
          mergingAccount = true;
          accountTrigger.click();
          mergingAccount = false;
        }
        accountTrigger = null;
      }

      /** Закрыть всплывающий список панелей. */
      function closePanelMenu() {
        if (!panelOpen) return;
        panelOpen = false;
        html?.removeAttribute(MOBILE_PANEL_MENU_ATTR);
        restoreAccountInline();
        for (const listener of panelListeners) listener(false);
      }

      /** Открыть/закрыть список панелей. */
      function togglePanelMenu() {
        if (panelOpen) {
          closePanelMenu();
          return;
        }
        const foot = document.querySelector('[class*="_footArea"]');
        const height = foot === null ? 64 : Math.max(48, Math.round(foot.offsetHeight));
        html?.style.setProperty('--dsh-tweaks-footer-height', `${height}px`);
        panelOpen = true;
        html?.setAttribute(MOBILE_PANEL_MENU_ATTR, 'open');
        for (const listener of panelListeners) listener(true);

        // Одно меню More: подтягиваем пункты аккаунта (Settings/Feedback/…)
        // внутрь списка панелей, а вложенный пункт More скрыт CSS-ом.
        accountTrigger = document.querySelector('button[aria-label="Account menu"]');
        if (accountTrigger !== null) {
          mergingAccount = true;
          accountTrigger.click();
          mergingAccount = false;
          let attempts = 0;
          const merge = () => {
            if (!panelOpen || disposed) return;
            const list = document.querySelector('[class*="_panelList"]');
            if (list === null) return;
            const menu = [...document.querySelectorAll('[role="menu"]')]
              .find((node) => node.closest('[class*="_panelList"]') === null && /Settings|Feedback|Sign/i.test(node.innerText ?? ''));
            if (menu === undefined) {
              if (attempts < 30) {
                attempts += 1;
                window.requestAnimationFrame(merge);
              }
              return;
            }
            accountRoot = menu;
            menu.style.display = 'none';
            accountInline = document.createElement('div');
            accountInline.setAttribute('data-dsh-tweaks-account-inline', '');
            for (const button of [...menu.querySelectorAll('button')]) accountInline.appendChild(button);
            list.appendChild(accountInline);
          };
          window.requestAnimationFrame(merge);
        }
      }

      /**
       * Анимированное закрытие: сначала ящик уезжает при открытом состоянии
       * приложения, затем вызывается настоящий toggle — содержимое меняется за экраном.
       * @param {Function} finish - настоящий toggle.
       * @returns {void}
       */
      function closeAnimated(finish) {
        if (leaving || disposed) return;
        const frame = mobileDrawerFrame();
        // Приложение уже свернуло панель (например, навигация по чату):
        // не запускаем обратный toggle и не мигаем ящиком.
        if (frame === null || mobileDrawerCollapsed(frame)) {
          closePanelMenu();
          return;
        }
        const reduced = typeof window?.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
        closePanelMenu();
        if (reduced || typeof finish !== 'function') {
          finish?.();
          return;
        }
        leaving = true;
        html?.setAttribute(MOBILE_DRAWER_LEAVING_ATTR, 'leaving');
        leavingTimer = window.setTimeout(() => {
          leavingTimer = null;
          leaving = false;
          html?.removeAttribute(MOBILE_DRAWER_LEAVING_ATTR);
          // За 300 мс панель могла свернуться сама: повторный toggle открыл бы её.
          const current = mobileDrawerFrame();
          if (current !== null && !mobileDrawerCollapsed(current)) finish();
        }, MOBILE_DRAWER_SLIDE_MS);
      }

      // Настоящий toggle раскладки; при открытом ящике в узком режиме его
      // вызов превращается в анимированное закрытие (наша кнопка, кнопка
      // панели и shortcut используют один и тот же сервис).
      let layoutService = null;
      let originalToggle = null;
      try {
        layoutService = typeof ctx?.get === 'function' ? ctx.get('layout') : null;
        if (layoutService !== null && typeof layoutService.toggleSidebar === 'function') {
          originalToggle = layoutService.toggleSidebar.bind(layoutService);
          const patched = () => {
            if (disposed) {
              originalToggle();
              return;
            }
            const frame = mobileDrawerFrame();
            if (frame !== null && narrow(frame)) {
              // Пока ящик уезжает, запоздавший toggle не должен разворачивать его обратно.
              if (leaving) return;
              if (!mobileDrawerCollapsed(frame)) {
                closeAnimated(originalToggle);
                return;
              }
            }
            originalToggle();
          };
          layoutService.toggleSidebar = patched;
          own(() => {
            if (layoutService.toggleSidebar === patched) layoutService.toggleSidebar = originalToggle;
          });
        }
      } catch (_error) {
        /* сервис только для чтения: обойдёмся прямыми вызовами */
      }

      /** Ширина рамки в логических пикселях: её уже правит твик масштаба. */
      function narrow(frame) {
        const width = typeof frame?.getBoundingClientRect === 'function' ? frame.getBoundingClientRect().width : 0;
        if (Number.isFinite(width) && width > 0) return width < MOBILE_DRAWER_BREAKPOINT;
        return Number(window?.innerWidth) > 0 && window.innerWidth < MOBILE_DRAWER_BREAKPOINT;
      }

      let observer = null;
      let observedFrame = null;
      let retryTimer = null;
      let retryCount = 0;
      let rightbarTrack = 'minmax(0px, 0px)';
      let lastStyle = style.textContent;

      /** Перерисовать правило, только если трек правой панели правда изменился. */
      function writeStyle() {
        const next = mobileDrawerStyleText(rightbarTrack);
        if (next === lastStyle) return;
        lastStyle = next;
        style.textContent = next;
      }

      /** Снять observer с прежней рамки. */
      function detachObserver() {
        if (observer !== null) {
          observer.disconnect();
          observer = null;
        }
        observedFrame = null;
      }

      /** Следить за сеткой и состоянием ящика. */
      function attachObserver(frame) {
        if (frame === null || frame === undefined || typeof MutationObserver === 'undefined') return;
        if (observer !== null && observedFrame === frame) return;
        detachObserver();
        observer = new MutationObserver(() => sync());
        observer.observe(frame, { attributes: true, attributeFilter: ['style', 'data-sidebar-collapsed'] });
        observedFrame = frame;
      }

      /** Привести режим и правило к текущей раскладке. */
      function sync() {
        if (disposed) return;
        const frame = mobileDrawerFrame();
        const sidebar = mobileDrawerSidebar();
        const active = frame !== null && sidebar !== null && narrow(frame);
        if (active) html?.setAttribute(MOBILE_DRAWER_ATTR, 'on');
        else html?.removeAttribute(MOBILE_DRAWER_ATTR);
        if (frame !== null && leaving && mobileDrawerCollapsed(frame)) {
          if (leavingTimer !== null) window.clearTimeout(leavingTimer);
          leavingTimer = null;
          leaving = false;
          html?.removeAttribute(MOBILE_DRAWER_LEAVING_ATTR);
        }
        if (frame !== null) {
          const tracks = mobileDrawerTracks(frame.style.gridTemplateColumns);
          const third = tracks.length > 2 ? tracks[2] : 'minmax(0px, 0px)';
          if (third !== rightbarTrack) {
            rightbarTrack = third;
            writeStyle();
          }
          if (mobileDrawerCollapsed(frame)) closePanelMenu();
          if (active) attachObserver(frame);
          else {
            detachObserver();
            closePanelMenu();
          }
        } else {
          detachObserver();
          closePanelMenu();
        }
      }

      const onResize = () => sync();

      /**
       * Тап мимо открытого ящика закрывает его. Портальные меню и сам ящик
       * не считаются «мимо»; событие не отменяется, тап доходит до цели.
       * @param {object} event - pointerdown.
       * @returns {void}
       */
      /**
       * Цель тапа находится вне открытого ящика и вне портальных меню?
       * @param {object} target - цель события.
       * @returns {boolean} да или нет.
       */
      const outsideDrawer = (target) => {
        if (typeof target?.closest !== 'function') return false;
        if (target.closest('[class*="_sidebarCol"]') !== null) return false;
        if (target.closest('[role="menu"], [role="listbox"], [data-trigger-menu]') !== null) return false;
        return true;
      };

      /**
       * Тап по видимой центральной части закрывает ящик.
       * @param {object} event - pointerdown.
       * @returns {void}
       */
      const onPointerDown = (event) => {
        if (suppressor.armed()) suppressor.clear();
        if (disposed || leaving) return;
        const frame = mobileDrawerFrame();
        if (frame === null || !narrow(frame) || mobileDrawerCollapsed(frame)) return;
        if (!outsideDrawer(event.target)) return;
        closeAnimated(originalToggle ?? toggleSidebar);
      };

      /**
       * Страховка для тапов, где pointerdown не дошёл (сложный target/оверлей):
       * отпускание пальца вне ящика закрывает его тем же путём.
       * @param {object} event - pointerup.
       * @returns {void}
       */
      const onPointerUp = (event) => {
        if (disposed || leaving) return;
        const frame = mobileDrawerFrame();
        if (frame === null || !narrow(frame) || mobileDrawerCollapsed(frame)) return;
        if (!outsideDrawer(event.target)) return;
        closeAnimated(originalToggle ?? toggleSidebar);
      };

      /** Клик по аккаунту открывает единое меню More, а не отдельное. */
      const onAccountTriggerClick = (event) => {
        if (mergingAccount) return;
        const trigger = event.target?.closest?.('button[aria-label="Account menu"]');
        if (trigger === null || trigger === undefined) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (panelOpen) closePanelMenu();
        else togglePanelMenu();
      };
      document.addEventListener('click', onAccountTriggerClick, true);
      own(() => document.removeEventListener('click', onAccountTriggerClick, true));

      /** Пункт аккаунта внутри общего меню закрывает меню после действия. */
      const onAccountInlineClick = (event) => {
        if (event.target?.closest?.('[data-dsh-tweaks-account-inline]') === null) return;
        window.setTimeout(() => closePanelMenu(), 0);
      };
      document.addEventListener('click', onAccountInlineClick, true);
      own(() => document.removeEventListener('click', onAccountInlineClick, true));

      /**
       * Клик в левой панели и по всплывающему списку панелей.
       * @param {object} event - click.
       * @returns {void}
       */
      const onClick = (event) => {
        if (disposed || mergingAccount) return;
        const target = event.target;
        if (panelOpen && target?.closest?.('[class*="_panelList"]') === null
          && target?.closest?.('[role="menu"], [role="listbox"]') === null
          && target?.closest?.('[data-dsh-tweaks-panel-toggle]') === null) {
          closePanelMenu();
        }
        const frame = mobileDrawerFrame();
        if (frame === null || leaving || !narrow(frame) || mobileDrawerCollapsed(frame)) return;
        const intent = mobileSidebarIntent(target);
        if (intent === null || intent === 'keep') return;
        // Композер мог остаться в фокусе с прошлого чата: клавиатуру закрываем сразу.
        const active = document.activeElement;
        if (isComposerInput(active)) active.blur?.();
        suppressor.arm();
        closePanelMenu();
        closeAnimated(originalToggle ?? toggleSidebar);
      };

      /** Escape закрывает список панелей, не трогая ящик. */
      const onKeyDown = (event) => {
        if (panelOpen && event.key === 'Escape') closePanelMenu();
      };

      /** Искать рамку, если плагин поднялся раньше приложения. */
      const tryStart = () => {
        if (disposed) return;
        sync();
        if (mobileDrawerFrame() === null && retryCount < 40) {
          retryCount += 1;
          retryTimer = window.setTimeout(tryStart, 100);
        }
      };

      window.addEventListener?.('resize', onResize);
      window.visualViewport?.addEventListener?.('resize', onResize);
      document.addEventListener?.('pointerdown', onPointerDown, true);
      document.addEventListener?.('pointerup', onPointerUp, true);
      document.addEventListener?.('click', onClick, true);
      document.addEventListener?.('keydown', onKeyDown, true);
      own(() => {
        document.removeEventListener?.('pointerdown', onPointerDown, true);
        document.removeEventListener?.('pointerup', onPointerUp, true);
        document.removeEventListener?.('click', onClick, true);
        document.removeEventListener?.('keydown', onKeyDown, true);
        window.removeEventListener?.('resize', onResize);
        window.visualViewport?.removeEventListener?.('resize', onResize);
      });
      own(() => {
        // Выключение твика возвращает штатную раскладку.
        if (disposed) return;
        disposed = true;
        if (retryTimer !== null) window.clearTimeout(retryTimer);
        retryTimer = null;
        if (leavingTimer !== null) window.clearTimeout(leavingTimer);
        leavingTimer = null;
        leaving = false;
        detachObserver();
        suppressor.clear();
        closePanelMenu();
        html?.removeAttribute(MOBILE_DRAWER_ATTR);
        html?.removeAttribute(MOBILE_DRAWER_LEAVING_ATTR);
        html?.style.removeProperty('--dsh-tweaks-footer-height');
        const frame = mobileDrawerFrame();
        if (frame !== null && narrow(frame) && !mobileDrawerCollapsed(frame)) {
          (originalToggle ?? toggleSidebar)();
        }
      });

      let slots = undefined;
      try {
        slots = typeof ctx?.get === 'function' ? ctx.get('slots') : undefined;
      } catch (_error) {
        slots = undefined;
      }
      if (typeof slots?.inject === 'function' && typeof slots?.register === 'function') {
        const menuHost = {
          label: () => translate('mobileSidebar.open'),
          open: toggleSidebar,
        };
        // Меню и название — в общий leading-слот: меню первым, затем лампа,
        // затем название чата.
        headerLeadingSeat.set(ctx, 'mobileMenu', 0, (props) => React.createElement(MobileSidebarToggle, { ...props, host: menuHost }));
        own(() => headerLeadingSeat.clear('mobileMenu'));
        headerLeadingSeat.set(ctx, 'title', 2, (props) => React.createElement(MobileHeaderTitle, props));
        own(() => headerLeadingSeat.clear('title'));

        const panelHost = {
          label: () => translate('mobilePanels.open'),
          isOpen: () => panelOpen,
          toggle: togglePanelMenu,
          subscribe: (listener) => {
            panelListeners.add(listener);
            return () => panelListeners.delete(listener);
          },
        };
        own(slots.inject('sidebar.footer.action', () => slots.register(
          { name: 'sidebar.footer.action', id: 'mobile-panel-menu', order: -10 },
          (props) => React.createElement(MobilePanelMenuToggle, { ...props, host: panelHost }),
        )));
      }

      own(installHeaderOverflow(translate));
      tryStart();
    }

    /**
     * Верхнее «…» становится единственным меню шапки: в него добавляются
     * «Copy session ID» и прокси к скрытым действиям/утилитам/меню видов.
     * @param {Function} translate - словарь твика.
     * @returns {void}
     */
    function installHeaderOverflow(translate) {
      if (typeof MutationObserver === 'undefined') return;
      const moreOf = () => document.querySelector('[data-slot="conversation.session.header.utilities"] [class*="_moreButton"]')
        ?? document.querySelector('[data-dsh-tweaks-more-slot] [class*="_moreButton"]');
      let scheduled = false;
      let probeViews = 0;
      let revealTimer = 0;

      // Короткая мягкая анимация появления. Меню показывается один раз, уже
      // собранным: раньше пункты досыпались в открытое меню и оно дёргалось.
      const style = document.createElement('style');
      style.dataset.dshHeaderMenuMotion = '';
      style.textContent = [
        '@keyframes dsh-tweaks-menu-drop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}',
        '[data-dsh-tweaks-header-menu][data-dsh-tweaks-menu-ready]{animation:dsh-tweaks-menu-drop 130ms cubic-bezier(.2,.8,.2,1);transform-origin:top center;will-change:transform,opacity}',
        '@media (prefers-reduced-motion:reduce){[data-dsh-tweaks-header-menu][data-dsh-tweaks-menu-ready]{animation:none}}',
      ].join('');
      document.head?.appendChild(style);

      /** Снять таймер аварийного показа. */
      function clearRevealTimer() {
        if (revealTimer !== 0) {
          window.clearTimeout(revealTimer);
          revealTimer = 0;
        }
      }

      /** Спрятать меню до окончания сборки пунктов. */
      function beginBuild(menu) {
        if (menu === null) return;
        if (menu.dataset.dshTweaksMenuReady === '1' || menu.dataset.dshTweaksMenuBuilding === '1') return;
        menu.dataset.dshTweaksMenuBuilding = '1';
        menu.style.visibility = 'hidden';
        menu.style.opacity = '0';
        menu.style.pointerEvents = 'none';
      }

      /** Показать собранное меню с одной короткой анимацией сверху вниз. */
      function finishBuild(menu, trigger) {
        if (menu === null || menu.dataset.dshTweaksMenuReady === '1') return;
        clearRevealTimer();
        clampHeaderMenu(menu, trigger);
        delete menu.dataset.dshTweaksMenuBuilding;
        menu.style.visibility = '';
        menu.style.opacity = '';
        menu.style.pointerEvents = '';
        menu.setAttribute('data-dsh-tweaks-header-menu', '');
        // Перезапуск анимации на повторном открытии: узел мог быть тем же.
        menu.removeAttribute('data-dsh-tweaks-menu-ready');
        void menu.offsetWidth;
        menu.setAttribute('data-dsh-tweaks-menu-ready', '');
        menu.dataset.dshTweaksMenuReady = '1';
        const done = () => menu.removeAttribute('data-dsh-tweaks-menu-ready');
        menu.addEventListener?.('animationend', done, { once: true });
        window.setTimeout(done, 220);
      }

      /**
       * Сбросить состояние открытия при закрытии меню, чтобы следующее
       * открытие снова пришло с анимацией и не осталось скрытым.
       * @returns {void}
       */
      function resetMenus() {
        clearRevealTimer();
        probeViews = 0;
        for (const menu of document.querySelectorAll('[data-dsh-tweaks-header-menu], [data-dsh-tweaks-menu-building]')) {
          delete menu.dataset.dshTweaksMenuReady;
          delete menu.dataset.dshTweaksMenuBuilding;
          menu.removeAttribute('data-dsh-tweaks-menu-ready');
          menu.style.visibility = '';
          menu.style.opacity = '';
          menu.style.pointerEvents = '';
        }
      }

      /** Скопировать id текущей сессии. */
      function copySessionId() {
        const id = document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session');
        if (typeof id !== 'string' || id === '') return;
        try {
          const write = primitives?.writeClipboard;
          if (typeof write === 'function') write(id);
          else navigator.clipboard?.writeText(id);
        } catch (_error) {
          /* буфер недоступен: пункт всё равно виден */
        }
      }

      /**
       * Пункт меню на основе штатной разметки.
       * @param {object} template - штатный menuitem.
       * @param {string} label - подпись.
       * @param {Function} run - действие.
       * @returns {object} кнопка.
       */
      function makeItem(template, label, run) {
        const node = template.cloneNode(true);
        node.setAttribute('data-dsh-tweaks-overflow-item', '');
        for (const span of [...node.querySelectorAll('span')]) {
          if (span.querySelector('svg') !== null) span.remove();
        }
        const text = [...node.querySelectorAll('span')].find((span) => span.textContent !== '');
        if (text !== undefined) text.textContent = label;
        else node.textContent = label;
        node.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          moreOf()?.click();
          window.setTimeout(run, 0);
        });
        return node;
      }

      /**
       * Удержать меню верхнего «…» на экране: на телефоне примитив иногда
       * ставит его ниже viewport (top ≈ innerHeight + gap). Позиционируем
       * fixed по кнопке и прижимаем к видимой области над клавиатурой.
       * @param {object} menu - меню.
       * @param {object} trigger - кнопка «…».
       * @returns {void}
       */
      function clampHeaderMenu(menu, trigger) {
        if (menu === null || trigger === null) return;
        const viewport = typeof window.visualViewport === 'object' && window.visualViewport !== null ? window.visualViewport : null;
        const height = viewport?.height ?? window.innerHeight;
        const top = viewport?.offsetTop ?? 0;
        const width = viewport?.width ?? window.innerWidth;
        const rect = menu.getBoundingClientRect();
        const button = trigger.getBoundingClientRect();
        let y = button.bottom + 4;
        if (y + rect.height > top + height - 8) y = button.top - rect.height - 4;
        if (y < top + 8) y = top + 8;
        const left = Math.min(Math.max(8, button.left), Math.max(8, width - rect.width - 8));
        menu.style.position = 'fixed';
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(y)}px`;
        menu.style.maxHeight = `${Math.max(120, Math.round(height - 16))}px`;
        menu.style.overflowY = 'auto';
        menu.dataset.dshTweaksClamped = '';
      }

      /** Добавить пункты в открытое меню верхнего «…». */
      function inject() {
        if (document.documentElement?.getAttribute?.(MOBILE_DRAWER_ATTR) !== 'on') return;
        const trigger = moreOf();
        if (trigger === null) return;
        if (trigger.getAttribute('aria-expanded') !== 'true') { resetMenus(); return; }
        const menu = [...document.querySelectorAll('[role="menu"]')].find((node) => {
          if (node.querySelector('[class*="viewsMoreMenu"]') !== null) return false;
          return node.querySelector('button[role="menuitem"]') !== null;
        });
        if (menu === undefined) return;
        // Меню уже показано: после появления больше не меняем его состав.
        if (menu.dataset.dshTweaksMenuReady === '1') return;
        beginBuild(menu);
        const template = menu.querySelector('button[role="menuitem"]');
        if (template === null) return;
        const host = menu.querySelector('[role="presentation"]') ?? menu;
        let complete = true;
        const seen = new Set(['More actions', translate('session.copyId')]);
        for (const node of menu.querySelectorAll('[data-dsh-tweaks-overflow-item]')) seen.add(node.textContent.trim());
        if (menu.getAttribute('data-dsh-tweaks-overflow-base') === null) {
          menu.setAttribute('data-dsh-tweaks-overflow-base', '');
          const separator = document.createElement('div');
          separator.setAttribute('role', 'separator');
          separator.setAttribute('data-dsh-tweaks-overflow-item', '');
          separator.style.cssText = 'height:.5px;margin:4px 8px;background:var(--dsw-alias-border-l2)';
          host.appendChild(separator);
          host.appendChild(makeItem(template, translate('session.copyId'), copySessionId));
        }
        // Пункты меню видов (Browse other plugins / Create your plugin)
        // переносим отдельными строками: открываем скрытое меню, читаем
        // подписи и закрываем. Само меню в мобильном режиме скрыто CSS-ом.
        const viewsTrigger = document.querySelector('button[class*="_viewsMore"]');
        if (viewsTrigger !== null && menu.getAttribute('data-dsh-tweaks-views-done') === null) {
          const viewsMenu = document.querySelector('[class*="_viewsMoreMenu"]');
          if (viewsMenu !== null) {
            menu.setAttribute('data-dsh-tweaks-views-done', '');
            for (const item of viewsMenu.querySelectorAll('button[role="menuitem"]')) {
              const label = item.textContent.trim();
              if (label === '' || seen.has(label)) continue;
              seen.add(label);
              host.appendChild(makeItem(template, label, () => {
                viewsTrigger.click();
                window.setTimeout(() => {
                  const next = document.querySelector('[class*="_viewsMoreMenu"]');
                  [...(next?.querySelectorAll('button[role="menuitem"]') ?? [])]
                    .find((button) => button.textContent.trim() === label)?.click();
                }, 0);
              }));
            }
            viewsTrigger.click();
          } else if (probeViews < 2) {
            probeViews += 1;
            complete = false;
            viewsTrigger.click();
            window.setTimeout(inject, 30);
          } else {
            // Виды не появились за два коротких прохода: показываем без них,
            // чтобы не держать меню скрытым дольше ~100 мс.
            menu.setAttribute('data-dsh-tweaks-views-done', '');
          }
        }
        const originals = [
          ...document.querySelectorAll('[data-slot="conversation.session.header.actions"] button'),
          ...document.querySelectorAll('[data-slot="conversation.session.header.utilities"] > *:not(:has([class*="_moreButton"])) button'),
        ];
        for (const original of originals) {
          const label = (original.getAttribute('aria-label') || original.getAttribute('title') || original.textContent || '').trim();
          if (label === '' || seen.has(label) || label.length > 48) continue;
          if (original.getAttribute('data-dsh-mobile-sidebar-toggle') !== null) continue;
          seen.add(label);
          host.appendChild(makeItem(template, label, () => original.click()));
        }
        if (complete) {
          finishBuild(menu, trigger);
          return;
        }
        // Страховка: даже если пункты видов не пришли, показываем меню быстро,
        // уже в финальной позиции, без последующего роста высоты.
        clampHeaderMenu(menu, trigger);
        clearRevealTimer();
        revealTimer = window.setTimeout(() => {
          revealTimer = 0;
          if (menu.dataset.dshTweaksMenuReady === '1') return;
          menu.setAttribute('data-dsh-tweaks-views-done', '');
          finishBuild(menu, trigger);
        }, 100);
      }

      /** Запланировать инъекцию после перерисовки меню. */
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        const run = () => {
          scheduled = false;
          inject();
        };
        if (typeof window?.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
        else window.setTimeout(run, 0);
      };

      // Только шапка и её меню: собирать меню заново из-за перерисовки ленты ни к чему.
      const HEADER_WATCH = [
        '[class*="_moreButton"]',
        '[role="menu"]',
        '[class*="_viewsMoreMenu"]',
        '[data-slot="conversation.session.header.actions"]',
        '[data-slot="conversation.session.header.utilities"]',
        '[data-dsh-tweaks-more-slot]',
      ].join(', ');
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes ?? []) {
            if (touchesRoot(node, HEADER_WATCH)) {
              schedule();
              return;
            }
          }
        }
      });
      let observing = false;
      /** Включить наблюдение и один раз собрать меню. */
      const connectObserver = () => {
        if (observing) return;
        observing = true;
        observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
        schedule();
      };
      /** Выключить наблюдение, пока вкладка скрыта. */
      const disconnectObserver = () => {
        if (!observing) return;
        observing = false;
        observer.disconnect();
      };
      const stopWatchingVisibility = pauseWhenHidden(document, connectObserver, disconnectObserver);
      const onClick = (event) => {
        if (event.target?.closest?.('[class*="_moreButton"]') !== null) schedule();
      };
      document.addEventListener('click', onClick, true);
      connectObserver();
      return () => {
        clearRevealTimer();
        disconnectObserver();
        stopWatchingVisibility();
        document.removeEventListener('click', onClick, true);
        style.remove();
      };
    }

    /* #endregion tweak-mobile-sidebar */

    /* #region tweak-mobile-right-tabs */

    /** Сколько держать вкладку, прежде чем начнётся перенос. */
    const RIGHT_TAB_LONG_PRESS_MS = 1000;
    /** Порог жеста-перелистывания вкладок. */
    const RIGHT_TAB_SWIPE_PX = 48;
    /** Смещение, после которого жест уже не считается удержанием. */
    const RIGHT_TAB_HOLD_SLOP = 10;

    /**
     * Активная панель правого докера: жест работает только по видимой панели.
     * @returns {object|null} панель или null.
     */
    function rightActivePane() {
      const panes = [...document.querySelectorAll('[data-dockkit-pane]')];
      const active = panes.find((pane) => pane.hasAttribute('data-dockkit-pane-active'));
      const pane = active ?? panes[0];
      if (!pane || pane.closest('[hidden], [aria-hidden="true"]') !== null) return null;
      const rect = pane.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? pane : null;
    }

    /**
     * Полоса вкладок активной панели и её чипы по порядку.
     * @param {object|null} pane - панель.
     * @returns {object[]} чипы.
     */
    function rightTabChips(pane) {
      if (!pane) return [];
      const strip = pane.querySelector('[data-dockkit-strip-tabs]');
      if (!strip) return [];
      return [...strip.querySelectorAll('[data-dockkit-tab]')];
    }

    /**
     * Переключить активную вкладку на соседнюю.
     * @param {object} pane - панель.
     * @param {number} delta - +1 следующая, -1 предыдущая.
     * @returns {boolean} был ли переход.
     */
    function switchRightTab(pane, delta) {
      const chips = rightTabChips(pane);
      if (chips.length < 2) return false;
      const index = chips.findIndex((chip) => chip.getAttribute('aria-selected') === 'true');
      const next = chips[index + delta];
      if (!next) return false;
      next.click();
      return true;
    }

    /**
     * Горизонтально прокручиваемый предок: по такому месту свайп листает
     * контент, а не вкладки.
     * @param {object} target - цель.
     * @param {object} pane - панель.
     * @returns {boolean} есть ли горизонтальный скролл.
     */
    function rightHorizontalScroller(target, pane) {
      let node = target;
      while (node && node !== pane) {
        if (node.scrollWidth > node.clientWidth + 4) {
          const overflow = getComputedStyle(node).overflowX;
          if (overflow === 'auto' || overflow === 'scroll') return true;
        }
        node = node.parentElement;
      }
      return false;
    }

    /** Интерактивный элемент, на котором свайп вкладок не перехватываем. */
    function rightInteractiveTarget(target) {
      return typeof target?.closest === 'function' && target.closest(
        'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="menu"], [role="listbox"], button, a, [role="button"], [data-dockkit-tab-close]',
      ) !== null;
    }

    /**
     * Свайпы по содержимому правой панели и по полосе вкладок + долгое
     * нажатие для переноса вкладки. Свайп по полосе/телу листает вкладки;
     * удержание чипа секунду разблокирует штатный drag докера.
     * @param {object} ctx - клиентский контекст.
     * @param {object} api - очистки твика.
     * @returns {Function} очистка.
     */
    function setupMobileRightTabs(ctx, api) {
      if (typeof window === 'undefined' || !mobileComposerDevice(window)) return () => {};
      const doc = window.document;
      let disposed = false;
      let suppressClick = false;
      let suppressChip = null;
      let suppressTimer = null;
      let bodyStart = null;
      let hold = null;
      let moveBlocker = null;
      /** Где пользователь оставил полосу вкладок до выбора. */
      const savedStripScroll = new WeakMap();
      const restoreTimers = new Set();

      /** Не дать клику после свайпа/переноса выбрать вкладку. */
      const onClickCapture = (event) => {
        if (!suppressClick) return;
        if (suppressChip !== null && !suppressChip.contains(event.target)) return;
        suppressClick = false;
        suppressChip = null;
        if (suppressTimer !== null) window.clearTimeout(suppressTimer);
        suppressTimer = null;
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      /** Погасить следующий клик по исходному чипу. */
      const armSuppress = (chip) => {
        suppressClick = true;
        suppressChip = chip;
        if (suppressTimer !== null) window.clearTimeout(suppressTimer);
        suppressTimer = window.setTimeout(() => {
          suppressClick = false;
          suppressChip = null;
          suppressTimer = null;
        }, 500);
      };

      /**
       * Свайп по телу панели: влево — следующая вкладка, вправо — предыдущая.
       * @param {object} event - pointerdown.
       * @returns {void}
       */
      const onBodyDown = (event) => {
        if (disposed || event.button > 0 || bodyStart !== null) return;
        const pane = event.target?.closest?.('[data-dockkit-pane]');
        if (pane === null || pane === undefined || pane !== rightActivePane()) return;
        if (event.target.closest('[data-dockkit-strip]') !== null) return;
        if (rightInteractiveTarget(event.target) || rightHorizontalScroller(event.target, pane)) return;
        const strip = pane.querySelector('[data-dockkit-strip-tabs]');
        if (strip !== null) savedStripScroll.set(strip, strip.scrollLeft);
        bodyStart = { id: event.pointerId, x: event.clientX, y: event.clientY, pane, horizontal: false, dead: false };
      };

      const onBodyMove = (event) => {
        if (bodyStart === null || event.pointerId !== bodyStart.id) return;
        const dx = event.clientX - bodyStart.x;
        const dy = event.clientY - bodyStart.y;
        if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) bodyStart.dead = true;
        if (!bodyStart.dead && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) bodyStart.horizontal = true;
      };

      const onBodyUp = (event) => {
        if (bodyStart === null || event.pointerId !== bodyStart.id) return;
        const start = bodyStart;
        bodyStart = null;
        if (start.dead || !start.horizontal) return;
        const dx = event.clientX - start.x;
        if (Math.abs(dx) < RIGHT_TAB_SWIPE_PX) return;
        if (switchRightTab(start.pane, dx < 0 ? 1 : -1)) armSuppress(start.pane.querySelector('[data-dockkit-tab][aria-selected="true"]'));
      };

      /**
       * Нажатие на чип вкладки: удержание 1 с разрешает штатный перенос,
       * короткий горизонтальный жест листает вкладки.
       * @param {object} event - pointerdown.
       * @returns {void}
       */
      const onStripDown = (event) => {
        if (disposed || event.button > 0 || hold !== null || suppressClick) return;
        const chip = event.target?.closest?.('[data-dockkit-tab]');
        if (chip === null || chip === undefined || chip.closest('[data-dockkit-tab-close]') !== null) return;
        const pane = chip.closest('[data-dockkit-pane]');
        if (pane === null || pane === undefined) return;
        const strip = chip.closest('[data-dockkit-strip-tabs]');
        if (strip !== null) savedStripScroll.set(strip, strip.scrollLeft);
        const state = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          chip,
          pane,
          horizontal: false,
          cancelled: false,
          longFired: false,
          movedAfterHold: false,
          timer: null,
        };
        hold = state;
        chip.setAttribute('data-dsh-tweaks-tab-hold', '');
        // Пока идёт удержание, гасим движения: штатный drag докера не должен
        // начаться раньше времени. После таймера отпускаем — докер сам решает.
        moveBlocker = (moved) => {
          if (state.id !== moved.pointerId) return;
          moved.stopImmediatePropagation();
          const dx = moved.clientX - state.x;
          const dy = moved.clientY - state.y;
          if (state.longFired) {
            state.movedAfterHold = state.movedAfterHold || Math.abs(dx) + Math.abs(dy) > 4;
            return;
          }
          if (Math.abs(dx) > RIGHT_TAB_HOLD_SLOP || Math.abs(dy) > RIGHT_TAB_HOLD_SLOP) {
            state.cancelled = true;
            if (state.timer !== null) { window.clearTimeout(state.timer); state.timer = null; }
            chip.removeAttribute('data-dsh-tweaks-tab-hold');
          }
          if (!state.cancelled && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) state.horizontal = true;
        };
        window.addEventListener('pointermove', moveBlocker, true);
        state.timer = window.setTimeout(() => {
          state.timer = null;
          if (disposed || hold !== state) return;
          state.longFired = true;
          chip.removeAttribute('data-dsh-tweaks-tab-hold');
          if (moveBlocker !== null) window.removeEventListener('pointermove', moveBlocker, true);
          moveBlocker = null;
        }, RIGHT_TAB_LONG_PRESS_MS);
      };

      /**
       * Отпускание после нажатия на чип: убрать таймеры и решить,
       * был ли это свайп (тогда переключаем вкладку и гасим клик).
       * @param {object} event - pointerup.
       * @returns {void}
       */
      const onStripUp = (event) => {
        const state = hold;
        if (state === null || event.pointerId !== state.id) return;
        hold = null;
        if (state.timer !== null) window.clearTimeout(state.timer);
        state.chip.removeAttribute('data-dsh-tweaks-tab-hold');
        if (moveBlocker !== null) {
          window.removeEventListener('pointermove', moveBlocker, true);
          moveBlocker = null;
        }
        const dx = event.clientX - state.x;
        const dy = event.clientY - state.y;
        if (state.longFired) {
          // После снятия блокировщика движения уже не проходят через него:
          // факт переноса определяем по смещению от точки нажатия.
          if (state.movedAfterHold || Math.abs(dx) + Math.abs(dy) > 4) armSuppress(state.chip);
          return;
        }
        if (Math.abs(dy) > Math.abs(dx)) return;
        if (Math.abs(dx) < RIGHT_TAB_SWIPE_PX) return;
        if (switchRightTab(state.pane, dx < 0 ? 1 : -1)) armSuppress(state.chip);
      };

      const onStripCancel = (event) => {
        const state = hold;
        if (state === null || (event.pointerId !== undefined && event.pointerId !== state.id)) return;
        hold = null;
        if (state.timer !== null) window.clearTimeout(state.timer);
        state.chip.removeAttribute('data-dsh-tweaks-tab-hold');
        if (moveBlocker !== null) {
          window.removeEventListener('pointermove', moveBlocker, true);
          moveBlocker = null;
        }
      };

      /**
       * После выбора вкладки вернуть полосу туда, где пользователь её оставил:
       * useActiveChipInView иначе «придвигает» активный чип к правому краю.
       * @param {object} event - click.
       * @returns {void}
       */
      const onChipClick = (event) => {
        if (disposed) return;
        const chip = event.target?.closest?.('[data-dockkit-tab]');
        if (chip === null || chip === undefined) return;
        const strip = chip.closest('[data-dockkit-strip-tabs]');
        if (strip === null) return;
        const left = savedStripScroll.get(strip);
        if (left === undefined) return;
        const restore = () => {
          if (!disposed && strip.isConnected) strip.scrollLeft = left;
        };
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restore);
        for (const delay of [40, 120, 260]) {
          const timer = window.setTimeout(() => {
            restoreTimers.delete(timer);
            restore();
          }, delay);
          restoreTimers.add(timer);
        }
      };
      doc.addEventListener('click', onChipClick, true);

      doc.addEventListener('pointerdown', onBodyDown, true);
      doc.addEventListener('pointerdown', onStripDown, true);
      doc.addEventListener('pointermove', onBodyMove, true);
      doc.addEventListener('pointerup', onBodyUp, true);
      doc.addEventListener('pointerup', onStripUp, true);
      doc.addEventListener('pointercancel', onStripCancel, true);
      doc.addEventListener('click', onClickCapture, true);
      return () => {
        disposed = true;
        if (hold !== null) {
          if (hold.timer !== null) window.clearTimeout(hold.timer);
          hold.chip.removeAttribute('data-dsh-tweaks-tab-hold');
          hold = null;
        }
        if (moveBlocker !== null) {
          window.removeEventListener('pointermove', moveBlocker, true);
          moveBlocker = null;
        }
        if (suppressTimer !== null) window.clearTimeout(suppressTimer);
        suppressTimer = null;
        doc.removeEventListener('click', onChipClick, true);
        doc.removeEventListener('pointerdown', onBodyDown, true);
        doc.removeEventListener('pointerdown', onStripDown, true);
        for (const timer of restoreTimers) window.clearTimeout(timer);
        restoreTimers.clear();
        doc.removeEventListener('pointermove', onBodyMove, true);
        doc.removeEventListener('pointerup', onBodyUp, true);
        doc.removeEventListener('pointerup', onStripUp, true);
        doc.removeEventListener('pointercancel', onStripCancel, true);
        doc.removeEventListener('click', onClickCapture, true);
      };
    }

    /* #endregion tweak-mobile-right-tabs */

    /* #region tweak-queue-editor */

    /** Относительный путь host-роута: работает и под /dev/. */
    const QUEUE_EDIT_ROUTE = 'dsh-tweaks/queue/edit';
    /** Предел одного нового вложения до base64 (как на хосте). */
    const QUEUE_EDIT_MAX_ATTACHMENT = 32 * 1024 * 1024;
    /** Разрешённые типы картинок (совпадают с attachment-store). */
    const QUEUE_EDIT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

    /** Состояние открытой формы: payload и подписчики. */
    const queueEditorState = {
      value: null,
      listeners: new Set(),
      get() { return this.value; },
      open(value) {
        this.value = value;
        for (const listener of this.listeners) listener(this.value);
      },
      close() {
        this.value = null;
        for (const listener of this.listeners) listener(null);
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };

    /** Durable-строки очереди: pending-echo сюда не входят. */
    function queueEditorRows() {
      return [...document.querySelectorAll('[data-queue-dock] li:not([data-submission-echo])')];
    }

    /**
     * Видимые элементы durable-очереди в том же порядке, что рисует QueueDock:
     * inbox next-turn минус транскриптные локальные echo.
     * @param {object} session - клиентская Session.
     * @returns {object[]} элементы очереди.
     */
    function queueEditorItems(session) {
      try {
        const inbox = session?.projections?.faceOf?.('inbox')?.getSnapshot?.();
        const rows = Array.isArray(inbox?.['next-turn']) ? inbox['next-turn'] : [];
        const pending = session?.getSnapshot?.()?.pendingSubmissions ?? [];
        const inChat = new Set(pending.filter((item) => item.placement === 'transcript').map((item) => item.requestId));
        if (inChat.size === 0) return [...rows];
        return rows.filter(({ source }) => source?.kind !== 'user' || !('rpcId' in source) || !inChat.has(source.rpcId));
      } catch (_error) {
        return [];
      }
    }

    /** Текущая Session по DOM-маркеру. */
    function queueEditorSession(ctx) {
      try {
        const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined;
        const id = document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session');
        if (!id || typeof sessions?.scope !== 'function' || typeof sessions?.sessionOf !== 'function') return undefined;
        const actx = sessions.scope(id);
        return actx === undefined ? undefined : sessions.sessionOf(actx);
      } catch (_error) {
        return undefined;
      }
    }

    /** Первая кнопка actions в durable-строке — это карандаш. */
    function queueEditorEditButton(row) {
      const actions = row?.querySelector?.('[class*="_actions"]');
      return actions?.querySelector?.('button') ?? null;
    }

    /** Собрать JSON-payload формы. */
    function queueEditorPayload(text, attachments) {
      return {
        text,
        attachments: attachments.map((item) => item.kind === 'existing'
          ? { kind: 'existing', type: item.type, attachment: item.attachment }
          : {
            kind: 'new',
            type: item.type,
            name: item.name,
            ...(item.type === 'image' ? { mediaType: item.mediaType } : {}),
            data: item.data,
          }),
      };
    }

    /** base64 из байтов без переполнения стека. */
    function queueEditorBase64(bytes) {
      let binary = '';
      const chunk = 0x8000;
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
      }
      return btoa(binary);
    }

    /** Прочитать File в base64. */
    async function queueEditorReadFile(file) {
      const buffer = await file.arrayBuffer();
      return queueEditorBase64(new Uint8Array(buffer));
    }

    /** Миниатюра существующего изображения из durable-ссылки. */
    function QueueEditExistingImage({ attachment, imageUrl }) {
      const [url, setUrl] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        try {
          Promise.resolve(imageUrl?.(attachment)).then((next) => {
            if (alive && typeof next === 'string') setUrl(next);
          }, () => {});
        } catch (_error) {
          /* превью необязательно */
        }
        return () => { alive = false; };
      }, [attachment, imageUrl]);
      return url === null ? React.createElement('span', { className: 'dsh-tweaks-queue-att-placeholder' }) : React.createElement('img', { src: url, alt: '', className: 'dsh-tweaks-queue-att-image' });
    }

    /** Строка вложения с удалением. */
    function QueueEditAttachment({ item, imageUrl, onRemove }) {
      const name = item.kind === 'existing' ? item.attachment?.name : item.name;
      return React.createElement(
        'span',
        { className: `dsh-tweaks-queue-att dsh-tweaks-queue-att-${item.type}` },
        item.type === 'image'
          ? (item.kind === 'existing'
            ? React.createElement(QueueEditExistingImage, { attachment: item.attachment, imageUrl })
            : React.createElement('img', { src: item.previewUrl, alt: '', className: 'dsh-tweaks-queue-att-image' }))
          : React.createElement(primitives?.FileTypeIcon ?? 'span', { path: name ?? '', size: 16 }),
        React.createElement('span', { className: 'dsh-tweaks-queue-att-name', title: name }, name ?? 'file'),
        React.createElement('button', { type: 'button', className: 'dsh-tweaks-queue-att-remove', 'aria-label': 'Удалить вложение', onClick: onRemove }, '×'),
      );
    }

    /**
     * Единая форма редактирования очереди: composer-стиль, текст и вложения.
     * @param {object} props - payload, sessionId, imageUrl, onClose, onSaved.
     * @returns {object} форма.
     */
    function QueueEditForm({ payload, sessionId, imageUrl, onClose }) {
      const [text, setText] = React.useState(() => (payload.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join(''));
      const [attachments, setAttachments] = React.useState(() => (payload.content ?? [])
        .filter((block) => block.type === 'image' || block.type === 'file')
        .map((block, index) => ({
          kind: 'existing',
          type: block.type,
          attachment: block.attachment,
          key: `${block.attachment?.attachmentId ?? 'ref'}:${index}`,
        })));
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const inputRef = React.useRef(null);
      const newUrls = React.useRef(new Set());
      React.useEffect(() => () => {
        for (const url of newUrls.current) URL.revokeObjectURL?.(url);
        newUrls.current.clear();
      }, []);
      const addFiles = async (files) => {
        const next = [];
        for (const file of files) {
          if (file.size > QUEUE_EDIT_MAX_ATTACHMENT) {
            setError(`Файл «${file.name}» больше ${Math.round(QUEUE_EDIT_MAX_ATTACHMENT / 1024 / 1024)} МБ`);
            continue;
          }
          try {
            const data = await queueEditorReadFile(file);
            const type = QUEUE_EDIT_IMAGE_TYPES.has(file.type) ? 'image' : 'file';
            let previewUrl;
            if (type === 'image') {
              previewUrl = URL.createObjectURL(file);
              newUrls.current.add(previewUrl);
            }
            next.push({ kind: 'new', type, name: file.name || 'file', mediaType: type === 'image' ? file.type : undefined, data, previewUrl });
          } catch (_error) {
            setError(`Не удалось прочитать «${file.name}»`);
          }
        }
        if (next.length > 0) setAttachments((current) => [...current, ...next]);
      };
      const removeAt = (index) => {
        setAttachments((current) => {
          const removed = current[index];
          if (removed?.previewUrl) URL.revokeObjectURL?.(removed.previewUrl);
          return current.filter((_item, itemIndex) => itemIndex !== index);
        });
      };
      const save = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
          const response = await fetch(QUEUE_EDIT_ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, itemId: payload.itemId, ...queueEditorPayload(text, attachments) }),
          });
          const result = await response.json().catch(() => null);
          if (!response.ok || result?.ok !== true) {
            setError(response.status === 404 || response.status === 405
              ? 'Сервер ещё не загрузил редактор вложений: нужен перезапуск DSH. Сообщение не изменено.'
              : (result?.message ?? `Не удалось сохранить (${response.status})`));
            return;
          }
          onClose();
        } catch (_error) {
          setError('Нет связи с хостом: сообщение не изменено');
        } finally {
          setBusy(false);
        }
      };
      return React.createElement(
        'section',
        { className: 'dsh-tweaks-queue-editor', 'data-queue-editor': '' },
        React.createElement('div', { className: 'dsh-tweaks-queue-editor-head' },
          React.createElement('span', { className: 'dsh-tweaks-queue-editor-title' }, 'Редактирование очереди'),
          React.createElement('button', { type: 'button', className: 'dsh-tweaks-queue-editor-close', 'aria-label': 'Закрыть', onClick: onClose }, '×')),
        React.createElement('textarea', {
          className: 'dsh-tweaks-queue-editor-text',
          value: text,
          placeholder: 'Текст сообщения',
          rows: 3,
          onChange: (event) => setText(event.target.value),
        }),
        React.createElement('div', { className: 'dsh-tweaks-queue-editor-atts' },
          attachments.map((item, index) => React.createElement(QueueEditAttachment, { key: item.key ?? `${item.name}:${index}`, item, imageUrl, onRemove: () => removeAt(index) }))),
        React.createElement('div', { className: 'dsh-tweaks-queue-editor-actions' },
          React.createElement('button', { type: 'button', className: 'dsh-tweaks-queue-editor-add', onClick: () => inputRef.current?.click() }, '+ Вложение'),
          React.createElement('input', {
            ref: inputRef,
            type: 'file',
            multiple: true,
            className: 'dsh-tweaks-queue-editor-file',
            onChange: (event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              addFiles(files);
            },
          })),
        error === null ? null : React.createElement('div', { className: 'dsh-tweaks-queue-editor-error', role: 'alert' }, error),
        React.createElement('div', { className: 'dsh-tweaks-queue-editor-footer' },
          React.createElement('button', { type: 'button', className: 'dsh-tweaks-queue-editor-cancel', disabled: busy, onClick: onClose }, 'Отмена'),
          React.createElement('button', { type: 'button', className: 'dsh-tweaks-queue-editor-save', disabled: busy || (text.trim() === '' && attachments.length === 0), onClick: save }, busy ? 'Сохраняем…' : 'Сохранить')),
      );
    }

    /** Панель формы: подписка на store + текущая сессия. */
    function QueueEditPanel({ sessionId, imageUrl }) {
      const [payload, setPayload] = React.useState(queueEditorState.get());
      React.useEffect(() => queueEditorState.subscribe(setPayload), []);
      React.useEffect(() => {
        if (payload !== null && payload.sessionId !== sessionId) queueEditorState.close();
      }, [payload, sessionId]);
      if (payload === null || payload.sessionId !== sessionId) return null;
      return React.createElement(QueueEditForm, {
        key: payload.itemId,
        payload,
        sessionId,
        imageUrl,
        onClose: () => queueEditorState.close(),
      });
    }

    /**
     * Включить единый редактор: снять disabled с карандаша durable-строк,
     * перехватить клик и отрисовать форму в доке композера.
     * @param {object} ctx - клиентский контекст.
     * @param {object} api - очистки твика.
     * @returns {void}
     */
    function setupQueueEditor(ctx, api) {
      const own = typeof api?.own === 'function' ? api.own : () => {};
      const style = document.createElement('style');
      style.dataset.dshQueueEditor = '';
      style.textContent = [
        '.dsh-tweaks-queue-editor{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,748px);margin:0 auto 6px;padding:10px 12px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}',
        '.dsh-tweaks-queue-editor-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
        '.dsh-tweaks-queue-editor-title{font-weight:500}',
        '.dsh-tweaks-queue-editor-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer;padding:2px 4px}',
        '.dsh-tweaks-queue-editor-text{box-sizing:border-box;width:100%;min-height:84px;max-height:36vh;resize:none;border:0;outline:none;background:transparent;color:inherit;font:400 var(--dsh-content-font-size,14px)/1.5 system-ui,sans-serif;white-space:pre-wrap;word-break:break-word}',
        '.dsh-tweaks-queue-editor-atts{display:flex;gap:6px;flex-wrap:wrap;max-height:140px;overflow:auto}',
        '.dsh-tweaks-queue-att{position:relative;display:inline-flex;align-items:center;gap:4px;max-width:200px;padding:3px 22px 3px 4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-overlay)}',
        '.dsh-tweaks-queue-att-image{width:36px;height:36px;object-fit:cover;border-radius:var(--dsw-radius-sm);flex:none}',
        '.dsh-tweaks-queue-att-placeholder{width:36px;height:36px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-skeleton);flex:none}',
        '.dsh-tweaks-queue-att-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px}',
        '.dsh-tweaks-queue-att-remove{position:absolute;right:2px;top:0;bottom:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px}',
        '.dsh-tweaks-queue-editor-actions{display:flex;align-items:center;gap:6px}',
        '.dsh-tweaks-queue-editor-add{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px 8px;cursor:pointer}',
        '.dsh-tweaks-queue-editor-file{display:none}',
        '.dsh-tweaks-queue-editor-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px}',
        '.dsh-tweaks-queue-editor-footer{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}',
        '.dsh-tweaks-queue-editor-cancel,.dsh-tweaks-queue-editor-save{font:inherit;font-size:13px;padding:5px 12px;border-radius:var(--dsw-radius-md);cursor:pointer}',
        '.dsh-tweaks-queue-editor-cancel{border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}',
        '.dsh-tweaks-queue-editor-save{border:0;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}',
        '.dsh-tweaks-queue-editor-save:disabled,.dsh-tweaks-queue-editor-cancel:disabled{opacity:.5;cursor:default}',
        '@media (max-width:720px){.dsh-tweaks-queue-editor{max-width:100%;border-radius:0;margin-bottom:4px}}',
      ].join('\n');
      document.head?.appendChild(style);
      own(() => style.remove());
      own(() => queueEditorState.close());

      let scheduled = false;
      /** Разрешить карандаш у durable-строк (React снова ставит disabled). */
      const enablePencils = () => {
        scheduled = false;
        for (const row of queueEditorRows()) {
          const button = queueEditorEditButton(row);
          if (button === null) continue;
          button.disabled = false;
          button.removeAttribute('title');
          button.setAttribute('data-dsh-tweaks-queue-edit', '');
        }
      };
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        if (typeof window?.requestAnimationFrame === 'function') window.requestAnimationFrame(enablePencils);
        else window.setTimeout(enablePencils, 0);
      };

      const onClick = (event) => {
        const target = event.target;
        const row = target?.closest?.('[data-queue-dock] li');
        if (row === null || row === undefined || row.hasAttribute('data-submission-echo')) return;
        const button = target.closest?.('button');
        if (button === null || button === undefined) return;
        const actions = row.querySelector('[class*="_actions"]');
        if (actions === null || !actions.contains(button)) return;
        if (actions.querySelector('button') !== button) return;
        const rows = queueEditorRows();
        const index = rows.indexOf(row);
        if (index < 0) return;
        const session = queueEditorSession(ctx);
        const items = queueEditorItems(session);
        const item = items[index];
        if (item === undefined) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        queueEditorState.open({ sessionId: row.ownerDocument?.querySelector?.('[data-conversation-session]')?.getAttribute('data-conversation-session'), itemId: item.id, content: item.content });
      };
      document.addEventListener?.('click', onClick, true);
      own(() => document.removeEventListener?.('click', onClick, true));

      const observer = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
        // Карандаш живёт в доке очереди: остальные правки документа не повод
        // перебирать строки очереди на каждом кадре.
        for (const record of records) {
          const nodes = record.type === 'attributes' ? [record.target] : [...(record.addedNodes ?? [])];
          for (const node of nodes) {
            if (touchesRoot(node, '[data-queue-dock]')) {
              schedule();
              return;
            }
          }
        }
      }) : null;
      let observing = false;
      /** Включить наблюдение и один раз разрешить карандаши. */
      const connectObserver = () => {
        if (observing) return;
        observing = true;
        observer?.observe(document.body ?? document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
        schedule();
      };
      /** Выключить наблюдение, пока вкладка скрыта. */
      const disconnectObserver = () => {
        if (!observing) return;
        observing = false;
        observer?.disconnect();
      };
      const stopWatchingVisibility = pauseWhenHidden(document, connectObserver, disconnectObserver);
      own(() => {
        disconnectObserver();
        stopWatchingVisibility();
      });
      connectObserver();

      let slots = undefined;
      try {
        slots = typeof ctx?.get === 'function' ? ctx.get('slots') : undefined;
      } catch (_error) {
        slots = undefined;
      }
      if (typeof slots?.inject === 'function' && typeof slots?.register === 'function') {
        own(slots.inject('conversation.input.dock', () => slots.register(
          {
            name: 'conversation.input.dock',
            id: 'queue-editor',
            order: -10,
            inject: (sessionId) => ({
              imageUrl: (attachment) => {
                try {
                  return ctx.get('uiConversation')?.imageUrl?.(sessionId, attachment);
                } catch (_error) {
                  return undefined;
                }
              },
            }),
          },
          (props) => React.createElement(QueueEditPanel, props),
        )));
      }
    }

    /* #endregion tweak-queue-editor */

    /* #region tweak-mobile-tabs-actions */

    /**
     * Перенести штатные триггеры Agent Team и Subagents из шапки в строку
     * вкладок Chat/Trajectory, справа от них. Переносятся реальные DOM-узлы,
     * поэтому сохраняются стандартный вид, порталы меню и анимация работы
     * (StateDot/спиннеры внутри триггеров).
     * @returns {Function} восстановление DOM.
     */
    function setupTabActions() {
      const style = document.createElement('style');
      style.dataset.dshTabsActions = '';
      style.textContent = [
        '.dsh-tweaks-tabs-actions{display:inline-flex;align-items:center;gap:2px;margin-left:0;min-width:0;flex:1;position:relative;top:-6px}',
        '.dsh-tweaks-tabs-actions [data-dsh-tweaks-more-slot]{margin-left:auto;display:inline-flex;align-items:center;flex:none}',
        '[data-slot="conversation.session.header.utilities"] > *:empty{display:none!important}',
        // На ПК те же панели/аккаунт прячем в нижнее меню: список панелей
        // показывается только по атрибуту открытия, отдельный More видов скрыт.
        '[class*="_viewsMoreAnchor"], [class*="_viewsMoreMenu"]{display:none!important}',
        '[class*="_panelList"]{display:none!important}',
        'html[data-dsh-tweaks-panel-menu="open"] [class*="_panelList"]{display:flex!important;position:fixed;left:8px;bottom:calc(var(--dsh-tweaks-footer-height,64px) + 8px);width:min(280px,calc(100vw - 16px));flex-direction:column;gap:2px;padding:6px;z-index:120;max-height:calc(100vh - var(--dsh-tweaks-footer-height,64px) - 16px);overflow:auto;border-radius:var(--dsw-radius-lg);background:Canvas!important;backdrop-filter:none!important;box-shadow:var(--dsw-elevation-prominent)}',
        'html[data-dsh-tweaks-panel-menu="open"] [class*="_panelList"] button[aria-label="More"]{display:none!important}',
        '@media (max-width:720px){',
        'div:has(> [data-conversation-tabs]){gap:4px!important}',
        '[data-conversation-tabs]{gap:8px!important}',
        '.dsh-tweaks-tabs-actions > * > button{padding-top:2px!important;padding-bottom:2px!important}',
        '.dsh-tweaks-tabs-actions [data-team-action] button{padding-left:3px!important;padding-right:3px!important;gap:4px!important}',
        '}',
      ].join('\n');
      document.head?.appendChild(style);
      const moved = new Map();
      let scheduled = false;
      let disposed = false;

      /** Строка вкладок разговора (не путать с вкладками правого докера). */
      const tabRow = () => {
        const tabs = document.querySelector('[data-conversation-tabs]');
        return tabs?.parentElement ?? null;
      };

      /** Контейнер для перенесённых кнопок. */
      const hostFor = (row) => {
        let host = row.querySelector(':scope > [data-dsh-tweaks-tabs-actions]');
        if (host === null) {
          host = document.createElement('div');
          host.className = 'dsh-tweaks-tabs-actions';
          host.setAttribute('data-dsh-tweaks-tabs-actions', '');
          const tabs = row.querySelector('[data-conversation-tabs]');
          if (tabs === null) return null;
          tabs.after(host);
        }
        return host;
      };

      /** Запомнить исходное место узла и перенести его. */
      const move = (node, host) => {
        if (node === null || node === undefined) return;
        if (node.parentElement === host) return;
        if (!moved.has(node)) moved.set(node, { parent: node.parentElement, next: node.nextSibling });
        host.appendChild(node);
      };

      const place = () => {
        scheduled = false;
        if (disposed) return;
        const row = tabRow();
        const actions = document.querySelector('[data-slot="conversation.session.header.actions"]');
        if (row === null || actions === null) return;
        const host = hostFor(row);
        if (host === null) return;
        const direct = [...actions.children];
        const team = direct.find((node) => node.hasAttribute?.('data-team-action') || node.querySelector?.('[data-team-action]') !== null) ?? null;
        const subagents = direct.find((node) => node !== team && [...node.querySelectorAll?.('button') ?? []].some((button) => {
          const label = `${button.getAttribute?.('aria-label') ?? ''} ${button.textContent ?? ''}`;
          return /subagents?|субагент/i.test(label);
        })) ?? null;
        const jobButton = [...document.querySelectorAll('[data-slot] button')].find((button) => {
          const label = `${button.getAttribute?.('aria-label') ?? ''} ${button.textContent ?? ''}`;
          return /background jobs?|background job running|фонов\w* задач/i.test(label);
        }) ?? null;
        let job = null;
        if (jobButton !== null && jobButton !== undefined) {
          const inHost = jobButton.closest('[data-dsh-tweaks-tabs-actions]');
          if (inHost !== null) {
            job = jobButton.parentElement;
          } else {
            let node = jobButton;
            while (node.parentElement !== null && !node.parentElement.hasAttribute?.('data-slot')) node = node.parentElement;
            job = node.parentElement?.hasAttribute?.('data-slot') ? node : null;
          }
        }
        const moreButton = document.querySelector('[data-slot="conversation.session.header.utilities"] [class*="_moreButton"]')
          ?? document.querySelector('button[class*="_moreButton"]');
        const moreSlot = host.querySelector('[data-dsh-tweaks-more-slot]') ?? (() => {
          const node = document.createElement('span');
          node.setAttribute('data-dsh-tweaks-more-slot', '');
          host.appendChild(node);
          return node;
        })();
        if (moreButton !== null && moreButton !== undefined && !moreSlot.contains(moreButton)) {
          // Переносим весь компонент Menu вместе с якорем: если вырвать только
          // кнопку, React при открытии меню теряет родителя и клик не срабатывает.
          let moreRoot = moreButton;
          while (
            moreRoot.parentElement !== null
            && !moreRoot.parentElement.hasAttribute?.('data-slot')
            && moreRoot.parentElement !== host
            && !moreRoot.parentElement.contains(host)
          ) {
            moreRoot = moreRoot.parentElement;
          }
          const root = moreRoot.parentElement?.hasAttribute?.('data-slot') ? moreRoot : moreButton;
          if (!root.contains(host)) move(root, moreSlot);
        }
        const teamButton = team?.querySelector?.('button');
        if (teamButton !== null && teamButton !== undefined) {
          if (teamButton.getAttribute('aria-label') !== 'Team') teamButton.setAttribute('aria-label', 'Team');
          const label = teamButton.querySelector('[class*="_triggerLabel"]');
          if (label !== null && label.textContent !== 'Team') label.textContent = 'Team';
        }
        const jobTrigger = job?.querySelector?.('button') ?? jobButton;
        if (jobTrigger !== null && jobTrigger !== undefined) {
          if (jobTrigger.getAttribute('aria-label') !== 'Job') jobTrigger.setAttribute('aria-label', 'Job');
          const count = jobTrigger.querySelector('[class*="_count"]');
          if (count !== null && count.textContent !== 'Job') count.textContent = 'Job';
        }
        if (team !== null) move(team, host);
        if (subagents !== null) move(subagents, host);
        if (job !== null) move(job, host);
        // Порядок: Team, Subagents, Job. Переставляем только если он реально
        // нарушен, иначе MutationObserver зациклится на своих же вставках.
        const desired = [team, subagents, job].filter((node) => node !== null && node.parentElement === host);
        const current = [...host.children].filter((node) => desired.includes(node));
        if (desired.some((node, index) => current[index] !== node)) host.append(...desired);
        if (moreSlot.parentElement === host) host.append(moreSlot);
      };

      const schedule = () => {
        if (scheduled || disposed) return;
        scheduled = true;
        if (typeof window?.requestAnimationFrame === 'function') window.requestAnimationFrame(place);
        else window.setTimeout(place, 0);
      };

      // Строка вкладок и слоты шапки: их правки и текст переносим, остальное не наше.
      const TABS_WATCH = [
        '[data-conversation-tabs]',
        '[data-dsh-tweaks-tabs-actions]',
        '[data-slot="conversation.session.header.actions"]',
        '[data-slot="conversation.session.header.utilities"]',
      ].join(', ');
      const observer = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'characterData') {
            if (touchesRoot(record.target?.parentElement, TABS_WATCH)) {
              schedule();
              return;
            }
            continue;
          }
          if (record.type === 'attributes') {
            if (touchesRoot(record.target, TABS_WATCH)) {
              schedule();
              return;
            }
            continue;
          }
          for (const node of record.addedNodes ?? []) {
            if (touchesRoot(node, TABS_WATCH)) {
              schedule();
              return;
            }
          }
        }
      }) : null;
      let observing = false;
      let keepTimer = 0;
      /** Включить наблюдение и один раз расставить кнопки. */
      const connectObserver = () => {
        if (observing || disposed) return;
        observing = true;
        observer?.observe(document.body ?? document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
        // Страховка от полного ремоунта шапки: записи наблюдателя по отфильтрованным
        // узлам могли не прийти, а контейнер кнопок пропал. Раз в 2 с — одна проверка.
        keepTimer = window.setInterval(() => {
          if (disposed) return;
          if (document.querySelector('[data-dsh-tweaks-tabs-actions]') === null) schedule();
        }, 2000);
        schedule();
      };
      /** Выключить наблюдение, пока вкладка скрыта. */
      const disconnectObserver = () => {
        if (!observing) return;
        observing = false;
        observer?.disconnect();
        if (keepTimer !== 0) {
          window.clearInterval(keepTimer);
          keepTimer = 0;
        }
      };
      const stopWatchingVisibility = pauseWhenHidden(document, connectObserver, disconnectObserver);
      connectObserver();
      return () => {
        disposed = true;
        disconnectObserver();
        stopWatchingVisibility();
        style.remove();
        for (const [node, origin] of moved) {
          const parent = origin.parent?.isConnected ? origin.parent : document.querySelector('[data-slot="conversation.session.header.actions"]');
          if (parent !== null && node.isConnected) {
            const next = origin.next?.isConnected ? origin.next : null;
            parent.insertBefore(node, next);
          }
        }
        moved.clear();
        for (const host of document.querySelectorAll('[data-dsh-tweaks-tabs-actions]')) host.remove();
      };
    }

    /* #endregion tweak-mobile-tabs-actions */

    /* #region tweak-mobile-overlays */

    /** Стили мобильной рамки для тяжёлых body-оверлеев приложения. */
    const MOBILE_OVERLAY_STYLE = [
      '@media (max-width:720px){',
      '[data-dsh-tweaks-mobile-overlay]{box-sizing:border-box;position:fixed!important;',
      'top:var(--dsh-tweaks-mobile-overlay-top,8px)!important;left:8px!important;right:8px!important;',
      'width:auto!important;min-width:0!important;max-width:none!important;height:auto!important;',
      'max-height:calc(100vh - var(--dsh-tweaks-mobile-overlay-top,8px) - 16px)!important;',
      'max-height:calc(100dvh - var(--dsh-tweaks-mobile-overlay-top,8px) - 16px)!important;',
      'margin:0!important;padding-bottom:0!important;display:flex!important;flex-direction:column!important;',
      'overflow:hidden!important;border-radius:var(--dsw-radius-lg)!important;',
      'z-index:130!important;zoom:1!important;transform:none!important}',
      '[data-dsh-tweaks-mobile-overlay] > *{min-height:0}',
      '[data-dsh-tweaks-mobile-overlay] > [class*="_body"],[data-dsh-tweaks-mobile-overlay] > [class*="_menuBody"]{',
      'flex:1 1 auto!important;min-height:0!important;overflow-y:auto!important;overscroll-behavior:contain}',
      '[data-dsh-tweaks-overlay-backdrop]{position:fixed;inset:0;z-index:129;',
      'background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);',
      'backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}',
      '[data-dsh-tweaks-overlay-close]{position:fixed;top:calc(var(--dsh-tweaks-mobile-overlay-top,8px) + 6px);right:16px;',
      'z-index:131;box-sizing:border-box;width:30px;height:30px;padding:0;border:.5px solid var(--dsw-alias-border-l2);',
      'border-radius:999px;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);',
      'box-shadow:var(--dsw-elevation-prominent);font:18px/28px system-ui,sans-serif;cursor:pointer;',
      'display:inline-flex;align-items:center;justify-content:center}',
      '}',
    ].join('');

    /**
     * На телефоне вписать body-оверлеи Agent Team и Subagents в экран и дать
     * видимый выход. Оба окна приложение порталит в body, поэтому они не
     * подчиняются мобильной сетке; при зуме их размеры ещё и умножаются.
     * @returns {Function} очистка наблюдателя и добавленных слоёв.
     */
    function setupMobileOverlays() {
      if (typeof window === 'undefined' || !mobileComposerDevice(window)) return () => {};
      const doc = window.document;
      const style = doc.createElement('style');
      style.dataset.dshMobileOverlays = '';
      style.textContent = MOBILE_OVERLAY_STYLE;
      doc.head?.appendChild(style);
      let backdrop = null;
      let closeButton = null;
      let activeKind = null;
      let scheduled = false;
      let disposed = false;
      const marked = new Set();
      /** Тип оверлея, подтверждённый двумя проходами подряд. */
      let confirmedKind = null;
      /** Тип оверлея на прошлом проходе и сколько проходов он держится. */
      let lastKind = null;
      let kindStreak = 0;
      /** Страховочный таймер: пока затемнение висит, оверлей перепроверяется. */
      let safetyTimer = 0;

      /** Сейчас телефонный (узкий) режим? */
      const isPhone = () => (Number(window.innerWidth) || 0) <= 720;

      /** Стиль узла; в заглушках без getComputedStyle берём inline-стиль. */
      const styleOf = (node) => {
        try {
          return typeof getComputedStyle === 'function' ? getComputedStyle(node) : node?.style ?? {};
        } catch (_error) {
          return node?.style ?? {};
        }
      };

      /**
       * Узел действительно виден в вьюпорте.
       *
       * Проверка строгая: скрытые узлы (`display:none`, `visibility:hidden`,
       * `opacity:0`) и узлы за границами окна оверлеями не считаются. Без неё
       * на телефоне за оверлей принималось вынесенное или скрытое меню —
       * прозрачное затемнение ложилось поверх экрана и съедало все тапы, то
       * есть интерфейс выглядел полностью зависшим.
       * @param {Element} node - проверяемый узел.
       * @returns {boolean} виден ли он в окне.
       */
      const visibleInViewport = (node) => {
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return false;
        const style = styleOf(node);
        const display = String(style.display ?? '');
        const visibility = String(style.visibility ?? '');
        if (display === 'none' || visibility === 'hidden' || visibility === 'collapse') return false;
        const opacity = Number.parseFloat(style.opacity ?? '1');
        if (Number.isFinite(opacity) && opacity === 0) return false;
        const rect = node.getBoundingClientRect();
        if (!(rect.width > 1 && rect.height > 1)) return false;
        const width = Number(window.innerWidth) || 0;
        const height = Number(window.innerHeight) || 0;
        if (width <= 0 || height <= 0) return false;
        return rect.left < width && rect.right > 0 && rect.top < height && rect.bottom > 0;
      };

      /**
       * Узел принадлежит панелям приложения, а не слою поверх экрана.
       * @param {Element} node - проверяемый узел.
       * @returns {boolean} да или нет.
       */
      const insideChrome = (node) => {
        if (node === null || node === undefined || typeof node.closest !== 'function') return false;
        return node.closest('[data-side], [data-dockkit-pane], [class*="_sidebarCol"], nav, aside') !== null;
      };

      /**
       * Кнопка, раскрывающая меню субагентов.
       * @returns {Element | null} открытый триггер либо null.
       */
      const subagentTrigger = () => doc.querySelector('button[aria-haspopup="tree"][aria-expanded="true"]');

      /**
       * Панель Agent Team: только открытая, видимая и поверх экрана.
       *
       * Пока панель открывают, приложение успевает отрисовать её скрытой
       * (`visibility:hidden`, 0,0): размер у неё уже есть, поэтому по rect её
       * нельзя считать показанной.
       * @returns {Element | null} панель либо null.
       */
      const teamPanel = () => {
        const panel = doc.querySelector('[data-team-panel]');
        if (panel === null || panel === undefined) return null;
        const role = typeof panel.getAttribute === 'function' ? panel.getAttribute('role') : null;
        if (role !== null && role !== undefined && role !== 'dialog') return null;
        if (insideChrome(panel)) return null;
        return visibleInViewport(panel) ? panel : null;
      };

      /**
       * Меню субагентов: открыто по триггеру и лежит fixed-слоем в body.
       *
       * Без открытого триггера меню не ищем вовсе: закрытое или чужое дерево
       * (например, дерево сессий в выдвижной панели) тоже бывает
       * `[role="tree"]` с fixed-предком, и раньше оно включало затемнение.
       * @returns {object | null} корень меню либо null.
       */
      const subagentMenu = () => {
        const trigger = subagentTrigger();
        if (trigger === null || !visibleInViewport(trigger)) return null;
        const triggerRect = trigger.getBoundingClientRect();
        for (const tree of doc.querySelectorAll('[role="tree"]')) {
          if (insideChrome(tree)) continue;
          let node = tree;
          while (node !== null && node !== doc.body && styleOf(node).position !== 'fixed') {
            node = node.parentElement;
          }
          if (node === null || node === doc.body) continue;
          if (!visibleInViewport(node)) continue;
          // Меню выпадает от своего триггера, а не приходит из другого угла экрана.
          const rect = node.getBoundingClientRect();
          const nearTrigger = rect.top >= triggerRect.top - 40 && rect.top <= triggerRect.bottom + 200;
          if (!nearTrigger) continue;
          return node;
        }
        return null;
      };

      /** Пометить живой оверлей и вернуть его тип. */
      const mark = (node, kind) => {
        if (node === null || node === undefined) return null;
        if (!marked.has(node)) {
          marked.add(node);
          node.setAttribute('data-dsh-tweaks-mobile-overlay', '');
          node.setAttribute('data-dsh-tweaks-overlay-kind', kind);
        }
        return kind;
      };

      /** Снять страховочный таймер перепроверки. */
      function stopSafety() {
        if (safetyTimer !== 0) {
          window.clearTimeout(safetyTimer);
          safetyTimer = 0;
        }
      }

      /** Убрать затемнение и крестик, снять подтверждение оверлея. */
      const clearChrome = () => {
        stopSafety();
        if (backdrop !== null) backdrop.remove();
        if (closeButton !== null) closeButton.remove();
        backdrop = null;
        closeButton = null;
        activeKind = null;
        confirmedKind = null;
        lastKind = null;
        kindStreak = 0;
      };

      /**
       * Перепроверить оверлей через 2 с, даже если приложение не прислало
       * ни одной записи: закрытие может пройти без мутаций DOM.
       * @returns {void}
       */
      const armSafety = () => {
        if (safetyTimer !== 0) return;
        safetyTimer = window.setTimeout(() => {
          safetyTimer = 0;
          schedule();
        }, 2000);
      };

      /**
       * Закрыть активное окно штатным способом приложения.
       * @returns {void}
       */
      const closeActive = () => {
        if (activeKind === 'subagents') {
          const trigger = doc.querySelector('button[aria-haspopup="tree"][aria-expanded="true"]');
          if (trigger !== null) {
            trigger.click();
            return;
          }
        }
        // Agent Team слушает Escape на document; для subagents это запасной путь.
        try {
          doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } catch (_error) {
          /* остаётся observer: панель закроется другим способом */
        }
      };

      /** Создать затемнение и кнопку закрытия один раз. */
      const ensureChrome = () => {
        if (backdrop === null) {
          backdrop = doc.createElement('div');
          backdrop.setAttribute('data-dsh-tweaks-overlay-backdrop', '');
          // Пока оверлей не подтверждён вторым проходом, затемнение не ест тапы:
          // ошибка детектора иначе запирает весь интерфейс на телефоне.
          backdrop.style.pointerEvents = 'none';
          backdrop.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeActive();
            schedule();
          });
          doc.body?.appendChild(backdrop);
        }
        if (closeButton === null) {
          closeButton = doc.createElement('button');
          closeButton.type = 'button';
          closeButton.setAttribute('data-dsh-tweaks-overlay-close', '');
          closeButton.setAttribute('aria-label', 'Закрыть');
          closeButton.textContent = '×';
          closeButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeActive();
            schedule();
          });
          doc.body?.appendChild(closeButton);
        }
      };

      /** Актуализировать верхнюю границу/слои по текущей шапке. */
      const update = () => {
        scheduled = false;
        if (disposed) return;
        if (!isPhone()) {
          clearChrome();
          return;
        }
        // data-slot шапки — display:contents, у него нет rect. Берём реальный
        // header и строку вкладок: их низ и есть граница, ниже которой окно
        // не должно перекрывать Chat/Trajectory/Team/Subagents.
        const headerCandidates = [
          doc.querySelector('[data-conversation-tabs]')?.parentElement,
          doc.querySelector('header'),
        ];
        let headerBottom = 0;
        for (const candidate of headerCandidates) {
          const rect = candidate?.getBoundingClientRect?.();
          if (rect !== undefined && rect.width > 0 && rect.bottom > headerBottom) headerBottom = rect.bottom;
        }
        const top = Math.max(8, Math.round(headerBottom > 0 ? headerBottom + 4 : 8));
        // Оба детектора возвращают только положительно видимый оверлей:
        // при сомнении затемнение не ставим вовсе.
        const team = teamPanel();
        const subagents = subagentMenu();
        const teamKind = team === null ? null : mark(team, 'team');
        const subagentKind = subagents === null ? null : mark(subagents, 'subagents');
        const kind = subagentKind ?? teamKind;
        if (kind === null) {
          clearChrome();
          return;
        }
        doc.documentElement?.style?.setProperty('--dsh-tweaks-mobile-overlay-top', `${top}px`);
        activeKind = kind;
        if (kind === lastKind) kindStreak += 1;
        else {
          lastKind = kind;
          kindStreak = 1;
        }
        ensureChrome();
        // Тапы перехватывает только оверлей, подтверждённый вторым проходом
        // подряд: первый проход рисует неинтерактивное затемнение и просит
        // перепроверку в следующем кадре.
        const interactive = kindStreak >= 2;
        if (backdrop !== null) {
          const next = interactive ? 'auto' : 'none';
          if (backdrop.style.pointerEvents !== next) backdrop.style.pointerEvents = next;
        }
        confirmedKind = interactive ? kind : null;
        if (!interactive) schedule();
        armSafety();
      };

      const schedule = () => {
        if (disposed || scheduled) return;
        scheduled = true;
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(update);
        else window.setTimeout(update, 0);
      };

      // Только сами оверлеи, их меню и триггер меню субагентов: перерисовка
      // ленты и правки стилей чата не повод пересобирать рамку окон.
      const OVERLAY_WATCH = '[data-team-panel], [role="tree"], [aria-haspopup="tree"], [data-dsh-tweaks-mobile-overlay]';
      /**
       * Добавленный узел — оверлей или его меню.
       *
       * Оверлеи приложение порталит в `body` мимо `#root`, поэтому осмотр
       * поддерева ограничен слоями: внутри `#root` смотрим только предков.
       * @param {Element} node - добавленный узел.
       * @returns {boolean} да или нет.
       */
      const overlayAdded = (node) => {
        if (node === null || node === undefined || node.nodeType !== 1) return false;
        if (touchesRoot(node, OVERLAY_WATCH)) return true;
        if (typeof node.closest !== 'function' || node.closest('#root') !== null) return false;
        return typeof node.querySelector === 'function' && node.querySelector(OVERLAY_WATCH) !== null;
      };
      const observer = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') {
            if (touchesRoot(record.target, OVERLAY_WATCH)) {
              schedule();
              return;
            }
            continue;
          }
          for (const node of record.addedNodes ?? []) {
            if (overlayAdded(node)) {
              schedule();
              return;
            }
          }
        }
      }) : null;
      let observing = false;
      /** Включить наблюдение и один раз пересобрать рамку окон. */
      const connectObserver = () => {
        if (observing || disposed) return;
        observing = true;
        observer?.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'aria-expanded'] });
        schedule();
      };
      /**
       * Выключить наблюдение, пока вкладка скрыта, и снять затемнение:
       * скрытая вкладка не должна оставлять поверх себя перехват тапов.
       * @returns {void}
       */
      const disconnectObserver = () => {
        if (!observing) return;
        observing = false;
        observer?.disconnect();
        clearChrome();
      };
      const stopWatchingVisibility = pauseWhenHidden(doc, connectObserver, disconnectObserver);
      window.addEventListener('resize', schedule);
      window.addEventListener('dsh-ui-zoom-change', schedule);
      doc.addEventListener('scroll', schedule, true);
      const visual = window.visualViewport;
      visual?.addEventListener?.('resize', schedule);
      visual?.addEventListener?.('scroll', schedule);
      connectObserver();
      return () => {
        disposed = true;
        stopWatchingVisibility();
        disconnectObserver();
        style.remove();
        window.removeEventListener('resize', schedule);
        window.removeEventListener('dsh-ui-zoom-change', schedule);
        doc.removeEventListener('scroll', schedule, true);
        visual?.removeEventListener?.('resize', schedule);
        visual?.removeEventListener?.('scroll', schedule);
        clearChrome();
        for (const node of marked) {
          node.removeAttribute?.('data-dsh-tweaks-mobile-overlay');
          node.removeAttribute?.('data-dsh-tweaks-overlay-kind');
        }
        marked.clear();
        doc.documentElement?.style?.removeProperty('--dsh-tweaks-mobile-overlay-top');
      };
    }

    /* #endregion tweak-mobile-overlays */

    /* #region tweak-file-download */

    /** Относительный путь хост-роута скачивания. */
    const DOWNLOAD_ROUTE = 'dsh-tweaks/download';
    /** Относительный путь хост-роута копирования пути. */
    const FILE_PATH_ROUTE = 'dsh-tweaks/file-path';

    /**
     * Разобрать `dsh-resource://file/session/<id>/<path>`.
     * @param {unknown} address - адрес ресурса.
     * @returns {{sessionId: string, path: string} | undefined} части или undefined.
     */
    function parseDshFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith('dsh-resource://file/')) return undefined;
      const end = address.search(/[?#]/);
      const parts = address.slice(20, end === -1 ? undefined : end).split('/');
      const scope = parts.shift();
      if (scope !== 'session') return undefined;
      const id = parts.shift();
      if (id === undefined || id === '' || parts.length === 0) return undefined;
      try {
        return { sessionId: decodeURIComponent(id), path: parts.map(decodeURIComponent).join('/') };
      } catch (_error) {
        return undefined;
      }
    }

    /**
     * Скачать файл через хост-роут: ответ превращается в Blob и обычную ссылку.
     * @param {object} body - тело запроса.
     * @param {string} fallbackName - имя, если сервер не прислал.
     * @returns {Promise<void>} завершение скачивания.
     */
    async function downloadViaHost(body, fallbackName) {
      const response = await fetch(DOWNLOAD_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const message = await response.json().then((value) => value?.message).catch(() => null);
        throw new Error(message ?? `Не удалось скачать (${response.status})`);
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      let name = fallbackName;
      if (encoded !== undefined) {
        try { name = decodeURIComponent(encoded); } catch (_error) { /* имя остаётся запасным */ }
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name || 'file';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    /**
     * Положить текст в буфер обмена с запасным путём для старых WebView.
     * @param {string} value - текст.
     * @returns {Promise<void>} завершение.
     */
    async function copyText(value) {
      try {
        const write = primitives?.writeClipboard;
        if (typeof write === 'function') {
          await write(value);
          return;
        }
        if (navigator.clipboard?.writeText !== undefined) {
          await navigator.clipboard.writeText(value);
          return;
        }
      } catch (_error) {
        /* ниже запасной путь */
      }
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand?.('copy'); } catch (_error) { /* ничего */ }
      area.remove();
    }

    /**
     * Скопировать путь через хост; если хост старый/недоступен — запасной текст.
     * @param {object} body - тело запроса пути.
     * @param {string} fallback - что копировать при ошибке.
     * @returns {Promise<void>} завершение.
     */
    async function copyPathViaHost(body, fallback) {
      try {
        const response = await fetch(FILE_PATH_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await response.json().catch(() => null);
        if (response.ok && typeof result?.path === 'string' && result.path !== '') {
          await copyText(result.path);
          return;
        }
      } catch (_error) {
        /* копируем запасной путь */
      }
      await copyText(fallback);
    }

    /**
     * Найти durable-ссылку файла у карточки вложения через React fiber.
     * В DOM у карточки есть только имя; сам ref лежит в props содержимого.
     * @param {object} card - DOM-карточка файла.
     * @returns {object | null} durable ref либо null.
     */
    function fileRefOfCard(card) {
      try {
        const key = Object.keys(card).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
        let fiber = key === undefined ? null : card[key];
        const title = card.getAttribute('title') ?? '';
        for (let depth = 0; depth < 20 && fiber !== null; depth += 1, fiber = fiber.return) {
          const attachments = fiber.memoizedProps?.content?.attachments;
          if (Array.isArray(attachments)) {
            const match = attachments.find((item) => item?.type === 'file' && item.file?.name === title);
            if (match !== undefined) return match.file;
          }
        }
      } catch (_error) {
        /* fiber недоступен — пункт меню будет неактивен */
      }
      return null;
    }

    /** Пункты «Скачать» и «Копировать путь» в меню вкладки файла. */
    function DownloadTabMenuItem({ tab, dismiss }) {
      const parsed = parseDshFileAddress(tab?.contentId);
      if (parsed === undefined) return null;
      const download = () => {
        dismiss?.();
        downloadViaHost({ sessionId: parsed.sessionId, path: parsed.path, name: tab.title }, tab.title).catch((error) => {
          window.alert?.(error instanceof Error ? error.message : 'Не удалось скачать файл');
        });
      };
      const copyPath = () => {
        dismiss?.();
        copyPathViaHost({ sessionId: parsed.sessionId, path: parsed.path, name: tab.title }, parsed.path).catch((error) => {
          window.alert?.(error instanceof Error ? error.message : 'Не удалось скопировать путь');
        });
      };
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', { type: 'button', role: 'menuitem', className: 'dsh-tweaks-download-item', onClick: download }, 'Скачать'),
        React.createElement('button', { type: 'button', role: 'menuitem', className: 'dsh-tweaks-download-item', onClick: copyPath }, 'Копировать путь'),
      );
    }

    /**
     * Скачивание файлов: пункт в меню вкладки правой панели и долгое нажатие
     * на файловой карточке в чате.
     * @param {object} ctx - клиентский контекст.
     * @param {object} api - очистки твика.
     * @returns {void}
     */
    function setupFileDownload(ctx, api) {
      const own = typeof api?.own === 'function' ? api.own : () => {};
      const style = document.createElement('style');
      style.dataset.dshFileDownload = '';
      style.textContent = [
        '.dsh-tweaks-download-item{box-sizing:border-box;width:100%;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);text-align:left;font:inherit;font-size:12px;line-height:17px;padding:5px 8px;cursor:pointer}',
        '.dsh-tweaks-download-item:hover,.dsh-tweaks-download-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsh-tweaks-file-menu{position:fixed;z-index:120;min-width:132px;padding:4px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent)}',
        '.dsh-tweaks-file-menu button{display:block;width:100%;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);text-align:left;font:inherit;font-size:13px;padding:7px 10px;cursor:pointer}',
        '.dsh-tweaks-file-menu button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsh-tweaks-file-menu button:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      ].join('\n');
      document.head?.appendChild(style);
      own(() => style.remove());

      let menu = null;
      const closeMenu = () => {
        menu?.remove();
        menu = null;
      };
      const onDocumentDown = (event) => {
        if (menu !== null && !menu.contains(event.target)) closeMenu();
      };
      const onKey = (event) => {
        if (event.key === 'Escape') closeMenu();
      };
      document.addEventListener('pointerdown', onDocumentDown, true);
      document.addEventListener('keydown', onKey, true);
      own(() => {
        document.removeEventListener('pointerdown', onDocumentDown, true);
        document.removeEventListener('keydown', onKey, true);
        closeMenu();
      });

      /**
       * Открыть маленькое меню у точки нажатия.
       * @param {number} clientX - x.
       * @param {number} clientY - y.
       * @param {object | null} ref - durable-ссылка.
       * @param {string} name - имя файла.
       * @returns {void}
       */
      const openMenu = (clientX, clientY, ref, name) => {
        closeMenu();
        menu = document.createElement('div');
        menu.className = 'dsh-tweaks-file-menu';
        menu.setAttribute('role', 'menu');
        const sessionId = () => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session');
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.textContent = 'Скачать';
        item.disabled = ref === null;
        item.addEventListener('click', () => {
          if (ref === null) return;
          closeMenu();
          const id = sessionId();
          if (typeof id !== 'string' || id === '') return;
          downloadViaHost({ sessionId: id, attachment: ref }, name).catch((error) => {
            window.alert?.(error instanceof Error ? error.message : 'Не удалось скачать файл');
          });
        });
        const copyPath = document.createElement('button');
        copyPath.type = 'button';
        copyPath.setAttribute('role', 'menuitem');
        copyPath.textContent = 'Копировать путь';
        copyPath.addEventListener('click', () => {
          closeMenu();
          const id = sessionId();
          if (typeof id !== 'string' || id === '') return;
          if (ref === null) {
            copyText(name).catch(() => {});
            return;
          }
          copyPathViaHost({ sessionId: id, attachment: ref }, name).catch((error) => {
            window.alert?.(error instanceof Error ? error.message : 'Не удалось скопировать путь');
          });
        });
        menu.appendChild(item);
        menu.appendChild(copyPath);
        document.body.appendChild(menu);
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        menu.style.left = `${Math.round(Math.min(Math.max(8, clientX), window.innerWidth - width - 8))}px`;
        menu.style.top = `${Math.round(Math.min(Math.max(8, clientY), window.innerHeight - height - 8))}px`;
      };

      let holdTimer = null;
      let holdStart = null;
      const cancelHold = () => {
        if (holdTimer !== null) window.clearTimeout(holdTimer);
        holdTimer = null;
        holdStart = null;
      };
      const onPointerDown = (event) => {
        if (event.button > 0) return;
        const card = event.target?.closest?.('[class*="_fileCard"]');
        if (card === null || card === undefined) return;
        cancelHold();
        holdStart = { x: event.clientX, y: event.clientY, card };
        holdTimer = window.setTimeout(() => {
          holdTimer = null;
          if (holdStart === null) return;
          openMenu(holdStart.x, holdStart.y, fileRefOfCard(holdStart.card), holdStart.card.getAttribute('title') ?? 'file');
        }, 520);
      };
      const onPointerMove = (event) => {
        if (holdStart === null) return;
        if (Math.abs(event.clientX - holdStart.x) > 8 || Math.abs(event.clientY - holdStart.y) > 8) cancelHold();
      };
      const onPointerUp = () => cancelHold();
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerup', onPointerUp, true);
      document.addEventListener('pointercancel', onPointerUp, true);
      own(() => {
        cancelHold();
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('pointermove', onPointerMove, true);
        document.removeEventListener('pointerup', onPointerUp, true);
        document.removeEventListener('pointercancel', onPointerUp, true);
      });

      let slots;
      try {
        slots = typeof ctx?.get === 'function' ? ctx.get('slots') : undefined;
      } catch (_error) {
        slots = undefined;
      }
      if (typeof slots?.inject === 'function' && typeof slots?.register === 'function') {
        own(slots.inject('sidebar.right.tab.menu.item', () => slots.register(
          { name: 'sidebar.right.tab.menu.item', id: 'download', order: 40 },
          (props) => React.createElement(DownloadTabMenuItem, props),
        )));
      }
    }

    /* #endregion tweak-file-download */

    const TWEAKS = {
      mobileComposer: {
        title: 'Мобильный ввод: Enter переносит строку',
        titleKey: 'tweak.mobileComposer',
        support: 'all',
        defaultOn: true,
        activate(ctx, api) {
          setupMobileComposer(ctx, api);
        },
        // Собственных подписок нет: обработчики и слоты снимает own().
      },
      queueEditor: {
        title: 'Очередь: редактирование с вложениями',
        titleKey: 'tweak.queueEditor',
        support: 'all',
        // Единая форма с сохранением позиции; host-роут в tweaks/queue-edit-host.js.
        defaultOn: true,
        activate(ctx, api) {
          setupQueueEditor(ctx, api);
        },
      },
      fileDownload: {
        title: 'Скачивание файлов из чата и вкладок',
        titleKey: 'tweak.fileDownload',
        support: 'all',
        defaultOn: true,
        activate(ctx, api) {
          setupFileDownload(ctx, api);
        },
      },
      mobileSidebar: {
        title: 'Мобильное меню: выдвижная панель',
        titleKey: 'tweak.mobileSidebar',
        support: 'legacy',
        // Лёгкий твик: CSS, кнопка в шапке и подавление фокуса; хост-части нет.
        defaultOn: true,
        activate(ctx, api) {
          setupMobileSidebar(ctx, api);
        },
      },
      zoom: {
        title: 'Масштаб интерфейса',
        titleKey: 'tweak.zoom',
        support: 'all',
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
        support: 'all',
        defaultOn: true,
        activate(ctx, api) {
          attachContextMenu(ctx, api);
        },
      },
      whisper: {
        title: 'Распознавание русской речи',
        titleKey: 'tweak.whisper',
        support: 'all',
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
        support: 'all',
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
      freePanels: {
        title: 'Свободный размер панелей',
        titleKey: 'tweak.freePanels',
        support: 'mixed',
        // Штатный драг панелей клампит ширины (сайдбар 264–420, панель 300–70%
        // окна, центр не уже 400) — твик снимает эти лимиты.
        defaultOn: true,
        activate(ctx, api) {
          setupFreePanels(ctx, api.markReady, api.own);
        },
        deactivate() {
          freePanelsBridge.reset?.();
        },
      },
      imageModelFallback: {
        title: 'Кнопка «отправить с Flash» для картинок',
        titleKey: 'tweak.imageModelFallback',
        support: 'all',
        // Лёгкий твик: плашка в доке над полем ввода, когда выбранная модель
        // не видит изображения. Модель-замена настраивается полями Config.
        defaultOn: true,
        activate(ctx, api) {
          setupImageModelFallback(ctx, api);
        },
        deactivate() {
          teardownImageModelFallback();
        },
        // Каркас зовёт refresh на каждый снимок конфигурации: из него берём
        // провайдера, модель и подпись кнопки.
        refresh({ value }) {
          const source = value !== null && typeof value === 'object' ? value : {};
          const provider = typeof source.imageFallbackProvider === 'string' && source.imageFallbackProvider !== '' ? source.imageFallbackProvider : 'deepseek-account';
          const model = typeof source.imageFallbackModel === 'string' && source.imageFallbackModel !== '' ? source.imageFallbackModel : 'deepseek-flash';
          const label = typeof source.imageFallbackLabel === 'string' && source.imageFallbackLabel !== '' ? source.imageFallbackLabel : 'Flash';
          imageFallbackConfig.provider = provider;
          imageFallbackConfig.model = model;
          imageFallbackConfig.label = label;
        },
      },
    };

    /** Активные твики: id → очистки его ресурсов. */
    const activeTweaks = new Map();

    /**
     * Диагностический выключатель: все твики выключены через `?tweaks=off`.
     * Форма флагов показывает по нему, почему включённые галочки ничего не делают.
     */
    let tweaksSwitchOff = false;

    /**
     * Включить твик, если он ещё не включён.
     * @param {object} ctx - клиентский контекст плагина.
     * @param {string} id - id твика в реестре.
     * @param {Function} markReady - отметка этапа инициализации.
     * @returns {void}
     */
    function enableTweak(ctx, id, markReady) {
      if (activeTweaks.has(id)) return;
      // Legacy-shell твики не включаем на новом ядре: там drawer, автоскрытие,
      // клавиатура, центр и меню «…» уже нативные. Флаг остаётся в форме для
      // установки на старую версию.
      if (TWEAKS[id].support === 'legacy' && coreFeatures().modernShell) {
        markReady(`skipped: ${id} (${coreVersion()} native)`);
        return;
      }
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
     * как вёл до появления флагов. Диагностический выключатель `?tweaks=off`
     * гасит все твики независимо от галочек: он и нужен, чтобы проверить
     * зависание без нашего слоя, не снимая флаги по одному.
     * @param {object | undefined} controller - форма записи сервиса configForms.
     * @returns {object} id твика → включён ли он.
     */
    function readFlags(controller) {
      if (tweaksSwitchOff) {
        const off = {};
        for (const id of Object.keys(TWEAKS)) off[id] = false;
        return off;
      }
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
    const FORM_LABEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      minWidth: '0',
      flex: '1 1 auto',
    };
    const FORM_VERSION_STYLE = {
      display: 'block',
      color: 'var(--dsw-alias-label-tertiary)',
      font: '400 12px/16px system-ui, sans-serif',
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
            React.createElement(
              'span',
              { style: FORM_LABEL_STYLE },
              React.createElement('span', null, label),
              React.createElement(
                'span',
                { style: FORM_VERSION_STYLE, 'data-version-note': id },
                copy(`version.${id}`),
              ),
            ),
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
        if (checked && !tweaksSwitchOff && typeof tweak.renderDetail === 'function') {
          rows.push(React.createElement('div', { key: `${id}-detail` }, tweak.renderDetail({ controller, t, translate })));
        }
      }
      const coreLabel = copy('form.core').replace('{{version}}', coreVersion());
      const notices = [
        React.createElement('p', { key: 'core', style: FORM_NOTICE_STYLE, 'data-core-version': coreVersion() }, coreLabel),
        React.createElement('p', { key: 'hint', style: FORM_NOTICE_STYLE }, copy('form.hint')),
      ];
      if (tweaksSwitchOff) {
        notices.unshift(
          React.createElement('p', { key: 'switch-off-top', style: { ...FORM_NOTICE_STYLE, color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-primary))' } }, copy('settings.switchOff')),
        );
      }
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

    /** Кнопка «Твики» в подвале мобильной панели. */
    const SETTINGS_BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '6px',
      minWidth: '0',
      height: '32px',
      padding: '0 10px',
      border: '0.5px solid var(--dsw-alias-border-l2)',
      borderRadius: '10px',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: '500 13px/18px system-ui, sans-serif',
      cursor: 'pointer',
    };
    const SETTINGS_BACKDROP_STYLE = {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483000',
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      padding: '12px',
      boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-mask-1)',
    };
    const SETTINGS_WARNING_STYLE = {
      margin: '0 0 12px',
      padding: '10px 12px',
      border: '0.5px solid var(--dsw-alias-state-warning-primary, var(--dsw-alias-border-l2))',
      borderRadius: '10px',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: '400 13px/18px system-ui, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    };
    const SETTINGS_SHEET_STYLE = {
      boxSizing: 'border-box',
      width: 'min(520px, 100%)',
      maxHeight: '86vh',
      overflowY: 'auto',
      padding: '14px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
      border: '0.5px solid var(--dsw-alias-border-l2)',
      borderRadius: '16px',
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: 'var(--dsw-elevation-prominent)',
    };

    /**
     * Снять диагностический выключатель `?tweaks=off` и перезагрузить страницу.
     * @returns {void}
     */
    function enableAllTweaks() {
      try {
        window.localStorage?.removeItem(SWITCH_KEY);
      } catch (_error) {
        /* приватный режим: перезагрузка всё равно попробует */
      }
      const url = new URL(window.location.href);
      url.searchParams.delete('tweaks');
      window.location.replace(url.toString());
    }

    /**
     * Мобильная шторка с теми же флагами, что и страница пакета.
     * @param {object} props - controller и переводчик.
     * @returns {object | null} кнопка и шторка.
     */
    function TweaksSettingsButton(props) {
      const { controller, translate } = props;
      const [open, setOpen] = React.useState(false);
      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
      }, [open]);
      if (!mobileComposerDevice(window)) return null;
      const copy = (key) => (typeof translate === 'function' ? translate(key) : key);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'button',
          {
            type: 'button',
            'data-dsh-tweaks-settings': '',
            'aria-label': copy('settings.open'),
            style: SETTINGS_BUTTON_STYLE,
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            },
          },
          copy('settings.open'),
        ),
        open
          ? React.createElement(
              'div',
              {
                style: SETTINGS_BACKDROP_STYLE,
                'data-dsh-tweaks-settings-sheet': '',
                role: 'presentation',
                onMouseDown: (event) => {
                  if (event.target === event.currentTarget) setOpen(false);
                },
              },
              React.createElement(
                'section',
                {
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-label': copy('settings.title'),
                  style: SETTINGS_SHEET_STYLE,
                },
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '12px' } },
                  React.createElement('strong', { style: { font: '600 16px/22px system-ui, sans-serif' } }, copy('settings.title')),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      'aria-label': copy('settings.close'),
                      style: { border: '0', background: 'transparent', color: 'inherit', font: '400 22px/1 system-ui, sans-serif', cursor: 'pointer', padding: '2px 6px' },
                      onClick: () => setOpen(false),
                    },
                    '×',
                  ),
                ),
                tweaksSwitchOff
                  ? React.createElement(
                      'div',
                      { style: SETTINGS_WARNING_STYLE, 'data-dsh-tweaks-switch-off': '' },
                      React.createElement('span', null, copy('settings.switchOff')),
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          style: SETTINGS_BUTTON_STYLE,
                          onClick: enableAllTweaks,
                        },
                        copy('settings.enableAll'),
                      ),
                    )
                  : null,
                React.createElement(TweaksForm, { controller, t: copy, translate }),
              ),
            )
          : null,
      );
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
        // Диагностический выключатель читается до первого reconcile: `?tweaks=off`
        // должен не дать включиться ни одному твику, а не погасить их после старта.
        tweaksSwitchOff = readTweaksSwitch(storage);
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
          // Быстрый мобильный вход: та же форма, что на странице пакета, но
          // в собственной шторке — до неё не надо искать Plugins → Volna tweak.
          try {
            const translate = createTranslator(locale);
            scope.own(
              slots.inject('sidebar.footer.action', () =>
                slots.register(
                  {
                    name: 'sidebar.footer.action',
                    id: 'dsh-tweaks-settings',
                    order: -20,
                    inject: () => ({ controller, translate }),
                  },
                  TweaksSettingsButton,
                ),
              ),
            );
          } catch (error) {
            console.error('dsh-tweaks: мобильная кнопка твиков не подключена', error);
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
          // твики активны после каждой правки флагов. Состояние выключателя
          // пишется отдельно: по отметке на реальном телефоне видно, применён ли
          // `?tweaks=off` — иначе выключенные твики неотличимы от сломанных.
          markReady(
            tweaksSwitchOff
              ? 'applied: none (tweaks=off)'
              : `applied: ${[...activeTweaks.keys()].join(',') || 'none'}`,
          );
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
