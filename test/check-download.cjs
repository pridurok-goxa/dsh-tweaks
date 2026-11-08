'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed += 1; console.log('ok', name); });
}

(async () => {
  const host = await import(pathToFileURL(path.join(__dirname, '..', 'tweaks', 'download-host.js')).href);

  await test('parseDownload: вложение или файл workspace', () => {
    assert.equal(host.parseDownload({ sessionId: 's', attachment: { attachmentId: 'a1', name: 'a.txt' } }).kind, 'attachment');
    assert.equal(host.parseDownload({ sessionId: 's', path: '/tmp/a.txt' }).kind, 'workspace');
    assert.ok(host.parseDownload({}).error);
    assert.ok(host.parseDownload({ sessionId: 's' }).error);
  });

  await test('readDownload отдаёт байты вложения и имя', async () => {
    const ref = { attachmentId: 'a1', name: 'a.txt' };
    const scope = {
      attachments: {
        async *readFileStream(input) {
          assert.equal(input, ref);
          yield new Uint8Array([65, 66]);
          yield new Uint8Array([67]);
        },
      },
      workspaceFiles: { readBytes: async () => ({ data: new Uint8Array([1]) }) },
    };
    const result = await host.readDownload(scope, { kind: 'attachment', attachment: ref });
    assert.equal(result.data.toString(), 'ABC');
    assert.equal(result.name, 'a.txt');
  });

  await test('readDownload читает workspace-файл через workspaceFiles', async () => {
    const calls = [];
    const scope = {
      attachments: {},
      sessions: { get: () => ({ header: { cwd: '/workspace' } }) },
      sandboxPolicy: { workspaceRoot: '/workspace' },
      workspaceFiles: { async readBytes(session, path, options, signal) { calls.push([session, path, options, signal]); return { data: new Uint8Array([88]) }; } },
    };
    const result = await host.readDownload(scope, { kind: 'workspace', sessionId: 's', path: 'dir/a.bin', name: 'a.bin' });
    assert.equal(result.data[0], 88);
    assert.equal(result.name, 'a.bin');
    assert.deepEqual(calls[0][0], { sessionId: 's', workspaceRoot: '/workspace' });
    assert.equal(calls[0][1], 'dir/a.bin');
  });

  await test('activate регистрирует POST /dsh-tweaks/download', () => {
    let route = null;
    const scope = {
      webServer: { register(next) { route = next; return () => {}; } },
      connection: { requestRejection: () => undefined },
      attachments: {}, workspaceFiles: {}, sessions: {}, sandboxPolicy: {},
      effect(callback) { callback(); return () => {}; },
    };
    host.activate({ inject(deps, callback) { callback(scope); } });
    assert.equal(route.path, '/dsh-tweaks/download');
    assert.equal(typeof route.handler, 'function');
  });

  console.log(`PASS ${passed} download host contract tests`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
