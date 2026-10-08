/**
 * Хост-половина бандла dsh-tweaks: схема флагов твиков и подключение
 * хост-частей твиков.
 *
 * Поля помечены `volatile()` — только такие DSH показывает в настройках и
 * принимает на запись. Смена одних лишь volatile-полей не перезапускает
 * плагин: DSH компилирует новые значения в уже выданную конфигурацию и шлёт
 * владельцу записи событие `loader/volatile-update`, поэтому хост-часть твика
 * включается, выключается и переактивируется по этому событию.
 *
 * Значения volatile-полей приходят в `apply` ссылками `Volatile` (значение
 * читается через `.get()`). Хост-часть получает уже развёрнутую копию
 * конфигурации обычными значениями: свой файл твика ничего о ссылках не знает.
 *
 * `@deepseek-ai/schemastery` лежит в установке DSH, а не в нашей папке.
 * Резолвер профиля отдаёт его копию из дистрибутива плагинам, объявившим
 * пакет в peerDependencies, — отдельная установка не нужна.
 */
import Schema from '@deepseek-ai/schemastery';

/**
 * Флаги твиков: имя поля — id твика в реестре TWEAKS (client.js).
 * `default(true)` сохраняет поведение пакета до появления флагов.
 */
export const Config = Schema.object({
  zoom: Schema.boolean().default(true).volatile(),
  contextMenu: Schema.boolean().default(true).volatile(),
  // Речь — тяжёлый твик: он поднимает Python-воркер и качает модель весов,
  // поэтому по умолчанию выключен и включается только галочкой.
  whisper: Schema.boolean().default(false).volatile(),
  whisperModel: Schema.union(['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'])
    .default('medium')
    .volatile(),
  // Служебное поле, а не твик: признак «провайдер и язык распознавания уже
  // выставлены». Галочки у него нет — форма строится из реестра TWEAKS
  // (client.js), а не из схемы. Хранить признак в чужой записи профиля или в
  // файле нельзя: это наша настройка, и её видно в нашем же снимке конфигурации.
  whisperSelectionApplied: Schema.boolean().default(false).volatile(),
});

/** Модуль хост-части твика «речь»: путь относительно нашего index.js. */
const WHISPER_HOST = './tweaks/whisper-host.js';
/** Размеры модели из схемы Config; всё прочее сводится к размеру по умолчанию. */
const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'];
const WHISPER_DEFAULT_MODEL = 'medium';
/** Провайдер распознавания, который твик «речь» ставит выбором по умолчанию. */
const WHISPER_PROVIDER_ID = 'whisper-local';
/** Язык, который твик «речь» ставит выбором по умолчанию. */
const WHISPER_LANGUAGE = 'ru';
/** Имя служебного поля схемы: «провайдер и язык уже выставлены». */
const SELECTION_FIELD = 'whisperSelectionApplied';

/**
 * Значение поля конфигурации.
 *
 * Volatile-поля DSH отдаёт ссылкой с методом `get()`, обычные — как есть.
 * @param {unknown} value - значение поля из конфигурации.
 * @param {unknown} fallback - что вернуть, если значения нет.
 * @returns {unknown} развёрнутое значение.
 */
function unwrap(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object' && typeof value.get === 'function') {
    try {
      const inner = value.get();
      return inner === undefined || inner === null ? fallback : inner;
    } catch (_error) {
      return fallback;
    }
  }
  return value;
}

/**
 * Копия конфигурации из обычных значений: ссылки Volatile развёрнуты.
 * @param {unknown} config - конфигурация записи из DSH.
 * @returns {object} конфигурация без ссылок.
 */
function flatten(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const plain = {};
  for (const key of Object.keys(source)) plain[key] = unwrap(source[key], source[key]);
  return plain;
}

/**
 * Размер модели из конфигурации: неизвестное значение сводится к дефолту схемы.
 * @param {unknown} value - значение поля `whisperModel`.
 * @returns {string} допустимый размер модели.
 */
function normalizeModel(value) {
  return typeof value === 'string' && WHISPER_MODELS.includes(value) ? value : WHISPER_DEFAULT_MODEL;
}

/**
 * Записать предупреждение в лог DSH; без логгера — в консоль.
 * @param {object} ctx - хост-контекст плагина.
 * @param {string} message - текст предупреждения.
 * @param {unknown} [error] - причина, если есть.
 * @returns {void}
 */
function warn(ctx, message, error) {
  try {
    const logger = ctx?.logger;
    if (typeof logger?.warn === 'function') {
      logger.warn(message);
      if (error !== undefined) logger.warn(error);
      return;
    }
  } catch (_error) {
    /* логгер сломан: сообщение уйдёт в консоль */
  }
  if (error === undefined) console.warn(message);
  else console.warn(message, error);
}

