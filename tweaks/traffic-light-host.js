/**
 * Хост-половина твика «светофор» (trafficLight) бандла dsh-tweaks.
 *
 * Что делает:
 *  1. Считает цвет светофора по политике тарифов DeepSeek
 *     (`traffic-light-policy.js`) и следит за переходами.
 *  2. На красном удерживает доставку расписаний: сообщение с источником
 *     `schedule` снимается из входящих агента и возвращается в работу на
 *     зелёном через `sessionController.resolveAgent` + `agent.followup`.
 *  3. На красном приостанавливает автоматические шаги агентов и субагентов
 *     на ближайшем модельном вызове (`llm/stream`): вызов ждёт зелёного.
 *     Ручные сообщения разработчика не блокируются — на красном можно
 *     работать, дорогое время лишь не тратится фоном.
 *
 * Классификация шага: батч автоматический ⇔ все сообщения автоматические.
 *   - пользовательские источники: user, parent (стиринг родителя),
 *     user-approval, user-question-reply, plan-mode, ptc-mode, fallback;
 *   - автоматические: schedule, goal, subagent, child, subagent-settled,
 *     agent-message;
 *   - parent/subagent у дочерних сессий разрешаются через autoMode:
 *     субагент, порождённый из ручного шага, работает и на красном;
 *   - неизвестные источники — как пользовательские (fail-open: никогда
 *     не блокируем то, чего не понимаем).
 *
 * Вызов модели, уже начавшийся в момент включения красного, дорабатывает;
 * жёлтое окно предупреждения существует именно для того, чтобы работа
 * завершилась до пика. Удержанные напоминания живут в памяти хоста: рестарт
 * DSH во время красного теряет их (получатель уже помечен «доставлено»
 * самим планировщиком) — ограничение задокументировано в README.
 *
 * Интерфейс модуля: `activate(ctx, config)`, `update(config)`, `deactivate()`
 * (деактивация асинхронная: сначала раздаёт удержанное).
 *
 * @module dsh-tweaks/traffic-light-host
 */

import { lightAt, normalizePolicy } from './traffic-light-policy.js';

/** Период пересчёта цвета светофора. */
const REFRESH_MS = 15_000;

/** Источники сообщений, которые всегда считаются автоматическими. */
const AUTOMATIC_KINDS = new Set(['schedule', 'goal', 'child', 'subagent-settled', 'agent-message']);
/** Источники сообщений, которые всегда считаются пользовательскими. */
const USER_KINDS = new Set(['user', 'user-approval', 'user-question-reply', 'plan-mode', 'ptc-mode', 'fallback']);

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
 * Записать сообщение в лог DSH; без логгера — тихо.
 * @param {string} message - текст сообщения.
 * @param {unknown} [error] - причина, если есть.
 * @returns {void}
 */
function log(message, error) {
  const logger = runtime?.logger;
  if (logger === undefined || logger === null) return;
  try {
    if (error === undefined) logger.info(message);
    else logger.warn(message, error);
  } catch (_error) {
    /* логгер сломан: молчим */
  }
}

/**
 * Классификация одного сообщения по источнику.
 * @param {object} message - сообщение из входящих агента.
 * @param {boolean} autoMode - режим сессии (субагент ли это автоматического родителя).
 * @returns {'auto' | 'user'} класс сообщения.
 */
function classifyMessage(message, autoMode) {
  const kind = message?.source?.kind;
  if (typeof kind !== 'string' || kind === '') return 'user';
  if (USER_KINDS.has(kind)) return 'user';
  if (AUTOMATIC_KINDS.has(kind)) return 'auto';
  if (kind === 'parent' || kind === 'subagent') return autoMode ? 'auto' : 'user';
  return 'user';
}

/**
 * Классификация батча шага: автоматический, только если все сообщения
 * автоматические. Пустой батч — пользовательский.
 * @param {Array<object>} messages - сообщения батча.
 * @param {boolean} autoMode - режим сессии.
 * @returns {'auto' | 'user'} класс батча.
 */
function classifyBatch(messages, autoMode) {
  if (!Array.isArray(messages) || messages.length === 0) return 'user';
  for (const message of messages) {
    if (classifyMessage(message, autoMode) !== 'auto') return 'user';
  }
  return 'auto';
}

