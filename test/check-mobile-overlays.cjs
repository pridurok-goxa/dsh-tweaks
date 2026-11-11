/**
 * Мобильные оверлеи Agent Team / Subagents: тёмка и крестик ставятся только
 * для действительно открытого окна и гарантированно снимаются.
 *
 * Отдельная регрессия из прогона DIAG на 0.2.2: закрытое/вынесенное меню
 * принималось за активный оверлей, прозрачное затемнение оставалось в DOM
 * поверх экрана и съедало все тапы — на телефоне это выглядело как полное
 * зависание интерфейса.
 *
 * Проверка без браузера: регион `tweak-mobile-overlays` из client.js
 * исполняется в vm с мини-DOM, а затемнение ищется в body по маркеру.
 *
 * Запуск: node test/check-mobile-overlays.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const CLIENT = path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(CLIENT, 'utf8');
const region = source.split('/* #region tweak-mobile-overlays */')[1].split('/* #endregion tweak-mobile-overlays */')[0];

/* ------------------------------- мини-DOM ------------------------------- */

/** Совпадает ли атрибутная часть селектора с узлом. */
function matchAttr(node, part) {
  const match = /^\[([a-z-]+)(?:([*^$~|]?=)"([^"]*)")?\]$/i.exec(part);
  if (match === null) return false;
  const [, name, op, value] = match;
  const actual = node.getAttribute(name);
  if (actual === null) return false;
  if (op === undefined) return true;
  if (op === '*=') return actual.includes(value);
  return actual === value;
}

/** Совпадает ли узел с простым селектором (тег, #id, [attr], тег[attr="v"]...). */
function matches(node, selector) {
  const text = String(selector).trim();
  if (text.startsWith('#')) return node.id === text.slice(1);
  if (text.startsWith('[')) return matchAttr(node, text);
  // Составной селектор: `button[aria-haspopup="tree"][aria-expanded="true"]`.
  const parts = text.match(/^[a-z0-9-]*|\[[^\]]*\]/gi) ?? [];
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (part === '') continue;
    if (part.startsWith('[')) {
      if (!matchAttr(node, part)) return false;
    } else if (String(node.tagName ?? '').toUpperCase() !== part.toUpperCase()) {
      return false;
    }
  }
  return true;
}

/** Совпадает ли узел со списком селекторов через запятую. */
function matchesAny(node, selector) {
  return String(selector)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .some((part) => matches(node, part));
}

