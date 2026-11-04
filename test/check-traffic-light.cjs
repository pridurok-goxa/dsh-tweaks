'use strict';

// Проверка твика «светофор» (trafficLight) бандла dsh-tweaks без установки DSH:
//   1. политика тарифов (tweaks/traffic-light-policy.js) — границы окон,
//      выходные, праздники, жёлтое предупреждение, нормализация конфигурации;
//   2. копия политики в client.js совпадает с хост-модулем (дрейфа нет);
//   3. хост-половина (tweaks/traffic-light-host.js) — контракт на моке
//      контекста: удержание расписаний на красном, возврат на зелёном,
//      пауза автоматических модельных вызовов, fail-open для ручных;
//   4. схема Config в index.js объявляет поля твика, а список праздников
//      совпадает с политикой.
//
// Запуск: node test/check-traffic-light.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Файловый лог и памятка удержанного пишутся во временный каталог: тест не
// трогает состояние настоящего профиля.
process.env.DSH_HOME = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsh-tweaks-test-'));

const ROOT = path.join(__dirname, '..');
const POLICY_PATH = path.join(ROOT, 'tweaks', 'traffic-light-policy.js');
const HOST_PATH = path.join(ROOT, 'tweaks', 'traffic-light-host.js');
const CLIENT_PATH = path.join(ROOT, 'client.js');
const INDEX_PATH = path.join(ROOT, 'index.js');

/** Миллисекунды в минуте. */
const MINUTE_MS = 60_000;

/** Среда внутри утреннего окна пика — «сейчас» для хост-половины. */
const FIXED_NOW = Date.UTC(2026, 9, 14, 2, 0); // 2026-10-14 10:00 по Пекину

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

/** Подождать микрозадач и макротиков — чтобы дошла повторная доставка. */
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
 * Мок хост-контекста: службы, события корневого контекста, таймеры.
 *
 * Службы мутируемые: тест меняет инициатора и ответ resolveAgent на лету —
 * хост-половина держит ссылки на объекты служб, взятые при activate.
 * @returns {object} контекст с эмиттером, записями и методами подмены.
 */
