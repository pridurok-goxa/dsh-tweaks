import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
 *     работать, дорогое время лишь не тратится фоном. Пустой ход после
 *     изъятого расписания отклоняется, чтобы не платить за него.
 *     Работа, начатая человеком, доводится до конца: субагент, порождённый
 *     из ручного шага, запоминается, и его итог (стиринг, сообщение команды)
 *     возвращается родителю как пользовательское сообщение — родитель не
 *     встаёт в очередь до конца пика (см. «Классификация шага»).
 *
 * Удержанное переживает перезапуск DSH: памятка в `$DSH_HOME/dsh-tweaks/held.json`
 * (доставка повторяется на зелёном, до 8 попыток), события пишутся в
 * `$DSH_HOME/dsh-tweaks/traffic-light.log` — journal владельцу недоступен.
 *
 * Классификация шага: батч автоматический ⇔ все сообщения автоматические.
 *   - пользовательские источники: user, parent (стиринг родителя),
 *     user-approval, user-question-reply, plan-mode, ptc-mode, fallback;
 *   - автоматические: schedule, goal, tool-goal, child,
 *     subagent-settled, agent-message, team-message;
 *   - parent/subagent у дочерних сессий разрешаются через autoMode:
 *     субагент, порождённый из ручного шага, работает и на красном;
 *   - родословная ручной работы: субагент, порождённый из ручного шага,
 *     запоминается (`manualChildren`, предел 256 записей, FIFO-вытеснение),
 *     и сообщение с id отправителя из памятки — итог (`subagent-settled`),
 *     стиринг (`agent-message`) или сообщение команды (`team-message`) —
 *     считается пользовательским: родитель не встаёт в очередь до конца
 *     пика. Цепочка работает вверх по уровням (итог ребёнка → родитель, на
 *     любую глубину). Сообщение без id отправителя или от отправителя вне
 *     памятки — автоматическое, как раньше;
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
const AUTOMATIC_KINDS = new Set([
  'schedule',
  'goal',
  'tool-goal',
  'child',
  'subagent-settled',
  'agent-message',
  'team-message',
]);
/** Источники сообщений, которые всегда считаются пользовательскими. */
const USER_KINDS = new Set(['user', 'parent', 'user-approval', 'user-question-reply', 'plan-mode', 'ptc-mode', 'fallback']);
/**
 * Служебные вставки в батч шага: контекст времени и рантайма, каталог скилов,
 * инструкции, напоминания о повторе инструментов и уведомления о работах.
 *
 * Их подмешивают сам цикл агента и другие плагины, поэтому к решению «ручная
 * работа или автоматическая» они отношения не имеют. Без этого списка каждый
 * шаг выглядел пользовательским: цикл добавляет `runtime-context` в каждый батч,
 * а `time-context` — почти в каждый, и пауза на красном не включалась ни разу.
 */
const NEUTRAL_KINDS = new Set([
  'time-context',
  'runtime-context',
  'skill-catalog',
  'agent-instructions',
  'repeat-tool-reminder',
  'tool-jobs',
  'model-selection',
  'compact-checkpoint',
]);

/** Виды сообщений, у которых в источнике есть id отправителя-сессии. */
const MANUAL_LINEAGE_KINDS = new Set(['subagent-settled', 'child', 'agent-message', 'team-message']);
/** Предел памятки ручных субагентов: переполнение только возвращает прежнее ожидание. */
const MANUAL_CHILDREN_LIMIT = 256;

/** Сколько раз пробуем вернуть удержанное напоминание, прежде чем признать потерю. */
const HELD_ATTEMPTS = 8;

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
 * Служба сессий: доставать при использовании — при активации её может ещё не быть.
 * @param {object | null} state - состояние хост-половины.
 * @returns {*} служба либо undefined.
 */
function sessionControllerOf(state) {
  if (state === null || state === undefined) return undefined;
  const cached = state.sessionController;
  if (cached !== undefined && cached !== null) return cached;
  const live = serviceOf(state.ctx, 'sessionController');
  if (live !== undefined && live !== null) state.sessionController = live;
  return live;
}

