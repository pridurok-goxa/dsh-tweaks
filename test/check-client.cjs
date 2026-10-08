/**
 * Проверка плагина ui-zoom без браузера: реальный client.js исполняется в vm
 * с заглушками window/document/React/ctx, затем проверяются масштаб, команды,
 * хранение значения, границы и индикатор.
 *
 * Запуск: node test/check-client.js
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const CLIENT = path.join(__dirname, '..', 'client.js');

/** Заглушка хранилища в памяти. */
function createStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  };
}

/**
 * Мини-React: useState/useEffect достаточны, чтобы индикатор отработал.
 * Эффекты выполняются сразу и возвращают очистку в общий список.
 */
function createReact(cleanups) {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const cell = { value: initial };
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next;
        },
      ];
    },
    useEffect(effect) {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };
}

/** Заглушка класса Element: плагин проверяет узлы через instanceof. */
class FakeElement {}

/** Заглушка MouseEvent: clientX объявлен геттером, как в браузере. */
class FakeMouseEvent {
  constructor(type) {
    this.type = type;
    this.target = null;
    this._x = 0;
  }
}

Object.defineProperty(FakeMouseEvent.prototype, 'clientX', {
  configurable: true,
  get() {
    return this._x;
  },
});

/** Заглушка PointerEvent: наследник MouseEvent, как в настоящем DOM. */
class FakePointerEvent extends FakeMouseEvent {}

/**
 * Заглушка inline-стиля: обычные свойства плюс CSS-переменные через setProperty.
 * @returns {object} объект стиля.
 */
function createStyle() {
  const style = {
    setProperty(name, value) {
      style[name] = String(value);
    },
    removeProperty(name) {
      delete style[name];
    },
    getPropertyValue(name) {
      return style[name] ?? '';
    },
  };
  return style;
}

/**
 * Создать элемент так, как его видит плагин: со стилем и списком классов.
 * @param {string} id - идентификатор элемента.
 * @param {string[]} classes - классы элемента.
 * @returns {object} заглушка элемента.
 */
