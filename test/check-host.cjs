/**
 * Проверка хост-половины dsh-tweaks: `index.js` поднимает и снимает хост-часть
 * твика «распознавание русской речи» по volatile-флагам схемы Config.
 *
 * Тест идёт без установки DSH: `@deepseek-ai/schemastery` подменяется заглушкой
 * через `module.registerHooks`, а хост-часть берётся настоящая
 * (`tweaks/whisper-host.js`). Python-воркер не запускается: провайдер только
 * регистрируется в реестре `speechToText`, модель весов не грузится.
 *
 * Контракт самого `index.js` (какие значения и в каком порядке уходят в
 * `activate`/`deactivate`) проверяется на копии пакета со стабом хост-части:
 * через `register()` фасад провайдера не виден, а стаб видит всё.
 *
 * Здесь же проверяется разовая настройка распознавания: при первом включении
 * твик зовёт `speechToText.configure({ providerId: 'whisper-local', language: 'ru' })`,
 * сохраняет признак в своё volatile-поле схемы и больше выбор не переписывает;
 * падение `configure` и отсутствие службы твик не роняют.
 *
 * Запуск: node test/check-host.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');

const INDEX = path.join(__dirname, '..', 'index.js');

if (typeof registerHooks !== 'function') {
  // Заглушку схемы иначе не подставить, а без неё index.js не загрузится:
  // @deepseek-ai/schemastery живёт в установке DSH, не в этой папке.
  console.log('check-host: пропущено — нужен Node с module.registerHooks (22.15+)');
  process.exit(0);
}

/**
 * Заглушка `@deepseek-ai/schemastery`: схема, по которой видно объявленные поля.
 * Нужна только чтобы index.js загрузился без установки DSH; поведение DSH
 * (volatile-ссылки в конфигурации) тест изображает сам.
 */
const SCHEMA_STUB = `
class Field {
  constructor(type, options) { this.type = type; this.options = options; }
  default(value) { return new Field(this.type, { ...this.options, default: value }); }
  volatile() { return new Field(this.type, { ...this.options, volatile: true }); }
}
export default {
  object(dict) { return new Field('object', { dict }); },
  boolean() { return new Field('boolean', {}); },
  union(values) { return new Field('union', { values }); },
};
`;