/**
 * Обещание, разрешающееся, когда красный закончится, сигнал прервётся
 * или хост-половина остановится.
 * @param {AbortSignal} [signal] - сигнал текущего вызова.
 * @returns {Promise<void>} разрешается при выходе из красного.
 */
function untilGreen(signal) {
  if (runtime === null || runtime.light !== 'red') return Promise.resolve();
  return new Promise((resolve) => {
    let waiter;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (waiter !== undefined) runtime?.waiters.delete(waiter);
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch (_error) {
        /* сигнал без removeEventListener */
      }
      resolve();
    };
    const onAbort = () => done();
    waiter = { done };
    runtime.waiters.add(waiter);
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    } catch (_error) {
      /* сигнал без addEventListener */
    }
  });
}

/**
 * Раздать удержанные напоминания: вернуть их в работу на зелёном.
 *
 * Порядок повторяет доставку планировщика: сессия поднимается через
 * `sessionController.resolveAgent`, сообщение уходит в `followup`.
 * @param {object} [state] - состояние хост-половины (по умолчанию активное).
 * @returns {Promise<void>}
 */
async function redeliverHeld(state = runtime) {
  if (state === null) return;
  const controller = state.sessionController;
  const held = [...state.held.entries()];
  state.held.clear();
  if (held.length === 0) return;
  if (controller === undefined || typeof controller.resolveAgent !== 'function') {
    log('trafficLight: удержанные напоминания не вернуть — нет службы sessionController');
    return;
  }
  for (const [sessionId, messages] of held) {
    try {
      const resolved = await controller.resolveAgent(sessionId);
      if (resolved === null || resolved === undefined || 'error' in resolved) {
        log(`trafficLight: удержанное напоминание для сессии ${sessionId} потеряно`);
        continue;
      }
      for (const message of messages) resolved.agent.followup(message);
      log(`trafficLight: удержанные напоминания сессии ${sessionId} возвращены`);
    } catch (error) {
      log(`trafficLight: не удалось вернуть напоминания сессии ${sessionId}`, error);
    }
  }
}

/**
 * Удержать сообщение расписания на красном: снять из входящих и запомнить.
 * @param {object} agent - агент-получатель.
 * @param {object} message - сообщение из события agent/inbox/inserted.
 * @returns {void}
 */
function holdScheduleMessage(agent, message) {
  if (runtime === null || runtime.light !== 'red' || runtime.pauseSchedules !== true) return;
  if (message?.source?.kind !== 'schedule') return;
  try {
    agent.inbox.remove(message.id);
  } catch (error) {
    log('trafficLight: не удалось снять напоминание из входящих', error);
    return;
  }
  const list = runtime.held.get(agent.id) ?? [];
  list.push(message);
  runtime.held.set(agent.id, list);
  log(`trafficLight: напоминание «${message.id}» удержано до конца пика`);
}

/**
 * Пересчитать цвет светофора и обработать переход.
 * @returns {void}
 */
function refresh() {
  if (runtime === null) return;
  const next = lightAt(Date.now(), runtime.policy);
  if (next === runtime.light) return;
  const previous = runtime.light;
  runtime.light = next;
  log(`trafficLight: ${previous} → ${next}`);
  if (previous === 'red') {
    for (const waiter of [...runtime.waiters]) waiter.done();
    void redeliverHeld();
  }
}

/**
 * Включить хост-половину.
 * @param {object} ctx - контекст плагина.
 * @param {object} config - плоская конфигурация твика.
 * @returns {void}
 */
