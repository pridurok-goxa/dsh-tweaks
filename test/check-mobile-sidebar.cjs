/**
 * Контракт мобильного меню (твик `mobileSidebar`) без браузера: чистые
 * помощники региона исполняются в vm, а CSS и регистрация проверяются по
 * исходнику. Реальное поведение телефона проверяется человеком: DOM-тест не
 * заменяет виртуальную клавиатуру.
 *
 * Запуск: node test/check-mobile-sidebar.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT = path.join(__dirname, '..', 'client.js');
const INDEX = path.join(__dirname, '..', 'index.js');
const source = fs.readFileSync(CLIENT, 'utf8');
const region = source
  .split('/* #region tweak-mobile-sidebar */')[1]
  .split('/* #endregion tweak-mobile-sidebar */')[0];

const context = vm.createContext({});
vm.runInContext(
  region +
    '\nthis.tracks = mobileDrawerTracks; this.grid = mobileDrawerGrid; this.intent = mobileSidebarIntent;' +
    ' this.isComposerInput = isComposerInput; this.suppressor = createMobileFocusSuppressor;' +
    ' this.patch = installMobileFocusPatch; this.css = mobileDrawerStyleText;',
  context,
);

let passed = 0;
/** Прогнать одну проверку и напечатать её имя. */
function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok', name);
}

/** Цель клика с заданным набором совпавших селекторов. */
function target(...selectors) {
  return { closest: (selector) => (selectors.includes(selector) ? {} : null) };
}

test('треки сетки не рвут minmax с пробелами', () => {
  assert.deepEqual(
    Array.from(context.tracks('56px minmax(400px, 1fr) minmax(0px, 0px)')),
    ['56px', 'minmax(400px, 1fr)', 'minmax(0px, 0px)'],
  );
  assert.deepEqual(Array.from(context.tracks('')), []);
  assert.deepEqual(Array.from(context.tracks('none')), []);
});

test('сетка режима обнуляет сайдбар и сохраняет трек правой панели', () => {
  assert.equal(
    context.grid('56px minmax(400px, 1fr) minmax(0px, 0px)'),
    '0px minmax(0px, 1fr) minmax(0px, 0px)',
  );
  assert.equal(
    context.grid('280px minmax(0px, 1fr) 344px'),
    '0px minmax(0px, 1fr) 344px',
  );
  assert.equal(
    context.grid('300px minmax(400px, 1fr) minmax(0px, 500px)'),
    '0px minmax(0px, 1fr) minmax(0px, 500px)',
  );
  assert.equal(context.grid(''), '0px minmax(0px, 1fr) minmax(0px, 0px)');
});

test('клик по строке чата закрывает ящик', () => {
  assert.equal(context.intent(target('[data-row-key^="session:"]')), 'close');
});

test('точки и кнопки строки ящик не закрывают', () => {
  assert.equal(
    context.intent(target('[class*="_rowActions"]', '[data-row-key^="session:"]')),
    'keep',
  );
});

test('результат поиска по чатам закрывает ящик', () => {
  assert.equal(context.intent(target('[class*="_searchResultRow"]')), 'close');
});

test('навигация панелей и новая сессия закрывают ящик', () => {
  assert.equal(context.intent(target('[class*="_panelRow"]')), 'close');
  assert.equal(context.intent(target('[class*="_newSession"]')), 'close');
});

test('остальные клики в панели не наши', () => {
  assert.equal(context.intent(target()), null);
  assert.equal(context.intent(null), null);
});

test('поле композера узнаётся по атрибуту и по вложенности', () => {
  assert.equal(context.isComposerInput({ hasAttribute: (name) => name === 'data-composer-input' }), true);
  assert.equal(
    context.isComposerInput({ closest: (selector) => (selector === '[data-composer-input]' ? {} : null) }),
    true,
  );
  assert.equal(context.isComposerInput({ hasAttribute: () => false, closest: () => null }), false);
  assert.equal(context.isComposerInput(null), false);
});

test('подавление фокуса взводится, истекает и снимается жестом', () => {
  let now = 1000;
  const suppressor = context.suppressor(() => now);
  assert.equal(suppressor.armed(), false, 'по умолчанию не взведено');
  suppressor.arm(5000);
  assert.equal(suppressor.armed(), true);
  assert.equal(suppressor.shouldSwallow({ hasAttribute: (n) => n === 'data-composer-input' }), true);
  assert.equal(suppressor.shouldSwallow({ hasAttribute: () => false, closest: () => null }), false);
  now += 5001;
  assert.equal(suppressor.armed(), false, 'окно ограничено');
  suppressor.arm(5000);
  suppressor.clear();
  assert.equal(suppressor.armed(), false, 'жест снимает подавление');
});

