'use strict';

// Проверка твика «светофор» (trafficLight) бандла dsh-tweaks без установки DSH:
//   1. политика тарифов (tweaks/traffic-light-policy.js) — границы окон,
//      выходные, праздники, жёлтое предупреждение, нормализация конфигурации;
//   2. копия политики в client.js совпадает с хост-модулем (дрейфа нет);
//   3. хост-половина (tweaks/traffic-light-host.js) по контрактам §4 плана:
//      на красном ждёт КАЖДЫЙ ход без спецсигнала (D1, D3 — сообщение любого
//      вида пропуска не даёт), спецсигнал наследуется по `parentSession` (D2),
//      состояние переживает рестарт через `special.json` (D4), строки лога
//      пишутся только в файл (D9);
//   4. схема Config в index.js: поле `trafficLightSpecial`, сид t1447u,
//      список праздников совпадает с политикой.
//
// Кейсы: (а)(б)(б2)(в)(г)(ж)(з)(е)(п1)(п2)(л)(м) + старые 3.1–3.7.
// Инверсия под D3: 3.2, 3.4, 3.4а — раньше «ручная работа проходила на красном»,
// теперь сообщение пропуск не даёт, поэтому кейсы ожидают ожидание. Это
// осознанная потеря старого поведения, помеченная в P5-таблице fail-expected,
// а не ослабление проверок.
//
// Каждый кейс изолирован и складывается в таблицу результатов. При `TL_BASE=1`
// прогон сверяет результаты с ожиданиями базового дерева `9b9ac36` (P5):
// fail-expected обязан упасть, pass-expected — пройти; неожиданный исход —
// стоп и разбор, а не правка ожиданий (E1/F6).
//
// Запуск: node test/check-traffic-light.cjs
//         TL_BASE=1 node test/check-traffic-light.cjs   (в дереве 9b9ac36)

// Зона машины фиксируется до первого Date: статусы и подписи в интерфейсе
// считаются локальной зоной, иначе ожидания «до HH:MM» зависели бы от хоста.
process.env.TZ = 'Europe/Moscow';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Файлы состояния (леджер спецсигнала, памятка удержанного, лог) пишутся во
// временный каталог: тест не трогает профиль настоящего DSH.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tweaks-test-'));

const ROOT = path.join(__dirname, '..');
const POLICY_PATH = path.join(ROOT, 'tweaks', 'traffic-light-policy.js');
const HOST_PATH = path.join(ROOT, 'tweaks', 'traffic-light-host.js');
const CLIENT_PATH = path.join(ROOT, 'client.js');
const INDEX_PATH = path.join(ROOT, 'index.js');

/** Каталог состояния твика внутри временного DSH_HOME. */
const STATE_DIR = path.join(process.env.DSH_HOME, 'dsh-tweaks');
/** Леджер спецсигнала — авторитетное состояние (D4). */
const SPECIAL_FILE = path.join(STATE_DIR, 'special.json');
/** Лог твика: структурные строки §4.3 (D9). */
const LOG_FILE = path.join(STATE_DIR, 'traffic-light.log');
/** Сессия, включённая в спецсигнал сидом (решение Игоря t1447u). */
const SEED_SESSION = 'session-e4698bf8-717f-4e1a-9390-a2b40c03d985';

/** Миллисекунды в минуте. */
const MINUTE_MS = 60_000;

/** Среда 10:00 по Пекину = 05:00 МСК — внутри утреннего окна пика (красный). */
const RED_NOW = Date.UTC(2026, 9, 14, 2, 0);

/** Один чанк ответа модели: годится любому кейсу, где важен сам факт вызова. */
const ONE_CHUNK = [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }];

/**
 * Ожидания базового дерева `9b9ac36` для режима `TL_BASE=1` (P5).
 * `pass` — кейс обязан пройти на базе, `fail` — обязан упасть: он проверяет
 * новое поведение и ложнозелёным быть не должен.
 */
const BASE_EXPECT = new Map([
  ['policy', 'pass'],
  ['policy-parity', 'pass'],
  ['3.1', 'pass'],
  ['3.2', 'fail'],
  ['3.3', 'pass'],
  ['3.4', 'fail'],
  ['3.4а', 'fail'],
  ['3.5', 'pass'],
  ['3.6', 'pass'],
  ['3.7', 'pass'],
  ['(а)', 'pass'],
  ['(п1)', 'pass'],
  ['(в-инициатор)', 'pass'],
  ['(б)', 'fail'],
  ['(б2)', 'fail'],
  ['(в)', 'fail'],
  ['(в-signal-less)', 'fail'],
  ['(г)', 'fail'],
  ['(ж)', 'fail'],
  ['(з)', 'fail'],
  ['(е)', 'fail'],
  ['(п2)', 'fail'],
  ['(л)', 'fail'],
  ['(м)', 'fail'],
  ['стенд', 'fail'],
]);

/** Результаты кейсов: имя, исход и ошибка. */
const results = [];

/**
 * Прогнать кейс, записав исход и не прерывая прогон остальных.
 * @param {string} name - имя кейса (совпадает с ключом BASE_EXPECT).
 * @param {Function} fn - тело кейса.
 * @returns {Promise<void>}
 */
async function runCase(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true, error: null });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

/**
 * Пекинское время как миллисекунды эпохи: fixed UTC+8, без летнего времени.
 * @param {string} iso - локальное пекинское время 'YYYY-MM-DDTHH:mm'.
 * @returns {number} миллисекунды эпохи.
 */
function beijingMs(iso) {
  const [date, time] = iso.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) - 8 * 60 * MINUTE_MS;
}

/**
 * Политика с окнами по умолчанию, но другим предупреждением/праздниками.
 * @param {object} [overrides] - поля политики поверх дефолтов.
 * @returns {object} политика.
 */
function makePolicy(overrides = {}) {
  return {
    utcOffsetMinutes: 480,
    peakWindows: [[9 * 60, 12 * 60], [14 * 60, 18 * 60]],
    holidays: [],
    warningMinutes: 30,
    ...overrides,
  };
}

