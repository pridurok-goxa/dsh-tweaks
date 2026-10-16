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
export const HOLIDAYS_2026 = [
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
export const DEFAULT_POLICY = Object.freeze({
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
export function parseClock(value) {
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
export function beijingParts(instantMs, policy = DEFAULT_POLICY) {
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
export function isPeakAt(instantMs, policy = DEFAULT_POLICY) {
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
export function nextSwitchAt(instantMs, policy = DEFAULT_POLICY) {
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
export function nextPeakStartAt(instantMs, policy = DEFAULT_POLICY) {
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
export function lightAt(instantMs, policy = DEFAULT_POLICY) {
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
export function normalizePolicy(config) {
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
