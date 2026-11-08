/**
 * Контракт хост-части редактора очереди: разбор запроса, сборка content с
 * вложениями и замена сообщения **на месте**. HTTP-обвязка проверяется
 * регистрацией роута; сеть и реальный DSH не нужны.
 *
 * Запуск: node test/check-queue-edit.cjs
 */
'use strict';

const assert = require('node:assert/strict');
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

const ref = (id, extra = {}) => ({ attachmentId: id, ...extra });
const block = (type, attachment, extra = {}) => ({ type, attachment, ...extra });

(async () => {
  const host = await import(pathToFileURL(path.join(__dirname, '..', 'tweaks', 'queue-edit-host.js')).href);

  await test('parseQueueEdit принимает текст, existing и новые вложения', () => {
    const parsed = host.parseQueueEdit({
      sessionId: 's', itemId: 'i', text: 'hello',
      attachments: [
        { kind: 'existing', type: 'image', attachment: ref('img1') },
        { kind: 'existing', type: 'file', attachment: ref('f1', { name: 'a.pdf' }) },
        { kind: 'new', type: 'image', name: 'new.png', mediaType: 'image/png', data: 'AAAA' },
        { kind: 'new', type: 'file', name: 'b.txt', data: 'AAAA' },
      ],
    });
    assert.equal(parsed.ok === undefined, true, 'нет ошибки');
    assert.equal(parsed.text, 'hello');
    assert.equal(parsed.attachments.length, 4);
  });

  await test('parseQueueEdit отклоняет пустое, неверные типы и data', () => {
    assert.equal(host.parseQueueEdit({}).error !== undefined, true);
    assert.equal(host.parseQueueEdit({ sessionId: 's', itemId: 'i', text: '  ', attachments: [] }).error, 'empty message');
    assert.equal(host.parseQueueEdit({ sessionId: 's', itemId: 'i', attachments: [{ kind: 'new', type: 'image', mediaType: 'image/svg+xml', data: 'AA' }] }).error !== undefined, true);
    assert.equal(host.parseQueueEdit({ sessionId: 's', itemId: 'i', attachments: [{ kind: 'new', type: 'file', name: 'x', data: '' }] }).error !== undefined, true);
  });

  await test('buildQueueContent сохраняет existing refs и добавляет новые', async () => {
    const message = { content: [block('text', undefined, { text: 'old' }), block('image', ref('img1')), block('file', ref('f1', { name: 'a.pdf' }))] };
    const calls = [];
    const scope = {
      attachments: {
        async saveImages(inputs) { calls.push(['images', inputs]); return [ref('newimg', { name: inputs[0].name })]; },
        async saveFile(input) { calls.push(['file', input]); return ref('newfile', { name: input.name }); },
      },
    };
    const request = {
      text: 'new',
      attachments: [
        { kind: 'existing', type: 'image', attachment: ref('img1') },
        { kind: 'new', type: 'image', mediaType: 'image/png', name: 'x.png', data: 'AAAA' },
        { kind: 'new', type: 'file', name: 'b.txt', data: 'AAAA' },
      ],
    };
    const content = await host.buildQueueContent(scope, request, message);
    assert.deepEqual(content.map((item) => item.type), ['text', 'image', 'image', 'file']);
    assert.equal(content[1].attachment.attachmentId, 'img1');
    assert.equal(content[2].attachment.attachmentId, 'newimg');
    assert.equal(content[3].attachment.attachmentId, 'newfile');
    assert.equal(calls.length, 2, 'новые вложения сохранены до замены');
  });

  await test('чужой existing-ref отклоняется без сохранения', async () => {
    const message = { content: [block('image', ref('img1'))] };
    const scope = { attachments: { saveImages: async () => [ref('x')], saveFile: async () => ref('y') } };
    await assert.rejects(
      () => host.buildQueueContent(scope, { text: '', attachments: [{ kind: 'existing', type: 'image', attachment: ref('other') }] }, message),
      (error) => error.status === 400,
    );
  });

  await test('applyQueueEdit заменяет сообщение на месте и сохраняет id', async () => {
    const message = { id: 'item-2', content: [block('text', undefined, { text: 'old' }), block('image', ref('img1'))] };
    const inbox = {
      nextTurn: [{ id: 'item-1', content: [] }, message, { id: 'item-3', content: [] }],
      nextStep: [],
      replace(id, next) {
        const index = this.nextTurn.findIndex((item) => item.id === id);
        if (index < 0) return false;
        this.nextTurn[index] = next;
        return true;
      },
    };
    const scope = {
      sessionController: { resolveAgent: async () => ({ agent: { inbox } }) },
      attachments: { saveImages: async () => [ref('x')], saveFile: async () => ref('y') },
    };
    const result = await host.applyQueueEdit(scope, {
      sessionId: 's', itemId: 'item-2', text: 'new',
      attachments: [{ kind: 'existing', type: 'image', attachment: ref('img1') }],
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(inbox.nextTurn.map((item) => item.id), ['item-1', 'item-2', 'item-3'], 'позиция не изменилась');
    assert.equal(inbox.nextTurn[1].content[0].text, 'new');
    assert.equal(inbox.nextTurn[1].content[1].attachment.attachmentId, 'img1');
  });

  await test('applyQueueEdit отдаёт 409 для исчезнувшего элемента', async () => {
    const scope = {
      sessionController: { resolveAgent: async () => ({ agent: { inbox: { nextTurn: [], nextStep: [], replace: () => false } } }) },
      attachments: {},
    };
    await assert.rejects(
      () => host.applyQueueEdit(scope, { sessionId: 's', itemId: 'gone', text: 'x', attachments: [] }),
      (error) => error.status === 409,
    );
  });

  await test('activate регистрирует POST-роут через webServer', () => {
    let route = null;
    let effectCleanup = null;
    const scope = {
      webServer: { register(next) { route = next; return () => { route = null; }; } },
      connection: { requestRejection: () => undefined },
      sessionController: {},
      attachments: {},
      effect(callback) { effectCleanup = callback(); return () => {}; },
    };
    const ctx = {
      inject(deps, callback) { callback(scope); return () => {}; },
    };
    host.activate(ctx);
    assert.ok(route, 'роут зарегистрирован');
    assert.equal(route.kind, 'exact');
    assert.equal(route.path, '/dsh-tweaks/queue/edit');
    assert.equal(typeof route.handler, 'function');
    assert.equal(typeof effectCleanup, 'function');
  });

  console.log(`PASS ${passed} queue-edit host contract tests`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
