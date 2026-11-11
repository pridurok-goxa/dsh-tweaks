import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
 *  3. На красном останавливает модельный вызов (`llm/stream`) любой сессии,
 *     у которой нет спецсигнала: вызов ждёт зелёного. Остальные сообщения из
 *     входящих не изымаются — их ход просто ждёт, поэтому ничего не теряется.
 *     Вызовы с `purpose` (заголовок чата, компакция) — сервисные, они проходят
 *     сразу: иначе служебная работа хода встала бы вместе с ним.
 *  4. Спецсигнал («работаю на красном, дороже вдвое») включает только человек.
 *     Переключатель у лампы пишет список сессий в конфиг `trafficLightSpecial`,
 *     хост переносит его в леджер `$DSH_HOME/dsh-tweaks/special.json`
 *     (запись атомарная: tmp + rename; пустой список тоже пишется, иначе
 *     выключение воскресло бы после рестарта). Источник набора при активации:
 *     файл → значение конфига → seed (`SEED_SPECIAL` — включено по решению
 *     Игоря t1447u). Сообщения пропуск не дают: человеческий промпт, промпт
 *     continuable-субагента и стиринг неотличимы от сервисных отправок
 *     harness-relay/deputy (те же `clientTimeZone`, owner-cookie и `source`
 *     байт-в-байт), поэтому пропуск даёт только кнопка.
 *  5. Спецсигнал наследуется деревом субагентов: `hasSignal(id)` поднимается по
 *     `agent.session.header.parentSession` не больше `PARENT_HOPS_LIMIT` шагов,
 *     с защитой от цикла. Реестр агентов знает только живых, поэтому
 *     неизвестная сессия считается сессией без сигнала (fail-closed).
 *     Спецсигнал действует через любое число красных окон, пока человек его
 *     не выключит.
 *  6. Пустой ход (доставку изъяли, wake-латч открыл ход) на красном
 *     отклоняется: в батче из одних служебных вставок терять нечего. У сессии
 *     со спецсигналом такой ход не отклоняется — она работает.
 *
 * Удержанное переживает перезапуск DSH: памятка в `$DSH_HOME/dsh-tweaks/held.json`
 * (доставка повторяется на зелёном, до 8 попыток), события пишутся в
 * `$DSH_HOME/dsh-tweaks/traffic-light.log` — journal владельцу недоступен.
 *
 * Лог: строки `trafficLight: …` идут и в логгер DSH, как раньше; новые
 * структурированные события — только в файл лога:
 *   `pause | session=<id> | until=<ISO>` — модельный вызов встал на красном
 *     (раз на сессию за окно);
 *   `resume | session=<id> | after=green` — вызов отпущен зелёным;
 *   `signal | session=<id> | state=on|off | actor=ui-config|seed|config|file | rev=<n>`
 *     — набор спецсигнала изменён (rev — локальный монотонный счётчик);
 *   `state-conflict | file=<n> | config=<n> | authority=file` — файл и конфиг
 *     разошлись при активации (авторитетен файл);
 *   `save-error | reason=<код>` — леджер не записался, повтор на пересчёте;
 *   `signal-less | reason=no-initiator` — сессия вызова неизвестна, пропускаем.
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

import { lightAt, nextSwitchAt, normalizePolicy } from './traffic-light-policy.js';

/** Период пересчёта цвета светофора. */
const REFRESH_MS = 15_000;

/**
 * Служебные вставки в батч шага: контекст времени и рантайма, каталог скилов,
 * инструкции, напоминания о повторе инструментов и уведомления о работах.
 *
 * Их подмешивают сам цикл агента и другие плагины, поэтому признаком пустого
 * хода служат именно они: без этого списка каждый такой ход выглядел
 * содержательным и отклонялся бы зря.
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

/**
 * Сессии со спецсигналом по умолчанию — seed конфига (`trafficLightSpecial`)
 * и запасной набор хоста, если ни файла, ни значения конфига нет.
 * Включено по решению Игоря t1447u.
 */
const SEED_SPECIAL = ['session-e4698bf8-717f-4e1a-9390-a2b40c03d985'];

