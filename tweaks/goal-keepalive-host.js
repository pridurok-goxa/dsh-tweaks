import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Хост-половина твика «цель живёт» (goalKeepalive) бандла dsh-tweaks.
 *
 * Зачем: активация цели (`armed`/`disarmed`) живёт только в процессе DSH и
 * после рестарта, fork или resume сессии снимается в `disarmed`. Tool-политика
 * `tool-goal` разрешает `resume` только на ходу человека, поэтому до сих пор
 * требовалась ручная кнопка «Resume goal». Этот твик возвращает активацию сам:
 * сервисный вызов `goals.resume(agent, ref)` идёт мимо tool-политики.
 *
 * Что делает:
 *  1. На старте инстанса обходит живые агенты (`agents.list()`) и возвращает
 *     активацию тем целям, у которых `phase=active && activation=disarmed`.
 *  2. Подписан на `goal/activation-changed` и `agent/created`: любое снятие
 *     активации (старт сессии, fork, resume) немедленно возвращается.
 *  3. `paused` (человек сам поставил паузу), `complete` и `blocked` не трогает.
 *  4. Перед вызовом читает актуальное состояние; ошибку устаревшей `revision`
 *     и «уже armed» глотает — цель уже изменилась, повтор не нужен.
 *
 * Наблюдаемость: одна строка на событие в `$DSH_HOME/dsh-tweaks/goal-keepalive.log`
 * (`ts | session | goal | was→now | reason`), ротация по 1 МБ. Journal владельцу
 * недоступен, поэтому лог — файл.
 *
 * Отказоустойчивость: вся работа в try/catch; исключение не поднимается в
 * загрузчик плагина, твик уходит в пассивный режим, штатная кнопка работает.
 *
 * Интерфейс модуля: `activate(ctx, config)`, `update(config)`, `deactivate()`;
 * для тестов — `shouldResume(goal)` и `resumeIfNeeded(agent, reason, deps)`.
 *
 * @module dsh-tweaks/goal-keepalive-host
 */

/** Имя файла журнала твика. */
const LOG_NAME = 'goal-keepalive.log';

/** Порог ротации журнала. */
const LOG_MAX_BYTES = 1024 * 1024;

/** Пауза перед стартовым обходом: сессии успевают подняться. */
const START_SWEEP_DELAY_MS = 1500;

/** Периодический скан после старта: рестарт не даёт события, цель остаётся disarmed. */
const SCAN_TICK_MS = 15_000;

/** Сколько тиков скана отрабатывает после старта (≈2 минуты). */
const SCAN_TICKS = 8;

/** Одно активное состояние хост-половины. */
let runtime = null;

/**
 * Служба контекста по имени; доступ защищён — службы может не быть.
 * @param {object} ctx - контекст плагина.
 * @param {string} name - имя службы.
 * @returns {*} служба либо undefined.
 */
function serviceOf(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch (_error) {
    return undefined;
  }
}

/**
 * Каталог файлов твика в домашней папке DSH; без DSH_HOME — null.
 * @returns {string | null} каталог либо null.
 */
function stateDir() {
  const home = typeof process === 'object' ? process?.env?.DSH_HOME : undefined;
  return typeof home === 'string' && home !== '' ? join(home, 'dsh-tweaks') : null;
}

/**
 * Дописать строку в журнал твика с ротацией по 1 МБ; при ошибках — тихо.
 * @param {string} line - готовая строка без перевода строки.
 * @returns {void}
 */
function appendLogFile(line) {
  const dir = stateDir();
  if (dir === null) return;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, LOG_NAME);
    try {
      if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch (_error) {
      /* файла ещё нет — ротировать нечего */
    }
    appendFileSync(path, `${line}\n`);
  } catch (_error) {
    /* диск недоступен: журнал не пишем, работу продолжаем */
  }
}

/**
 * Записать событие твика: файл журнала и (если есть) логгер DSH.
 * @param {string} line - строка события.
 * @param {unknown} [error] - причина, если есть.
 * @returns {void}
 */
function log(line, error) {
  appendLogFile(error === undefined ? line : `${line} | ${String(error)}`);
  const logger = runtime?.logger;
  if (logger === undefined || logger === null) return;
  try {
    if (error === undefined) logger.info(`goalKeepalive: ${line}`);
    else logger.warn(`goalKeepalive: ${line}`, error);
  } catch (_error) {
    /* логгер сломан: журнал уже записан */
  }
}

/**
 * Нужно ли возвращать активацию этой цели.
 *
 * Возвращает true только для `phase=active && activation=disarmed`: пауза
 * человека, завершённая и заблокированная цель остаются как есть.
 * @param {{ phase?: unknown, activation?: unknown } | null | undefined} goal - вид цели.
 * @returns {boolean} true — цель активна, но продолжение снято.
 */