/** Подождать микрозадач и макротиков — чтобы дошли повторные доставки и release. */
async function settle() {
  for (let step = 0; step < 8; step += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Мок агента: входящие, эффекты и слушатели на agent.ctx.
 * @param {string} id - идентификатор сессии.
 * @returns {object} агент, эмиттеры событий и записи вызовов.
 */
function createAgent(id) {
  const calls = { removed: [], followed: [] };
  const listeners = new Map();
  const effects = [];
  const inbox = {
    remove(messageId) {
      calls.removed.push(messageId);
    },
  };
  const agent = {
    id,
    inbox,
    followup(message) {
      calls.followed.push(message);
    },
  };
  agent.ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(callback) {
      effects.push(callback());
      return () => {};
    },
  };
  return {
    agent,
    calls,
    emit(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
    /** Отправить waterfall-событие pre-step и вернуть решение. */
    async preStep(messages, stepNumber = 1) {
      let decision = null;
      for (const listener of [...(listeners.get('agent/pre-step') ?? [])]) {
        decision = await listener({ messages, step: stepNumber }, async () => ({ kind: 'enter', messages }));
      }
      return decision;
    },
  };
}

/**
 * Мок хост-контекста: службы, живой реестр агентов, события корня, лог на диске.
 *
 * Реестр `agents.list/get` — то, по чему хост-половина поднимается по
 * `session.header.parentSession` (D2): без него дерево спецсигнала не проверить.
 * Лог читается с диска (`logSince`), потому что структурные строки §4.3 идут
 * только в файл, а `trafficLight: …` — в логгер.
 * @returns {object} контекст с эмиттером, записями и методами подмены.
 */
function createHostContext() {
  const rootListeners = new Map();
  const logs = [];
  const resolved = [];
  const registry = new Map();
  const state = { initiator: undefined };
  let resolveImpl = async (sessionId) => {
    resolved.push(sessionId);
    return { error: { code: 'session/not-found' } };
  };
  const hidden = new Set();
  const services = {
    agents: {
      currentInitiator: () => state.initiator,
      list: () => [...registry.values()],
      get: (id) => registry.get(String(id)),
    },
    sessionController: {
      async resolveAgent(sessionId) {
        resolved.push(sessionId);
        return await resolveImpl(sessionId);
      },
    },
    logger: { info: (line) => logs.push(`info: ${line}`), warn: (line) => logs.push(`warn: ${line}`) },
  };
  return {
    logs,
    resolved,
    setInitiator(id) {
      state.initiator = id === undefined ? undefined : { id };
    },
    setResolveAgent(fn) {
      resolveImpl = fn;
    },
    /** Завести сессию в живом реестре: parentSession задаёт дерево (D2). */
    register(id, parentId) {
      registry.set(id, {
        id,
        session: { header: parentId === undefined ? {} : { parentSession: parentId } },
      });
    },
    /** Убрать сессию из реестра: выгруженный агент предком больше не считается. */
    unregister(id) {
      registry.delete(id);
    },
    /** Завести сессию и объявить агента корневому контексту. */
    open(id, parentId) {
      this.register(id, parentId);
      const handle = createAgent(id);
      this.emit('agent/created', { agent: handle.agent });
      return handle;
    },
    get(name) {
      return hidden.has(name) ? undefined : services[name];
    },
    /** Спрятать службу: ctx.get вернёт undefined — как до её применения. */
    hideService(name) {
      hidden.add(name);
    },
    showService(name) {
      hidden.delete(name);
    },
    on(event, listener) {
      const list = rootListeners.get(event) ?? [];
      list.push(listener);
      rootListeners.set(event, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    emit(event, ...args) {
      for (const listener of [...(rootListeners.get(event) ?? [])]) listener(...args);
    },
    /** Перебрать waterfall-слушателя llm/stream до первых чанков. */
    async driveLlmStream(options, chunks) {
      let generator = null;
      for (const listener of [...(rootListeners.get('llm/stream') ?? [])]) {
        generator = listener(options, async function* () {
          yield* chunks;
        });
      }
      assert.ok(generator, 'слушатель llm/stream зарегистрирован');
      const collected = [];
      for await (const chunk of generator) collected.push(chunk);
      return collected;
    },
    /** Строки файла лога (пустые отброшены). */
    logLines() {
      try {
        return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter((line) => line !== '');
      } catch (_error) {
        return [];
      }
    },
    /** Отметка «сколько строк было» — чтобы ассерты видели только свой кейс. */
    logMark() {
      return this.logLines().length;
    },
    /** Строки лога, появившиеся после отметки. */
    logSince(mark) {
      return this.logLines().slice(mark);
    },
  };
}

/**
 * Запустить модельный вызов и узнать, пошёл ли он, не подвешивая прогон:
 * проверка «не ждёт» обязана падать утверждением, а не зависать (E1).
 * @param {object} ctx - мок хост-контекста.
 * @param {string|undefined} initiatorId - id сессии-инициатора.
 * @param {object} [options] - опции вызова (sessionId, purpose, signal).
 * @returns {{done: boolean, chunks: Array<object>|null, promise: Promise<Array<object>>}} флаг и обещание.
 */
function startCall(ctx, initiatorId, options = {}) {
  ctx.setInitiator(initiatorId);
  const tracked = { done: false, chunks: null, promise: null };
  tracked.promise = ctx.driveLlmStream(options, ONE_CHUNK);
  tracked.promise.then((chunks) => {
    tracked.done = true;
    tracked.chunks = chunks;
  });
  return tracked;
}

/**
 * Проверить, что вызов ждёт: обещание не разрешилось и не вернуло чанки.
 * @param {object} tracked - результат startCall.
 * @param {string} message - текст утверждения.
 * @returns {Promise<void>}
 */
async function expectWaiting(tracked, message) {
  await settle();
  assert.equal(tracked.done, false, message);
}

/**
 * Проверить, что вызов прошёл.
 * @param {object} tracked - результат startCall.
 * @param {string} message - текст утверждения.
 * @returns {Promise<void>}
 */
async function expectPassing(tracked, message) {
  await settle();
  assert.equal(tracked.done, true, message);
  await tracked.promise;
}

/**
 * Строки лога после отметки, содержащие маркер §4.3.
 *
 * Файл пишет ISO-префикс (`${ISO} ${строка}`), поэтому маркер ищется вхождением,
 * а не началом строки.
 * @param {object} ctx - мок хост-контекста.
 * @param {number} mark - отметка до кейса.
 * @param {string} marker - маркер, например `pause | session=`.
 * @returns {string[]} подходящие строки.
 */
function logByMarker(ctx, mark, marker) {
  return ctx.logSince(mark).filter((line) => line.includes(marker));
}

/** Убрать каталог состояния: кейсы не должны видеть файлы друг друга. */
function resetStateFiles() {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
}

/**
 * Записать леджер спецсигнала руками — как это сделал бы хост при выключении.
 * @param {string[]} sessions - список сессий со спецсигналом.
 * @returns {void}
 */
function writeSpecialFile(sessions) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SPECIAL_FILE, JSON.stringify({ sessions }));
}

/**
 * Прочитать леджер спецсигнала с диска.
 * @returns {{sessions: string[]}} состояние леджера.
 */
function readSpecialFile() {
  return JSON.parse(fs.readFileSync(SPECIAL_FILE, 'utf8'));
}

/** Базовый конфиг: твик включён, паузы включены; поле спецсигнала задано явно. */
const baseConfig = {
  trafficLight: true,
  trafficLightPauseSchedules: true,
  trafficLightPauseAgents: true,
};

/** Конфиг без единого спецсигнала: явный пустой список перекрывает сид (D4). */
const noSignalConfig = { ...baseConfig, trafficLightSpecial: [] };

/** Зелёный конфиг: окна пика сдвинуты на ночь — свет зелёный в любое «сейчас». */
const greenConfig = {
  ...noSignalConfig,
  trafficLightPeakWindows: [{ start: '23:00', end: '23:59' }],
  trafficLightWarningMinutes: 0,
};

/** Часы прогона: кейсы двигают «сейчас» сами. */
const clock = { now: RED_NOW };

/** Главный прогон проверок. */
async function main() {
  const policy = await import(pathToFileURL(POLICY_PATH).href);
  const hostModule = await import(pathToFileURL(HOST_PATH).href);
  const { activate, update, deactivate } = hostModule;
  const baseMode = process.env.TL_BASE === '1';

  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    // ---- 1) Политика тарифов -----------------------------------------------
    await runCase('policy', async () => {
      const tuesday = '2026-10-13'; // вторник
      const saturday = '2026-10-17'; // суббота
      const holiday = '2026-10-01'; // четверг, праздник КНР
      const p = makePolicy();

      assert.equal(policy.isPeakAt(beijingMs(`${tuesday}T09:00`), p), true, 'рабочий день 09:00 — пик');
      assert.equal(policy.isPeakAt(beijingMs(`${tuesday}T11:59`), p), true, '11:59 ещё пик');
      assert.equal(policy.isPeakAt(beijingMs(`${tuesday}T12:00`), p), false, '12:00 уже не пик (полуинтервал)');
      assert.equal(policy.isPeakAt(beijingMs(`${tuesday}T13:59`), p), false, 'обед вне пика');
      assert.equal(policy.isPeakAt(beijingMs(`${tuesday}T14:00`), p), true, '14:00 снова пик');
      assert.equal(policy.isPeakAt(beijingMs(`${tuesday}T18:00`), p), false, '18:00 конец пика');
      assert.equal(policy.isPeakAt(beijingMs(`${tuesday}T22:00`), p), false, 'вечер вне пика');
      assert.equal(policy.isPeakAt(beijingMs(`${saturday}T10:00`), p), false, 'суббота вне пика');
      assert.equal(policy.isPeakAt(beijingMs(`${holiday}T10:00`), makePolicy({ holidays: ['2026-10-01'] })), false, 'праздник вне пика');

      assert.equal(policy.lightAt(beijingMs(`${tuesday}T10:00`), p), 'red', 'в окне пика — красный');
      assert.equal(policy.lightAt(beijingMs(`${tuesday}T08:31`), p), 'yellow', 'за 29 минут до пика — жёлтый');
      assert.equal(policy.lightAt(beijingMs(`${tuesday}T08:00`), p), 'green', 'за час до пика — зелёный');
      assert.equal(policy.lightAt(beijingMs(`${tuesday}T22:00`), p), 'green', 'вечером — зелёный');
      assert.equal(policy.lightAt(beijingMs(`${saturday}T08:31`), p), 'green', 'перед «пиком» в субботу — зелёный');

      assert.equal(policy.nextSwitchAt(beijingMs(`${tuesday}T10:00`), p), beijingMs(`${tuesday}T12:00`), 'из пика выход в 12:00');
      assert.equal(policy.nextSwitchAt(beijingMs(`${tuesday}T12:30`), p), beijingMs(`${tuesday}T14:00`), 'из обеда вход в 14:00');
      assert.equal(policy.nextPeakStartAt(beijingMs(`${tuesday}T08:00`), p), beijingMs(`${tuesday}T09:00`), 'следующий пик — в 09:00');
      assert.equal(policy.nextPeakStartAt(beijingMs(`${tuesday}T11:00`), p), beijingMs(`${tuesday}T14:00`), 'из первого окна следующий пик — в 14:00');
      // Пятница вечером: следующий пик — понедельник 09:00.
      assert.equal(policy.nextPeakStartAt(beijingMs('2026-10-16T20:00'), p), beijingMs('2026-10-19T09:00'), 'с вечера пятницы — понедельник 09:00');

      // Нормализация конфигурации: мусор отбрасывается, валидное применяется.
      const normalized = policy.normalizePolicy({
        trafficLightPeakWindows: [
          { start: '01:00', end: '02:00' },
          { start: 'bad', end: 'value' },
          { start: '09:00', end: '08:00' },
        ],
        trafficLightHolidays: ['2027-01-01', 'мусор', '2027-05-01'],
        trafficLightWarningMinutes: 15,
      });
      assert.deepEqual(normalized.peakWindows, [[60, 120]], 'валидное окно применено, мусор отброшен');
      assert.deepEqual(normalized.holidays, ['2027-01-01', '2027-05-01'], 'праздники фильтруются по формату');
      assert.equal(normalized.warningMinutes, 15, 'предупреждение применено');
      assert.deepEqual(policy.normalizePolicy({ trafficLightWarningMinutes: 9999 }).warningMinutes, 10, 'слишком долгое предупреждение — дефолт');
      assert.equal(policy.DEFAULT_POLICY.warningMinutes, 10, 'предупреждение по умолчанию — 10 минут');
      assert.deepEqual(policy.normalizePolicy(null).peakWindows, p.peakWindows, 'пустая конфигурация — дефолты');
    });

    // ---- 2) Копия политики в client.js --------------------------------------
    await runCase('policy-parity', async () => {
      const hostSource = fs.readFileSync(POLICY_PATH, 'utf8').replace(/^export /gm, '');
      const clientSource = fs.readFileSync(CLIENT_PATH, 'utf8');
      const regionMatch = /\/\* region traffic-light-policy[^*]*\*\/([\s\S]*?)\/\* endregion traffic-light-policy \*\//.exec(clientSource);
      assert.ok(regionMatch, 'в client.js есть регион traffic-light-policy');
      const clientPolicy = regionMatch[1]
        .split('\n')
        .map((line) => (line.startsWith('    ') ? line.slice(4) : line))
        .join('\n')
        .trim();
      assert.equal(clientPolicy, hostSource.trim(), 'копия политики в client.js совпадает с хост-модулем');
    });

    // ---- 3) Хост-половина: старые кейсы 3.1–3.7 -----------------------------
    // 3.1) Красный: расписание удерживается, прочие входящие не трогаются.
    await runCase('3.1', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      ctx.setInitiator('session-a');
      activate(ctx, noSignalConfig);
      try {
        assert.ok(ctx.logs.some((line) => line.includes('green → red')), '3.1 активация вычислила красный');
        const sessionA = ctx.open('session-a');
        sessionA.emit('agent/inbox/inserted', { message: { id: 'msg-schedule', source: { kind: 'schedule' } } });
        assert.deepEqual(sessionA.calls.removed, ['msg-schedule'], '3.1 расписание на красном снято из входящих');
        sessionA.emit('agent/inbox/inserted', { message: { id: 'msg-user', source: { kind: 'user' } } });
        assert.deepEqual(sessionA.calls.removed, ['msg-schedule'], '3.1 прочее входящее не трогается');
      } finally {
        await deactivate();
      }
    });

    // 3.2) Красный: без спецсигнала ждёт любой ход.
    // ИНВЕРСИЯ ПОД D3 (осознанная, см. fail-expected): раньше «ручной» шаг
    // проходил сразу, теперь сообщение пропуск не даёт — обе половины ждут.
    await runCase('3.2', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, noSignalConfig);
      try {
        const sessionA = ctx.open('session-a');
        await sessionA.preStep([{ id: 'm1', source: { kind: 'goal' } }]);
        const automatic = startCall(ctx, 'session-a');
        await expectWaiting(automatic, '3.2 автоход на красном ждёт зелёного');

        await sessionA.preStep([{ id: 'm2', source: { kind: 'user', rpcId: 'rpc-1', clientTimeZone: 'Europe/Moscow' } }]);
        const manual = startCall(ctx, 'session-a');
        await expectWaiting(manual, '3.2 инверсия под D3: ручной шаг на красном тоже ждёт');

        update(greenConfig);
        await settle();
        assert.equal(automatic.done, true, '3.2 на зелёном автоматический вызов пошёл');
        assert.equal(manual.done, true, '3.2 на зелёном ручной вызов пошёл');
      } finally {
        await deactivate();
      }
    });

    // 3.3) Зелёный: ожидавший вызов отпускается, расписание возвращается в работу.
    await runCase('3.3', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, noSignalConfig);
      try {
        const sessionA = ctx.open('session-a');
        sessionA.emit('agent/inbox/inserted', { message: { id: 'msg-schedule', source: { kind: 'schedule' } } });
        // Автошаг: на красном он стоит и на базовом дереве (там гейт знал только
        // автоматические вызовы), поэтому кейс остаётся старым, не новым.
        await sessionA.preStep([{ id: 'm-goal', source: { kind: 'goal' } }]);
        const automatic = startCall(ctx, 'session-a');
        await expectWaiting(automatic, '3.3 на красном вызов стоит');
        const followedAgents = new Map();
        ctx.setResolveAgent(async (sessionId) => {
          const handle = createAgent(sessionId);
          followedAgents.set(sessionId, handle);
          return { agent: handle.agent };
        });
        update(greenConfig);
        await settle();
        assert.equal(automatic.done, true, '3.3 на зелёном вызов пошёл');
        assert.ok(ctx.logs.some((line) => line.includes('red → green')), '3.3 переход в зелёный залогирован логгером');
        assert.ok(ctx.resolved.includes('session-a'), '3.3 сессия удержанного поднята');
        assert.deepEqual(
          followedAgents.get('session-a')?.calls.followed.map((message) => message.id),
          ['msg-schedule'],
          '3.3 удержанное напоминание вернулось в работу',
        );
      } finally {
        await deactivate();
      }
    });

    // 3.4) ИНВЕРСИЯ ПОД D3: дерево без спецсигнала ждёт — родословная ручного
    // шага больше не даёт прохода (её заменил спецсигнал, кейс (б)).
    await runCase('3.4', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, noSignalConfig);
      try {
        ctx.open('session-tree-parent');
        const child = ctx.open('child-tree', 'session-tree-parent');
        await child.preStep([{ id: 'm-sub', source: { kind: 'subagent' } }]);
        const childCall = startCall(ctx, 'child-tree');
        await expectWaiting(childCall, '3.4 инверсия под D3: субагент без спецсигнала в дереве ждёт');
      } finally {
        await deactivate();
      }
    });

    // 3.4а) ИНВЕРСИЯ ПОД D3: ручной шаг со служебными вставками тоже ждёт.
    await runCase('3.4а', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, noSignalConfig);
      try {
        const agent = ctx.open('session-context');
        await agent.preStep([
          { id: 'ctx-runtime', source: { kind: 'runtime-context' } },
          { id: 'ctx-time', source: { kind: 'time-context' } },
          { id: 'm-user', source: { kind: 'user', rpcId: 'rpc-2', clientTimeZone: 'Europe/Moscow' } },
        ]);
        const manualWithContext = startCall(ctx, 'session-context');
        await expectWaiting(manualWithContext, '3.4а инверсия под D3: ручной шаг со вставками контекста ждёт');
      } finally {
        await deactivate();
      }
    });

    // 3.5) Выгрузка: ожидающие отпущены, удержанное роздано.
    await runCase('3.5', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, noSignalConfig);
      try {
        const held = ctx.open('session-c');
        held.emit('agent/inbox/inserted', { message: { id: 'msg-held', source: { kind: 'schedule' } } });
        assert.deepEqual(held.calls.removed, ['msg-held'], '3.5 сообщение удержано перед выгрузкой');
        await held.preStep([{ id: 'm-goal', source: { kind: 'goal' } }]);
        const waiting = startCall(ctx, 'session-c');
        await expectWaiting(waiting, '3.5 на красном вызов стоит');
        const followed = [];
        ctx.setResolveAgent(async () => ({ agent: { followup: (message) => followed.push(message.id) } }));
        await deactivate();
        await settle();
        assert.ok(ctx.resolved.includes('session-c'), '3.5 выгрузка вернула удержанное напоминание');
        assert.deepEqual(followed, ['msg-held'], '3.5 после выгрузки сообщение в работе');
        assert.equal(waiting.done, true, '3.5 выгрузка отпустила ожидавший вызов');
        // Повторная деактивация безопасна.
        await deactivate();
      } finally {
        await deactivate();
      }
    });

    // 3.6) Служба сессий поднялась позже: удержанное не теряется, а доезжает
    // повторной доставкой на следующем пересчёте зелёного света.
    await runCase('3.6', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      ctx.hideService('sessionController');
      activate(ctx, noSignalConfig);
      try {
        const late = ctx.open('session-late');
        late.emit('agent/inbox/inserted', { message: { id: 'msg-late', source: { kind: 'schedule' } } });
        assert.deepEqual(late.calls.removed, ['msg-late'], '3.6 расписание удержано без службы сессий');
        const followed = [];
        ctx.setResolveAgent(async () => ({ agent: { followup: (message) => followed.push(message.id) } }));
        update(greenConfig);
        await settle();
        assert.deepEqual(followed, [], '3.6 без службы сессий доставка отложена');
        ctx.showService('sessionController');
        update(greenConfig);
        await settle();
        assert.deepEqual(followed, ['msg-late'], '3.6 служба появилась — напоминание доехало');
      } finally {
        await deactivate();
      }
    });

    // 3.7) Памятка с диска после перезапуска: возвращается на зелёном.
    await runCase('3.7', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const heldFile = path.join(STATE_DIR, 'held.json');
      fs.writeFileSync(
        heldFile,
        JSON.stringify([['session-restored', [{ id: 'msg-restored', source: { kind: 'schedule' } }]]]),
      );
      const ctx = createHostContext();
      const followed = [];
      ctx.setResolveAgent(async () => ({ agent: { followup: (message) => followed.push(message.id) } }));
      activate(ctx, greenConfig);
      try {
        await settle();
        assert.deepEqual(followed, ['msg-restored'], '3.7 памятка с диска доставлена на зелёном');
        assert.ok(!fs.existsSync(heldFile), '3.7 памятка очищена после доставки');
      } finally {
        await deactivate();
      }
    });

    // ---- 4) Новые кейсы плана ----------------------------------------------
    // (а) Автоход на красном ждёт; на зелёном продолжается; удержанное не теряется.
    await runCase('(а)', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, noSignalConfig);
      try {
        const agent = ctx.open('session-a');
        agent.emit('agent/inbox/inserted', { message: { id: 'msg-a-schedule', source: { kind: 'schedule' } } });
        assert.deepEqual(agent.calls.removed, ['msg-a-schedule'], '(а) расписание удержано на красном');
        await agent.preStep([{ id: 'm-a', source: { kind: 'goal' } }]);
        const call = startCall(ctx, 'session-a');
        await expectWaiting(call, '(а) автоход на красном ждёт (done===false)');
        const followed = new Map();
        ctx.setResolveAgent(async (sessionId) => {
          const handle = createAgent(sessionId);
          followed.set(sessionId, handle);
          return { agent: handle.agent };
        });
        update(greenConfig);
        await settle();
        assert.equal(call.done, true, '(а) на зелёном ход продолжился (done===true)');
        assert.deepEqual(
          followed.get('session-a')?.calls.followed.map((message) => message.id),
          ['msg-a-schedule'],
          '(а) удержанное не потеряно',
        );
      } finally {
        await deactivate();
      }
    });

    // (б) Спецсигнал на предке пропускает всё дерево; чужая сессия ждёт.
    await runCase('(б)', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, { ...baseConfig, trafficLightSpecial: ['session-parent'] });
      try {
        ctx.open('session-parent');
        ctx.open('session-parent-child', 'session-parent');
        ctx.open('session-parent-grandchild', 'session-parent-child');
        ctx.open('session-other');
        const mark = ctx.logMark();
        const grandCall = startCall(ctx, 'session-parent-grandchild');
        await expectPassing(grandCall, '(б) внук проходит по спецсигналу предка');
        const otherCall = startCall(ctx, 'session-other');
        await expectWaiting(otherCall, '(б) чужая сессия на красном ждёт');

        // Fail-closed (D2): сессия без записи в реестре — предка нет, сигнала нет.
        const ghostCall = startCall(ctx, undefined, { sessionId: 'session-ghost' });
        await expectWaiting(ghostCall, '(б) fail-closed: предок неизвестен — ждёт');
        assert.equal(logByMarker(ctx, mark, 'pause | session=session-ghost').length, 1, '(б) пауза неизвестной сессии записана');
        ctx.hideService('agents');
        const noRegistryCall = startCall(ctx, undefined, { sessionId: 'session-ghost-2' });
        await expectWaiting(noRegistryCall, '(б) без службы agents сигнала нет (fail-closed)');
        ctx.showService('agents');

        // Включение сигнала адресно отпускает ожидавшую сессию.
        update({ ...baseConfig, trafficLightSpecial: ['session-parent', 'session-other'] });
        await settle();
        assert.equal(otherCall.done, true, '(б) включение сигнала отпускает ожидавшую сессию');
        assert.ok(
          logByMarker(ctx, mark, 'signal | session=session-other').some((line) => line.includes('state=on')),
          '(б) включение записано строкой signal state=on',
        );

        // Выключение возвращает ожидание.
        update({ ...baseConfig, trafficLightSpecial: ['session-parent'] });
        await settle();
        const otherAgain = startCall(ctx, 'session-other');
        await expectWaiting(otherAgain, '(б) выключение сигнала возвращает ожидание');
      } finally {
        await deactivate();
      }
    });

    // (б2) Пределы подъёма: цикл конечен, за 32-м хопом сигнала нет.
    await runCase('(б2)', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, { ...baseConfig, trafficLightSpecial: [] });
      try {
        ctx.register('cycle-a', 'cycle-c');
        ctx.register('cycle-b', 'cycle-a');
        ctx.register('cycle-c', 'cycle-b');
        const cycleCall = startCall(ctx, 'cycle-a');
        await expectWaiting(cycleCall, '(б2) цикл parentSession конечен: сигнала нет — ждёт');

        // Цепочка 35 узлов: корень chain-34, лист chain-00 (34 хопа).
        const depth = 35;
        for (let index = 0; index < depth; index += 1) {
          const id = `chain-${String(index).padStart(2, '0')}`;
          const parent = index === depth - 1 ? undefined : `chain-${String(index + 1).padStart(2, '0')}`;
          ctx.register(id, parent);
        }
        update({ ...baseConfig, trafficLightSpecial: ['chain-34'] });
        await settle();
        const farCall = startCall(ctx, 'chain-00');
        await expectWaiting(farCall, '(б2) за 32-м хопом спецсигнал не достаёт — ждёт');

        update({ ...baseConfig, trafficLightSpecial: ['chain-30'] });
        await settle();
        const nearCall = startCall(ctx, 'chain-00');
        await expectPassing(nearCall, '(б2) в пределах 32 хопов сигнал работает');
      } finally {
        await deactivate();
      }
    });

    // (в) Сообщения пропуск не дают; канал выдачи агенту недоступен.
    await runCase('(в)', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, { ...baseConfig, trafficLightSpecial: ['session-signalled'] });
      try {
        const human = ctx.open('session-human');
        await human.preStep([{ id: 'm-human', source: { kind: 'user', rpcId: 'rpc-human', clientTimeZone: 'Europe/Moscow' } }]);
        const humanCall = startCall(ctx, 'session-human');
        await expectWaiting(humanCall, '(в) человеческий промпт на красном ждёт');

        const child = ctx.open('session-continuable');
        await child.preStep([{ id: 'm-child', source: { kind: 'user', rpcId: 'rpc-child', clientTimeZone: 'Europe/Moscow' } }]);
        const continuableCall = startCall(ctx, 'session-continuable');
        await expectWaiting(continuableCall, '(в) промпт continuable-ребёнка (та же форма) ждёт');

        for (const kind of ['agent-message', 'subagent-settled', 'team-message']) {
          const id = `session-kind-${kind}`;
          ctx.open(id);
          const call = startCall(ctx, id);
          await expectWaiting(call, `(в) ${kind} на красном ждёт`);
        }

        // Агент не получает канал выдачи: наружу торчит только управление твиком.
        assert.deepEqual(
          Object.keys(hostModule).sort(),
          ['activate', 'deactivate', 'update'],
          '(в) экспорт хост-модуля — только activate/update/deactivate',
        );
        const indexForTools = fs.readFileSync(INDEX_PATH, 'utf8');
        assert.doesNotMatch(indexForTools, /registerTool|provide\('tools'\)|ctx\.tools/, '(в) в index.js нет регистрации tools');
      } finally {
        await deactivate();
      }
    });

    // (в-инициатор) F5: id берётся из currentInitiator, а не из options.sessionId.
    await runCase('(в-инициатор)', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, { ...baseConfig, trafficLightSpecial: ['session-signalled'] });
      try {
        ctx.open('session-signalled');
        ctx.open('session-human');
        const call = startCall(ctx, 'session-signalled', { sessionId: 'session-human' });
        await expectPassing(call, '(в-инициатор) id сессии берётся из currentInitiator, а не из options');
      } finally {
        await deactivate();
      }
    });

    // (в-signal-less) F5: полностью неизвестная сессия — fail-open со строкой лога.
    await runCase('(в-signal-less)', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, noSignalConfig);
      try {
        const mark = ctx.logMark();
        const anonymous = startCall(ctx, undefined, {});
        await expectPassing(anonymous, '(в-signal-less) пустой id → вызов проходит (fail-open)');
        assert.equal(
          logByMarker(ctx, mark, 'signal-less').filter((line) => line.includes('reason=no-initiator')).length,
          1,
          '(в-signal-less) fail-open записан строкой signal-less reason=no-initiator',
        );
      } finally {
        await deactivate();
      }
    });

    // (г) Спецсигнал действует через несколько красных окон, пока не выключен.
    await runCase('(г)', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, { ...baseConfig, trafficLightSpecial: ['session-multi'] });
      try {
        ctx.register('session-multi');
        const firstWindow = startCall(ctx, 'session-multi');
        await expectPassing(firstWindow, '(г) первое красное окно: сигнал пропускает');
        clock.now = beijingMs('2026-10-14T14:05');
        update({ ...baseConfig, trafficLightSpecial: ['session-multi'] });
        await settle();
        const secondWindow = startCall(ctx, 'session-multi');
        await expectPassing(secondWindow, '(г) второе красное окно: сигнал всё ещё действует');
        update({ ...baseConfig, trafficLightSpecial: [] });
        await settle();
        const offAgain = startCall(ctx, 'session-multi');
        await expectWaiting(offAgain, '(г) после выключения переключателя снова ждёт');
      } finally {
        await deactivate();
      }
    });

    // (ж) Персистентность: леджер перекрывает сид, выключение переживает рестарт.
    await runCase('(ж)', async () => {
      // 1. файл [] и поля нет → выключено.
      resetStateFiles();
      clock.now = RED_NOW;
      writeSpecialFile([]);
      const ctx1 = createHostContext();
      activate(ctx1, baseConfig);
      try {
        ctx1.register('session-ledger');
        const ledgerOff = startCall(ctx1, 'session-ledger');
        await expectWaiting(ledgerOff, '(ж) файл []: выключение переживает рестарт (сид не воскресает)');
      } finally {
        await deactivate();
      }

      // 2. файла нет и поля нет → сид включён.
      resetStateFiles();
      const ctx2 = createHostContext();
      activate(ctx2, baseConfig);
      try {
        ctx2.register(SEED_SESSION);
        const seedOn = startCall(ctx2, SEED_SESSION);
        await expectPassing(seedOn, '(ж) без файла и поля — сид включён');
      } finally {
        await deactivate();
      }

      // 3. битый файл + поле ['session-x'] → значение конфига.
      resetStateFiles();
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(SPECIAL_FILE, '{ это не json');
      const ctx3 = createHostContext();
      activate(ctx3, { ...baseConfig, trafficLightSpecial: ['session-x'] });
      try {
        ctx3.register('session-x');
        ctx3.register(SEED_SESSION);
        const configOn = startCall(ctx3, 'session-x');
        await expectPassing(configOn, '(ж) битый файл + поле: действует значение конфига');
        const seedUnderConfig = startCall(ctx3, SEED_SESSION);
        await expectWaiting(seedUnderConfig, '(ж) битый файл + поле: сид не подмешивается');
      } finally {
        await deactivate();
      }

      // 4. битый файл и поля нет → сид.
      resetStateFiles();
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(SPECIAL_FILE, 'null');
      const ctx4 = createHostContext();
      activate(ctx4, baseConfig);
      try {
        ctx4.register(SEED_SESSION);
        const seedAfterBroken = startCall(ctx4, SEED_SESSION);
        await expectPassing(seedAfterBroken, '(ж) битый файл без поля — работает сид');
      } finally {
        await deactivate();
      }

      // 5. конфиг со сидом + файл [] → авторитетен файл + строка state-conflict.
      resetStateFiles();
      writeSpecialFile([]);
      const ctx5 = createHostContext();
      const mark = ctx5.logMark();
      activate(ctx5, { ...baseConfig, trafficLightSpecial: [SEED_SESSION] });
      try {
        ctx5.register(SEED_SESSION);
        const fileWins = startCall(ctx5, SEED_SESSION);
        await expectWaiting(fileWins, '(ж) файл [] авторитетнее конфига со сидом');
        assert.ok(
          logByMarker(ctx5, mark, 'state-conflict |').some((line) => line.includes('authority=file')),
          '(ж) расхождение файла и конфига записано строкой state-conflict',
        );

        // 6. Постороннее volatile-поле не пишет леджер и не логирует signal.
        const beforeZoom = fs.readFileSync(SPECIAL_FILE, 'utf8');
        const markZoom = ctx5.logMark();
        update({ ...baseConfig, trafficLightSpecial: [], zoom: false });
        await settle();
        assert.equal(fs.readFileSync(SPECIAL_FILE, 'utf8'), beforeZoom, '(ж) постороннее volatile-поле не пишет файл');
        assert.equal(logByMarker(ctx5, markZoom, 'signal |').length, 0, '(ж) и не логирует signal');
      } finally {
        await deactivate();
      }

      // 7. Сбой записи леджера: save-error, конфиг авторитетен до успешной
      // записи, повтор в refresh(), выключение переживает рестарт.
      resetStateFiles();
      writeSpecialFile(['session-on']);
      const ctx7 = createHostContext();
      activate(ctx7, { ...baseConfig, trafficLightSpecial: ['session-on'] });
      try {
        ctx7.register('session-on');
        const mark = ctx7.logMark();
        fs.chmodSync(STATE_DIR, 0o555);
        try {
          update({ ...baseConfig, trafficLightSpecial: [] });
          await settle();
          assert.ok(logByMarker(ctx7, mark, 'save-error |').length >= 1, '(ж) сбой записи леджера записан строкой save-error');
          const afterFailedSave = startCall(ctx7, 'session-on');
          await expectWaiting(afterFailedSave, '(ж) при сбое записи авторитетен конфиг: сессия ждёт');
        } finally {
          fs.chmodSync(STATE_DIR, 0o755);
        }
        update({ ...baseConfig, trafficLightSpecial: [] });
        await settle();
        assert.deepEqual(readSpecialFile(), { sessions: [] }, '(ж) повтор записи в refresh() сохранил выключение');
      } finally {
        await deactivate();
      }
      const ctx7b = createHostContext();
      activate(ctx7b, baseConfig);
      try {
        ctx7b.register('session-on');
        const afterRestart = startCall(ctx7b, 'session-on');
        await expectWaiting(afterRestart, '(ж) после рестарта выключение осталось выключенным');
      } finally {
        await deactivate();
      }
    });

    // (м) Старт пишет строку signal … rev=0 для каждой сессии сида.
    await runCase('(м)', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, baseConfig);
      try {
        const seedLines = ctx.logLines().filter((line) => line.includes(`signal | session=${SEED_SESSION}`));
        assert.ok(
          seedLines.some((line) => line.includes('state=on') && line.includes('actor=seed') && line.includes('rev=0')),
          '(м) старт пишет signal … actor=seed | rev=0 для сессии сида',
        );
      } finally {
        await deactivate();
      }
    });

    // (е) Ночные окна МСК через гейт: 04:00–07:00 и 09:00–13:00 — пауза.
    await runCase('(е)', async () => {
      resetStateFiles();
      clock.now = Date.UTC(2026, 9, 14, 1, 0); // 04:00 МСК = 09:00 по Пекину — красный
      const ctx = createHostContext();
      activate(ctx, noSignalConfig);
      try {
        ctx.register('session-night');
        const atFour = startCall(ctx, 'session-night');
        await expectWaiting(atFour, '(е) 04:00 МСК без спецсигнала ждёт');
        update({ ...baseConfig, trafficLightSpecial: ['session-night'] });
        await settle();
        const atFourSignal = startCall(ctx, 'session-night');
        await expectPassing(atFourSignal, '(е) 04:00 МСК со спецсигналом проходит');
        update(noSignalConfig);
        await settle();

        clock.now = Date.UTC(2026, 9, 14, 4, 30); // 07:30 МСК = 12:30 по Пекину — зелёный
        update(noSignalConfig);
        await settle();
        const atHalfPastSeven = startCall(ctx, 'session-night');
        await expectPassing(atHalfPastSeven, '(е) 07:30 МСК свободно');

        clock.now = Date.UTC(2026, 9, 14, 10, 30); // 13:30 МСК = 18:30 по Пекину — зелёный
        update(noSignalConfig);
        await settle();
        const atHalfPastThirteen = startCall(ctx, 'session-night');
        await expectPassing(atHalfPastThirteen, '(е) 13:30 МСК свободно');

        // Окна взяты из дефолтов политики, а не из литералов теста.
        assert.deepEqual(policy.normalizePolicy(null).peakWindows, p0Windows(policy), '(е) окна — дефолт политики');
      } finally {
        await deactivate();
      }
    });

    // (п1) Служебный вызов с purpose на красном проходит сразу.
    await runCase('(п1)', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, noSignalConfig);
      try {
        ctx.register('session-purpose');
        const call = startCall(ctx, 'session-purpose', { purpose: 'compaction' });
        await expectPassing(call, '(п1) вызов с purpose на красном проходит сразу');
      } finally {
        await deactivate();
      }
    });

    // (п2) Пустой ход: без сигнала — reject, со сигналом — enter, на зелёном — enter.
    await runCase('(п2)', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, noSignalConfig);
      try {
        const agent = ctx.open('session-empty');
        const emptyBatch = [
          { id: 'ctx-empty-runtime', source: { kind: 'runtime-context' } },
          { id: 'ctx-empty-time', source: { kind: 'time-context' } },
        ];
        const rejected = await agent.preStep(emptyBatch, 1);
        assert.equal(rejected?.kind, 'reject', '(п2) без спецсигнала пустой ход на красном отклонён');

        update({ ...baseConfig, trafficLightSpecial: ['session-empty'] });
        await settle();
        const entered = await agent.preStep(emptyBatch, 1);
        assert.equal(entered?.kind, 'enter', '(п2) со спецсигналом пустой ход не отклоняется');

        update(greenConfig);
        await settle();
        const onGreen = await agent.preStep(emptyBatch, 1);
        assert.equal(onGreen?.kind, 'enter', '(п2) на зелёном пустой ход не отклоняется');
      } finally {
        await deactivate();
      }
    });

    // (л) Лог: структурные строки только в файле; строки логгера не изменились;
    // until — конец окна; пауза дедуплицирована.
    await runCase('(л)', async () => {
      resetStateFiles();
      clock.now = RED_NOW;
      const ctx = createHostContext();
      activate(ctx, noSignalConfig);
      try {
        ctx.register('session-log');
        const mark = ctx.logMark();
        const first = startCall(ctx, 'session-log');
        await expectWaiting(first, '(л) первый вызов на красном ждёт');
        const second = startCall(ctx, 'session-log');
        await expectWaiting(second, '(л) второй вызов на красном ждёт');

        const paused = logByMarker(ctx, mark, 'pause | session=session-log');
        assert.equal(paused.length, 1, '(л) пауза логируется один раз за окно');
        const until = new Date(policy.nextSwitchAt(RED_NOW, policy.DEFAULT_POLICY)).toISOString();
        assert.ok(paused[0].includes(`until=${until}`), '(л) until = конец красного окна');

        update(greenConfig);
        await settle();
        assert.ok(logByMarker(ctx, mark, 'resume | session=session-log').some((line) => line.includes('after=green')), '(л) resume пишется с after=green');

        // Смена поля спецсигнала — повод для строки signal с actor и rev.
        update({ ...noSignalConfig, trafficLightSpecial: ['session-log'] });
        await settle();
        assert.ok(
          logByMarker(ctx, mark, 'signal | session=session-log').some(
            (line) => line.includes('state=on') && line.includes('actor=ui-config') && line.includes('rev=1'),
          ),
          '(л) signal пишется в файл c actor=ui-config и rev=1',
        );

        assert.equal(
          ctx.logs.filter((line) => /\b(pause|resume|signal|signal-less|state-conflict|save-error) \|/.test(line)).length,
          0,
          '(л) структурные строки не идут в логгер',
        );
        assert.ok(ctx.logs.some((line) => line.includes('trafficLight:')), '(л) строки trafficLight: … остались в логгере');
      } finally {
        await deactivate();
      }
    });

    // ---- 4b) Стенд (P4): автономность и полнота состояний -------------------
    await runCase('стенд', async () => {
      const standPath = path.join(__dirname, 'traffic-light-stand.html');
      const stand = fs.readFileSync(standPath, 'utf8');

      // Автономность: ни одного внешнего ресурса — стенд открывается двойным щелчком.
      for (const forbidden of ['http://', 'https://', '<link', 'src=', '@import', 'fetch(', 'XMLHttpRequest']) {
        assert.ok(!stand.includes(forbidden), `стенд без сети: нет «${forbidden}»`);
      }

      // Семь секций: шесть состояний и таблица «состояние → ожидание».
      const sections = [...stand.matchAll(/data-stand-section="([a-z-]+)"/g)].map((match) => match[1]);
      assert.equal(sections.length, 7, 'на стенде семь секций');
      assert.deepEqual(
        sections.sort(),
        ['green', 'red-motion-reduced', 'red-paused', 'red-signal-off', 'red-signal-on', 'states-table', 'yellow'],
        'секции стенда покрывают все состояния',
      );

      // Таблица состояний: строка на каждое ожидание.
      assert.ok(stand.includes('data-stand-table'), 'есть таблица состояний');
      const expectations = [...stand.matchAll(/data-expect="([a-z]+)"/g)].map((match) => match[1]);
      assert.deepEqual(
        expectations.sort(),
        ['bypass', 'free', 'off', 'paused', 'reduced', 'warn'],
        'таблица перечисляет все ожидания',
      );

      // Статусы и маркеры: каждое состояние показано тем же контрактом, что и в клиенте.
      const statuses = [...stand.matchAll(/data-dsh-light-status="([a-z]+)"/g)].map((match) => match[1]);
      assert.deepEqual(
        [...new Set(statuses)].sort(),
        ['bypass', 'free', 'paused'],
        'на стенде видны все три статуса',
      );
      assert.ok(stand.includes('data-dsh-light-signal="on"') && stand.includes('aria-pressed="true"'), 'есть включённый переключатель');
      assert.ok(stand.includes('data-dsh-light-signal="off"') && stand.includes('aria-pressed="false"'), 'есть выключенный переключатель');
      assert.ok(stand.includes('data-motion="reduced"'), 'есть состояние reduced-motion');
      assert.ok(stand.includes('data-motion="full"'), 'есть состояние с полной анимацией');
      assert.ok(/@keyframes signal-strobe/.test(stand) && /\[data-motion="reduced"\]/.test(stand), 'стробоскоп и статика описаны в CSS стенда');
      assert.match(stand, /ждёт зелёного до \d{2}:\d{2}/, 'красный статус подписан «ждёт зелёного до HH:MM»');

      // Стенд не расходится с клиентом: те же признаки и подсказка об отказе.
      const clientForStand = fs.readFileSync(CLIENT_PATH, 'utf8');
      for (const marker of [
        'data-dsh-light-signal',
        'data-motion',
        'data-dsh-light-status',
        'data-dsh-light-panel',
        'data-dsh-light-alert',
      ]) {
        assert.ok(stand.includes(marker), `стенд использует признак ${marker}`);
        assert.ok(clientForStand.includes(marker), `клиент объявляет признак ${marker} (стенд не врёт)`);
      }
    });

    // ---- 5) Схема Config, сид и праздники в index.js ------------------------
    await runCase('(з)', async () => {
      const indexSource = fs.readFileSync(INDEX_PATH, 'utf8');
      for (const field of [
        'trafficLight',
        'trafficLightWarningMinutes',
        'trafficLightPeakWindows',
        'trafficLightHolidays',
        'trafficLightPauseSchedules',
        'trafficLightPauseAgents',
        'trafficLightSpecial',
      ]) {
        assert.ok(indexSource.includes(`${field}: Schema.`), `в схеме Config есть поле ${field}`);
      }
      assert.match(
        indexSource,
        /trafficLightWarningMinutes: Schema\.number\(\)\.default\(10\)/,
        'в схеме профиля предупреждение по умолчанию — 10 минут',
      );
      assert.match(
        indexSource,
        /trafficLightSpecial: Schema\.array\(Schema\.string\(\)\)\.default\(TRAFFIC_LIGHT_SPECIAL_SEED\)/,
        'поле спецсигнала объявлено списком строк с сидом по умолчанию',
      );
      assert.ok(indexSource.includes(SEED_SESSION), '(з) сид содержит сессию session-e4698bf8-717f-4e1a-9390-a2b40c03d985');
      assert.ok(indexSource.includes('t1447u'), '(з) рядом с сидом записано решение t1447u');
      assert.ok(
        indexSource.includes("start: Schema.string().pattern(/^([01]\\d|2[0-3]):[0-5]\\d$/)"),
        'окна пика проверяются паттерном времени',
      );
      const holidaysMatch = /const TRAFFIC_LIGHT_HOLIDAYS_2026 = \[[\s\S]*?\];/.exec(indexSource);
      assert.ok(holidaysMatch, 'в index.js есть список праздников по умолчанию');
      const indexHolidays = [...holidaysMatch[0].matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map((match) => match[1]);
      assert.deepEqual(indexHolidays, policy.HOLIDAYS_2026, 'список праздников в схеме совпадает с политикой');
    });
  } finally {
    Date.now = realNow;
  }

  // ---- 6) Итог: обычный прогон или сверка с ожиданиями базового дерева -----
  const lines = results.map((result) => `${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.ok ? '' : `: ${result.error?.message}`}`);
  console.log(lines.join('\n'));

  if (baseMode) {
    const problems = [];
    for (const result of results) {
      const expected = BASE_EXPECT.get(result.name);
      if (expected === undefined) {
        problems.push(`${result.name}: нет ожидания для базового дерева (дополни BASE_EXPECT)`);
        continue;
      }
      if (expected === 'pass' && !result.ok) problems.push(`${result.name}: на базе ожидался pass, получен fail (${result.error?.message})`);
      if (expected === 'fail' && result.ok) problems.push(`${result.name}: на базе ожидался fail — кейс ложнозелёный`);
    }
    const unexpected = [...BASE_EXPECT.keys()].filter((name) => !results.some((result) => result.name === name));
    for (const name of unexpected) problems.push(`${name}: ожидание есть, кейса нет`);
    if (problems.length > 0) {
      console.error(`\nбаза 9b9ac36: расхождение с ожиданиями\n${problems.join('\n')}`);
      fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
      process.exit(1);
    }
    console.log(`\nбаза 9b9ac36: ожидания совпали (${results.length} кейсов)`);
    fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
    return;
  }

  const failed = results.filter((result) => !result.ok);
  fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  if (failed.length > 0) {
    console.error(`\nЕСТЬ ОШИБКИ: ${failed.length} из ${results.length} кейсов`);
    process.exit(1);
  }
  console.log('\ncheck-traffic-light: ok');
}

/**
 * Дефолтные окна пика из политики — без литералов теста.
 * @param {object} policy - модуль политики.
 * @returns {number[][]} окна в минутах суток.
 */
function p0Windows(policy) {
  return policy.DEFAULT_POLICY.peakWindows;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
