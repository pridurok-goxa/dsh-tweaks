'use strict';
/**
 * Проверка страховки агентов (tweaks/agent-guards-host.js): секреты в argv,
 * выкат «+wip», запись в основной checkout на main/master, зацикливание и
 * сам хук tools/pre-execute (deny до исполнения, журнал без значения секрета).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('ok', name);
}

function sh(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guards-'));
  process.env.DSH_HOME = home;
  const g = await import(pathToFileURL(path.join(__dirname, '..', 'tweaks', 'agent-guards-host.js')).href);

  await test('secrets: литералы находятся', () => {
    assert.equal(g.checkSecrets('PGPASSWORD=hunter2 psql -h x'), 'PGPASSWORD=<литерал>');
    assert.equal(g.checkSecrets("psql 'postgresql://app:s3cr3t@127.0.0.1/db'"), 'DSN с паролем');
    assert.equal(g.checkSecrets('mysqldump --password=abc db'), '--password <литерал>');
    assert.equal(g.checkSecrets('curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345" x'), 'Bearer <токен>');
    assert.equal(g.checkSecrets('echo ghp_' + 'a'.repeat(36)), 'токен GitHub');
  });
  await test('secrets: ссылки на переменные разрешены', () => {
    assert.equal(g.checkSecrets('PGPASSWORD="$DB_PASS" psql'), null);
    assert.equal(g.checkSecrets('PGPASSWORD=$(cat /run/x) psql'), null);
    assert.equal(g.checkSecrets('psql "postgresql://app:${PW}@h/db"'), null);
    assert.equal(g.checkSecrets('curl -H "Authorization: Bearer $TOKEN" x'), null);
    assert.equal(g.checkSecrets('set -a; . /etc/x.env; set +a; psql "$DSN"'), null);
    assert.equal(g.checkSecrets('git status'), null);
  });
  await test('wip: «+wip» в выкате — отказ, в grep — нет', () => {
    assert.equal(g.checkWipCommand('ops/deploy/dev-stand.sh deploy --lane a # 3bbddb0+wip'), true);
    assert.equal(g.checkWipCommand('grep -c "+wip" sessions.jsonl'), false);
    assert.equal(g.checkWipCommand('echo +wip'), false);
  });
  await test('wip: разбор dev-stand', () => {
    const calls = g.parseDevStand('cd /r && ops/deploy/dev-stand.sh deploy --lane x --ref abc123 && echo ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ref, 'abc123');
    assert.equal(g.parseDevStand('ops/deploy/dev-stand.sh status').length, 0);
    assert.equal(g.parseDevStand('dev-stand.sh deploy --lane x --allow-shared-tree')[0].shared, true);
  });

  // Стенд git: основной checkout на master + linked worktree лейна.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-repo-'));
  sh(repo, 'init', '-q', '-b', 'master');
  fs.mkdirSync(path.join(repo, 'ops', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'ops', 'deploy', 'dev-stand.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'init');
  const wt = path.join(repo, '.local', 'worktrees', 'lane1');
  sh(repo, 'worktree', 'add', '-q', '-b', 'lane1', wt);

  await test('wip: чистый worktree лейна проходит, грязный — отказ', async () => {
    const cmd = `${repo}/ops/deploy/dev-stand.sh deploy --lane lane1`;
    assert.equal(await g.checkDevStand(cmd, repo), null);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
    assert.match(await g.checkDevStand(cmd, repo), /незакоммиченных/);
    assert.equal(await g.checkDevStand(`${cmd} --ref deadbee`, repo), null);
    assert.match(await g.checkDevStand(`ops/deploy/dev-stand.sh deploy --lane x --allow-shared-tree`, repo), /общее дерево/);
  });
  await test('rootWrite: основной checkout на master — отказ, worktree и docs/plans — нет', () => {
    const opts = { roots: [path.dirname(repo)] };
    assert.match(g.checkRootWrite(path.join(repo, 'src', 'x.js'), opts), /основном checkout/);
    assert.equal(g.checkRootWrite(path.join(repo, 'docs', 'plans', 'p.md'), opts), null);
    assert.equal(g.checkRootWrite(path.join(wt, 'src', 'x.js'), opts), null);
    assert.equal(g.checkRootWrite(path.join(repo, 'src', 'x.js'), { roots: ['/nowhere'] }), null);
    sh(repo, 'checkout', '-q', '-b', 'feature');
    assert.equal(g.checkRootWrite(path.join(repo, 'src', 'x.js'), opts), null);
    sh(repo, 'checkout', '-q', 'master');
  });
  await test('loop: третий одинаковый вызов подряд', () => {
    const d = g.createLoopDetector(3);
    const agent = {};
    assert.equal(d.hit(agent, 'bash', { command: 'ls', description: 'a' }), 1);
    assert.equal(d.hit(agent, 'bash', { command: 'ls', description: 'b' }), 2);
    assert.equal(d.hit(agent, 'bash', { command: 'ls' }), 3);
    assert.equal(d.hit(agent, 'bash', { command: 'pwd' }), 1);
    assert.equal(d.hit({}, 'bash', { command: 'pwd' }), 1, 'другой агент — свой счётчик');
  });
  await test('хук: deny до исполнения, журнал без значения секрета', async () => {
    const handlers = [];
    const ctx = { on: (name, fn) => { handlers.push({ name, fn }); return () => { handlers.length = 0; }; }, get: () => undefined };
    g.activate(ctx, { agentGuardsRootWriteRoots: [path.dirname(repo)] });
    const hook = handlers.find((h) => h.name === 'tools/pre-execute');
    assert.ok(hook, 'хук поставлен');
    const agent = { session: { id: 'session-test' } };
    const allow = await hook.fn({ name: 'bash', arguments: { command: 'git status' }, agent }, async () => ({ kind: 'allow' }));
    assert.equal(allow.kind, 'allow');
    const deny = await hook.fn({ name: 'bash', arguments: { command: 'PGPASSWORD=topsecret9 psql' }, agent }, async () => ({ kind: 'allow' }));
    assert.equal(deny.kind, 'deny');
    assert.match(deny.reason, /agent-guards \[secrets\]/);
    assert.ok(!deny.reason.includes('topsecret9'));
    const w = await hook.fn({ name: 'write', arguments: { file_path: path.join(repo, 'x.js'), content: '' }, agent }, async () => ({ kind: 'allow' }));
    assert.equal(w.kind, 'deny');
    const log = fs.readFileSync(path.join(home, 'dsh-tweaks', 'agent-guards.jsonl'), 'utf8');
    assert.ok(!log.includes('topsecret9'), 'секрет не в журнале');
    assert.match(log, /"rule":"secrets"/);
    assert.match(log, /"rule":"rootWrite"/);
    g.update({ agentGuardsSecrets: false });
    const off = await hook.fn({ name: 'bash', arguments: { command: 'PGPASSWORD=x2 psql' }, agent }, async () => ({ kind: 'allow' }));
    assert.equal(off.kind, 'allow', 'флаг выключает правило без перестановки');
    await g.deactivate();
    assert.equal(handlers.length, 0, 'хук снят');
  });
  await test('хук: ошибка проверки = пропуск (fail-open)', async () => {
    const handlers = [];
    g.activate({ on: (n, fn) => { handlers.push(fn); return () => {}; } }, {});
    const res = await handlers[0]({ name: 'bash', get arguments() { throw new Error('boom'); } }, async () => ({ kind: 'allow' }));
    assert.equal(res.kind, 'allow');
    await g.deactivate();
  });
  console.log(`agent-guards: ${passed} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