export function shouldResume(goal) {
  if (goal === null || goal === undefined || typeof goal !== 'object') return false;
  return goal.phase === 'active' && goal.activation === 'disarmed';
}

/**
 * Считать текущее состояние цели, не поднимая исключение наружу.
 * @param {*} goals - служба целей.
 * @param {object} agent - живой агент сессии.
 * @returns {{ goal?: object } | null} вид цели либо null.
 */
function readGoal(goals, agent) {
  try {
    const view = goals.get(agent);
    return view === null || view === undefined ? null : view;
  } catch (_error) {
    // Проекция цели может быть не зарегистрирована для этой сессии, а агент —
    // уже не живым: повода считать это ошибкой нет.
    return null;
  }
}

/**
 * Живой ли агент в реестре прямо сейчас.
 *
 * `goals.get`/`goals.resume` требуют именно живой агент (сравнение по
 * идентичности), поэтому не-live пропускаем до вызова сервиса.
 * @param {*} agents - служба агентов.
 * @param {object} agent - кандидат.
 * @returns {boolean} true — агент живой; без службы агентов считаем живым.
 */
function isLive(agents, agent) {
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return true;
  try {
    return agents.get(String(agent?.id ?? '')) === agent;
  } catch (_error) {
    return false;
  }
}

/**
 * Маркер причины пропуска по коду ошибки сервиса целей.
 * @param {unknown} error - ошибка `goals.resume`.
 * @returns {string} not-live | revision-stale | already-armed | rounds-exhausted | error.
 */
function skipMarker(error) {
  const code = String(error?.code ?? '');
  if (code.includes('NOT_LIVE')) return 'not-live';
  if (code.includes('STALE_REVISION')) return 'revision-stale';
  if (code.includes('INVALID_TRANSITION')) return String(error?.message ?? '').includes('already active and armed') ? 'already-armed' : 'invalid-transition';
  if (code.includes('NOT_FOUND')) return 'not-found';
  if (String(error?.message ?? '').includes('exhausted')) return 'rounds-exhausted';
  return 'error';
}

/**
 * Вернуть активацию цели, если она активна и снята.
 *
 * Перед вызовом читает актуальное состояние (защита от устаревшей `revision`),
 * не-live агентов пропускает, повторное событие по той же ревизии не даёт
 * второго `resume`, а ошибки сервиса («уже armed», устаревшая ревизия,
 * исчерпанный бюджет раундов) глотает с маркером в журнале.
 * @param {object} agent - живой агент сессии.
 * @param {string} reason - источник события: startup | activation-changed | agent-created.
 * @param {{ goals: *, agents?: *, done?: Map<string, number>, inflight?: Set<string> }} deps - службы и память попыток.
 * @returns {Promise<boolean>} true — активация восстановлена этим вызовом.
 */
export async function resumeIfNeeded(agent, reason, deps) {
  const goals = deps?.goals;
  if (goals === undefined || goals === null) return false;
  if (agent === null || agent === undefined || typeof agent !== 'object') return false;
  const sessionId = String(agent.id ?? 'unknown');
  const stamp = new Date().toISOString();
  if (!isLive(deps?.agents, agent)) {
    log(`${stamp} | ${sessionId} | - | disarmed→disarmed | ${reason} | not-live`);
    return false;
  }
  const goal = readGoal(goals, agent);
  if (!shouldResume(goal)) return false;
  const key = `${sessionId}:${String(goal.revision)}`;
  // Двойное событие по одной ревизии (и повтор после успеха) не даёт второго resume.
  if (deps?.done?.has(key) === true || deps?.inflight?.has(key) === true) {
    log(`${stamp} | ${sessionId} | ${String(goal.id)} | disarmed→disarmed | ${reason} | duplicate`);
    return false;
  }
  deps?.inflight?.add(key);
  try {
    goals.resume(agent, { id: goal.id, revision: goal.revision });
  } catch (error) {
    const marker = skipMarker(error);
    log(`${stamp} | ${sessionId} | ${String(goal.id)} | disarmed→disarmed | ${reason} | ${marker}`);
    if (marker === 'revision-stale') deps?.done?.set(key, Date.now());
    return false;
  } finally {
    deps?.inflight?.delete(key);
  }
  deps?.done?.set(key, Date.now());
  if (deps?.done !== undefined && deps.done.size > 200) {
    const first = deps.done.keys().next();
    if (first.done !== true) deps.done.delete(first.value);
  }
  log(`${stamp} | ${sessionId} | ${String(goal.id)} | disarmed→armed | ${reason}`);
  return true;
}