function createHostContext() {
  const rootListeners = new Map();
  const logs = [];
  const resolved = [];
  const state = { initiator: undefined };
  let resolveImpl = async (sessionId) => {
    resolved.push(sessionId);
    return { error: { code: 'session/not-found' } };
  };
  const hidden = new Set();
  const services = {
    agents: {
      currentInitiator: () => state.initiator,
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
    get(name) {
      return hidden.has(name) ? undefined : services[name];
    },
    /** Спрятать службу: ctx.get вернёт undefined — как до её применения. */
    hideService(name) {
      hidden.add(name);
    },
    /** Показать службу обратно. */
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
  };
}

/** Главный прогон проверок. */
async function main() {
  const policy = await import(pathToFileURL(POLICY_PATH).href);
  const { activate, update, deactivate } = await import(pathToFileURL(HOST_PATH).href);

  // ---- 1) Политика тарифов -------------------------------------------------
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

  // ---- 2) Копия политики в client.js --------------------------------------
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

  // ---- 3) Хост-половина ----------------------------------------------------
  // Время зафиксировано: среда 10:00 по Пекину — внутри утреннего окна пика.
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const defaultConfig = {
      trafficLight: true,
      trafficLightPauseSchedules: true,
      trafficLightPauseAgents: true,
    };
    const greenConfig = {
      ...defaultConfig,
      trafficLightPeakWindows: [{ start: '23:00', end: '23:59' }],
      trafficLightWarningMinutes: 0,
    };

    // 3.1) Красный: расписание удерживается, ручное сообщение — нет.
    const ctx = createHostContext();
    ctx.setInitiator('session-a');
    activate(ctx, defaultConfig);
    assert.ok(ctx.logs.some((line) => line.includes('green → red')), 'активация вычислила красный');

    const sessionA = createAgent('session-a');
    ctx.emit('agent/created', { agent: sessionA.agent });
    const scheduleMessage = { id: 'msg-schedule', source: { kind: 'schedule' } };
    sessionA.emit('agent/inbox/inserted', { message: scheduleMessage });
    assert.deepEqual(sessionA.calls.removed, ['msg-schedule'], 'расписание на красном снято из входящих');

    const userMessage = { id: 'msg-user', source: { kind: 'user' } };
    sessionA.emit('agent/inbox/inserted', { message: userMessage });
    assert.deepEqual(sessionA.calls.removed, ['msg-schedule'], 'ручное сообщение не трогается');

    // 3.2) Автоматический шаг на красном ждёт зелёного; ручной — не ждёт.
    await sessionA.preStep([{ id: 'm1', source: { kind: 'goal' } }]);
    const automatic = ctx.driveLlmStream({}, [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }]);
    let automaticDone = false;
    automatic.then(() => {
      automaticDone = true;
    });
    await settle();
    assert.equal(automaticDone, false, 'автоматический вызов стоит на красном');

    await sessionA.preStep([{ id: 'm2', source: { kind: 'user' } }]);
    const manual = await ctx.driveLlmStream({}, [{ type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }]);
    assert.equal(manual.length, 1, 'ручной вызов на красном проходит сразу');

    // 3.3) Зелёный: ожидавший вызов отпускается, расписание возвращается в работу.
    const followedAgents = new Map();
    ctx.setResolveAgent(async (sessionId) => {
      const handle = createAgent(sessionId);
      followedAgents.set(sessionId, handle);
      return { agent: handle.agent };
    });
    update(greenConfig);
    await settle();
    assert.equal(automaticDone, true, 'на зелёном автоматический вызов пошёл');
    assert.deepEqual(ctx.resolved, ['session-a'], 'сессия удержанного напоминания поднята');
    assert.deepEqual(
      followedAgents.get('session-a')?.calls.followed.map((message) => message.id),
      ['msg-schedule'],
      'удержанное напоминание вернулось в работу',
    );

    // 3.4) Субагент наследует режим родителя: из ручного шага — работает на красном.
    await sessionA.preStep([{ id: 'm3', source: { kind: 'user' } }]);
    const childB = createAgent('child-b');
    sessionA.emit('subagent/start', { id: 'child-b' });
    ctx.setInitiator('child-b');
    update(defaultConfig);
    ctx.emit('agent/created', { agent: childB.agent });
    await childB.preStep([{ id: 'm4', source: { kind: 'subagent' } }]);
    const childCall = await ctx.driveLlmStream({}, [{ type: 'usage', usage: { inputTokens: 3, outputTokens: 3 } }]);
    assert.equal(childCall.length, 1, 'субагент ручного родителя на красном не блокируется');

    // 3.4а) Служебные вставки не делают шаг ручным: расписание в красном
    // окне ждёт зелёного, хотя в батче есть runtime-context и time-context.
    const scheduleAgent = createAgent('session-schedule');
    ctx.emit('agent/created', { agent: scheduleAgent.agent });
    ctx.setInitiator('session-schedule');
    await scheduleAgent.preStep([
      { id: 'ctx-runtime', source: { kind: 'runtime-context' } },
      { id: 'ctx-time', source: { kind: 'time-context' } },
      { id: 'm-schedule', source: { kind: 'schedule' } },
    ]);
    const scheduleCall = ctx.driveLlmStream({}, [{ type: 'usage', usage: { inputTokens: 4, outputTokens: 4 } }]);
    let scheduleDone = false;
    scheduleCall.then(() => {
      scheduleDone = true;
    });
    await settle();
    assert.equal(scheduleDone, false, 'автоматический шаг с вставками контекста стоит на красном');

    // Продолжение того же хода: в батче только служебные вставки — режим
    // шага наследуется от начала хода, пауза продолжается.
    await scheduleAgent.preStep([
      { id: 'ctx-runtime-2', source: { kind: 'runtime-context' } },
      { id: 'ctx-time-2', source: { kind: 'time-context' } },
    ], 2);
    const continued = ctx.driveLlmStream({}, [{ type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } }]);
    let continuedDone = false;
    continued.then(() => {
      continuedDone = true;
    });
    await settle();
    assert.equal(continuedDone, false, 'продолжение автоматического хода тоже ждёт зелёного');

    // Ручной шаг со служебными вставками не блокируется.
    await scheduleAgent.preStep([
      { id: 'ctx-runtime-3', source: { kind: 'runtime-context' } },
      { id: 'm-user', source: { kind: 'user' } },
    ]);
    const manualWithContext = await ctx.driveLlmStream({}, [{ type: 'usage', usage: { inputTokens: 6, outputTokens: 6 } }]);
    assert.equal(manualWithContext.length, 1, 'ручной шаг со вставками контекста не блокируется');

    // Зелёный отпускает и ожидавшие автоматические вызовы.
    update(greenConfig);
    await settle();
    assert.equal(scheduleDone, true, 'на зелёном автоматический шаг пошёл');
    assert.equal(continuedDone, true, 'на зелёном продолжился и второй шаг');

    // Пустой ход (доставку изъяли, wake-латч открыл ход) на красном
    // отклоняется: батч из одних служебных вставок не тратит токены.
    update(defaultConfig);
    await settle();
    const wakeAgent = createAgent('session-wake');
    ctx.emit('agent/created', { agent: wakeAgent.agent });
    const rejected = await wakeAgent.preStep([
      { id: 'ctx-wake-runtime', source: { kind: 'runtime-context' } },
      { id: 'ctx-wake-time', source: { kind: 'time-context' } },
    ], 1);
    assert.equal(rejected?.kind, 'reject', 'пустой ход на красном отклонён');

    // На зелёном такой же ход не отклоняется — режим показывает честное «дальше».
    update(greenConfig);
    await settle();
    const allowed = await wakeAgent.preStep([
      { id: 'ctx-wake-runtime-2', source: { kind: 'runtime-context' } },
      { id: 'ctx-wake-time-2', source: { kind: 'time-context' } },
    ], 1);
    assert.equal(allowed?.kind, 'enter', 'на зелёном пустой ход не отклоняется');

    // Возвращаем красный: проверка выгрузки ниже снова ждёт удержание.
    update(defaultConfig);
    await settle();

    // 3.5) Выгрузка: ожидающие отпущены, удержанное роздано.
    const heldAgain = createAgent('session-c');
    ctx.emit('agent/created', { agent: heldAgain.agent });
    heldAgain.emit('agent/inbox/inserted', { message: { id: 'msg-held', source: { kind: 'schedule' } } });
    assert.deepEqual(heldAgain.calls.removed, ['msg-held'], 'сообщение удержано перед выгрузкой');
    await deactivate();
    await settle();
    assert.ok(ctx.resolved.includes('session-c'), 'выгрузка вернула удержанное напоминание');
    assert.deepEqual(
      followedAgents.get('session-c')?.calls.followed.map((message) => message.id),
      ['msg-held'],
      'после выгрузки сообщение в работе',
    );
    // Повторная деактивация безопасна.
    await deactivate();

    // 3.6) Служба сессий поднялась позже: удержанное не теряется, а доезжает
    // повторной доставкой на следующем пересчёте зелёного света.
    const lateCtx = createHostContext();
    lateCtx.hideService('sessionController');
    activate(lateCtx, defaultConfig);
    const lateAgent = createAgent('session-late');
    lateCtx.emit('agent/created', { agent: lateAgent.agent });
    lateAgent.emit('agent/inbox/inserted', { message: { id: 'msg-late', source: { kind: 'schedule' } } });
    assert.deepEqual(lateAgent.calls.removed, ['msg-late'], 'расписание удержано без службы сессий');
    const followedLate = [];
    lateCtx.setResolveAgent(async () => ({ agent: { followup: (message) => followedLate.push(message.id) } }));
    update(greenConfig);
    await settle();
    assert.deepEqual(followedLate, [], 'без службы сессий доставка отложена');
    lateCtx.showService('sessionController');
    update(greenConfig);
    await settle();
    assert.deepEqual(followedLate, ['msg-late'], 'служба появилась — напоминание доехало');
    await deactivate();

    // 3.7) Памятка с диска после перезапуска: возвращается на зелёном.
    const stateFile = path.join(process.env.DSH_HOME, 'dsh-tweaks', 'held.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify([['session-restored', [{ id: 'msg-restored', source: { kind: 'schedule' } }]]]),
    );
    const restoredCtx = createHostContext();
    const followedRestored = [];
    restoredCtx.setResolveAgent(async () => ({ agent: { followup: (message) => followedRestored.push(message.id) } }));
    activate(restoredCtx, greenConfig);
    await settle();
    assert.deepEqual(followedRestored, ['msg-restored'], 'памятка с диска доставлена на зелёном');
    assert.ok(!fs.existsSync(stateFile), 'памятка очищена после доставки');
    await deactivate();
  } finally {
    Date.now = realNow;
  }

  // ---- 4) Схема Config и праздники в index.js ------------------------------
  const indexSource = fs.readFileSync(INDEX_PATH, 'utf8');
  for (const field of [
    'trafficLight',
    'trafficLightWarningMinutes',
    'trafficLightPeakWindows',
    'trafficLightHolidays',
    'trafficLightPauseSchedules',
    'trafficLightPauseAgents',
  ]) {
    assert.ok(indexSource.includes(`${field}: Schema.`), `в схеме Config есть поле ${field}`);
  assert.match(
    indexSource,
    /trafficLightWarningMinutes: Schema\.number\(\)\.default\(10\)/,
    'в схеме профиля предупреждение по умолчанию — 10 минут',
  );
  }
  assert.ok(
    indexSource.includes("start: Schema.string().pattern(/^([01]\\d|2[0-3]):[0-5]\\d$/)"),
    'окна пика проверяются паттерном времени',
  );
  const holidaysMatch = /const TRAFFIC_LIGHT_HOLIDAYS_2026 = \[[\s\S]*?\];/.exec(indexSource);
  assert.ok(holidaysMatch, 'в index.js есть список праздников по умолчанию');
  const indexHolidays = [...holidaysMatch[0].matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map((match) => match[1]);
  assert.deepEqual(indexHolidays, policy.HOLIDAYS_2026, 'список праздников в схеме совпадает с политикой');

  fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });

console.log('check-traffic-light: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