/** Предел подъёма по родословной: глубже спецсигнал не ищем (защита от цикла). */
const PARENT_HOPS_LIMIT = 32;

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
 * Записать сообщение в лог DSH и в файл твика; без логгера — только в файл.
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
 * Записать структурное событие только в файл лога (логгер DSH не трогаем:
 * там остаются прежние строки `trafficLight: …`).
 * @param {string} line - строка события по контракту §4.
 * @returns {void}
 */
function logLine(line) {
  appendLogFile(line);
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
 * Привести значение поля `trafficLightSpecial` к списку сессий.
 *
 * Порядок нормализуется сортировкой: значение сравнивается поэлементно, а
 * `Volatile.get()` отдаёт новый массив на каждое чтение конфигурации, поэтому
 * сравнение по ссылке ничего не значит. Неизвестное значение (`undefined`,
 * `null`, не массив) — это «поля нет», а не пустой список.
 * @param {unknown} value - значение поля конфигурации.
 * @returns {string[] | null} нормализованный список либо null.
 */
function normalizeSpecialList(value) {
  if (!Array.isArray(value)) return null;
  const list = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id === '' || list.includes(id)) continue;
    list.push(id);
  }
  return list.sort();
}

/**
 * Сравнить два нормализованных списка поэлементно.
 * @param {string[] | null} left - первый список.
 * @param {string[] | null} right - второй список.
 * @returns {boolean} true, если списки совпадают (в том числе оба null).
 */
function sameList(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

/**
 * Прочитать леджер спецсигнала.
 *
 * Файл авторитетен, поэтому битый или отсутствующий файл даёт null («файла
 * нет») — вызывающий откатывается к значению конфига и seed. Пустой массив
 * сессий — это осознанное «выключено», его нельзя спутать с отсутствием файла.
 * @returns {string[] | null} список сессий либо null.
 */
function loadSpecialFile() {
  const dir = stateDir();
  if (dir === null) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'special.json'), 'utf8'));
    const list = normalizeSpecialList(parsed?.sessions);
    return list;
  } catch (_error) {
    return null;
  }
}

/**
 * Записать леджер спецсигнала атомарно: tmp-файл + rename.
 *
 * Пустой список пишется намеренно: выключение из интерфейса должно пережить
 * рестарт DSH, а удалённый файл означал бы «взять seed» — сигнал воскрес бы.
 * @param {string[]} list - список сессий со спецсигналом.
 * @returns {string | null} код ошибки записи либо null при успехе.
 */
function writeSpecialFile(list) {
  const dir = stateDir();
  if (dir === null) return null;
  const file = join(dir, 'special.json');
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify({ sessions: list }));
    renameSync(tmp, file);
    return null;
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch (_error) {
      /* tmp уже нет */
    }
    return typeof error?.code === 'string' ? error.code : 'unknown';
  }
}

/**
 * Записать эффективный набор в леджер и запомнить, что запись не удалась.
 *
 * Ошибка логируется один раз на серию: повтор идёт на каждом пересчёте света,
 * и строка `save-error` на каждый пересчёт была бы шумом. Пока запись не
 * удалась, авторитетно значение конфига (оно уже применено в памяти).
 * @returns {void}
 */
function persistSpecial() {
  if (runtime === null) return;
  const code = writeSpecialFile([...runtime.special]);
  const firstFailure = code !== null && runtime.savePending !== true;
  runtime.savePending = code !== null;
  if (firstFailure) logLine(`save-error | reason=${code}`);
}

/**
 * Мгновение в ISO; для неизвестной границы — строка `unknown`.
 * @param {number | null} instantMs - миллисекунды эпохи либо null.
 * @returns {string} ISO-строка.
 */
function isoOf(instantMs) {
  return typeof instantMs === 'number' && Number.isFinite(instantMs) ? new Date(instantMs).toISOString() : 'unknown';
}

/**
 * Разрешён ли сессии красный: есть ли спецсигнал у неё или у предка.
 *
 * Подъём идёт по `agent.session.header.parentSession` (дурная связь субагента
 * с создателем; образец обхода — `dsh-subagent/lib/index.js:1742-1754`).
 * Реестр агентов знает только живых, поэтому неизвестная сессия — это сессия
 * без сигнала: лучше подождать зелёного, чем пустить дорогую работу по ошибке.
 * @param {string} sessionId - id сессии.
 * @returns {boolean} true, если красный этой сессии разрешён.
 */
