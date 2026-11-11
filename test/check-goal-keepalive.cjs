'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log('ok', name);
    });
}

/** Свежий DSH_HOME: журнал твика пишется туда, а не в рабочий каталог. */
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-keepalive-'));
  process.env.DSH_HOME = home;
  return home;
}

/** Строки журнала твика из текущего DSH_HOME. */
function logLines(home) {
  const file = path.join(home, 'dsh-tweaks', 'goal-keepalive.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

/**
 * Стаб службы целей: помнит вызовы resume и отдаёт заданное состояние.
 * @param {object|null} goal - вид цели, который вернёт get().
 * @param {object|null} [failure] - ошибка, которую бросит resume.
 */
function stubGoals(goal, failure) {
  const calls = [];
  return {
    calls,
    get() {
      return goal;
    },
    resume(agent, ref) {
      calls.push({ agentId: agent.id, ref });
      if (failure !== undefined && failure !== null) throw failure;
      return { ...goal, activation: 'armed' };
    },
  };
}

/** Стаб реестра агентов: живым считается только переданный агент. */
function stubAgents(live) {
  return {
    get(id) {
      return live.find((agent) => agent.id === id);
    },
    list() {
      return [...live];
    },
  };
}

(async () => {
  const host = await import(pathToFileURL(path.join(__dirname, '..', 'tweaks', 'goal-keepalive-host.js')).href);
  const GOAL_ID = 'goal-abc';
  const goalActive = (revision, activation) => ({ id: GOAL_ID, revision, phase: 'active', activation });

  await test('shouldResume: только active+disarmed', () => {
    assert.equal(host.shouldResume(goalActive(3, 'disarmed')), true);
    assert.equal(host.shouldResume(goalActive(3, 'armed')), false);
    assert.equal(host.shouldResume({ id: GOAL_ID, revision: 3, phase: 'paused', activation: 'disarmed' }), false);
    assert.equal(host.shouldResume({ id: GOAL_ID, revision: 3, phase: 'complete', activation: 'disarmed' }), false);
    assert.equal(host.shouldResume({ id: GOAL_ID, revision: 3, phase: 'blocked', activation: 'disarmed' }), false);
    assert.equal(host.shouldResume(undefined), false);
    assert.equal(host.shouldResume(null), false);
  });

  await test('active+disarmed: resume вызван один раз, журнал disarmed→armed', async () => {
    const home = freshHome();
    const agent = { id: 'session-a' };
    const goals = stubGoals(goalActive(4, 'disarmed'));
    const ok = await host.resumeIfNeeded(agent, 'startup', { goals, agents: stubAgents([agent]) });
    assert.equal(ok, true);
    assert.equal(goals.calls.length, 1);
    assert.deepEqual(goals.calls[0].ref, { id: GOAL_ID, revision: 4 });
    const lines = logLines(home);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\| session-a \| goal-abc \| disarmed→armed \| startup$/);
  });

  await test('paused не трогаем: resume не вызывается', async () => {
    const home = freshHome();
    const agent = { id: 'session-b' };
    const goals = stubGoals({ id: GOAL_ID, revision: 5, phase: 'paused', activation: 'disarmed' });
    const ok = await host.resumeIfNeeded(agent, 'activation-changed', { goals, agents: stubAgents([agent]) });
    assert.equal(ok, false);
    assert.equal(goals.calls.length, 0);
    assert.deepEqual(logLines(home), []);
  });

  await test('complete и blocked не трогаем', async () => {
    freshHome();
    const agent = { id: 'session-c' };
    for (const phase of ['complete', 'blocked']) {
      const goals = stubGoals({ id: GOAL_ID, revision: 6, phase, activation: 'disarmed' });
      // eslint-disable-next-line no-await-in-loop
      const ok = await host.resumeIfNeeded(agent, 'agent-created', { goals, agents: stubAgents([agent]) });
      assert.equal(ok, false);
      assert.equal(goals.calls.length, 0);
    }
  });

  await test('двойное событие по одной ревизии не даёт второго resume', async () => {
    const home = freshHome();
    const agent = { id: 'session-d' };
    const goals = stubGoals(goalActive(7, 'disarmed'));
    const done = new Map();
    const inflight = new Set();
    const deps = { goals, agents: stubAgents([agent]), done, inflight };
    assert.equal(await host.resumeIfNeeded(agent, 'activation-changed', deps), true);
    assert.equal(await host.resumeIfNeeded(agent, 'activation-changed', deps), false);
    assert.equal(goals.calls.length, 1);
    const lines = logLines(home);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /duplicate$/);
  });

  await test('не-live агент пропускается с маркером not-live', async () => {
    const home = freshHome();
    const agent = { id: 'session-e' };
    const goals = stubGoals(goalActive(8, 'disarmed'));
    const ok = await host.resumeIfNeeded(agent, 'startup', { goals, agents: stubAgents([]) });
    assert.equal(ok, false);
    assert.equal(goals.calls.length, 0);
    const lines = logLines(home);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\| not-live$/);
  });

  await test('устаревшая revision глотается с маркером revision-stale', async () => {
    const home = freshHome();
    const agent = { id: 'session-f' };
    const stale = Object.assign(new Error('stale goal ref'), { code: 'GOAL_STALE_REVISION' });
    const goals = stubGoals(goalActive(9, 'disarmed'), stale);
    const done = new Map();
    const ok = await host.resumeIfNeeded(agent, 'activation-changed', { goals, agents: stubAgents([agent]), done });
    assert.equal(ok, false);
    assert.equal(goals.calls.length, 1);
    const lines = logLines(home);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\| revision-stale$/);
    // Повтор по той же ревизии после stale больше не дергает сервис.
    assert.equal(await host.resumeIfNeeded(agent, 'activation-changed', { goals, agents: stubAgents([agent]), done }), false);
    assert.equal(goals.calls.length, 1);
  });

  await test('ротация журнала по 1 МБ', async () => {
    const home = freshHome();
    const dir = path.join(home, 'dsh-tweaks');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'goal-keepalive.log');
    fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 10));
    const agent = { id: 'session-g' };
    const goals = stubGoals(goalActive(10, 'disarmed'));
    assert.equal(await host.resumeIfNeeded(agent, 'startup', { goals, agents: stubAgents([agent]) }), true);
    assert.equal(fs.existsSync(`${file}.1`), true, 'старый журнал переехал в .1');
    assert.match(fs.readFileSync(file, 'utf8'), /disarmed→armed/);
  });

  await test('activate без сервисов не падает и пишет диагностику, затем ждёт inject', async () => {
    const home = freshHome();
    const g = { value: undefined };
    const a = { value: undefined };
    let injected = null;
    const ctx = {
      get(name) {
        if (name === 'goals') return g.value;
        if (name === 'agents') return a.value;
        return undefined;
      },
      on() {
        return () => {};
      },
      inject(names, callback) {
        injected = callback;
        return () => {};
      },
    };
    host.activate(ctx, { goalKeepalive: true });
    const lines = logLines(home);
    assert.match(lines[0], /activate \| goals=no \| agents=no \| config\.goalKeepalive=true$/);
    assert.equal(typeof injected, 'function', 'ctx.inject получил колбэк ожидания сервисов');

    // Сервисы смонтировались позже: колбэк inject обязан вернуть активацию.
    const agent = { id: 'session-late' };
    const goals = stubGoals(goalActive(11, 'disarmed'));
    g.value = goals;
    a.value = stubAgents([agent]);
    injected();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(goals.calls.length, 1, 'resume по позднему сервису');
    const after = logLines(home).join('\n');
    assert.match(after, /inject-ready/);
    assert.match(after, /agents=1 \| resumed=1/);
    await host.deactivate();
  });

  await test('sweepNow логирует готовность и счётчики, resume только для active+disarmed', async () => {
    const home = freshHome();
    const pending = { id: 'session-need' };
    const pausedAgent = { id: 'session-paused' };
    const goals = {
      calls: [],
      get(agent) {
        if (agent.id === 'session-need') return goalActive(12, 'disarmed');
        return { id: GOAL_ID, revision: 3, phase: 'paused', activation: 'disarmed' };
      },
      resume(agent, ref) {
        this.calls.push({ agentId: agent.id, ref });
      },
    };
    const ctx = {
      get(name) {
        if (name === 'goals') return goals;
        if (name === 'agents') {
          return {
            get: (id) => [pending, pausedAgent].find((agent) => agent.id === id),
            list: () => [pending, pausedAgent],
          };
        }
        return undefined;
      },
      on() {
        return () => {};
      },
    };
    host.activate(ctx, { goalKeepalive: true });
    const result = await host.sweepNow('scan', 1);
    assert.equal(result.agents, 2);
    assert.equal(result.resumed, 1);
    assert.equal(goals.calls.length, 1);
    assert.equal(goals.calls[0].agentId, 'session-need');
    const text = logLines(home).join('\n');
    assert.match(text, /scan \| tick=1 \| agents=2 \| resumed=1/);
    await host.deactivate();
  });

  await test('sweepNow без сервисов пишет services-not-ready и не бросает', async () => {
    const home = freshHome();
    const ctx = {
      get() {
        return undefined;
      },
      on() {
        return () => {};
      },
    };
    host.activate(ctx, {});
    const result = await host.sweepNow('startup');
    assert.equal(result.ready, false);
    assert.equal(result.resumed, 0);
    assert.match(logLines(home).join('\n'), /services-not-ready goals=no agents=no/);
    await host.deactivate();
  });

  console.log(`check-goal-keepalive: ${passed} проверок пройдено`);
})().catch((error) => {
  console.error('FAIL', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