/** Стаб хост-части: записывает вызовы туда, откуда их видит тест. */
const HOST_STUB = `
globalThis.__whisperStubCalls = globalThis.__whisperStubCalls ?? [];
export function activate(ctx, config) {
  globalThis.__whisperStubCalls.push({ kind: 'activate', config });
}
export async function deactivate() {
  globalThis.__whisperStubCalls.push({ kind: 'deactivate' });
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: `data:text/javascript,${encodeURIComponent(SCHEMA_STUB)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

/**
 * Ссылка Volatile, как её отдаёт DSH: значение читается через `get()`.
 * @param {unknown} value - начальное значение.
 * @returns {object} ссылка с чтением и подменой значения.
 */
function volatileRef(value) {
  let current = value;
  return {
    get: () => current,
    set: (next) => {
      current = next;
    },
  };
}

/**
 * Заглушка хост-контекста плагина: реестр speechToText, выбор провайдера и языка,
 * служба настроек, логгер, события, effect.
 * @param {object} [options] - что именно есть в сборке.
 * @param {boolean} [options.speechToText] - отдавать ли службу распознавания.
 * @param {boolean} [options.settings] - отдавать ли службу настроек.
 * @param {string} [options.entryId] - id записи пакета в профиле.
 * @param {Error | null} [options.configureError] - ошибка, которой падает configure.
 * @returns {object} контекст, у которого видны регистрации, выбор, записи и логи.
 */
function createContext(options = {}) {
  const text = (value) => (typeof value === 'string' ? value : String(value?.message ?? value));
  const listeners = new Map();
  const cleanups = [];
  const registered = [];
  const unregistered = [];
  const logs = [];
  /** Вызовы `speechToText.configure`: что именно выставил твик. */
  const selections = [];
  /** Записи в своё поле схемы: namespace и патч. */
  const settingsUpdates = [];
  const withSpeech = options.speechToText !== false;
  const withSettings = options.settings !== false;
  const entryId = options.entryId === undefined ? 'zoom' : options.entryId;
  const configureError = options.configureError ?? null;
  const speechFace = {
    registered,
    unregistered,
    register(provider) {
      registered.push(provider);
      return async () => {
        unregistered.push(provider);
      };
    },
    async configure(patch) {
      selections.push(patch);
      if (configureError !== null) throw configureError;
    },
  };
  const settingsFace = {
    async update(ns, patch) {
      settingsUpdates.push({ ns, patch });
    },
  };
  return {
    registered,
    unregistered,
    logs,
    selections,
    settingsUpdates,
    fiber: { entry: { options: { id: entryId } } },
    logger: {
      info: (message) => logs.push(`info: ${text(message)}`),
      warn: (message) => logs.push(`warn: ${text(message)}`),
      error: (message) => logs.push(`error: ${text(message)}`),
      debug: (message) => logs.push(`debug: ${text(message)}`),
    },
    speechToText: withSpeech ? speechFace : undefined,
    get(name) {
      if (name === 'speechToText') return withSpeech ? speechFace : undefined;
      if (name === 'settings') return withSettings ? settingsFace : undefined;
      return undefined;
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return () => {};
    },
    /** Отправить событие, как это делает DSH при смене volatile-полей. */
    emit(event) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
    /** Выгрузить плагин: DSH зовёт очистку, зарегистрированную через effect. */
    async dispose() {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    },
  };
}

/** Дать очереди микро- и макрозадач твика дойти до конца. */
async function settle() {
  for (let step = 0; step < 12; step += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Разложить копию пакета во временной папке: `index.js` плюс необязательная
 * хост-часть. Так проверяются и контракт вызовов, и пропажа модуля.
 * @param {string | null} hostSource - исходник `tweaks/whisper-host.js` либо null.
 * @returns {string} путь к папке копии.
 */
function makePackageCopy(hostSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tweaks-host-'));
  fs.copyFileSync(INDEX, path.join(dir, 'index.js'));
  if (hostSource !== null) {
    fs.mkdirSync(path.join(dir, 'tweaks'));
    fs.writeFileSync(path.join(dir, 'tweaks', 'whisper-host.js'), hostSource);
  }
  return dir;
}

async function main() {
  const index = await import(pathToFileURL(INDEX).href);

  // 1) Схема знает оба поля твика, и оба они volatile.
  const dict = index.Config.options.dict;
  assert.ok(dict.whisper, 'в схеме Config есть поле whisper');
  assert.equal(dict.whisper.options.default, false, 'whisper по умолчанию выключен');
  assert.equal(dict.whisper.options.volatile, true, 'whisper — volatile-поле');
  assert.deepEqual(
    dict.whisperModel.options.values,
    ['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'],
    'whisperModel — перечисление размеров модели',
  );
  assert.equal(dict.whisperModel.options.default, 'medium', 'размер модели по умолчанию — medium');
  assert.equal(dict.whisperModel.options.volatile, true, 'whisperModel — volatile-поле');
  // Служебный признак «провайдер и язык уже выставлены»: живёт в своей схеме,
  // а не в чужой записи профиля. Форма галочек строится из реестра TWEAKS
  // (client.js), поэтому лишнего переключателя от этого поля не появляется.
  assert.ok(dict.whisperSelectionApplied, 'в схеме Config есть служебное поле whisperSelectionApplied');
  assert.equal(dict.whisperSelectionApplied.options.default, false, 'признак по умолчанию снят');
  assert.equal(dict.whisperSelectionApplied.options.volatile, true, 'признак — volatile-поле');

  // 2) Флаг снят: хост-часть даже не импортируется.
  const idle = createContext();
  index.apply(idle, { whisper: volatileRef(false), whisperModel: volatileRef('medium') });
  await settle();
  assert.equal(idle.registered.length, 0, 'без флага провайдер не регистрируется');
  assert.deepEqual(idle.logs, [], 'без флага ничего не логируется');

  // 3) Флаг включён: настоящая хост-часть поднимает провайдера.
  const live = createContext();
  const liveConfig = { whisper: volatileRef(false), whisperModel: volatileRef('small') };
  index.apply(live, liveConfig);
  await settle();
  assert.equal(live.registered.length, 0, 'до флага твик спит');

  liveConfig.whisper.set(true);
  live.emit('loader/volatile-update');
  await settle();
  assert.equal(live.registered.length, 1, 'флаг поднял хост-часть');
  assert.equal(live.registered[0].info.id, 'whisper-local', 'зарегистрирован провайдер whisper-local');
  assert.ok(live.registered[0].info.languages.includes('ru'), 'русский есть в списке языков');

  // 4) Повторное событие без изменений ничего не перерегистрирует.
  live.emit('loader/volatile-update');
  await settle();
  assert.equal(live.registered.length, 1, 'повторное событие идемпотентно');

  // 5) Смена модели перезапускает хост-часть целиком.
  liveConfig.whisperModel.set('large-v3');
  live.emit('loader/volatile-update');
  await settle();
  assert.equal(live.unregistered.length, 1, 'старый провайдер снят');
  assert.equal(live.registered.length, 2, 'провайдер поднят заново');

  // 6) Выключение флага останавливает твик.
  liveConfig.whisper.set(false);
  live.emit('loader/volatile-update');
  await settle();
  assert.equal(live.unregistered.length, 2, 'флаг снял провайдера');
  assert.equal(live.registered.length, 2, 'новых регистраций нет');

  // 7) Повторное включение после выключения работает.
  liveConfig.whisper.set(true);
  live.emit('loader/volatile-update');
  await settle();
  assert.equal(live.registered.length, 3, 'твик включается снова');

  // 8) Выгрузка плагина снимает провайдера (воркер не переживает твик).
  await live.dispose();
  await settle();
  assert.equal(live.unregistered.length, 3, 'выгрузка остановила хост-часть');

  // 9) Контракт вызовов: хост-часть получает обычные значения, а не ссылки Volatile.
  const contractDir = makePackageCopy(HOST_STUB);
  try {
    globalThis.__whisperStubCalls = [];
    const contract = await import(pathToFileURL(path.join(contractDir, 'index.js')).href);
    const ctx = createContext();
    const config = { whisper: volatileRef(false), whisperModel: volatileRef('small') };
    contract.apply(ctx, config);
    await settle();
    assert.deepEqual(globalThis.__whisperStubCalls, [], 'до флага вызовов нет');

    config.whisper.set(true);
    ctx.emit('loader/volatile-update');
    await settle();
    assert.deepEqual(
      globalThis.__whisperStubCalls.map((call) => call.kind),
      ['activate'],
      'включение — ровно один activate',
    );
    const first = globalThis.__whisperStubCalls[0].config;
    assert.equal(first.whisperModel, 'small', 'размер модели ушёл в activate');
    assert.equal(typeof first.whisperModel, 'string', 'значение развёрнуто из ссылки Volatile, а не отдано ссылкой');
    assert.equal(first.whisper, true, 'флаг ушёл в activate значением');

    config.whisperModel.set('tiny');
    ctx.emit('loader/volatile-update');
    await settle();
    assert.deepEqual(
      globalThis.__whisperStubCalls.map((call) => call.kind),
      ['activate', 'deactivate', 'activate'],
      'смена модели — deactivate и следом activate',
    );
    assert.equal(globalThis.__whisperStubCalls[2].config.whisperModel, 'tiny', 'новая модель ушла в activate');

    config.whisper.set(false);
    ctx.emit('loader/volatile-update');
    await settle();
    assert.deepEqual(
      globalThis.__whisperStubCalls.map((call) => call.kind),
      ['activate', 'deactivate', 'activate', 'deactivate'],
      'выключение — ровно один deactivate',
    );
  } finally {
    fs.rmSync(contractDir, { recursive: true, force: true });
  }

  // 10) Модуля хост-части нет: плагин не падает, причина уходит в лог.
  const brokenDir = makePackageCopy(null);
  try {
    const broken = await import(pathToFileURL(path.join(brokenDir, 'index.js')).href);
    const missing = createContext();
    broken.apply(missing, { whisper: true, whisperModel: 'medium' });
    await settle();
    assert.equal(missing.registered.length, 0, 'провайдер не зарегистрирован');
    assert.ok(
      missing.logs.some((line) => line.includes('недоступна')),
      `причина записана в лог (${missing.logs.join(' | ')})`,
    );
    // Схема и повторные события переживают пропажу файла.
    missing.emit('loader/volatile-update');
    await settle();
    assert.equal(missing.registered.length, 0, 'повторное событие не роняет плагин');
  } finally {
    fs.rmSync(brokenDir, { recursive: true, force: true });
  }

  // 11) Первое включение: провайдер и язык выставляются ровно один раз, признак
  // записывается в своё поле схемы (а не в чужую запись и не в файл).
  const first = createContext();
  const firstConfig = { whisper: volatileRef(true), whisperModel: volatileRef('small') };
  index.apply(first, firstConfig);
  await settle();
  assert.equal(first.registered.length, 1, 'провайдер поднят');
  assert.deepEqual(
    first.selections,
    [{ providerId: 'whisper-local', language: 'ru' }],
    'при первом включении выбор выставлен один раз',
  );
  assert.deepEqual(
    first.settingsUpdates,
    [{ ns: 'zoom', patch: { whisperSelectionApplied: true } }],
    'признак сохранён в своё поле схемы Config',
  );

  // Переактивация (смена модели) и повторное включение признак уже видят.
  firstConfig.whisperModel.set('tiny');
  first.emit('loader/volatile-update');
  await settle();
  assert.equal(first.selections.length, 1, 'переактивация выбор не переписывает');
  assert.equal(first.settingsUpdates.length, 1, 'и признак повторно не пишется');
  // Реальная хост-часть держит провайдера в модуле на весь процесс: отпускаем
  // её, иначе следующие песочницы не зарегистрируют своего провайдера.
  await first.dispose();
  await settle();

  // 12) Признак уже стоит: второй запуск выбор не трогает — ручную правку
  // пользователя (провайдер или язык) мы больше не перезаписываем.
  const second = createContext();
  index.apply(second, { whisper: true, whisperModel: 'medium', whisperSelectionApplied: true });
  await settle();
  assert.equal(second.registered.length, 1, 'провайдер поднят по флагу');
  assert.deepEqual(second.selections, [], 'с выставленным признаком configure не зовётся');
  assert.deepEqual(second.settingsUpdates, [], 'и признак повторно не записывается');
  await second.dispose();
  await settle();

  // 13) configure падает: твик продолжает работать, признак не ставится —
  // значит, при следующем включении попробуем снова.
  const failing = createContext({ configureError: new Error('Speech provider is unavailable: whisper-local') });
  const failingConfig = { whisper: volatileRef(true), whisperModel: volatileRef('small') };
  index.apply(failing, failingConfig);
  await settle();
  assert.equal(failing.registered.length, 1, 'провайдер остался поднят: твик работает');
  assert.equal(failing.selections.length, 1, 'попытка выставить выбор была');
  assert.deepEqual(failing.settingsUpdates, [], 'упавший configure признак не ставит');
  assert.ok(
    failing.logs.some((line) => line.includes('распознавания')),
    `причина записана в лог (${failing.logs.join(' | ')})`,
  );
  failingConfig.whisperModel.set('medium');
  failing.emit('loader/volatile-update');
  await settle();
  assert.equal(failing.selections.length, 2, 'при следующем включении попытка повторяется');
  await failing.dispose();
  await settle();

  // 14) Службы распознавания нет вовсе: плагин не падает, причина в логе,
  // признак не выставляется.
  const noSpeechDir = makePackageCopy(HOST_STUB);
  try {
    globalThis.__whisperStubCalls = [];
    const noSpeechModule = await import(pathToFileURL(path.join(noSpeechDir, 'index.js')).href);
    const noSpeech = createContext({ speechToText: false });
    noSpeechModule.apply(noSpeech, { whisper: true, whisperModel: 'medium' });
    await settle();
    assert.deepEqual(
      globalThis.__whisperStubCalls.map((call) => call.kind),
      ['activate'],
      'хост-часть поднята, падения нет',
    );
    assert.ok(
      noSpeech.logs.some((line) => line.includes('speechToText')),
      `причина записана в лог (${noSpeech.logs.join(' | ')})`,
    );
    assert.deepEqual(noSpeech.settingsUpdates, [], 'признак не выставлен');
    noSpeech.emit('loader/volatile-update');
    await settle();
    assert.equal(noSpeech.registered.length, 0, 'повторное событие не роняет плагин');
  } finally {
    fs.rmSync(noSpeechDir, { recursive: true, force: true });
  }

  console.log('check-host: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
