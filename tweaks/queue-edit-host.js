/**
 * Хост-половина редактора очереди: один POST-роут, который меняет pending
 * сообщение **на месте** и сохраняет вложения.
 *
 * Зачем свой роут: штатный `session/updateQueue` принимает при edit только
 * текстовые блоки и заменяет content целиком — приложение поэтому отключает
 * карандаш у строк с файлами/картинками. Здесь мы:
 *  1) резолвим agent и pending item (nextTurn/nextStep);
 *  2) сохраняем новые вложения через `ctx.attachments` (saveImages/saveFile);
 *  3) старые durable-ссылки оставляем как есть, но только если они реально
 *     присутствуют в текущем content (иначе клиент мог бы подставить чужую);
 *  4) заменяем сообщение через `agent.inbox.replace` — позиция в очереди
 *     сохраняется, остальные элементы не трогаются.
 *
 * Роут закрыт штатным connection-фильтром (host/origin/cookie) и проверяет
 * размеры тела; никаких DSH-пакетов не импортируем, чтобы модуль жил вне
 * установки Harness.
 */

/** Путь роута; клиент запрашивает его документ-относительно. */
export const QUEUE_EDIT_PATH = '/dsh-tweaks/queue/edit';

/** Общий лимит JSON-тела; файлы внутри — отдельным лимитом. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Лимит одного нового файла/картинки после base64-декодирования. */
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/** Сколько вложений разрешаем в одной форме. */
const MAX_ATTACHMENTS = 24;
/** Типы картинок, которые принимает attachment-store. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Ответ JSON без кеширования.
 * @param {object} res - ответ Node.
 * @param {number} status - HTTP-статус.
 * @param {object} payload - тело.
 * @returns {void}
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Прочитать тело запроса с жёстким лимитом.
 * @param {object} req - запрос Node.
 * @param {number} [limit] - предел в байтах.
 * @returns {Promise<string | null>} текст либо null, если превышен лимит.
 */
function readBoundedBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Рекурсивно заморозить content, как это делает inbox-слой для сообщений.
 * @param {unknown} value - значение.
 * @returns {unknown} замороженное значение.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** Ключ durable-ссылки, по которому сверяем existing-вложения. */
function attachmentKey(attachment) {
  if (attachment === null || typeof attachment !== 'object') return '';
  return typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '';
}

/** Все durable-ссылки текущего content: тип + id. */
function existingKeys(content) {
  const keys = new Map();
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type !== 'image' && block?.type !== 'file') continue;
    const key = attachmentKey(block.attachment);
    if (key !== '') keys.set(`${block.type}:${key}`, block.attachment);
  }
  return keys;
}

/**
 * Проверить строковое поле.
 * @param {unknown} value - значение.
 * @param {number} max - максимальная длина.
 * @returns {string | null} строка либо null.
 */
function stringField(value, max) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/**
 * Разобрать и проверить JSON-запрос.
 * @param {unknown} value - распарсенное тело.
 * @returns {object | {error: string}} нормализованный запрос либо ошибка.
 */
export function parseQueueEdit(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: 'body must be an object' };
  const sessionId = stringField(value.sessionId, 512);
  const itemId = stringField(value.itemId, 512);
  if (sessionId === null || sessionId === '' || itemId === null || itemId === '') return { error: 'sessionId/itemId required' };
  const text = typeof value.text === 'string' ? value.text : '';
  if (text.length > 200000) return { error: 'text too long' };
  const list = Array.isArray(value.attachments) ? value.attachments : [];
  if (list.length > MAX_ATTACHMENTS) return { error: 'too many attachments' };
  const attachments = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') return { error: 'bad attachment' };
    if (raw.kind === 'existing') {
      if (raw.type !== 'image' && raw.type !== 'file') return { error: 'bad existing attachment type' };
      const ref = raw.attachment;
      if (attachmentKey(ref) === '') return { error: 'bad existing attachment ref' };
      attachments.push({ kind: 'existing', type: raw.type, attachment: ref });
      continue;
    }
    if (raw.kind !== 'new') return { error: 'bad attachment kind' };
    if (raw.type !== 'image' && raw.type !== 'file') return { error: 'bad new attachment type' };
    const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name.slice(0, 255) : undefined;
    const data = typeof raw.data === 'string' ? raw.data : null;
    if (data === null || data === '') return { error: 'attachment data required' };
    if (raw.type === 'image') {
      if (typeof raw.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(raw.mediaType)) return { error: 'unsupported image media type' };
      attachments.push({ kind: 'new', type: 'image', mediaType: raw.mediaType, name, data });
    } else {
      attachments.push({ kind: 'new', type: 'file', name, data });
    }
  }
  if (text.trim() === '' && attachments.length === 0) return { error: 'empty message' };
  return { sessionId, itemId, text, attachments };
}