function hasSignal(sessionId) {
  if (runtime === null || typeof sessionId !== 'string' || sessionId === '') return false;
  const agents = agentsOf(runtime);
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return false;
  const visited = new Set();
  let current = sessionId;
  for (let hop = 0; hop <= PARENT_HOPS_LIMIT; hop += 1) {
    if (current === '' || visited.has(current)) return false;
    visited.add(current);
    // Собственная запись в наборе — уже сигнал: список авторитетен и без
    // живого handle (сессию мог выгрузить реестр, а решение уже принято).
    if (runtime.special.has(current)) return true;
    let agent;
    try {
      agent = agents.get(current);
    } catch (_error) {
      agent = undefined;
    }
    // Дальше подниматься не по чем: предок неизвестен — сигнала нет.
    if (agent === undefined || agent === null) return false;
    const parent = agent?.session?.header?.parentSession;
    current = typeof parent === 'string' ? parent : '';
  }
  return false;
}

/**
 * Обещание, разрешающееся, когда красный закончится, сигнал появится
 * или хост-половина остановится.
 *
 * Ожидающие разложены по сессиям: адресный `releaseSignalled` должен будить
 * только тех, кому пропуск теперь разрешён, а не весь ход целиком.
 * @param {string} sessionId - id ожидающей сессии.
 * @param {AbortSignal} [signal] - сигнал текущего вызова.
 * @returns {Promise<void>} разрешается при выходе из красного.
 */
function untilGreen(sessionId, signal) {
  if (runtime === null || runtime.light !== 'red') return Promise.resolve();
  return new Promise((resolve) => {
    let waiter;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      const set = runtime?.waiters.get(sessionId);
      if (set !== undefined) {
        set.delete(waiter);
        if (set.size === 0) runtime?.waiters.delete(sessionId);
      }
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch (_error) {
        /* сигнал без removeEventListener */
      }
      resolve();
    };
    const onAbort = () => done();
    waiter = { done };
    const set = runtime.waiters.get(sessionId) ?? new Set();
    set.add(waiter);
    runtime.waiters.set(sessionId, set);
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    } catch (_error) {
      /* сигнал без addEventListener */
    }
  });
}

/**
 * Разбудить ожидающие вызовы тех сессий, которым спецсигнал теперь разрешён.
 *
 * Вызывается, когда набор спецсигнала изменился: сессия изменившегося
 * поддерева не должна ждать зелёного до конца окна.
 * @returns {void}
 */
function releaseSignalled() {
  if (runtime === null) return;
  for (const sessionId of [...runtime.waiters.keys()]) {
    if (!hasSignal(sessionId)) continue;
    const set = runtime.waiters.get(sessionId);
    runtime.waiters.delete(sessionId);
    runtime.pauseLogged.delete(sessionId);
    if (set === undefined) continue;
    for (const waiter of [...set]) waiter.done();
  }
}

/**
 * Разбудить ожидающие вызовы одной сессии (агент выгружается).
 * @param {string} sessionId - id сессии.
 * @returns {void}
 */
function releaseSession(sessionId) {
  if (runtime === null) return;
  const set = runtime.waiters.get(sessionId);
  runtime.waiters.delete(sessionId);
  runtime.pauseLogged.delete(sessionId);
  if (set === undefined) return;
  for (const waiter of [...set]) waiter.done();
}

/**
 * Разбудить все ожидающие вызовы: зелёный свет или выключение твика.
 * @param {boolean} afterGreen - true, если причина — переход на зелёный
 *   (тогда пишем по строке `resume` на сессию).
 * @returns {void}
 */