/** Элемент мини-DOM: атрибуты, стиль, дети, геометрия. */
class FakeNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = 1;
    this.isConnected = true;
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.childNodes = [];
    this.parentElement = null;
    this.textContent = '';
    this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  get children() {
    return this.childNodes;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentElement = this;
    return child;
  }

  remove() {
    const parent = this.parentElement;
    if (parent === null) return;
    const index = parent.childNodes.indexOf(this);
    if (index >= 0) parent.childNodes.splice(index, 1);
    this.parentElement = null;
    this.isConnected = false;
  }

  setPointerCapture() {}

  addEventListener() {}

  removeEventListener() {}

  click() {}

  focus() {}

  contains(node) {
    let current = node;
    while (current !== null && current !== undefined) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  querySelector(selector) {
    for (const child of this.childNodes) {
      if (matchesAny(child, selector)) return child;
      const found = child.querySelector(selector);
      if (found !== null) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (matchesAny(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  closest(selector) {
    let node = this;
    while (node !== null && node !== undefined) {
      if (matchesAny(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

/** Песочница: документ, окно, кадры и таймеры под рукой у теста. */
function createSandbox() {
  const body = new FakeNode('body');
  const html = new FakeNode('html');
  html.id = 'html';
  const documentElement = html;
  documentElement.style = {
    setProperty() {},
    removeProperty() {},
    getPropertyValue: () => '',
  };
  const frames = [];
  const timers = new Map();
  let timerSeq = 0;
  let visibilityState = 'visible';
  const documentListeners = new Map();

  const window = {
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: null,
    requestAnimationFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
    setTimeout: (fn) => {
      timerSeq += 1;
      timers.set(timerSeq, fn);
      return timerSeq;
    },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const document = {
    body,
    documentElement,
    head: new FakeNode('head'),
    get visibilityState() {
      return visibilityState;
    },
    createElement: (tag) => new FakeNode(tag),
    getElementById: (id) => (id === 'root' ? null : null),
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    addEventListener: (type, listener) => {
      const list = documentListeners.get(type) ?? [];
      list.push(listener);
      documentListeners.set(type, list);
    },
    removeEventListener: (type, listener) => {
      const list = documentListeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent: () => true,
  };

  /** Выполнить один кадр: колбэки rAF могут запросить следующий. */
  const flushFrame = () => {
    const pending = frames.splice(0, frames.length);
    for (const fn of pending) fn();
  };
  /** Прокрутить несколько кадров и все таймеры. */
  const settle = () => {
    for (let step = 0; step < 6; step += 1) {
      flushFrame();
      const snapshot = [...timers.entries()];
      timers.clear();
      for (const [, fn] of snapshot) fn();
    }
    flushFrame();
  };

  window.document = document;

  const sandbox = {
    window,
    document,
    getComputedStyle: (node) => node?.style ?? {},
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {}
      disconnect() {}
    },
    KeyboardEvent: class {
      constructor(type, init) {
        this.type = type;
        this.key = init?.key;
      }
    },
    // Внешние помощники каркаса: в этом тесте они не предмет проверки.
    mobileComposerDevice: () => true,
    /** Как в каркасе: скрытая вкладка отключает наблюдение, видимая включает. */
    pauseWhenHidden: (doc, connect, disconnect) => {
      const onVisibility = () => {
        if (doc.visibilityState === 'hidden') disconnect();
        else connect();
      };
      doc.addEventListener('visibilitychange', onVisibility);
      return () => doc.removeEventListener('visibilitychange', onVisibility);
    },
    touchesRoot: (node, selector) =>
      node !== null && node !== undefined && typeof node.closest === 'function' && node.closest(selector) !== null,
  };
  sandbox.globalThis = sandbox;
  return {
    sandbox,
    body,
    document,
    window,
    settle,
    /** Выполнить ровно один кадр (для проверки промежуточного состояния). */
    frame: flushFrame,
    fireVisibility: (state) => {
      visibilityState = state;
      for (const listener of [...(documentListeners.get('visibilitychange') ?? [])]) listener();
    },
  };
}

vm.createContext({});
/** Загрузить регион оверлеев и вернуть фабрику с уже подставленными заглушками. */
function loadOverlays() {
  const env = createSandbox();
  const context = vm.createContext(env.sandbox);
  vm.runInContext(`${region}\nthis.setupMobileOverlays = setupMobileOverlays;`, context, { filename: 'mobile-overlays.js' });
  return { ...env, setup: () => env.sandbox.setupMobileOverlays() };
}

/** Найти затемнение в body. */
function backdropOf(env) {
  return env.body.childNodes.find((node) => node.hasAttribute('data-dsh-tweaks-overlay-backdrop')) ?? null;
}

/** Кнопка-триггер меню субагентов в шапке. */
function addSubagentTrigger(env, expanded = true) {
  const button = env.document.createElement('button');
  button.setAttribute('aria-haspopup', 'tree');
  button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  button.rect = { left: 300, top: 40, right: 340, bottom: 70, width: 40, height: 30 };
  env.body.appendChild(button);
  return button;
}

/** Fixed-слой меню с деревом внутри; возвращает корень слоя. */
function addSubagentMenu(env, { top = 76, insideSidebar = false } = {}) {
  const root = env.document.createElement('div');
  root.style.position = 'fixed';
  root.rect = { left: 40, top, right: 380, bottom: top + 400, width: 340, height: 400 };
  const tree = env.document.createElement('div');
  tree.setAttribute('role', 'tree');
  root.appendChild(tree);
  if (insideSidebar) {
    const sidebar = env.document.createElement('div');
    sidebar.setAttribute('class', 'X_sidebarCol');
    sidebar.appendChild(root);
    env.body.appendChild(sidebar);
  } else {
    env.body.appendChild(root);
  }
  return root;
}

/** Панель Agent Team; возвращает узел. */
function addTeamPanel(env, { visible = true } = {}) {
  const panel = env.document.createElement('div');
  panel.setAttribute('data-team-panel', '');
  panel.setAttribute('role', 'dialog');
  panel.style.position = 'fixed';
  if (!visible) panel.style.visibility = 'hidden';
  panel.rect = { left: 8, top: 120, right: 382, bottom: 700, width: 374, height: 580 };
  env.body.appendChild(panel);
  return panel;
}

let passed = 0;
/**
 * Выполнить проверку.
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

check('закрытое меню субагентов (дерево в DOM без открытого триггера) не включает затемнение', () => {
  const env = loadOverlays();
  addSubagentMenu(env);
  env.setup();
  env.settle();
  assert.equal(backdropOf(env), null, 'затемнение не создано');
  assert.equal(env.body.childNodes.length, 1, 'в body только слой меню, затемнения нет');
});

check('дерево в выдвижной панели не считается оверлеем', () => {
  const env = loadOverlays();
  addSubagentTrigger(env, true);
  addSubagentMenu(env, { insideSidebar: true });
  env.setup();
  env.settle();
  assert.equal(backdropOf(env), null, 'дерево сайдбара затемнение не включает');
});

check('скрытая панель Agent Team не включает затемнение', () => {
  const env = loadOverlays();
  addTeamPanel(env, { visible: false });
  env.setup();
  env.settle();
  assert.equal(backdropOf(env), null, 'visibility:hidden не считается открытой панелью');
});

check('открытая панель Agent Team: затемнение появляется и перехватывает тапы вторым проходом', () => {
  const env = loadOverlays();
  addTeamPanel(env, { visible: true });
  env.setup();
  env.settle();
  const backdrop = backdropOf(env);
  assert.ok(backdrop, 'затемнение создано');
  assert.equal(backdrop.style.pointerEvents, 'auto', 'подтверждённое затемнение перехватывает тапы');
  assert.ok(env.body.childNodes.some((node) => node.hasAttribute('data-dsh-tweaks-overlay-close')), 'есть кнопка закрытия');
});

check('затемнение не ест тапы до подтверждения вторым проходом', () => {
  const env = loadOverlays();
  addTeamPanel(env, { visible: true });
  env.setup();
  // Один кадр: оверлей найден, затемнение нарисовано, подтверждения ещё нет.
  env.frame();
  const backdrop = backdropOf(env);
  assert.ok(backdrop, 'затемнение первого прохода есть');
  assert.equal(backdrop.style.pointerEvents, 'none', 'первый проход тапы не перехватывает');
  // Второй кадр подтверждает оверлей — только теперь перехват включается.
  env.frame();
  assert.equal(backdrop.style.pointerEvents, 'auto', 'подтверждённое затемнение перехватывает тапы');
});

check('после закрытия панели затемнение снимается', () => {
  const env = loadOverlays();
  const panel = addTeamPanel(env, { visible: true });
  env.setup();
  env.settle();
  assert.ok(backdropOf(env), 'сначала затемнение есть');
  panel.remove();
  env.settle();
  assert.equal(backdropOf(env), null, 'после закрытия затемнение удалено');
});

check('открытое меню субагентов: затемнение появляется, после закрытия — снимается', () => {
  const env = loadOverlays();
  const trigger = addSubagentTrigger(env, true);
  const menu = addSubagentMenu(env, { top: 76 });
  env.setup();
  env.settle();
  assert.ok(backdropOf(env), 'открытое меню включает затемнение');
  trigger.setAttribute('aria-expanded', 'false');
  menu.remove();
  env.settle();
  assert.equal(backdropOf(env), null, 'после закрытия меню затемнение удалено');
});

check('меню далеко от своего триггера оверлеем не считается', () => {
  const env = loadOverlays();
  addSubagentTrigger(env, true);
  addSubagentMenu(env, { top: 600 });
  env.setup();
  env.settle();
  assert.equal(backdropOf(env), null, 'слой из другого угла экрана затемнение не включает');
});

check('страховочный таймер снимает затемнение, если оверлей закрылся без мутаций', () => {
  const env = loadOverlays();
  const panel = addTeamPanel(env, { visible: true });
  env.setup();
  env.settle();
  assert.ok(backdropOf(env), 'затемнение есть');
  // Панель исчезает молча: ни одной записи наблюдателя не приходит.
  panel.remove();
  env.settle();
  assert.equal(backdropOf(env), null, 'страховочная перепроверка сняла затемнение');
});

check('скрытая вкладка снимает затемнение', () => {
  const env = loadOverlays();
  addTeamPanel(env, { visible: true });
  // Оверлей найден и затемнение подтверждено.
  env.setup();
  env.settle();
  assert.ok(backdropOf(env), 'затемнение есть');
  env.fireVisibility('hidden');
  assert.equal(backdropOf(env), null, 'при скрытии вкладки перехват тапов снят');
});

check('на широком экране затемнение не ставится', () => {
  const env = loadOverlays();
  env.window.innerWidth = 1280;
  addTeamPanel(env, { visible: true });
  env.setup();
  env.settle();
  assert.equal(backdropOf(env), null, 'на ПК рамка окон не нужна');
});

console.log(`\nВсе проверки: ${passed}`);