/**
 * Собрать content из текста и вложений; новые сохраняются заранее.
 * @param {object} scope - контекст с attachments/sessionController.
 * @param {object} request - нормализованный запрос.
 * @param {object} message - текущий inbox-message.
 * @returns {Promise<object[]>} новый content.
 */
export async function buildQueueContent(scope, request, message) {
  const allowed = existingKeys(message.content);
  const blocks = request.text.trim() === '' ? [] : [{ type: 'text', text: request.text }];
  for (const item of request.attachments) {
    if (item.kind === 'existing') {
      const key = `${item.type}:${attachmentKey(item.attachment)}`;
      if (!allowed.has(key)) {
        const error = new Error('existing attachment does not belong to this queue item');
        error.status = 400;
        throw error;
      }
      blocks.push({ type: item.type, attachment: allowed.get(key) });
      continue;
    }
    const bytes = Buffer.from(item.data, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
      const error = new Error('attachment size is not allowed');
      error.status = 413;
      throw error;
    }
    if (item.type === 'image') {
      const refs = await scope.attachments.saveImages([{ data: bytes, mediaType: item.mediaType, ...(item.name === undefined ? {} : { name: item.name }) }]);
      blocks.push({ type: 'image', attachment: refs[0] });
    } else {
      const ref = await scope.attachments.saveFile({ data: bytes, ...(item.name === undefined ? {} : { name: item.name }) });
      blocks.push({ type: 'file', attachment: ref });
    }
  }
  return blocks;
}

/**
 * Найти pending-сообщение в очереди агента.
 * @param {object} agent - agent.
 * @param {string} itemId - id сообщения.
 * @returns {object | null} сообщение либо null.
 */
function findPending(agent, itemId) {
  return agent?.inbox?.nextTurn?.find((message) => message.id === itemId)
    ?? agent?.inbox?.nextStep?.find((message) => message.id === itemId)
    ?? null;
}

/**
 * Применить отредактированное сообщение к очереди (без HTTP-обвязки).
 * @param {object} scope - контекст с sessionController/attachments.
 * @param {object} request - нормализованный запрос.
 * @returns {Promise<object>} `{ ok:true }`.
 */
export async function applyQueueEdit(scope, request) {
  const found = await scope.sessionController.resolveAgent(request.sessionId);
  if (found === undefined || found === null || 'error' in found) {
    const error = new Error('session is not available');
    error.status = 404;
    throw error;
  }
  const agent = 'agent' in found ? found.agent : found;
  const message = findPending(agent, request.itemId);
  if (message === null) {
    const error = new Error('queued item is no longer pending');
    error.status = 409;
    throw error;
  }
  const content = await buildQueueContent(scope, request, message);
  const replaced = agent.inbox.replace(request.itemId, deepFreeze({ ...message, content }));
  if (replaced !== true) {
    const error = new Error('queued item is no longer pending');
    error.status = 409;
    throw error;
  }
  return { ok: true };
}

/**
 * Зарегистрировать роут. `ctx.inject` привязывает регистрацию к жизни плагина.
 * @param {object} ctx - хост-контекст плагина.
 * @returns {void}
 */
export function activate(ctx) {
  ctx.inject(['webServer', 'connection', 'sessionController', 'attachments'], (scope) => {
    const handler = async (req, res) => {
      const rejection = scope.connection.requestRejection(req);
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST required' });
        return;
      }
      if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'application/json required' });
        return;
      }
      let raw;
      try {
        raw = await readBoundedBody(req);
      } catch (_error) {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'request body unreadable' });
        return;
      }
      if (raw === null) {
        sendJson(res, 413, { ok: false, code: 'payload-too-large', message: 'request body is too large' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_error) {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'invalid JSON' });
        return;
      }
      const request = parseQueueEdit(parsed);
      if (request.error !== undefined) {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: request.error });
        return;
      }
      try {
        const result = await applyQueueEdit(scope, request);
        sendJson(res, 200, result);
      } catch (error) {
        let status = Number.isInteger(error?.status) ? error.status : 500;
        let code = status === 413 ? 'payload-too-large' : 'edit-failed';
        try {
          if (scope.attachments.isAttachmentError?.(error) === true) {
            const attachmentCode = String(error?.code ?? '');
            status = /LARGE|TOO_MANY/.test(attachmentCode) ? 413 : 400;
            code = 'attachment-invalid';
          }
        } catch (_attachmentError) {
          /* классификация необязательна */
        }
        const message = error instanceof Error && error.message !== '' ? error.message : 'queue edit failed';
        sendJson(res, status, { ok: false, code, message });
      }
    };
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: QUEUE_EDIT_PATH, handler }), 'dsh-tweaks: queue edit route');
  });
}