/**
 * Служба распознавания речи (`ctx.speechToText`), если она есть в сборке.
 *
 * Сервиса может не быть вовсе: пакет `speech-to-text` — отдельный плагин, и без
 * него распознавание живёт только в нашей хост-части. Свойство контекста на
 * незарегистрированной службе может бросить, поэтому оба способа доступа —
 * свойство и `ctx.get` — под защитой.
 * @param {object} ctx - хост-контекст плагина.
 * @returns {object | null} служба распознавания либо null.
 */
function speechService(ctx) {
  try {
    const direct = ctx?.speechToText;
    if (typeof direct?.configure === 'function') return direct;
  } catch (_error) {
    /* службы нет: свойство контекста бросило */
  }
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('speechToText') : undefined;
    if (typeof viaGet?.configure === 'function') return viaGet;
  } catch (_error) {
    /* службы нет и через ctx.get */
  }
  return null;
}

/**
 * Записать признак «провайдер и язык выставлены» в своё поле схемы Config.
 *
 * Поле volatile, а ссылка `Volatile` доступна плагину только на чтение, поэтому
 * значение сохраняется штатной службой настроек — она пишет в запись профиля
 * нашего же пакета (`ctx.fiber.entry.options.id`), а не в чужую. Службы может не
 * быть (плагин поднят без Loader) — тогда признак не сохранить, и об этом
 * сообщается в лог.
 * @param {object} ctx - хост-контекст плагина.
 * @param {boolean} value - новое значение признака.
 * @returns {Promise<boolean>} удалось ли сохранить признак.
 */
async function persistSelection(ctx, value) {
  const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined;
  const entryId = ctx?.fiber?.entry?.options?.id;
  if (typeof settings?.update !== 'function' || typeof entryId !== 'string' || entryId === '') {
    warn(ctx, 'dsh-tweaks: служба настроек недоступна — признак «провайдер и язык распознавания выставлены» не сохранён');
    return false;
  }
  await settings.update(entryId, { [SELECTION_FIELD]: value });
  return true;
}

/**
 * Подключить хост-часть твика «распознавание русской речи».
 *
 * Модуль твика — отдельный файл, которого может не быть (другая ветка,
 * неполная поставка), поэтому импорт динамический и в try/catch: пропажа
 * файла не должна ронять ни схему Config, ни остальные твики.
 * @param {object} ctx - хост-контекст плагина.
 * @param {unknown} config - конфигурация записи (volatile-поля — ссылки).
 * @returns {void}
 */
