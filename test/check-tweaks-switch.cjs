/**
 * Диагностический выключатель твиков: `?tweaks=off` гасит твики только для
 * текущей ссылки, обычная ссылка без параметра всегда включает их.
 *
 * Проверка без браузера: настоящий client.js исполняется в vm с минимальными
 * заглушками window/document/React/configForms, затем читается отметка
 * инициализации (`dsh.ui-zoom.ready.v1`) — по ней видно, какие твики активны.
 *
 * Запуск: node test/check-tweaks-switch.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const CLIENT = path.join(__dirname, '..', 'client.js');

/** Ключ отметки инициализации: её пишет каркас твиков в хранилище устройства. */
const READY_KEY = 'dsh.ui-zoom.ready.v1';
/** Ключ выключателя: то же имя, что в client.js. */
const SWITCH_KEY = 'dsh.tweaks.disabled.v1';

/** Заглушка хранилища в памяти: как localStorage у телефона между перезагрузками. */
function createStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

/** Заглушка inline-стиля: обычные свойства плюс CSS-переменные. */
function createStyle() {
  return {
    setProperty(name, value) {
      this[name] = String(value);
    },
    removeProperty(name) {
      delete this[name];
    },
    getPropertyValue(name) {
      return this[name] ?? '';
    },
  };
}

/** Заглушка элемента: достаточно, чтобы твики стартовали и не падали на пустом DOM. */
function createElement(id) {
  const element = {
    id,
    nodeType: 1,
    isConnected: true,
    style: createStyle(),
    dataset: {},
    classList: { contains: () => false },
    childNodes: [],
    children: [],
    tagName: String(id).toUpperCase(),
    parentElement: null,
    textContent: '',
    hidden: false,
    offsetLeft: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    querySelector: () => null,
    querySelectorAll: () => [],
    matches: () => false,
    contains: () => false,
    closest: () => null,
    getAttribute: () => null,
    hasAttribute: () => false,
    setAttribute() {},
    removeAttribute() {},
    appendChild(child) {
      element.childNodes.push(child);
      child.parentElement = element;
      return child;
    },
    append(...nodes) {
      for (const node of nodes) element.appendChild(node);
    },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return element;
}

/** Мини-React: хватает для формы флагов и индикатора инициализации. */
function createReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial ?? null }),
  };
}