test('патч focus глотает только программный фокус композера и возвращается', () => {
  class FakeHTMLElement {
    constructor() {
      this.calls = 0;
    }

    focus() {
      this.calls += 1;
    }
  }
  const suppressor = context.suppressor();
  const restore = context.patch({ HTMLElement: FakeHTMLElement }, suppressor);
  const composer = new FakeHTMLElement();
  composer.hasAttribute = (name) => name === 'data-composer-input';
  const other = new FakeHTMLElement();

  suppressor.arm();
  composer.focus();
  assert.equal(composer.calls, 0, 'каретка и клавиатура не поднимаются');
  other.focus();
  assert.equal(other.calls, 1, 'остальные фокусы не затронуты');

  suppressor.clear();
  composer.focus();
  assert.equal(composer.calls, 1, 'после жеста фокус снова работает');

  restore();
  const after = new FakeHTMLElement();
  after.focus();
  assert.equal(after.calls, 1, 'оригинальный focus возвращён');
});

test('CSS режима: атрибут, нулевой трек, fixed-ящик и точки строки', () => {
  const css = context.css('minmax(0px, 344px)');
  assert.ok(css.includes('html[data-dsh-tweaks-mobile-drawer="on"]'), 'режим включён атрибутом html');
  assert.ok(
    css.includes('grid-template-columns:0px minmax(0px, 1fr) minmax(0px, 344px)!important'),
    'первый трек нулевой, трек правой панели сохранён',
  );
  assert.ok(css.includes('position:fixed!important'), 'ящик поверх раскладки');
  assert.ok(css.includes('> [class*=\"_centerCol\"]{grid-column:2;grid-row:1}'), 'центр закреплён во втором треке');
  assert.ok(css.includes('> [data-rightbar-col]{grid-column:3;grid-row:1}'), 'правая панель закреплена в третьем треке');
  assert.ok(css.includes('translateX(-102%)'), 'закрытое состояние за краем');
  assert.ok(css.includes('visibility:hidden'), 'скрытый ящик не ловит фокус');
  assert.ok(css.includes('transition:transform var(--ds-transition-duration-slow)'), 'выезд анимирован');
  assert.ok(css.includes('[class*="_sessionRow"] [class*="_rowActions"]'), 'точки строки чата видны всегда');
  assert.ok(css.includes('[class*="_searchResultRow"] [class*="_rowActions"]{display:inline-flex!important}'), 'точки видны и в результатах поиска');
  assert.ok(css.includes('[class*="_time"]'), 'время уступает место точкам');
  assert.ok(css.includes('[class*="_pinIndicator"]'), 'закрепление уступает место точкам');
  assert.ok(css.includes('[data-dsh-mobile-sidebar-toggle]{display:none}'), 'на десктопе кнопки нет');
  assert.ok(
    !css.includes(':not([data-sidebar-collapsed]) [data-dsh-mobile-sidebar-toggle]{display:none!important}'),
    'кнопка меню не скрывается на время анимации',
  );
  assert.ok(css.includes('prefers-reduced-motion'), 'анимация уважает настройку движения');
  assert.ok(css.includes('--dsh-chat-content-width:100%!important'), 'чат на всю ширину');
  assert.ok(css.includes('data-dsh-tweaks-drawer-leaving'), 'есть состояние анимированного закрытия');
  assert.ok(css.includes('data-dsh-tweaks-panel-menu'), 'есть поповер глобальных панелей');
  assert.ok(css.includes('data-dsh-tweaks-panel-toggle'), 'есть нижняя кнопка панелей');
  assert.ok(css.includes('dsh-tweaks-header-title'), 'есть название чата в шапке');
});

test('регистрация и очистка твика на месте', () => {
  assert.ok(source.includes("titleKey: 'tweak.mobileSidebar'"), 'запись в реестре');
  assert.ok(source.includes("headerLeadingSeat.set(ctx, 'mobileMenu'"), 'меню идёт через leading-seat');
  assert.ok(source.includes("headerLeadingSeat.set(ctx, 'title'"), 'название чата идёт через leading-seat');
  assert.ok(source.includes("sidebar.footer.action"), 'нижняя кнопка панелей в подвале');
  assert.ok(source.includes("id: 'mobile-panel-menu'"), 'id нижней кнопки уникален');
  assert.ok(source.includes("id: 'composer-command-mode-chip'"), 'чип режима в строке композера');
  assert.ok(source.includes('installMobileFocusPatch'), 'патч focus вызывается');
  assert.ok(source.includes('removeAttribute(MOBILE_DRAWER_ATTR)'), 'режим снимается при выключении');
  assert.ok(
    fs.readFileSync(INDEX, 'utf8').includes('mobileSidebar: Schema.boolean().default(true).volatile()'),
    'флаг схемы объявлен',
  );
});

console.log(`PASS ${passed} mobile sidebar contract tests`);