/**
 * Обойти живые агенты и вернуть снятую активацию всем подходящим целям.
 * @param {string} reason - источник обхода.
 * @returns {Promise<number>} сколько целей возвращено.
 */
async function sweep(reason, tick) {
  const stamp = new Date().toISOString();
  if (runtime === null) return { agents: 0, resumed: 0, ready: false };
  const agents = serviceOf(runtime.ctx, 'agents');
  const goals = serviceOf(runtime.ctx, 'goals') ?? runtime.goals;
  // Сервисы могут монтироваться позже хоста: это нормальный, а не аварийный случай.
  if (agents === undefined || agents === null || goals === undefined || goals === null) {
    log(`${stamp} | - | - | -→disarmed | ${reason} | services-not-ready goals=${goals === undefined || goals === null ? 'no' : 'yes'} agents=${agents === undefined || agents === null ? 'no' : 'yes'}`);
    return { agents: 0, resumed: 0, ready: false };
  }
  runtime.goals = goals;
  runtime.agents = agents;
  let resumed = 0;
  let list;
  try {
    list = typeof agents.list === 'function' ? agents.list() : [];
  } catch (error) {
    log(`${stamp} | - | - | -→disarmed | ${reason} | agents-unavailable ${String(error?.message ?? error)}`);
    return { agents: 0, resumed: 0, ready: true, failed: true };
  }
  for (const agent of list) {
    try {
      const done = await resumeIfNeeded(agent, reason, { goals, agents, done: runtime.resumed, inflight: runtime.inflight });
      if (done) resumed += 1;
    } catch (error) {
      log(`${stamp} | ${String(agent?.id ?? '?')} | - | -→disarmed | ${reason} | error ${String(error?.message ?? error)}`);
    }
  }
  const head = tick === undefined ? reason : `${reason} | tick=${tick}`;
  log(`${stamp} | - | - | -→disarmed | ${head} | agents=${list.length} | resumed=${resumed}`);
  return { agents: list.length, resumed, ready: true };
}

/**
 * Обработать один агент по событию.
 * @param {object} agent - агент из события.
 * @param {string} reason - источник события.
 * @returns {Promise<void>}
 */
async function handleAgent(agent, reason) {
  if (runtime === null) return;
  if (agent === null || agent === undefined) return;
  const goals = runtime.goals ?? serviceOf(runtime.ctx, 'goals');
  if (goals === undefined || goals === null) return;
  runtime.goals = goals;
  try {
    await resumeIfNeeded(agent, reason, {
      goals,
      agents: serviceOf(runtime.ctx, 'agents'),
      done: runtime.resumed,
      inflight: runtime.inflight,
    });
  } catch (error) {
    log(`${new Date().toISOString()} | ${String(agent?.id ?? '?')} | - | -→disarmed | ${reason} | error`, error);
  }
}

/**
 * Остановить периодический скан и записать причину.
 * @param {string} reason - почему скан выключен.
 * @returns {void}
 */
function stopScan(reason) {
  if (runtime === null || runtime.scanTimer === null) return;
  try {
    clearInterval(runtime.scanTimer);
  } catch (_error) {
    /* таймер уже остановлен */
  }
  runtime.scanTimer = null;
  log(`${new Date().toISOString()} | - | - | -→disarmed | scan-stop | ${reason}`);
}

/**
 * Запустить скан: рестарт не порождает событий, поэтому цель надо найти самим.
 *
 * Тик раз в 15 с, не больше 8 тиков (~2 минуты). Скан выключается раньше, если
 * агенты уже видны и ни одной снятой активации не осталось.
 * @returns {void}
 */
function startScan() {
  if (runtime === null || typeof setInterval !== 'function') return;
  runtime.scanTimer = setInterval(() => {
    if (runtime === null) return;
    runtime.tick += 1;
    const tick = runtime.tick;
    void sweep('scan', tick).then((result) => {
      if (runtime === null) return;
      if (result.ready === true && result.agents > 0 && result.resumed === 0) stopScan(`tick=${tick} idle`);
      else if (tick >= SCAN_TICKS) stopScan(`tick=${tick} limit`);
    }).catch((error) => {
      log(`${new Date().toISOString()} | - | - | -→disarmed | scan | error ${String(error?.message ?? error)}`);
    });
  }, SCAN_TICK_MS);
  if (typeof runtime.scanTimer?.unref === 'function') runtime.scanTimer.unref();
}

/**
 * Сделать один обход прямо сейчас (нужно тестам и ctx.inject-колбэку).
 * @param {string} reason - источник обхода.
 * @param {number} [tick] - номер тика.
 * @returns {Promise<{agents: number, resumed: number, ready: boolean}>} итог обхода.
 */
