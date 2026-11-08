/**
 * Контракт клиентской части редактора очереди: чистые помощники (payload,
 * inbox-порядок, base64) и wiring формы/перехвата по исходнику. Реальная форма
 * проверяется headless-сценарием с временным dsh.
 *
 * Запуск: node test/check-queue-editor.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');
const region = source
  .split('/* #region tweak-queue-editor */')[1]
  .split('/* #endregion tweak-queue-editor */')[0];

const context = vm.createContext({
  document: { querySelectorAll: () => [] },
  window: {},
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  React: { useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) },
  primitives: {},
});
vm.runInContext(
  region + '\nthis.items = queueEditorItems; this.payload = queueEditorPayload; this.b64 = queueEditorBase64; this.rows = queueEditorRows;',
  context,
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok', name);
}

const ref = (id, extra = {}) => ({ attachmentId: id, ...extra });

test('очередь фильтрует транскриптные локальные echo как QueueDock', () => {
  const session = {
    projections: {
      faceOf: () => ({
        getSnapshot: () => ({
          'next-turn': [
            { id: 'a', source: { kind: 'user', rpcId: 'r1' } },
            { id: 'b', source: { kind: 'user', rpcId: 'r2' } },
            { id: 'c', source: { kind: 'agent-message' } },
          ],
        }),
      }),
    },
    getSnapshot: () => ({ pendingSubmissions: [{ requestId: 'r1', placement: 'transcript' }] }),
  };
  assert.deepEqual(Array.from(context.items(session), (item) => item.id), ['b', 'c']);
  assert.equal(context.items({}).length, 0);
});

test('payload сохраняет existing-ссылки и новые данные', () => {
  const payload = context.payload('edited', [
    { kind: 'existing', type: 'image', attachment: ref('img1') },
    { kind: 'new', type: 'file', name: 'a.pdf', data: 'QUJD' },
    { kind: 'new', type: 'image', name: 'b.png', mediaType: 'image/png', data: 'QUJD' },
  ]);
  assert.equal(payload.text, 'edited');
  assert.equal(payload.attachments[0].kind, 'existing');
  assert.equal(payload.attachments[0].attachment.attachmentId, 'img1');
  assert.equal(payload.attachments[1].kind, 'new');
  assert.equal(payload.attachments[1].name, 'a.pdf');
  assert.equal(payload.attachments[2].mediaType, 'image/png');
});

test('base64 читает большие байты кусками', () => {
  const bytes = new Uint8Array(70000).fill(65);
  const encoded = context.b64(bytes);
  assert.equal(Buffer.from(encoded, 'base64').length, 70000);
  assert.equal(Buffer.from(encoded, 'base64')[0], 65);
});

test('wiring: форма в доке, перехват карандаша, host-роут и вложения', () => {
  assert.match(source, /function setupQueueEditor\(ctx, api\)/);
  assert.match(source, /data-queue-editor/);
  assert.match(source, /fetch\(QUEUE_EDIT_ROUTE/);
  assert.match(source, /'conversation.input.dock'/);
  assert.match(source, /id: 'queue-editor'/);
  assert.match(source, /queueEditorState\.open/);
  assert.match(source, /data-dsh-tweaks-queue-edit/);
  assert.match(source, /inputRef\.current\?\.click/);
  assert.match(source, /name: 'conversation.input.dock'/);
});

test('вкладки: Agent Team и Subagents переносятся реальными узлами', () => {
  assert.match(source, /function setupTabActions\(\)/);
  assert.match(source, /data-dsh-tweaks-tabs-actions/);
  assert.match(source, /data-team-action/);
  assert.match(source, /subagents\?\|субагент/);
  assert.match(source, /own\(setupTabActions\(\)\)/);
  assert.match(source, /top:-6px/, 'кнопки подняты на уровень подписей вкладок');
  assert.match(source, /aria-label'\) !== 'Team'/, 'Agent Team переименован в Team');
  assert.match(source, /getAttribute\('aria-label'\) !== 'Job'/, 'background jobs переименован в Job');
  assert.match(source, /background jobs\?/, 'триггер фоновых задач ищется и переносится');
  assert.match(source, /gap:2px;margin-left:0/, 'компактные отступы панели');
  assert.match(source, /data-dsh-tweaks-more-slot/, 'три точки закреплены в панели');
  assert.match(source, /let moreRoot = moreButton/, 'меню переносится целиком, а не одной кнопкой');
  assert.match(source, /data-dsh-tweaks-more-slot\] \[class\*="_moreButton"\]/, 'меню три точки ищется после переноса');
  assert.doesNotMatch(source, /const utilities = document.querySelector/, 'job ищется по всей шапке, а не только в utilities');
});

console.log(`PASS ${passed} queue-editor client contract tests`);