/**
 * Служба агентов: тоже достаётся при использовании, а не при активации.
 * @param {object | null} state - состояние хост-половины.
 * @returns {*} служба либо undefined.
 */
function agentsOf(state) {
  if (state === null || state === undefined) return undefined;
  const cached = state.agents;
  if (cached !== undefined && cached !== null) return cached;
  const live = serviceOf(state.ctx, 'agents');
  if (live !== undefined && live !== null) state.agents = live;
  return live;
}

/**
 * Записать сообщение в лог DSH; без логгера — тихо.
 * @param {string} message - текст сообщения.
 * @param {unknown} [error] - причина, если есть.
 * @returns {void}
 */
function log(message, error) {
  appendLogFile(message, error);
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
 * Каталог файлов твика в домашней папке DSH; без DSH_HOME — null.
 * @returns {string | null} каталог либо null.
 */
function stateDir() {
  const home = typeof process === 'object' ? process?.env?.DSH_HOME : undefined;
  return typeof home === 'string' && home !== '' ? join(home, 'dsh-tweaks') : null;
}

/**
 * Дописать строку в файл лога твика; без каталога и при ошибках — тихо.
 * @param {string} message - текст.
 * @param {unknown} [error] - причина.
 * @returns {void}
 */
function appendLogFile(message, error) {
  const dir = stateDir();
  if (dir === null) return;
  try {
    mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} ${message}${error === undefined ? '' : ` | ${String(error)}`}\n`;
    appendFileSync(join(dir, 'traffic-light.log'), line);
  } catch (_error) {
    /* диск недоступен: молчим */
  }
}

/**
 * Прочитать памятку удержанных напоминаний после перезапуска.
 * @returns {Array<[string, Array<object>]>} пары «сессия → сообщения».
 */
function loadHeldFile() {
  const dir = stateDir();
  if (dir === null) return [];
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'held.json'), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1]))
      .map((entry) => [entry[0], entry[1]]);
  } catch (_error) {
    return [];
  }
}

/**
 * Сохранить памятку удержанных напоминаний.
 * @param {Map<string, Array<object>>} held - удержанные сообщения.
 * @returns {void}
 */
function saveHeldFile(held) {
  const dir = stateDir();
  if (dir === null) return;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'held.json');
    if (held.size === 0) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify([...held.entries()]));
  } catch (_error) {
    /* диск недоступен: держим только в памяти */
  }
}

/**
 * Id сессии-отправителя из источника сообщения.
 *
 * `subagent-settled` и `agent-message` несут `senderSessionId`
 * (`dsh-subagent/lib/types/continuation-messages.d.ts:17,33`), `team-message` —
 * `senderId` (`dsh-goal/lib/typert.host.js:1259`), у `child` поля отправителя
 * нет (это элемент `list_agents`, а не источник сообщения) — тогда пусто.
 * @param {object} message - сообщение из входящих агента.
 * @returns {string} id сессии-отправителя либо ''.
 */
function senderSessionIdOf(message) {
  const source = message?.source;
  const raw = source?.senderSessionId ?? source?.senderId;
  return typeof raw === 'string' ? raw : '';
}

/**
 * Классификация одного сообщения по источнику.
 * @param {object} message - сообщение из входящих агента.
 * @param {boolean} autoMode - режим сессии (субагент ли это автоматического родителя).
 * @param {Map<string, string>} [manualChildren] - памятка ручных субагентов
 *   (`id сессии ребёнка → id сессии родителя`).
 * @returns {'auto' | 'user'} класс сообщения.
 */
function classifyMessage(message, autoMode, manualChildren) {
  const kind = message?.source?.kind;
  if (typeof kind !== 'string' || kind === '') return 'user';
  if (NEUTRAL_KINDS.has(kind)) return 'neutral';
  if (USER_KINDS.has(kind)) return 'user';
  if (AUTOMATIC_KINDS.has(kind)) {
    const senderId = senderSessionIdOf(message);
    if (MANUAL_LINEAGE_KINDS.has(kind) && senderId !== '' && manualChildren?.has(senderId) === true) return 'user';
    return 'auto';
  }
  if (kind === 'parent' || kind === 'subagent') return autoMode ? 'auto' : 'user';
  return 'user';
}

/**
 * Классификация батча шага.
 *
 * Служебные вставки игнорируются: решение принимают только сообщения-триггеры.
 * Если после них в батче ничего не осталось, шаг продолжает режим текущего хода
 * (`null`) — первый шаг хода всегда несёт триггер, которым ход начали, а
 * вставки контекста приходят на каждом следующем шаге.
 * @param {Array<object>} messages - сообщения батча.
 * @param {boolean} autoMode - режим сессии.
 * @param {Map<string, string>} [manualChildren] - памятка ручных субагентов.
 * @returns {'auto' | 'user' | null} класс батча либо null — наследовать режим хода.
 */
function classifyBatch(messages, autoMode, manualChildren) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let triggers = 0;
  let automatic = 0;
  for (const message of messages) {
    const kind = classifyMessage(message, autoMode, manualChildren);
    if (kind === 'neutral') continue;
    triggers += 1;
    if (kind === 'auto') automatic += 1;
  }
  if (triggers === 0) return null;
  return automatic === triggers ? 'auto' : 'user';
}

/**
 * Запомнить субагента, порождённого из ручного шага.
 *
 * Запись: `id сессии ребёнка → id сессии родителя`. Повторное рождение
 * освежает порядок (delete + set), чтобы вытеснялся действительно старший.
 * При переполнении забывается старшая запись: забытое сообщение снова
 * считается автоматическим, то есть возвращается прежнее поведение.
 * @param {string} childId - id сессии ребёнка.
 * @param {string} parentId - id сессии родителя.
 * @returns {void}
 */
function rememberManualChild(childId, parentId) {
  if (runtime === null) return;
  const manualChildren = runtime.manualChildren;
  manualChildren.delete(childId);
  manualChildren.set(childId, parentId);
  while (manualChildren.size > MANUAL_CHILDREN_LIMIT) {
    const oldest = manualChildren.keys().next();
    if (oldest.done === true) break;
    manualChildren.delete(oldest.value);
    log(`trafficLight: памятка ручных субагентов переполнена, «${oldest.value}» забыт`);
  }
}

/**
 * Забыть всех детей выгружаемого агента.
 *
 * Записи самого выгруженного агента не удаляются: выгрузка handle ребёнка
 * (`dsh-subagent/lib/index.js:2039`) идёт **до** доставки его итога (`:2053`),
 * поэтому удалять метку по `childId` нельзя — родословная потеряется и баг
 * вернётся. Забываются только записи, у которых родитель — выгружаемый агент.
 * @param {string} parentId - id сессии выгружаемого агента.
 * @returns {void}
 */
function forgetManualChildrenOf(parentId) {
  if (runtime === null) return;
  for (const [childId, ownerId] of [...runtime.manualChildren]) {
    if (ownerId === parentId) runtime.manualChildren.delete(childId);
  }
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
  if (state.held.size === 0) {
    saveHeldFile(state.held);
    return;
  }
  const controller = sessionControllerOf(state);
  if (controller === undefined || typeof controller.resolveAgent !== 'function') {
    log('trafficLight: удержанные напоминания не вернуть — нет службы sessionController');
    return;
  }
  for (const [sessionId, messages] of [...state.held.entries()]) {
    const attempts = (state.heldAttempts.get(sessionId) ?? 0) + 1;
    state.heldAttempts.set(sessionId, attempts);
    if (attempts > HELD_ATTEMPTS) {
      state.held.delete(sessionId);
      state.heldAttempts.delete(sessionId);
      log(`trafficLight: удержанные напоминания сессии ${sessionId} потеряны`);
      continue;
    }
    try {
      const resolved = await controller.resolveAgent(sessionId);
      if (resolved === null || resolved === undefined || 'error' in resolved) {
        // Сессию не вернуть прямо сейчас — попробуем на следующем пересчёте.
        log(`trafficLight: напоминание сессии ${sessionId} ждёт повтора`);
        continue;
      }
      for (const message of messages) resolved.agent.followup(message);
      state.held.delete(sessionId);
      state.heldAttempts.delete(sessionId);
      log(`trafficLight: удержанные напоминания сессии ${sessionId} возвращены`);
    } catch (error) {
      log(`trafficLight: не удалось вернуть напоминания сессии ${sessionId}`, error);
    }
  }
  saveHeldFile(state.held);
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
  saveHeldFile(runtime.held);
  log(`trafficLight: напоминание «${message.id}» удержано до конца пика`);
}

/**
 * Пересчитать цвет светофора и обработать переход.
 * @returns {void}
 */
function refresh() {
  if (runtime === null) return;
  const next = lightAt(Date.now(), runtime.policy);
  if (next !== runtime.light) {
    const previous = runtime.light;
    runtime.light = next;
    log(`trafficLight: ${previous} → ${next}`);
    if (previous === 'red') for (const waiter of [...runtime.waiters]) waiter.done();
  }
  // Недоставленное (служба сессий не готова, сессия занята) повторяем на каждом
  // пересчёте, пока свет зелёный: удержанное не должно пропасть из-за гонки.
  if (runtime.light === 'green' && runtime.held.size > 0) void redeliverHeld();
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
    held: new Map(loadHeldFile()),
    heldAttempts: new Map(),
    stepAutomatic: new Map(),
    autoMode: new Map(),
    manualChildren: new Map(),
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
            const batch = classifyBatch(
              step?.messages,
              runtime.autoMode.get(agent.id) === true,
              runtime.manualChildren,
            );
            if (
              batch === null &&
              step?.step === 1 &&
              runtime.light === 'red' &&
              runtime.pauseAgents === true
            ) {
              // Ход открылся без собственного ввода: доставку расписания на
              // красном мы изъяли, а wake-латч всё равно завёл ход. Любой
              // модельный вызов здесь — пустая трата дорогих токенов, поэтому
              // отклоняем шаг (в батче только служебные вставки, терять нечего).
              log(`trafficLight: пустой ход сессии ${agent.id} отклонён на красном`);
              return Promise.resolve({ kind: 'reject' });
            }
            // null — батч из одних служебных вставок: режим хода не меняем.
            if (batch !== null) runtime.stepAutomatic.set(agent.id, batch === 'auto');
            return next();
          }));
          off.push(agent.ctx.on('agent/inbox/inserted', (payload) => {
            holdScheduleMessage(agent, payload?.message);
          }));
          off.push(agent.ctx.on('subagent/start', (info) => {
            const childId = String(info?.id ?? '');
            if (childId === '') return;
            const automatic = runtime.stepAutomatic.get(agent.id) === true;
            runtime.autoMode.set(childId, automatic);
            // Новая активация из автошага снимает устаревшую ручную метку:
            // иначе повторный старт continuable-ребёнка отпустил бы авто-работу.
            if (automatic) runtime.manualChildren.delete(childId);
            else rememberManualChild(childId, agent.id);
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
      // Забываем только детей выгружаемого: его собственная запись обязана
      // пережить выгрузку, потому что handle ребёнка выгружается до доставки
      // итога (`dsh-subagent/lib/index.js:2039` и `:2053`).
      forgetManualChildrenOf(id);
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
        id = String(agentsOf(runtime)?.currentInitiator?.()?.id ?? '');
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
  previous.manualChildren.clear();
  for (const waiter of [...previous.waiters]) waiter.done();
  previous.waiters.clear();
  runtime = null;
  await redeliverHeld(previous);
}
