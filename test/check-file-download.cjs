'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');
const region = source.split('/* #region tweak-file-download */')[1].split('/* #endregion tweak-file-download */')[0];
const context = vm.createContext({
  document: { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} },
  window: { innerWidth: 400, innerHeight: 800 },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  fetch: async () => ({ ok: true }),
  React: { createElement: () => null },
});
vm.runInContext(region + '\nthis.parse = parseDshFileAddress;', context);

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('ok', name); }

test('parseDshFileAddress разбирает session-файл с encoded-сегментами', () => {
  const parsed = context.parse('dsh-resource://file/session/sess-1/dir/a%20b.txt');
  assert.equal(parsed.sessionId, 'sess-1');
  assert.equal(parsed.path, 'dir/a b.txt');
  assert.equal(context.parse('dsh-resource://file/absolute/tmp/a'), undefined);
  assert.equal(context.parse('https://example.com/a'), undefined);
});

test('wiring: Скачать и Копировать путь в обоих меню', () => {
  assert.match(source, /'Копировать путь'/);
  assert.match(source, /copyPathViaHost/);
  assert.match(source, /FILE_PATH_ROUTE/);
  assert.match(source, /const copyPath = document\.createElement\('button'\)/);
});

test('wiring: меню вкладки, долгое нажатие и fiber-ссылка', () => {
  assert.match(source, /function setupFileDownload\(ctx, api\)/);
  assert.match(source, /sidebar.right.tab.menu.item/);
  assert.match(source, /dsh-tweaks-download-item/);
  assert.match(source, /fileCard/);
  assert.match(source, /__reactFiber\$/);
  assert.match(source, /downloadViaHost/);
  assert.match(source, /520/);
});

console.log(`PASS ${passed} file-download client contract tests`);