export function sweepNow(reason, tick) {
  return sweep(reason, tick);
}

/**
 * Поднять хост-часть твика.
 *
 * Весь код в try/catch: сбой твика не должен ломать старт инстанса — при любой
 * ошибке твик остаётся в пассивном режиме, штатная кнопка «Resume goal» цела.
 * @param {object} ctx - хост-контекст плагина.
 * @param {unknown} [config] - конфигурация записи (используется флаг из index.js).
 * @returns {void}
 */
export function activate(ctx, config) {
  if (runtime !== null) return;
  const goals = serviceOf(ctx, 'goals');
  const agents = serviceOf(ctx, 'agents');
  const flag = config?.goalKeepalive;
  runtime = {
    ctx,
    config: config ?? {},
    logger: serviceOf(ctx, 'logger'),
    goals,
    agents,
    resumed: new Map(),
    inflight: new Set(),
    disposers: [],
    timer: null,
    scanTimer: null,
    tick: 0,
    active: true,
  };
  // Первая строка журнала: без неё не отличить «твик не поднялся» от «поднялся,
  // но сервисов ещё нет». Журнал — единственный доступный канал (journal пуст).
  log(`activate | goals=${goals === undefined || goals === null ? 'no' : 'yes'} | agents=${agents === undefined || agents === null ? 'no' : 'yes'} | config.goalKeepalive=${flag === false ? 'false' : 'true'}`);
  if (goals === undefined || goals === null || agents === undefined || agents === null) {
    // Хост-часть может подняться раньше сервисов целей/агентов: дождаться их.
    if (typeof ctx?.inject === 'function') {
      try {
        ctx.inject(['goals', 'agents'], () => {
          log(`${new Date().toISOString()} | - | - | -→disarmed | inject-ready | goals=yes agents=yes`);
          void sweep('inject-ready');
        });
      } catch (error) {
        log(`${new Date().toISOString()} | - | - | -→disarmed | inject | error ${String(error?.message ?? error)}`);
      }
    }
  }
  try {
    if (typeof ctx?.on === 'function') {
      runtime.disposers.push(
        ctx.on('goal/activation-changed', (payload) => {
          if (runtime === null || runtime.active !== true) return;
          try {
            if (payload?.goal?.activation !== 'disarmed') return;
            const agents = serviceOf(runtime.ctx, 'agents');
            const agent = agents !== undefined && agents !== null ? agents.get(payload.sessionId) : undefined;
            void handleAgent(agent, 'activation-changed');
          } catch (error) {
            log(`${new Date().toISOString()} | ${String(payload?.sessionId ?? '?')} | - | -→disarmed | activation-changed | error`, error);
          }
        }),
      );
      runtime.disposers.push(
        ctx.on('agent/created', (payload) => {
          if (runtime === null || runtime.active !== true) return;
          try {
            void handleAgent(payload?.agent, 'agent-created');
          } catch (error) {
            log(`${new Date().toISOString()} | ${String(payload?.agent?.id ?? '?')} | - | -→disarmed | agent-created | error`, error);
          }
        }),
      );
    }
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      void sweep('startup').catch((error) => log(`${new Date().toISOString()} | - | - | -→disarmed | startup | error ${String(error?.message ?? error)}`));
    }, START_SWEEP_DELAY_MS);
    if (typeof runtime.timer?.unref === 'function') runtime.timer.unref();
    startScan();
  } catch (error) {
    runtime.active = false;
    log(`${new Date().toISOString()} | - | - | -→disarmed | activate | error`, error);
  }
}

/**
 * Принять новую конфигурацию: твик читает только флаг, но интерфейс общий.
 * @param {unknown} config - новая конфигурация записи.
 * @returns {void}
 */
export function update(config) {
  if (runtime === null) return;
  runtime.config = config ?? runtime.config;
}

/**
 * Снять слушателей и таймер.
 * @returns {Promise<void>}
 */
export async function deactivate() {
  if (runtime === null) return;
  const state = runtime;
  runtime = null;
  state.active = false;
  if (state.scanTimer !== null) {
    try {
      clearInterval(state.scanTimer);
    } catch (_error) {
      /* таймер уже остановлен */
    }
  }
  if (state.timer !== null) {
    try {
      clearTimeout(state.timer);
    } catch (_error) {
      /* таймер уже отработал */
    }
  }
  for (const off of state.disposers) {
    try {
      if (typeof off === 'function') off();
    } catch (_error) {
      /* слушатель уже снят */
    }
  }
  state.disposers.length = 0;
  state.resumed.clear();
  state.inflight.clear();
}