function releaseAll(afterGreen) {
  if (runtime === null) return;
  for (const sessionId of [...runtime.waiters.keys()]) {
    if (afterGreen === true) logLine(`resume | session=${sessionId} | after=green`);
    releaseSession(sessionId);
  }
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
 * Пустой ли батч шага: пустой или из одних служебных вставок.
 *
 * Незнакомый источник содержимым считается: отклонять шаг с непонятным
 * сообщением нельзя — в нём может быть работа.
 * @param {Array<object>} [messages] - сообщения батча.
 * @returns {boolean} true, если терять в шаге нечего.
 */
function isEmptyBatch(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return true;
  for (const message of messages) {
    const kind = message?.source?.kind;
    if (typeof kind !== 'string' || !NEUTRAL_KINDS.has(kind)) return false;
  }
  return true;
}

/**
 * Пересчитать цвет светофора и обработать переход.
 * @returns {void}
 */
function refresh() {
  if (runtime === null) return;
  // Неудачная запись леджера повторяется здесь: диск мог освободиться.
  if (runtime.savePending === true) persistSpecial();
  const next = lightAt(Date.now(), runtime.policy);
  if (next !== runtime.light) {
    const previous = runtime.light;
    runtime.light = next;
    log(`trafficLight: ${previous} → ${next}`);
    // Граница окна: пауза новой сессии в следующем окне логируется снова.
    runtime.pauseLogged.clear();
    // Выход из красного отпускает всех: впереди дешёвое время (жёлтое — уже
    // не пик). Строку `resume … after=green` пишем только на честный зелёный.
    if (previous === 'red') releaseAll(next === 'green');
  }
  // Недоставленное (служба сессий не готова, сессия занята) повторяем на каждом
  // пересчёте, пока свет зелёный: удержанное не должно пропасть из-за гонки.
  if (runtime.light === 'green' && runtime.held.size > 0) void redeliverHeld();
}

/**
 * Включить хост-половину.
 *
 * Набор спецсигнала берётся в порядке «файл → конфиг → seed»; расхождение
 * файла и конфига не ошибка (человек мог выключить сигнал в другой вкладке, а
 * файл пишет хост), поэтому файл авторитетен, а факт расхождения попадает в лог.
 * @param {object} ctx - контекст плагина.
 * @param {object} config - плоская конфигурация твика.
 * @returns {void}
 */
export function activate(ctx, config) {
  if (runtime !== null) return;
  const configSpecial = normalizeSpecialList(config?.trafficLightSpecial);
  const fileSpecial = loadSpecialFile();
  const effective = fileSpecial ?? configSpecial ?? SEED_SPECIAL;
  runtime = {
    ctx,
    policy: normalizePolicy(config),
    light: 'green',
    pauseAgents: config?.trafficLightPauseAgents !== false,
    pauseSchedules: config?.trafficLightPauseSchedules !== false,
    held: new Map(loadHeldFile()),
    heldAttempts: new Map(),
    special: new Set(effective),
    appliedSpecial: configSpecial,
    specialRev: 0,
    savePending: false,
    waiters: new Map(),
    pauseLogged: new Set(),
    agents: serviceOf(ctx, 'agents'),
    sessionController: serviceOf(ctx, 'sessionController'),
    logger: serviceOf(ctx, 'logger'),
    interval: null,
    agentDisposers: new Map(),
    rootDisposers: [],
  };

  const actor = fileSpecial !== null ? 'file' : configSpecial !== null ? 'config' : 'seed';
  for (const sessionId of runtime.special) {
    logLine(`signal | session=${sessionId} | state=on | actor=${actor} | rev=0`);
  }
  if (fileSpecial !== null && configSpecial !== null && !sameList(fileSpecial, configSpecial)) {
    logLine(`state-conflict | file=${fileSpecial.length} | config=${configSpecial.length} | authority=file`);
  }

  runtime.rootDisposers.push(
    ctx.on('agent/created', (payload) => {
      const agent = payload?.agent;
      if (agent === undefined || typeof agent?.ctx?.effect !== 'function') return;
      let disposer;
      try {
        disposer = agent.ctx.effect(() => {
          const off = [];
          off.push(
            agent.ctx.on('agent/pre-step', (step, next) => {
              const id = String(agent.id ?? '');
              if (runtime.light !== 'red' || runtime.pauseAgents !== true) return next();
              // У сессии со спецсигналом работа идёт: отклонять её ход нельзя.
              if (hasSignal(id)) return next();
              if (step?.step === 1 && isEmptyBatch(step?.messages)) {
                // Ход открылся без собственного ввода: доставку расписания на
                // красном мы изъяли, а wake-латч всё равно завёл ход. Любой
                // модельный вызов здесь — пустая трата дорогих токенов, поэтому
                // отклоняем шаг (в батче только служебные вставки, терять нечего).
                log(`trafficLight: пустой ход сессии ${id} отклонён на красном`);
                return Promise.resolve({ kind: 'reject' });
              }
              return next();
            }),
          );
          off.push(
            agent.ctx.on('agent/inbox/inserted', (payload) => {
              holdScheduleMessage(agent, payload?.message);
            }),
          );
          return () => {
            for (const dispose of off) dispose();
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
      const sessionId = String(id);
      const disposer = runtime.agentDisposers.get(sessionId);
      if (disposer !== undefined) {
        try {
          disposer();
        } catch (error) {
          log(`trafficLight: очистка агента ${sessionId} прервана`, error);
        }
        runtime.agentDisposers.delete(sessionId);
      }
      // Ожидание выгруженной сессии будить некому: отпускаем сразу.
      releaseSession(sessionId);
    }),
  );

  runtime.rootDisposers.push(
    ctx.on('llm/stream', async function* (options, next) {
      if (runtime === null || runtime.light !== 'red' || runtime.pauseAgents !== true) {
        yield* next();
        return;
      }
      // Сервисный вызов (заголовок чата, компакция) — не работа хода.
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
      // Инициатор точнее: он знает сессию хода. Запасной путь — сессия запроса;
      // он нужен, когда инициатора нет (холостой вызов вне хода).
      if (id === '') id = String(options?.sessionId ?? '');
      if (id === '') {
        // Сессию не определить — пропускаем и фиксируем это в логе.
        logLine('signal-less | reason=no-initiator');
        yield* next();
        return;
      }
      if (hasSignal(id)) {
        yield* next();
        return;
      }
      if (runtime.pauseLogged.has(id) !== true) {
        runtime.pauseLogged.add(id);
        // Прежняя строка журнала DSH (наблюдаемость journal) + структурное
        // событие в файл: контракт §4.3 не отменяет старые строки.
        log(`trafficLight: модельный вызов сессии ${id} ждёт конца пика`);
        logLine(`pause | session=${id} | until=${isoOf(nextSwitchAt(Date.now(), runtime.policy))}`);
      }
      await untilGreen(id, options?.signal);
      yield* next();
    }),
  );

  runtime.interval = setInterval(refresh, REFRESH_MS);
  refresh();
}

/**
 * Применить новую конфигурацию без перезапуска: политика, флаги пауз и набор
 * спецсигнала подхватываются, удержанные напоминания сохраняются.
 *
 * Списки сравниваются поэлементно: `Volatile.get()` отдаёт новый массив на
 * каждое чтение, поэтому сорвавшееся сравнение по ссылке давало бы запись
 * леджера и строки `signal` на любое постороннее изменение конфигурации.
 * @param {object} config - плоская конфигурация твика.
 * @returns {void}
 */
export function update(config) {
  if (runtime === null) return;
  runtime.policy = normalizePolicy(config);
  runtime.pauseAgents = config?.trafficLightPauseAgents !== false;
  runtime.pauseSchedules = config?.trafficLightPauseSchedules !== false;
  const next = normalizeSpecialList(config?.trafficLightSpecial);
  if (!sameList(next, runtime.appliedSpecial)) {
    runtime.appliedSpecial = next;
    // Нет значения поля — это не команда «выключить»: набор не трогаем.
    if (next !== null) {
      const previous = runtime.special;
      runtime.special = new Set(next);
      runtime.specialRev += 1;
      const rev = runtime.specialRev;
      for (const sessionId of runtime.special) {
        if (previous.has(sessionId)) continue;
        logLine(`signal | session=${sessionId} | state=on | actor=ui-config | rev=${rev}`);
      }
      for (const sessionId of previous) {
        if (runtime.special.has(sessionId)) continue;
        logLine(`signal | session=${sessionId} | state=off | actor=ui-config | rev=${rev}`);
      }
      persistSpecial();
      releaseSignalled();
    }
  }
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
  // Сорвавшуюся запись леджера пробуем ещё раз: следующий пересчёт уже не придёт.
  if (previous.savePending === true) persistSpecial();
  releaseAll(false);
  previous.waiters.clear();
  previous.pauseLogged.clear();
  previous.special.clear();
  runtime = null;
  await redeliverHeld(previous);
}