/** Снимок флагов: как у настоящей службы конфигурации DSH. */
function createConfigForms(flags) {
  const listeners = new Set();
  return {
    listeners,
    get: () => ({
      getSnapshot: () => ({ status: 'ready', value: { ...flags }, revision: 1, writable: true }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      mutate: () => Promise.resolve(true),
    }),
  };
}

/**
 * Загрузить плагин в песочницу и вернуть наблюдаемые объекты.
 * @param {object} options - адрес страницы, сохранённые значения и флаги.
 * @returns {object} хранилище, отметка инициализации, форма флагов.
 */
function loadPlugin({ search = '', stored = null, flags = { zoom: true, contextMenu: true, mobileComposer: true, fileDownload: true } } = {}) {
  const storage = createStorage();
  if (stored !== null) {
    for (const [key, value] of Object.entries(stored)) storage.setItem(key, value);
  }
  const localeListeners = new Map();
  /** Сколько раз твики добавили свои стили в head: признак их работы. */
  let headAppends = 0;
  const documentElement = { style: createStyle(), id: 'html', setAttribute() {}, removeAttribute() {}, getAttribute: () => null };
  const body = createElement('body');
  const root = createElement('root');
  const windowListeners = new Map();
  let loaded = null;

  const documentObject = {
    documentElement,
    body,
    head: {
      appendChild: (node) => {
        headAppends += 1;
        return node;
      },
    },
    getElementById: (id) => (id === 'root' ? root : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => createElement(tag),
    addEventListener: (type, listener) => {
      const list = localeListeners.get(type) ?? [];
      list.push(listener);
      localeListeners.set(type, list);
    },
    removeEventListener: (type, listener) => {
      const list = localeListeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    visibilityState: 'visible',
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {}
    disconnect() {}
  }

  const windowObject = {
    localStorage: storage,
    location: { search },
    innerWidth: 412,
    innerHeight: 915,
    devicePixelRatio: 2,
    getComputedStyle: () => ({ position: 'static', zoom: '1' }),
    requestAnimationFrame: (fn) => fn(),
    cancelAnimationFrame: () => {},
    setTimeout: (fn) => {
      if (typeof fn === 'function') fn();
      return 0;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: (type, listener) => {
      const list = windowListeners.get(type) ?? [];
      list.push(listener);
      windowListeners.set(type, list);
    },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    __ModuleLoader__: {
      load: (definition) => {
        loaded = definition;
      },
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    visualViewport: null,
  };

  const configForms = createConfigForms(flags);
  const ctx = {
    get: (name) => (name === 'configForms' ? configForms.get('zoom') : undefined),
    on: () => () => {},
    provide: () => () => {},
  };

  const sandbox = {
    window: windowObject,
    document: documentObject,
    Element: class FakeElement {},
    Event: class FakeEvent {
      constructor(type) {
        this.type = type;
      }
    },
    MutationObserver: FakeMutationObserver,
    getComputedStyle: windowObject.getComputedStyle,
    console,
    setTimeout: windowObject.setTimeout,
    clearTimeout: windowObject.clearTimeout,
    setInterval: windowObject.setInterval,
    clearInterval: windowObject.clearInterval,
    requestAnimationFrame: windowObject.requestAnimationFrame,
    cancelAnimationFrame: windowObject.cancelAnimationFrame,
    require: (name) => {
      if (name === 'react') return createReact();
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Switch: (props) => ({ type: 'switch', props: props ?? {}, children: [] }) };
      if (name === 'react-dom') return null;
      throw new Error(`unexpected require: ${name}`);
    },
  };
  // Глобальные ссылки внутри client.js берутся из песочницы, а не из окна.
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: CLIENT });
  assert.ok(loaded, 'client.js должен вызвать window.__ModuleLoader__.load');
  assert.equal(loaded.id, 'dsh-tweaks', 'id клиентского модуля');
  const plugin = loaded.factory(sandbox.require);
  plugin.apply(ctx);

  /** Отметка инициализации из хранилища. */
  const ready = () => {
    const raw = storage.dump()[READY_KEY];
    assert.ok(raw, 'отметка инициализации записана в хранилище');
    return JSON.parse(raw);
  };
  return {
    storage,
    ready,
    headAppends: () => headAppends,
  };
}

let passed = 0;
/**
 * Выполнить проверку и напечатать результат.
 * @param {string} name - что проверяем.
 * @param {Function} fn - проверка.
 * @returns {void}
 */
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    process.exitCode = 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

check('без выключателя твики включаются', () => {
  const env = loadPlugin();
  const tweaks = env.ready().tweaks;
  assert.ok(tweaks.includes('zoom'), `масштаб активен (${tweaks.join(', ')})`);
  assert.ok(env.headAppends() > 0, 'твики добавили свои стили в head');
  assert.equal(env.storage.dump()[SWITCH_KEY], undefined, 'флаг выключателя не выставлен');
});

check('?tweaks=off выключает твики только для этой ссылки', () => {
  const env = loadPlugin({ search: '?tweaks=off' });
  assert.deepEqual(env.ready().tweaks, [], 'ни один твик не активирован');
  assert.match(env.ready().stage, /tweaks=off/, 'состояние выключателя записано в отметке');
  assert.equal(env.storage.dump()[SWITCH_KEY], undefined, 'в устройстве флаг не сохраняется');
  assert.equal(env.headAppends(), 0, 'твики не добавили ни одного стиля');
});

check('обычная ссылка снова включает твики и снимает старый флаг', () => {
  const env = loadPlugin({ stored: { [SWITCH_KEY]: '1' } });
  const tweaks = env.ready().tweaks;
  assert.ok(tweaks.includes('zoom'), `обычная ссылка включает твики (${tweaks.join(', ') || 'пусто'})`);
  assert.equal(env.storage.dump()[SWITCH_KEY], undefined, 'старый флаг очищен');
});

check('?tweaks=on снимает старый флаг и возвращает твики', () => {
  const env = loadPlugin({ stored: { [SWITCH_KEY]: '1' }, search: '?tweaks=on' });
  const tweaks = env.ready().tweaks;
  assert.ok(tweaks.includes('zoom'), `масштаб снова активен (${tweaks.join(', ') || 'пусто'})`);
  assert.equal(env.storage.dump()[SWITCH_KEY], undefined, 'флаг выключателя снят');
});

check('?tweaks=off гасит твики при всех включённых флагах', () => {
  const env = loadPlugin({
    search: '?tweaks=off',
    flags: { zoom: true, contextMenu: true, mobileComposer: true, fileDownload: true, mobileSidebar: true, freePanels: true },
  });
  assert.deepEqual(env.ready().tweaks, [], 'галочки конфигурации не пересиливают выключатель');
});

check('параметр в середине адреса тоже понимается', () => {
  const env = loadPlugin({ search: '?foo=1&tweaks=off&bar=2' });
  assert.deepEqual(env.ready().tweaks, [], 'выключатель сработал не только первым параметром');
});

check('неизвестное значение не ломает загрузку', () => {
  const env = loadPlugin({ search: '?tweaks=maybe' });
  const tweaks = env.ready().tweaks;
  assert.ok(tweaks.includes('zoom'), 'твики работают как обычно');
  assert.equal(env.storage.dump()[SWITCH_KEY], undefined, 'флаг не выставлен');
});

check('выключатель описан в словаре формы', () => {
  const source = fs.readFileSync(CLIENT, 'utf8');
  assert.ok(source.includes(`'${SWITCH_KEY}'`), 'ключ выключателя есть в client.js');
  assert.match(source, /form\.switchOff/, 'у формы флагов есть подпись состояния');
  assert.match(source, /tweaksSwitchOff/, 'каркас учитывает выключатель в ходе включения');
});

console.log(`\nВсе проверки: ${passed}`);
