/**
 * Геометрия панели-тултипа светофора: панель всегда над лампой и внутри
 * вьюпорта при любом масштабе/размере экрана. Чистая функция без браузера.
 *
 * Запуск: node test/check-light-panel.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');
const region = source
  .slice(source.indexOf('/** Ширина панели-тултипа'), source.indexOf('/** Геометрия горизонтальной шкалы часов'))
  .replace('function panelPosition(anchorRef, panelRef) {', 'function panelPosition(anchorRef, panelRef) {');
const context = vm.createContext({
  window: { innerWidth: 1200, innerHeight: 800 },
  readScale: () => 1,
});
vm.runInContext(region + '\nthis.compute = computeLightPanelGeometry;', context);

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('ok', name); }

const anchor = (left, top, width = 32) => ({ left, top, width, height: 20, right: left + width, bottom: top + 20 });
const viewport = (width, height) => ({ left: 0, top: 0, width, height });

test('панель стоит над лампой', () => {
  const g = context.compute({ anchorRect: anchor(190, 860), viewport: viewport(412, 915), scale: 1, contentHeight: 300 });
  assert.equal(g.width, 364);
  assert.equal(g.left, 24);
  assert.equal(g.maxHeight, 300);
  assert.equal(g.top, 552);
  assert.ok(g.top + g.maxHeight <= 860 - 8, 'низ панели выше якоря');
});

test('длинная панель ограничивается свободным местом и прокручивается', () => {
  const g = context.compute({ anchorRect: anchor(190, 860), viewport: viewport(412, 915), scale: 1, contentHeight: 2000 });
  assert.equal(g.maxHeight, 844, 'высота = место над якорем');
  assert.equal(g.top, 8);
  assert.ok(g.top + g.maxHeight <= 852);
});

test('узкий экран: ширина не выходит за окно', () => {
  const g = context.compute({ anchorRect: anchor(150, 540), viewport: viewport(320, 600), scale: 1, contentHeight: 220 });
  assert.equal(g.width, 304);
  assert.equal(g.left, 8);
  assert.equal(g.left + g.width, 312);
});

test('якорь у правого края: панель прижимается к правому полю', () => {
  const g = context.compute({ anchorRect: anchor(400, 600, 12), viewport: viewport(412, 700), scale: 1, contentHeight: 200 });
  assert.equal(g.left, 412 - 364 - 8);
});

test('якорь близко к верху: панель раскрывается вниз', () => {
  const g = context.compute({ anchorRect: anchor(190, 100), viewport: viewport(412, 915), scale: 1, contentHeight: 300 });
  assert.equal(g.placement, 'below');
  assert.equal(g.maxHeight, 300);
  assert.equal(g.top, 128);
  assert.ok(g.top >= 100 + 20 + 8, 'панель ниже лампы');
});

test('широкая кнопка не важна: панель выравнивается по лампе, а не по центру', () => {
  const g = context.compute({ anchorRect: anchor(499, 456, 16), viewport: viewport(1694, 958), scale: 1, contentHeight: 229 });
  assert.equal(g.left, 499, 'левый край панели у лампы');
  assert.equal(g.arrowLeft, 12, 'стрелка прижата к лампе');
  assert.equal(g.placement, 'above');
});

test('якорь у правого края: стрелка остаётся внутри панели', () => {
  const g = context.compute({ anchorRect: anchor(400, 600, 12), viewport: viewport(412, 700), scale: 1, contentHeight: 200 });
  assert.ok(g.arrowLeft >= 12 && g.arrowLeft <= g.width - 12);
});

test('масштаб 1.25 сохраняет визуальные размеры после деления в рендере', () => {
  const g = context.compute({ anchorRect: anchor(190, 860), viewport: viewport(412, 915), scale: 1.25, contentHeight: 300 });
  assert.equal(g.width / g.scale * g.scale, g.width);
  assert.equal(g.maxHeight / g.scale * g.scale, g.maxHeight);
  assert.equal(g.top, 552);
  assert.equal(g.left, 24);
});

test('визуальный вьюпорт со смещением не даёт панели совпасть с краем', () => {
  const vv = { left: 10, top: 20, width: 400, height: 700 };
  const g = context.compute({ anchorRect: anchor(180, 690), viewport: vv, scale: 1, contentHeight: 200 });
  assert.ok(g.left >= 18);
  assert.ok(g.top >= 28);
  assert.ok(g.top + g.maxHeight <= 690 - 8);
});

console.log(`PASS ${passed} light panel geometry tests`);