export function activate(ctx, config) {
  if (runtime !== null) return;
  runtime = {
    ctx,
    policy: normalizePolicy(config),
    light: 'green',
    pauseAgents: config?.trafficLightPauseAgents !== false,
    pauseSchedules: config?.trafficLightPauseSchedules !== false,
    held: new Map(),
    stepAutomatic: new Map(),
    autoMode: new Map(),
    waiters: new Set(),
    agents: serviceOf(ctx, 'agents'),
    sessionController: serviceOf(ctx, 'sessionController'),
    logger: serviceOf(ctx, 'logger'),
    interval: null,
    agentDisposers: new Map(),
    rootDisposers: [],
  };

  runtime.rootDisposers.push(
    ctx.on('agent/created', (payload) => {
      const agent = payload?.agent;
      if (agent === undefined || typeof agent?.ctx?.effect !== 'function') return;
      let disposer;
      try {
        disposer = agent.ctx.effect(() => {
          const off = [];
          off.push(agent.ctx.on('agent/pre-step', (step, next) => {
            const batch = classifyBatch(step?.messages, runtime.autoMode.get(agent.id) === true);
            runtime.stepAutomatic.set(agent.id, batch === 'auto');
            return next();
          }));
          off.push(agent.ctx.on('agent/inbox/inserted', (payload) => {
            holdScheduleMessage(agent, payload?.message);
          }));
          off.push(agent.ctx.on('subagent/start', (info) => {
            const childId = String(info?.id ?? '');
            if (childId === '') return;
            runtime.autoMode.set(childId, runtime.stepAutomatic.get(agent.id) === true);
          }));
          return () => {
            for (const dispose of off) dispose();
            runtime.stepAutomatic.delete(agent.id);
            runtime.autoMode.delete(agent.id);
          };
        });
      } catch (error) {
        log(`trafficLight: не удалось подключиться к агенту ${agent.id}`, error);
        return;
      }
      runtime.agentDisposers.set(agent.id, disposer);
    }),
  );

  runtime.rootDisposers.push(
    ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id;
      if (id === undefined) return;
      const disposer = runtime.agentDisposers.get(id);
      if (disposer !== undefined) {
        try {
          disposer();
        } catch (error) {
          log(`trafficLight: очистка агента ${id} прервана`, error);
        }
        runtime.agentDisposers.delete(id);
      }
      runtime.stepAutomatic.delete(id);
      runtime.autoMode.delete(id);
    }),
  );

  runtime.rootDisposers.push(
    ctx.on('llm/stream', async function* (options, next) {
      if (runtime === null || runtime.light !== 'red' || runtime.pauseAgents !== true) {
        yield* next();
        return;
      }
      if (options?.purpose !== undefined) {
        yield* next();
        return;
      }
      let id = '';
      try {
        id = String(runtime.agents?.currentInitiator?.()?.id ?? '');
      } catch (_error) {
        id = '';
      }
      if (id === '') id = String(options?.sessionId ?? '');
      if (id === '' || runtime.stepAutomatic.get(id) !== true) {
        yield* next();
        return;
      }
      log(`trafficLight: модельный вызов сессии ${id} ждёт конца пика`);
      await untilGreen(options?.signal);
      yield* next();
    }),
  );

  runtime.interval = setInterval(refresh, REFRESH_MS);
  refresh();
}

/**
 * Применить новую конфигурацию без перезапуска: политика и флаги пауз
 * подхватываются, удержанные напоминания сохраняются.
 * @param {object} config - плоская конфигурация твика.
 * @returns {void}
 */
export function update(config) {
  if (runtime === null) return;
  runtime.policy = normalizePolicy(config);
  runtime.pauseAgents = config?.trafficLightPauseAgents !== false;
  runtime.pauseSchedules = config?.trafficLightPauseSchedules !== false;
  refresh();
}

/**
 * Выключить хост-половину: остановить таймер, снять слушателей, разбудить
 * ожидающие вызовы и вернуть удержанные напоминания (твик выключен — паузы
 * больше нет, поэтому удержанное отдаётся сразу).
 * @returns {Promise<void>}
 */
export async function deactivate() {
  if (runtime === null) return;
  const previous = runtime;
  if (previous.interval !== null) clearInterval(previous.interval);
  for (const disposer of previous.rootDisposers) {
    try {
      disposer();
    } catch (error) {
      log(`trafficLight: снятие слушателя прервано`, error);
    }
  }
  for (const disposer of [...previous.agentDisposers.values()]) {
    try {
      disposer();
    } catch (error) {
      log(`trafficLight: очистка агента прервана`, error);
    }
  }
  previous.agentDisposers.clear();
  previous.stepAutomatic.clear();
  previous.autoMode.clear();
  for (const waiter of [...previous.waiters]) waiter.done();
  previous.waiters.clear();
  runtime = null;
  await redeliverHeld(previous);
}