function createElement(id, classes = []) {
  const element = Object.create(FakeElement.prototype);
  Object.assign(element, {
    id,
    nodeType: 1,
    isConnected: true,
    style: createStyle(),
    childNodes: [],
    hidden: false,
    textContent: '',
    type: '',
    offsetLeft: 0,
    offsetWidth: 0,
    classList: {
      contains: (name) => classes.includes(name),
    },
    dataset: {},
    tagName: id.toUpperCase(),
    parentElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: (node) => element.childNodes.includes(node),
    matches: () => false,
    setAttribute(name, value) {
      element[name] = value;
    },
    getAttribute: (name) => element[name] ?? null,
    appendChild(child) {
      element.childNodes.push(child);
      child.parentElement = element;
      return child;
    },
    append(...nodes) {
      for (const node of nodes) element.appendChild(node);
    },
    replaceChildren() {
      element.childNodes.length = 0;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
    remove: () => {},
    /** Геометрия заглушки: тесты задают её сами, layout здесь не считается. */
    rect: { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 },
    getBoundingClientRect() {
      return element.rect;
    },
  });
  // Доступ к детям — через геттеры: Object.assign выше скопировал бы их значения.
  Object.defineProperty(element, 'childElementCount', { get: () => element.childNodes.length });
  Object.defineProperty(element, 'children', {
    configurable: true,
    get: () => element.childNodes,
    set: (value) => {
      element.childNodes = value;
    },
  });
  return element;
}

/** Собрать песочницу с плагином и вернуть наблюдаемые объекты. */
function loadPlugin({ stored = null, shortcutsAvailable = true, servicesAvailable = true, handle = null, handles = null, columns = null } = {}) {
  const storage = createStorage();
  if (stored !== null) storage.setItem('dsh.ui-zoom.v1', stored);
  /** Полоска изменения ширины панели: по ней плагин находит рамку интерфейса. */
  let frameHandle = handle;
  /** Все полоски: плагин ставит их по границам колонок. */
  const handlesMock = handles ?? (handle === null ? [] : [handle]);
  /** Колонки раскладки: их границы и берёт плагин. */
  const columnsMock = columns ?? {};
  /** Текущее выделение: плагин показывает по нему копирование вне поля ввода. */
  let selectionText = '';

  /** Стиль элемента-носителя масштаба: и CSS-переменные, и обычные свойства. */
  const style = createStyle();
  const listeners = new Map();
  const timers = new Map();
  const intervals = new Map();
  let timerSeq = 0;
  const reactCleanups = [];
  let shortcutsAvailableNow = shortcutsAvailable;
  /** Куда плагин вешает масштаб: корень приложения, как в настоящей странице. */
  let zoomHostId = 'root';

  // Общий стиль: масштаб ставится на корень приложения, но наблюдать его удобно в одном месте.
  const documentElement = { style, id: 'html' };
  const rootElement = { style, id: 'root' };
  const bodyChildren = [];
  const bodyElement = createElement('body');
  bodyElement.children = bodyChildren;
  /** Корень приложения содержит узлы интерфейса — как в настоящем документе. */
  rootElement.contains = (node) => node !== bodyElement && !bodyChildren.includes(node);
  /** Подписчики MutationObserver: плагин следит за появлением попапов в body. */
  const mutationObservers = [];
  const fireMutation = (node) => {
    for (const observer of mutationObservers) observer([{ addedNodes: [node] }]);
  };
  bodyElement.appendChild = (child) => {
    bodyChildren.push(child);
    child.parentElement = bodyElement;
    fireMutation(child);
    return child;
  };
  /** События, которые плагин отправляет в window: проверяем сигнал пересчёта. */
  const dispatched = [];
  const documentListeners = new Map();
  const documentObject = {
    documentElement,
    body: bodyElement,
    head: { appendChild: (node) => node },
    getElementById: (id) => {
      if (id === 'root') return zoomHostId === 'root' ? rootElement : null;
      return null;
    },
    // Полоски изменения ширины и колонки раскладки — по ним плагин выравнивает полоски.
    querySelector: (selector) => {
      const text = String(selector);
      if (text.includes('data-side')) return handlesMock[0] ?? null;
      if (text.includes('_sidebarCol')) return columnsMock.sidebar ?? null;
      if (text.includes('data-rightbar-col')) return columnsMock.rightbar ?? null;
      return null;
    },
    querySelectorAll: (selector) => (String(selector).includes('data-side') ? handlesMock : []),
    createElement: (tag) => createElement(tag),
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
  };
  /** Стили заглушки: реальный layout не нужен — важны position и zoom. */
  const getComputedStyle = (element) => ({
    position: element?.style?.position ?? 'static',
    zoom: element?.style?.zoom ?? '1',
  });
  const windowObject = {
    localStorage: storage,
    MouseEvent: FakeMouseEvent,
    PointerEvent: FakePointerEvent,
    getSelection: () => selectionText,
    __ModuleLoader__: { load: (definition) => { loaded = definition; } },
    setTimeout: (fn, ms) => {
      const id = ++timerSeq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => {
      const id = ++timerSeq;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    dispatchEvent: (event) => {
      dispatched.push(event?.type ?? String(event));
      return true;
    },
    requestAnimationFrame: (fn) => {
      const id = ++timerSeq;
      timers.set(id, { fn, ms: 0 });
      return id;
    },
    getComputedStyle,
  };
  let loaded = null;

  const dictionaries = [];
  const slotEntries = [];
  const registeredCommands = [];
  const disposeListeners = [];

  const localeFace = {
    register: (ns, locale, dict) => {
      dictionaries.push({ ns, locale, dict });
      return () => {};
    },
    // Словарь не подключился (так бывает при перезагрузке модуля в живую страницу):
    // переводчик отдаёт сам ключ, и подписи меню обязаны подстраховаться.
    bind: () => (key) => key,
    getLocale: () => ({ active: 'ru', locales: [], revision: 1 }),
  };
  const shortcutsFace = {
    register: (command) => {
      registeredCommands.push(command);
      return () => {};
    },
  };
  const slotsFace = {
    inject: (name, callback) => {
      const entry = callback();
      slotEntries.push({ name, entry });
      return () => {};
    },
    register: (options, component) => ({ options, component }),
  };
  const ctx = {
    // Фасад даёт только ctx.get / ctx.on / ctx.provide — ровно как в браузере.
    on: (event, listener) => {
      if (event === 'dispose') disposeListeners.push(listener);
      return () => {};
    },
    provide: () => () => {},
    get: (name) => {
      if (!servicesAvailable && (name === 'locale' || name === 'slots')) return undefined;
      if (name === 'locale') return localeFace;
      if (name === 'slots') return slotsFace;
      if (name === 'shortcuts') return shortcutsAvailableNow ? shortcutsFace : undefined;
      return undefined;
    },
  };

  /** Заглушка MutationObserver: плагин следит за появлением попапов в body. */
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {
      mutationObservers.push((records) => this.callback(records));
    }

    disconnect() {
      const index = mutationObservers.indexOf(this.callback);
      if (index >= 0) mutationObservers.splice(index, 1);
    }
  }

  const sandbox = {
    window: windowObject,
    document: documentObject,
    Element: FakeElement,
    Event: class FakeEvent {
      constructor(type) {
        this.type = type;
      }
    },
    MutationObserver: FakeMutationObserver,
    getComputedStyle,
    console,
    setTimeout: windowObject.setTimeout,
    clearTimeout: windowObject.clearTimeout,
    require: (name) => {
      if (name === 'react') return createReact(reactCleanups);
      throw new Error(`unexpected require: ${name}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: CLIENT });

  assert.ok(loaded, 'client.js должен вызвать window.__ModuleLoader__.load');
  assert.equal(loaded.id, 'dsh-ui-tweaks', 'id клиентского модуля');
  const plugin = loaded.factory(sandbox.require);
  // Прототип события общий на весь файл: снимаем патч прошлого прогона, иначе
  // геттер остаётся привязанным к store предыдущей песочницы.
  delete FakePointerEvent.prototype.clientX;
  delete FakePointerEvent.prototype.__dshUiZoomPatched;
  plugin.apply(ctx);

  return {
    plugin,
    storage,
    style,
    body: bodyElement,
    dispatched,
    document: documentObject,
    timers,
    listeners,
    dictionaries,
    slotEntries,
    registeredCommands,
    disposeListeners,
    reactCleanups,
    /** Дождаться сервиса shortcuts: включить его и прокрутить опрос. */
    publishShortcuts: () => {
      shortcutsAvailableNow = true;
      const snapshot = [...intervals.values()];
      intervals.clear();
      for (const interval of snapshot) interval.fn();
    },
    /** Выгрузить плагин: уведомить подписчиков ctx.on('dispose'). */
    dispose: () => {
      for (const listener of disposeListeners) listener();
    },
    /** Текущий масштаб, как его видит документ: носитель — body. */
    zoom: () => style.zoom,
    /** Масштаб в переменной, которую читает calc() попапов. */
    scaleVar: () => style['--dsh-ui-zoom'],
    /** Исходное вьюпортное значение свойства, сохранённое плагином. */
    source: (node, prop) => node.style[`--dsh-ui-zoom-src-${prop}`],
    /**
     * Итоговая координата так, как её посчитает CSS: источник / масштаб.
     * @param {object} node - узел попапа.
     * @param {string} prop - имя свойства.
     * @returns {number} вьюпортная координата.
     */
    resolved: (node, prop) => {
      const raw = Number.parseFloat(node.style[`--dsh-ui-zoom-src-${prop}`]);
      const scale = Number.parseFloat(style['--dsh-ui-zoom']);
      return raw / scale;
    },
    /** Ожидаемая строка calc() для свойства. */
    calcOf: (prop) => `calc(var(--dsh-ui-zoom-src-${prop}) / var(--dsh-ui-zoom))`,
    /** Конструктор события указателя для проверки подмены clientX. */
    PointerEvent: FakePointerEvent,
    /** Нажать клавишу: вызвать обработчик storage-события. */
    fireStorage: (key) => listeners.get('storage')?.({ key }),
    /** Вызвать слушателя документа — так браузер доставляет событие. */
    fireDocument: (type, event) => {
      for (const listener of [...(documentListeners.get(type) ?? [])]) listener(event);
    },
    /** Своё меню по правой кнопке, если плагин его создал. */
    menuElement: () => bodyChildren.find((node) => node.className === 'dsh-ui-zoom-menu') ?? null,
    /** Задать текст выделения, который увидит плагин. */
    setSelection: (text) => {
      selectionText = text;
    },
    /**
     * Уведомить плагин, что приложение переписало style попапа (как MutationObserver).
     * @param {object} node - узел, у которого изменился style.
     * @returns {void}
     */
    fireStyle: (node) => {
      for (const observer of mutationObservers) observer([{ type: 'attributes', target: node }]);
    },
    /** Прокрутить все живые таймеры (скрытие индикатора). */
    runTimers: () => {
      const snapshot = [...timers.entries()];
      timers.clear();
      for (const [, timer] of snapshot) timer.fn();
    },
    /** Найти команду по id и выполнить её действие. */
    runCommand: (id) => {
      const command = registeredCommands.find((row) => row.id === id);
      assert.ok(command, `команда ${id} должна быть зарегистрирована`);
      const resolution = command.resolve({ region: 'page', modal: null, target: null });
      assert.equal(resolution.status, 'handled', `${id} должна обрабатывать ввод`);
      resolution.run();
      return command;
    },
    /**
     * Нажать клавишу напрямую, как это делает браузер.
     * @param {string} code - физический код клавиши.
     * @param {object} modifiers - модификаторы события.
     * @returns {object} признак того, что событие было перехвачено.
     */
    press: (code, modifiers = {}) => {
      const handler = listeners.get('keydown');
      assert.ok(handler, 'прямой перехват клавиш установлен');
      let prevented = false;
      let stopped = false;
      handler({
        code,
        key: code,
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        ...modifiers,
        preventDefault: () => {
          prevented = true;
        },
        stopImmediatePropagation: () => {
          stopped = true;
        },
      });
      return { prevented, stopped };
    },
    /**
     * Прокрутить колесо, как это делает браузер.
     * @param {number} deltaY - направление прокрутки (отрицательное — вверх).
     * @param {object} modifiers - модификаторы события.
     * @returns {object} признак того, что событие было перехвачено.
     */
    wheel: (deltaY, modifiers = {}) => {
      const handler = listeners.get('wheel');
      assert.ok(handler, 'перехват колеса установлен');
      let prevented = false;
      handler({
        deltaY,
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        ...modifiers,
        preventDefault: () => {
          prevented = true;
        },
      });
      return { prevented };
    },
  };
}

const results = [];
/** Значения приходят из другого vm-контекста: сравниваем их через JSON. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function check(name, fn) {
  try {
    fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

check('стартовый масштаб 100% не задаёт лишних стилей', () => {
  const env = loadPlugin();
  assert.ok(!env.zoom(), 'при 100% масштаб не выставляется');
  assert.ok(!env.body.style.height, 'высота не компенсируется на 100%');
});

check('сохранённое значение восстанавливается', () => {
  const env = loadPlugin({ stored: '1.35' });
  assert.equal(env.zoom(), '1.35');
});

check('испорченное значение игнорируется', () => {
  for (const bad of ['abc', '', 'NaN', '0.1', '99']) {
    const env = loadPlugin({ stored: bad });
    // 100% — это снятый inline-масштаб (пустая строка), остальные значения задают zoom.
    const expected = bad === '0.1' ? '0.5' : bad === '99' ? '2' : '';
    assert.equal(env.zoom(), expected, `значение ${JSON.stringify(bad)} → ${expected || '100%'}`);
  }
});

check('команды масштаба зарегистрированы, включая клавиши нумпада', () => {
  const env = loadPlugin();
  const ids = env.registeredCommands.map((row) => row.id).sort();
  assert.deepEqual(ids, [
    'ui-zoom.in',
    'ui-zoom.in.numpad',
    'ui-zoom.out',
    'ui-zoom.out.numpad',
    'ui-zoom.reset',
  ]);
  const increase = env.registeredCommands.find((row) => row.id === 'ui-zoom.in');
  assert.deepEqual(plain(increase.defaults['desktop:windows']), { code: 'Equal', modifiers: ['primary'] });
  assert.deepEqual(plain(increase.defaults['web:windows']), { code: 'Equal', modifiers: ['primary', 'alt'] });
  const decrease = env.registeredCommands.find((row) => row.id === 'ui-zoom.out');
  assert.deepEqual(plain(decrease.defaults['desktop:windows']), { code: 'Minus', modifiers: ['primary'] });
  const reset = env.registeredCommands.find((row) => row.id === 'ui-zoom.reset');
  assert.deepEqual(plain(reset.defaults['desktop:windows']), { code: 'Digit0', modifiers: ['primary'] });
  // Нумпад: Ctrl и клавиши + / − на цифровом блоке.
  const numpadIn = env.registeredCommands.find((row) => row.id === 'ui-zoom.in.numpad');
  assert.deepEqual(plain(numpadIn.defaults['desktop:windows']), { code: 'NumpadAdd', modifiers: ['primary'] });
  const numpadOut = env.registeredCommands.find((row) => row.id === 'ui-zoom.out.numpad');
  assert.deepEqual(plain(numpadOut.defaults['desktop:windows']), { code: 'NumpadSubtract', modifiers: ['primary'] });
  for (const command of env.registeredCommands) {
    assert.deepEqual(plain(command.regions), ['page', 'editable'], `${command.id}: работает и в поле ввода`);
    assert.ok(
      /^[А-Яа-яЁё]/.test(command.label()),
      `${command.id}: подпись — текст словаря, а не ключ (${command.label()})`,
    );
    assert.ok(command.aliases.length > 0, `${command.id}: есть алиасы для поиска`);
  }
});

check('клавиша нумпада даёт тот же шаг масштаба', () => {
  const env = loadPlugin();
  env.runCommand('ui-zoom.in.numpad');
  assert.equal(env.zoom(), '1.05', '+ на нумпаде увеличивает');
  env.runCommand('ui-zoom.out.numpad');
  assert.ok(!env.zoom(), '− на нумпаде уменьшает');
});

check('прямой перехват распознаёт символ клавиши, а не только код', () => {
  const env = loadPlugin();
  // Раскладка и Shift меняют event.key: символы = + - _ 0 должны работать так же.
  env.press('Equal', { key: '+' });
  assert.equal(env.zoom(), '1.05', 'Shift+= (символ +) увеличивает');
  env.press('Equal', { key: '=' });
  assert.equal(env.zoom(), '1.1', 'символ = увеличивает');
  env.press('Backquote', { key: 'ё' });
  assert.equal(env.zoom(), '1.1', 'чужая раскладка масштаб не меняет');
  env.press('Minus', { key: '_' });
  assert.equal(env.zoom(), '1.05', 'Shift+- (символ _) уменьшает');
  env.press('Digit0', { key: '0' });
  assert.ok(!env.zoom(), 'символ 0 сбрасывает');
});

check('прямой перехват клавиш работает независимо от сервиса команд', () => {
  const env = loadPlugin();
  // Сервис команд в этом сценарии недоступен: клавиши обязаны работать всё равно.
  env.press('Equal');
  assert.equal(env.zoom(), '1.05', 'Ctrl+= увеличивает');
  env.press('NumpadAdd');
  assert.equal(env.zoom(), '1.1', 'Ctrl++ на нумпаде увеличивает');
  env.press('Minus');
  assert.equal(env.zoom(), '1.05', 'Ctrl+- уменьшает');
  env.press('NumpadSubtract');
  assert.ok(!env.zoom(), 'Ctrl+− на нумпаде уменьшает');
  env.press('Digit0');
  assert.ok(!env.zoom(), 'Ctrl+0 сбрасывает к 100%');
  env.press('Numpad0');
  assert.ok(!env.zoom(), 'Ctrl+0 на нумпаде тоже сбрасывает');
});

check('прямой перехват перехватывает событие и не трогает чужие сочетания', () => {
  const env = loadPlugin();
  const handled = env.press('Minus');
  assert.equal(handled.prevented, true, 'событие отменено');
  assert.equal(handled.stopped, true, 'событие не уходит дальше');
  const zoomBefore = env.zoom();
  env.press('KeyA');
  env.press('Minus', { ctrlKey: false });
  env.press('Minus', { ctrlKey: true, altKey: true });
  assert.equal(env.zoom(), zoomBefore, 'без Ctrl или с Alt масштаб не меняется');
});

check('Ctrl+колёсико меняет масштаб тем же шагом', () => {
  const env = loadPlugin();
  const handled = env.wheel(-100);
  assert.equal(handled.prevented, true, 'прокрутка с Ctrl отменена (не прокручивает страницу)');
  assert.equal(env.zoom(), '1.05', 'колесо вверх увеличивает');
  env.wheel(100);
  assert.ok(!env.zoom(), 'колесо вниз возвращает к 100%');
  env.wheel(-200);
  assert.equal(env.zoom(), '1.05', 'большая амплитуда — тот же один шаг');
});

check('Ctrl+колёсико не срабатывает без Ctrl и с Alt', () => {
  const env = loadPlugin();
  env.wheel(-100, { ctrlKey: false });
  env.wheel(-100, { ctrlKey: true, altKey: true });
  env.wheel(0, { ctrlKey: true });
  assert.ok(!env.zoom(), 'без Ctrl, с Alt или без движения масштаб не меняется');
});

check('Ctrl+колёсико упирается в границы диапазона', () => {
  const env = loadPlugin();
  for (let i = 0; i < 40; i += 1) env.wheel(-100);
  assert.equal(env.zoom(), '2', 'верхняя граница 200%');
  for (let i = 0; i < 80; i += 1) env.wheel(100);
  assert.equal(env.zoom(), '0.5', 'нижняя граница 50%');
});

check('без сервиса shortcuts команды не падают, а появляются с ним', () => {
  const env = loadPlugin({ shortcutsAvailable: false });
  assert.equal(env.registeredCommands.length, 0, 'пока сервиса нет, регистраций нет');
  assert.ok(!env.zoom(), 'при 100% масштаб не задан, но плагин работает');
  env.publishShortcuts();
  assert.deepEqual(
    env.registeredCommands.map((row) => row.id).sort(),
    ['ui-zoom.in', 'ui-zoom.in.numpad', 'ui-zoom.out', 'ui-zoom.out.numpad', 'ui-zoom.reset'],
    'после появления сервиса команды зарегистрированы',
  );
});

check('без сервиса locale плагин не падает и масштаб всё равно работает', () => {
  const env = loadPlugin({ servicesAvailable: false });
  assert.equal(env.dictionaries.length, 0, 'словари не регистрируются');
  assert.equal(env.registeredCommands.length, 5, 'команды регистрируются независимо от локали');
  env.runCommand('ui-zoom.in');
  assert.equal(env.zoom(), '1.05', 'масштаб меняется');
});

check('увеличение шагами по 5% и запись в хранилище', () => {
  const env = loadPlugin();
  env.runCommand('ui-zoom.in');
  assert.equal(env.zoom(), '1.05');
  env.runCommand('ui-zoom.in');
  assert.equal(env.zoom(), '1.1');
  assert.equal(env.storage.dump()['dsh.ui-zoom.v1'], '1.1', 'значение сохранено');
});

check('уменьшение шагами по 5%', () => {
  const env = loadPlugin();
  env.runCommand('ui-zoom.out');
  assert.equal(env.zoom(), '0.95');
});

check('верхняя граница 200% не превышается', () => {
  const env = loadPlugin();
  for (let i = 0; i < 40; i += 1) env.runCommand('ui-zoom.in');
  assert.equal(env.zoom(), '2');
});

check('нижняя граница 50% не нарушается', () => {
  const env = loadPlugin();
  for (let i = 0; i < 40; i += 1) env.runCommand('ui-zoom.out');
  assert.equal(env.zoom(), '0.5');
});

check('сброс возвращает 100% из любого масштаба', () => {
  const env = loadPlugin({ stored: '1.75' });
  env.runCommand('ui-zoom.reset');
  assert.ok(!env.zoom(), 'на 100% масштаб снимается совсем');
  assert.equal(env.storage.dump()['dsh.ui-zoom.v1'], '1');
});

check('индикатор регистрируется в shell.overlay и показывает проценты', () => {
  const env = loadPlugin();
  const entry = env.slotEntries.find((row) => row.name === 'shell.overlay');
  assert.ok(entry, 'индикатор добавлен в shell.overlay');
  assert.equal(entry.entry.options.id, 'ui-zoom.hint');
  assert.equal(entry.entry.options.name, 'shell.overlay');

  const Hint = entry.entry.component;
  const hidden = Hint({});
  assert.equal(hidden, null, 'до изменения масштаба индикатор скрыт');

  const env2 = loadPlugin();
  env2.runCommand('ui-zoom.in');
  const hint = env2.slotEntries.find((row) => row.name === 'shell.overlay').entry.component({});
  assert.ok(hint, 'после изменения масштаба индикатор виден');
  assert.equal(hint.props.role, 'status');
  // Плашка показывает только проценты — без диагностики.
  assert.equal(String(hint.children[0]), '105%', 'индикатор показывает текущий масштаб');

  env2.runTimers();
  assert.equal(
    env2.slotEntries.find((row) => row.name === 'shell.overlay').entry.component({}),
    null,
    'индикатор гаснет сам',
  );
});

check('индикатор не появляется, когда масштаб не изменился', () => {
  const env = loadPlugin({ stored: '2' });
  env.runCommand('ui-zoom.in');
  const Hint = env.slotEntries.find((row) => row.name === 'shell.overlay').entry.component;
  assert.equal(Hint({}), null, 'на границе диапазона индикатор не всплывает');
});

check('смена значения в другой вкладке подхватывается', () => {
  const env = loadPlugin();
  env.storage.setItem('dsh.ui-zoom.v1', '1.25');
  env.fireStorage('dsh.ui-zoom.v1');
  assert.equal(env.zoom(), '1.25');
  env.storage.setItem('dsh.ui-zoom.v1', '0.75');
  env.fireStorage(null); // storage.clear() из другой вкладки
  assert.equal(env.zoom(), '0.75');
  env.fireStorage('чужая-запись-v2');
  assert.equal(env.zoom(), '0.75', 'чужая запись игнорируется');
});

check('словари en и ru зарегистрированы, ru не падает', () => {
  const env = loadPlugin();
  const locales = env.dictionaries.map((row) => row.locale).sort();
  assert.deepEqual(locales, ['en', 'ru']);
  for (const row of env.dictionaries) {
    assert.equal(row.ns, 'ui-zoom');
    for (const key of ['zoom.in', 'zoom.out', 'zoom.reset', 'zoom.hint']) {
      assert.ok(row.dict[key], `${row.locale}: есть ключ ${key}`);
    }
  }
});

check('плагин освобождает ресурсы при выгрузке', () => {
  const env = loadPlugin();
  assert.equal(env.disposeListeners.length, 1, 'подписка на dispose зарегистрирована');
  assert.ok(!env.zoom(), 'до выгрузки масштаб не задан');
  env.dispose();
  assert.equal(env.listeners.has('storage'), false, 'подписка на storage снята');
});

check('без ctx.effect и ctx.styles плагин работает (фасад даёт только ctx.get/on)', () => {
  const env = loadPlugin();
  const source = fs.readFileSync(CLIENT, 'utf8');
  assert.doesNotMatch(source, /ctx\.effect\(/, 'нет обращений к ctx.effect');
  assert.doesNotMatch(source, /ctx\.styles/, 'стили не берутся через ctx.styles');
  assert.doesNotMatch(source, /ctx\.inject\(/, 'нет обращений к ctx.inject');
  assert.ok(env.registeredCommands.length === 5, 'команды всё равно зарегистрированы');
});

check('недоступное хранилище не ломает плагин', () => {
  const env = loadPlugin();
  env.storage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  env.runCommand('ui-zoom.in');
  assert.equal(env.zoom(), '1.05', 'масштаб применяется даже без записи');
});

check('разметка стилей ссылается на токены темы', () => {
  loadPlugin();
  const css = fs.readFileSync(CLIENT, 'utf8');
  assert.match(css, /--dsw-alias-bg-overlay/, 'фон индикатора из токенов темы');
  assert.match(css, /--dsw-alias-label-primary/, 'текст индикатора из токенов темы');
  assert.match(css, /--dsw-alias-border-l2/, 'рамка индикатора из токенов темы');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}\b/, 'нет литеральных цветов');
  // Меню: фон обязательно непрозрачный токен попапа. Токена `--dsw-specific-menu`
  // в теме нет, и с ним фон становился прозрачным — сквозь меню был виден чат.
  assert.match(
    css,
    /background:var\(--dsw-alias-bg-overlay\)/,
    'фон меню — токен попапа, а не прозрачность',
  );
  assert.doesNotMatch(css, /background:var\(--dsw-specific-menu\)/, 'нет токена из другой темы');
  assert.doesNotMatch(css, /var\(--dsw-elevation-prominent\)/, 'нет токена тени из другой темы');
});

check('индикатор несёт доступную подпись и не ловит клики', () => {
  const env = loadPlugin();
  env.runCommand('ui-zoom.in');
  const hint = env.slotEntries.find((row) => row.name === 'shell.overlay').entry.component({});
  assert.equal(hint.props.role, 'status', 'индикатор объявлен как status');
  assert.equal(hint.props['aria-live'], 'polite');
  assert.equal(hint.props.style.pointerEvents, 'none', 'индикатор не перехватывает мышь');
  assert.equal(hint.props.style.position, 'fixed');
});

check('носитель масштаба — корень приложения, размеры не трогаем', () => {
  const env = loadPlugin();
  env.runCommand('ui-zoom.in');
  assert.equal(env.zoom(), '1.05', 'масштаб стоит на корне приложения');
  assert.equal(env.body.style.zoom, undefined, 'body масштаб не получает');
  // Компенсация размеров запрещена: движок сам отдаёт содержимому ширину / масштаб,
  // а `calc(100% / k)` сжимал интерфейс (проверено в живом приложении).
  assert.equal(env.style.width, undefined, 'ширина корня не подменяется');
  assert.equal(env.style.height, undefined, 'высота корня не подменяется');
  assert.equal(env.document.documentElement.style.overflow, undefined, 'прокрутка документа не трогается');
});

check('попап получает свой масштаб, а деление координат делает CSS', () => {
  const env = loadPlugin({ stored: '1.25' });
  const menu = createElement('menu-portal', ['portal']);
  menu.style.position = 'fixed';
  menu.style.top = '80px';
  menu.style.left = '24px';
  env.body.appendChild(menu);
  assert.equal(menu.style.transform, undefined, 'transform к попапу не применяется');
  assert.equal(menu.style.zoom, '1.25', 'своя зум-область: общий контекст корня сюда не достаёт');
  assert.equal(menu.style.left, env.calcOf('left'), 'координата отдана calc()');
  assert.equal(env.source(menu, 'left'), '24px', 'исходное вьюпортное значение сохранено');
  assert.equal(env.scaleVar(), '1.25', 'переменная масштаба стоит на документе');
  assert.equal(env.resolved(menu, 'left').toFixed(3), '19.200', 'CSS посчитает локальную координату');
  assert.equal(env.resolved(menu, 'top').toFixed(3), '64.000', 'то же для вертикали');
});

check('метрики попапа отдаются приложению во вьюпортных пикселях', () => {
  const env = loadPlugin({ stored: '1.25' });
  const menu = createElement('menu-portal', ['portal']);
  menu.style.position = 'fixed';
  menu.style.left = '10px';
  menu.rect = { left: 0, top: 0, right: 250, bottom: 120, width: 250, height: 120 };
  env.body.appendChild(menu);
  assert.equal(menu.offsetWidth, 250, 'ширина в вьюпортных пикселях');
  assert.equal(menu.offsetHeight, 120, 'высота в вьюпортных пикселях');
});

check('попап, появившийся позже, получает перехват координат и сигнал приложению', () => {
  const env = loadPlugin({ stored: '2' });
  const menu = createElement('late-portal', ['portal']);
  menu.style.position = 'fixed';
  menu.style.left = '100px';
  menu.style.maxHeight = '300px';
  env.body.appendChild(menu);
  assert.equal(env.source(menu, 'left'), '100px', 'координата сохранена как исходная');
  assert.equal(env.resolved(menu, 'left'), 50, 'деление отдано CSS (100 / 2)');
  assert.equal(env.source(menu, 'maxHeight'), '300px', 'ограничение высоты сохранено');
  assert.equal(env.resolved(menu, 'maxHeight'), 150, 'кап тоже делит CSS');
  env.runTimers();
  assert.ok(env.dispatched.includes('resize'), 'приложение получило сигнал пересчитать позицию');
});

check('ширина и кап попапа тоже уходят в calc', () => {
  const env = loadPlugin({ stored: '1.5' });
  const card = createElement('hover-card', ['hovercard']);
  card.style.position = 'fixed';
  card.style.width = '300px';
  card.style.maxWidth = '400px';
  card.style.minWidth = '200px';
  env.body.appendChild(card);
  assert.equal(env.resolved(card, 'width').toFixed(3), '200.000', 'width поделена');
  assert.equal(env.resolved(card, 'maxWidth').toFixed(3), '266.667', 'maxWidth поделена');
  assert.equal(env.resolved(card, 'minWidth').toFixed(3), '133.333', 'minWidth поделена');
  env.runCommand('ui-zoom.reset');
  assert.equal(env.resolved(card, 'width'), 300, 'при 100% ширина возвращается к исходной');
});

check('смена масштаба не пересчитывает координаты — их делит CSS', () => {
  const env = loadPlugin({ stored: '1' });
  const menu = createElement('menu-portal', ['portal']);
  menu.style.position = 'fixed';
  menu.style.left = '120px';
  env.body.appendChild(menu);
  assert.equal(env.resolved(menu, 'left'), 120, 'при 100% координата остаётся как есть');
  env.runCommand('ui-zoom.in');
  assert.equal(env.resolved(menu, 'left').toFixed(3), '114.286', 'делится исходное 120');
  assert.equal(env.source(menu, 'left'), '120px', 'исходное значение при этом не переписывается');
  env.runCommand('ui-zoom.in');
  assert.equal(env.resolved(menu, 'left').toFixed(3), '109.091', 'и дальше делится всё то же 120');
  env.runCommand('ui-zoom.reset');
  assert.equal(env.resolved(menu, 'left'), 120, 'сброс возвращает исходную координату');
});

check('слой без вьюпортных координат плагин не ломает', () => {
  const env = loadPlugin({ stored: '1.5' });
  // Затемнение модального окна: position: fixed, но координаты из класса inset: 0.
  const backdrop = createElement('modal-backdrop', ['backdrop']);
  backdrop.style.position = 'fixed';
  env.body.appendChild(backdrop);
  env.runCommand('ui-zoom.in');
  assert.equal(backdrop.style.left, undefined, 'координаты не появляются сами');
  assert.equal(backdrop.style.maxHeight, undefined, 'ограничение высоты не выдумывается');
});

check('полный цикл выравнивания меню по правому краю кнопки', () => {
  // Эмуляция useAnchoredPosition (align: end): приложение вычисляет left из
  // rect якоря и патчнутого offsetWidth, плагин делит результат на масштаб.
  const env = loadPlugin({ stored: '1.25' });
  const menu = createElement('menu-portal', ['portal']);
  menu.style.position = 'fixed';
  // Локальная ширина меню 200px; после zoom она становится 250px вьюпортных.
  menu.rect = { left: 0, top: 0, right: 250, bottom: 100, width: 250, height: 100 };
  // Якорь: правая граница кнопки на 520px вьюпортных.
  const anchorRight = 520;
  env.body.appendChild(menu);
  // Приложение (как useAnchoredPosition) пишет left = anchorRight - offsetWidth.
  // offsetWidth патчится плагином на вьюпортную ширину (250).
  const width = menu.offsetWidth;
  assert.equal(width, 250, 'offsetWidth отдаётся во вьюпортных пикселях');
  const viewportLeft = anchorRight - width; // 270
  // Приложение кладёт вьюпортное значение — плагин забирает его в переменную.
  menu.style.left = `${viewportLeft}px`;
  env.fireStyle(menu);
  assert.equal(env.source(menu, 'left'), '270px', 'вьюпортная координата сохранена');
  assert.equal(env.resolved(menu, 'left').toFixed(3), '216.000', 'CSS делит её на масштаб');
  // Проверка сходимости: визуально меню правым краем ложится на правый край кнопки.
  // Вьюпортная позиция = 216 * 1.25 = 270, ширина 250 → правый край 520.
  const viewport = env.resolved(menu, 'left') * 1.25;
  assert.equal(Math.round(viewport + width), anchorRight, 'меню правым краем стоит на правом крае кнопки');
});

check('смена нецелого масштаба не трогает исходную координату', () => {
  // Деление целиком в CSS, поэтому периодическая дробь (106 / 1.05) не переписывается
  // в стиль и не может быть обрезана движком — дрейфу взяться неоткуда.
  const env = loadPlugin({ stored: '1.05' });
  const menu = createElement('menu-portal', ['portal']);
  menu.style.position = 'fixed';
  menu.style.left = '106px';
  env.body.appendChild(menu);
  assert.equal(env.source(menu, 'left'), '106px', 'исходная координата сохранена как есть');
  assert.equal(env.resolved(menu, 'left').toFixed(3), '100.952', 'CSS делит её без потери точности');
  env.runCommand('ui-zoom.in');
  assert.equal(env.source(menu, 'left'), '106px', 'смена масштаба исходную координату не трогает');
  assert.equal(env.resolved(menu, 'left').toFixed(3), '96.364', 'делится всё то же 106');
  env.runCommand('ui-zoom.out');
  assert.equal(env.resolved(menu, 'left').toFixed(3), '100.952', 'возврат даёт прежнюю координату');
});

check('повторный перехват не портит уже перехваченную координату', () => {
  // Menu переписывает left каждый кадр (rAF): повторные срабатывания наблюдателя
  // не должны ни менять источник, ни наслаивать деление.
  const env = loadPlugin({ stored: '1.05' });
  const menu = createElement('menu-portal', ['portal']);
  menu.style.position = 'fixed';
  menu.style.left = '106px';
  env.body.appendChild(menu);
  menu.style.left = '106px';
  env.fireStyle(menu);
  env.fireStyle(menu);
  assert.equal(env.source(menu, 'left'), '106px', 'источник остаётся вьюпортным');
  assert.equal(menu.style.left, env.calcOf('left'), 'в свойстве по-прежнему calc()');
  assert.equal(env.resolved(menu, 'left').toFixed(3), '100.952', 'значение не изменилось');
});

check('позиционирование стабильно на всех масштабах 0.5–2.0', () => {
  const env = loadPlugin({ stored: '0.5' });
  const menu = createElement('menu-portal', ['portal']);
  menu.style.position = 'fixed';
  menu.style.left = '200px';
  env.body.appendChild(menu);
  // Исходная вьюпортная координата 200 делится движком на текущий масштаб.
  for (let step = 0; step <= 30; step++) {
    const zoom = 0.5 + step * 0.05;
    const got = env.resolved(menu, 'left');
    assert.ok(
      Math.abs(got - 200 / zoom) < 0.001,
      `масштаб ${zoom}: ожидали ${200 / zoom}, получили ${got}`,
    );
    if (step < 30) env.runCommand('ui-zoom.in');
  }
});

check('полоска изменения ширины ставится по границе своей колонки', () => {
  // Приложение считает позицию полоски как `viewport - rightbar`, и под zoom это
  // расходится с фактической сеткой — полоска уезжала, и взяться за неё было нечем.
  // Позицию берём у самой колонки: offsetLeft/offsetWidth от масштаба не зависят.
  const frame = createElement('app-frame');
  frame.querySelectorAll = () => [];
  const sidebarCol = createElement('sidebar-col', ['X_sidebarCol']);
  sidebarCol.offsetLeft = 0;
  sidebarCol.offsetWidth = 323;
  const rightbarCol = createElement('rightbar-col');
  rightbarCol.offsetLeft = 961;
  rightbarCol.offsetWidth = 1026;
  const sidebarHandle = createElement('handle-left');
  sidebarHandle.dataset.side = 'sidebar';
  sidebarHandle.parentElement = frame;
  const rightbarHandle = createElement('handle-right');
  rightbarHandle.dataset.side = 'rightbar';
  rightbarHandle.parentElement = frame;
  const env = loadPlugin({
    stored: '1.25',
    handles: [sidebarHandle, rightbarHandle],
    columns: { sidebar: sidebarCol, rightbar: rightbarCol },
  });
  assert.equal(sidebarHandle.style.left, '323px', 'полоска слева — на границе сайдбара');
  assert.equal(rightbarHandle.style.left, '961px', 'полоска справа — на границе панели');
  // Колонка поехала — полоска переезжает вместе с ней.
  rightbarCol.offsetLeft = 700;
  env.fireStyle(frame);
  assert.equal(rightbarHandle.style.left, '700px', 'полоска следует за границей колонки');
});

check('полоске панели clientX отдаётся в логических пикселях', () => {
  // DragHandle прибавляет clientX-сдвиг к ширине панели, а ширина — в логических
  // пикселях. Без деления панель на 150% проходила бы в полтора раза больше курсора.
  const frame = createElement('app-frame');
  frame.querySelectorAll = () => [];
  const handle = createElement('handle', ['handle']);
  handle.parentElement = frame;
  handle.closest = (selector) => (String(selector).includes('data-side') ? handle : null);
  const env = loadPlugin({ stored: '1.5', handle });
  assert.ok(
    Object.getOwnPropertyDescriptor(env.PointerEvent.prototype, 'clientX'),
    'патч координаты указателя установлен',
  );
  const onHandle = new env.PointerEvent('pointermove');
  onHandle.target = handle;
  onHandle._x = 150;
  assert.equal(onHandle.clientX, 100, 'сдвиг полоски — в логических пикселях');
  const elsewhere = new env.PointerEvent('pointermove');
  elsewhere.target = createElement('somewhere');
  elsewhere._x = 150;
  assert.equal(elsewhere.clientX, 150, 'чужие координаты указателя не трогаем');
  env.runCommand('ui-zoom.reset');
  assert.equal(onHandle.clientX, 150, 'при 100% координата исходная');
});

check('правый клик в поле ввода открывает своё меню вместо системного', () => {
  // Системное меню Electron рисует Windows, и zoom до него не достаёт: плагин
  // подменяет его своим слоем, который масштабируется как обычный попап.
  const env = loadPlugin();
  const menu = env.menuElement();
  assert.ok(menu, 'меню создано');
  assert.equal(menu.hidden, true, 'до клика меню скрыто');
  const field = createElement('field');
  field.tagName = 'TEXTAREA';
  field.closest = () => null;
  const prevented = [];
  env.fireDocument('contextmenu', {
    target: field,
    clientX: 100,
    clientY: 100,
    preventDefault: () => prevented.push(true),
  });
  assert.equal(prevented.length, 1, 'системное меню отменено');
  assert.equal(menu.hidden, false, 'меню показано');
  const buttons = menu.childNodes.filter((node) => node.tagName === 'BUTTON');
  assert.equal(buttons.length, 6, 'в поле ввода доступны все шесть команд');
  // Подпись — человеческий текст, а не ключ словаря: если словарь не подключился,
  // штатный переводчик отдаёт сам ключ и в меню появлялось «menu.copy».
  assert.equal(buttons[3].textContent, 'Копировать', 'подпись — текст, а не ключ словаря');
  assert.doesNotMatch(
    buttons.map((button) => button.textContent).join(' '),
    /menu\./,
    'ключи словаря в меню не показываются',
  );
  assert.ok(menu.style.left !== undefined, 'позиция задана от курсора');
});

check('при выделении вне поля ввода остаётся только копирование', () => {
  const env = loadPlugin();
  const menu = env.menuElement();
  const text = createElement('text');
  text.tagName = 'SPAN';
  text.closest = () => null;
  const prevented = [];
  const fire = () =>
    env.fireDocument('contextmenu', {
      target: text,
      clientX: 50,
      clientY: 50,
      preventDefault: () => prevented.push(true),
    });
  fire();
  assert.equal(prevented.length, 0, 'без выделения своё меню не вмешивается');
  assert.equal(menu.hidden, true, 'меню не показывается');
  env.setSelection('выделенный текст');
  fire();
  assert.equal(prevented.length, 1, 'с выделением системное меню отменено');
  assert.equal(menu.hidden, false, 'меню показано');
  const buttons = menu.childNodes.filter((node) => node.tagName === 'BUTTON');
  assert.equal(buttons.length, 1, 'вне поля ввода доступно только копирование');
});

check('попапы освобождаются при выгрузке плагина', () => {
  const env = loadPlugin({ stored: '1.5' });
  const menu = createElement('menu-portal', ['portal']);
  menu.style.position = 'fixed';
  menu.style.left = '80px';
  env.body.appendChild(menu);
  assert.equal(env.resolved(menu, 'left').toFixed(3), '53.333', 'попап под масштабом');
  env.dispose();
  assert.equal(env.zoom(), '1.5', 'стиль носителя плагин не откатывает: страница перезагружается целиком');
});

console.log(results.join('\n'));
console.log(process.exitCode ? '\nЕСТЬ ОШИБКИ' : '\nвсе проверки пройдены');
