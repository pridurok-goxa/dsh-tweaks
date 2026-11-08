/**
 * Контракт вкладок правой панели на телефоне: свайп листает вкладки,
 * удержание 1 с разрешает перенос, выбор вкладки не анимирует полосу.
 * Чистые помощники исполняются в vm; CSS и хуки проверяются по исходнику.
 *
 * Запуск: node test/check-mobile-tabs.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');
const region = source
  .split('/* #region tweak-mobile-right-tabs */')[1]
  .split('/* #endregion tweak-mobile-right-tabs */')[0];
const context = vm.createContext({});
vm.runInContext(region + '\nthis.chips = rightTabChips; this.switch = switchRightTab; this.css = null;', context);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok', name);
}

/** Чип с состоянием выбора и счётчиком кликов. */
function chip(selected) {
  return {
    selected,
    clicks: 0,
    getAttribute(name) {
      return name === 'aria-selected' && this.selected ? 'true' : 'false';
    },
    click() {
      this.clicks += 1;
      for (const other of chips) other.selected = false;
      this.selected = true;
    },
  };
}

let chips = [];
const pane = {
  querySelector: () => ({ querySelectorAll: () => chips }),
};

test('чипы активной панели читаются в порядке полосы', () => {
  chips = [chip(false), chip(true), chip(false)];
  assert.equal(context.chips(pane).length, 3);
  assert.equal(context.chips(null).length, 0);
});

test('свайп вправо выбирает предыдущую вкладку', () => {
  chips = [chip(false), chip(true), chip(false)];
  assert.equal(context.switch(pane, -1), true);
  assert.equal(chips[0].clicks, 1);
  assert.equal(chips[1].clicks, 0);
});

test('свайп влево выбирает следующую вкладку и не выходит за края', () => {
  chips = [chip(false), chip(true)];
  assert.equal(context.switch(pane, 1), false, 'последняя вкладка не заворачивается');
  chips = [chip(true), chip(false)];
  assert.equal(context.switch(pane, 1), true);
  assert.equal(chips[1].clicks, 1);
  assert.equal(context.switch(pane, -1), true, 'соседняя слева доступна');
  assert.equal(chips[0].clicks, 1);
  chips = [chip(true), chip(false)];
  assert.equal(context.switch(pane, -1), false, 'первая вкладка не заворачивается');
});

test('долгое удержание и свайп описаны в регионе', () => {
  assert.match(region, /RIGHT_TAB_LONG_PRESS_MS = 1000/);
  assert.match(region, /RIGHT_TAB_SWIPE_PX = 48/);
  assert.match(region, /stopImmediatePropagation/);
  assert.match(region, /data-dsh-tweaks-tab-hold/);
  assert.match(source, /function setupMobileRightTabs/);
  assert.match(source, /own\(setupMobileRightTabs\(ctx, api\)\)/);
});

test('CSS: полоса без плавной анимации, иконки сплита и фуллскрина скрыты', () => {
  const css = source.split('function mobileDrawerStyleText')[1].split('function MobileSidebarIcon')[0];
  assert.ok(css.includes('[data-dockkit-strip-tabs]{scroll-behavior:auto!important}'));
  assert.ok(css.includes('[data-dockkit-split-button]'));
  assert.ok(css.includes('[data-sidebar-right-mode]{display:none!important}'));
});

test('меню «…» прижимается к видимой области, модель меняется штатным сервисом', () => {
  assert.match(source, /function clampHeaderMenu/);
  assert.match(source, /viewport\?\.height \?\? window\.innerHeight/);
  assert.match(source, /directoryFor\(sessionId\)/);
  assert.match(source, /ctx\.get\('modelDirectories'\)/);
  assert.ok(source.indexOf("ctx.get('modelDirectories')") < source.indexOf('remote?.session?.selectModel'), 'штатный сервис моделей используется первым');
});

test('иконка меню не скрывается на время анимации ящика', () => {
  const css = source.split('function mobileDrawerStyleText')[1].split('function MobileSidebarIcon')[0];
  assert.ok(!css.includes(':not([data-sidebar-collapsed]) [data-dsh-mobile-sidebar-toggle]{display:none'));
});

console.log(`PASS ${passed} mobile right-tab contract tests`);