function attachWhisper(ctx, config) {
  /** Загруженный модуль хост-части; null, пока он не загружен. */
  let host = null;
  /** Поднята ли хост-часть прямо сейчас. */
  let enabled = false;
  /** Размер модели, с которым хост-часть поднята. */
  let model = '';
  /** Очередь переключений: activate и deactivate не накладываются друг на друга. */
  let queue = Promise.resolve();
  /** Признак «выбор уже выставлен в этой сессии» — до того, как его вернёт конфигурация. */
  let selectionApplied = false;
  /** Идёт попытка выставить выбор прямо сейчас. */
  let selecting = false;

  /**
   * Загрузить модуль хост-части.
   * @returns {Promise<object | null>} модуль либо null, если он недоступен.
   */
  async function ensureHost() {
    if (host !== null) return host;
    try {
      host = await import(WHISPER_HOST);
      return host;
    } catch (error) {
      host = null;
      warn(ctx, `dsh-tweaks: хост-часть твика «речь» (${WHISPER_HOST}) недоступна, твик остаётся выключенным`, error);
      return null;
    }
  }

  /**
   * Отпустить ресурсы хост-части.
   * @param {object} module - загруженный модуль твика.
   * @returns {Promise<void>}
   */
  async function release(module) {
    if (typeof module?.deactivate !== 'function') return;
    try {
      await module.deactivate();
    } catch (error) {
      warn(ctx, 'dsh-tweaks: хост-часть твика «речь» не выключилась до конца', error);
    }
  }

  /**
   * Выставить провайдера и язык распознавания при первом включении твика.
   *
   * Порядок обязателен: провайдера `whisper-local` регистрирует `activate`,
   * а `configure` сверяет язык со списком языков уже зарегистрированного
   * провайдера и падает, если того нет. Признак «уже выставляли» живёт в нашем
   * поле схемы Config, поэтому пользовательскую правку выбора мы больше не
   * перезаписываем: если владелец потом сменил провайдера или язык руками,
   * `configure` не зовётся.
   *
   * Ошибка не роняет твик: `configure` пишет в чужую запись профиля и может
   * упасть (нет плагина распознавания, язык не поддержан, нет службы настроек),
   * поэтому всё под `try/catch`, а причина уходит в лог. При падении признак не
   * ставится — попробуем при следующем включении.
   * @param {object} plain - конфигурация из обычных значений.
   * @returns {Promise<void>}
   */
  async function ensureSelection(plain) {
    if (selectionApplied || plain[SELECTION_FIELD] === true || selecting) return;
    selecting = true;
    try {
      const speech = speechService(ctx);
      if (speech === null) {
        warn(ctx, 'dsh-tweaks: служба распознавания речи (speechToText) недоступна — провайдер и язык не выставлены');
        return;
      }
      await speech.configure({ providerId: WHISPER_PROVIDER_ID, language: WHISPER_LANGUAGE });
      // Выбор выставлен: дальше его не трогаем даже при переактивации твика.
      selectionApplied = true;
      try {
        await persistSelection(ctx, true);
      } catch (error) {
        // Выбор уже применён и записан самим `configure`; не сохранился только
        // наш признак — значит, после перезапуска попробуем ещё раз.
        warn(ctx, 'dsh-tweaks: признак «провайдер и язык распознавания выставлены» не сохранён', error);
      }
    } catch (error) {
      warn(ctx, 'dsh-tweaks: не удалось выставить провайдера и язык распознавания', error);
    } finally {
      selecting = false;
    }
  }

  /**
   * Включить хост-часть с заданным размером модели.
   * @param {object} plain - конфигурация из обычных значений.
   * @param {string} nextModel - размер модели.
   * @returns {Promise<void>}
   */
  async function start(plain, nextModel) {
    const module = await ensureHost();
    if (module === null) return;
    if (typeof module.activate !== 'function') {
      warn(ctx, `dsh-tweaks: в хост-части твика «речь» (${WHISPER_HOST}) нет activate`);
      return;
    }
    try {
      await module.activate(ctx, { ...plain, whisperModel: nextModel });
      enabled = true;
      model = nextModel;
    } catch (error) {
      // Часть ресурсов activate мог успеть занять: снимаем их, чтобы повторное
      // включение поднимало твик с чистого листа.
      warn(ctx, 'dsh-tweaks: твик «речь» не включился', error);
      await release(module);
      enabled = false;
      model = '';
      return;
    }
    // Выбор провайдера и языка — только после регистрации провайдера.
    await ensureSelection(plain);
  }

  /** Выключить хост-часть. @returns {Promise<void>} */
  async function stop() {
    const module = host;
    enabled = false;
    model = '';
    if (module !== null) await release(module);
  }

  /**
   * Привести хост-часть в соответствие флагам.
   * @returns {Promise<void>}
   */
  async function sync() {
    const plain = flatten(config);
    if (plain.whisper !== true) {
      if (enabled) await stop();
      return;
    }
    const nextModel = normalizeModel(plain.whisperModel);
    if (!enabled) {
      await start(plain, nextModel);
      return;
    }
    if (model !== nextModel) {
      // Размер модели провайдер читает один раз при регистрации, поэтому смена
      // значения — это перезапуск хост-части целиком.
      await stop();
      await start(plain, nextModel);
    }
  }

  /** Поставить переключение в очередь, не роняя его ошибкой. */
  function schedule() {
    queue = queue.then(sync).catch((error) => {
      warn(ctx, 'dsh-tweaks: переключение твика «речь» прервано', error);
    });
  }

  schedule();
  // Смена только volatile-полей не перезапускает плагин: DSH шлёт это событие
  // владельцу записи, и по нему хост-часть подхватывает новые значения.
  if (typeof ctx.on === 'function') ctx.on('loader/volatile-update', () => schedule());
  // Выгрузка плагина обязана остановить Python-воркер: иначе он переживёт твик.
  const dispose = () => {
    queue = queue
      .then(() => (enabled ? stop() : undefined))
      .catch((error) => {
        warn(ctx, 'dsh-tweaks: твик «речь» не остановлен при выгрузке', error);
      });
    // Промис возвращается намеренно: выгрузка ждёт, пока воркер отпустит ресурсы.
    return queue;
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
  else if (typeof ctx.on === 'function') ctx.on('dispose', dispose);
}

/**
 * Хост-половина бандла: твики интерфейса живут в браузере, а у твика «речь»
 * есть хост-часть — её поднимает и снимает этот apply по флагу `whisper`.
 * @param {object} ctx - хост-контекст плагина.
 * @param {unknown} config - конфигурация записи из DSH.
 * @returns {void}
 */
export function apply(ctx, config) {
  attachWhisper(ctx, config);
}
