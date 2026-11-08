/**
 * Хост-половина скачивания: один роут, который отдаёт байты либо durable-файла
 * из чата, либо файла workspace из вкладки правой панели.
 *
 * Клиент не может прочитать файл вложения напрямую: браузеру доступны только
 * метаданные. Поэтому байты отдаёт хост, а браузер превращает ответ в Blob и
 * скачивает его обычной ссылкой.
 */

/** Путь роута; клиент зовёт его документ-относительно. */
export const DOWNLOAD_PATH = '/dsh-tweaks/download';
/** Путь роута копирования пути к файлу. */
export const FILE_PATH_PATH = '/dsh-tweaks/file-path';

/** Предел одного файла, чтобы случайно не залить память. */
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

/** JSON-ответ без кеша. */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Прочитать тело запроса с лимитом. */
function readBoundedBody(req, limit = 64 * 1024) {
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

/** Строковое поле допустимой длины. */
function stringField(value, max) {
  return typeof value === 'string' && value !== '' && value.length <= max ? value : null;
}

/** Безопасное имя для content-disposition. */
function safeName(value, fallback = 'file') {
  const name = typeof value === 'string' ? value.split(/[\\/]/).pop().trim() : '';
  return name === '' ? fallback : name.slice(0, 255);
}

/**
 * Проверить запрос скачивания.
 * @param {unknown} value - тело.
 * @returns {object | {error: string}} запрос или ошибка.
 */
export function parseDownload(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: 'body must be an object' };
  const sessionId = stringField(value.sessionId, 512);
  if (sessionId === null) return { error: 'sessionId required' };
  if (value.attachment !== undefined) {
    const attachment = value.attachment;
    if (attachment === null || typeof attachment !== 'object' || Array.isArray(attachment)) return { error: 'bad attachment' };
    if (stringField(attachment.attachmentId, 512) === null) return { error: 'attachmentId required' };
    return { kind: 'attachment', sessionId, attachment };
  }
  const path = stringField(value.path, 8192);
  if (path === null) return { error: 'attachment or path required' };
  return { kind: 'workspace', sessionId, path, name: safeName(value.name, path.split('/').pop() || 'file') };
}

/**
 * Получить байты и имя для скачивания.
 * @param {object} scope - контекст с attachments/workspaceFiles.
 * @param {object} request - разобранный запрос.
 * @returns {Promise<{data: Buffer, name: string}>} содержимое.
 */
export async function readDownload(scope, request) {
  if (request.kind === 'attachment') {
    const chunks = [];
    let total = 0;
    for await (const chunk of scope.attachments.readFileStream(request.attachment)) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        const error = new Error('attachment is too large');
        error.status = 413;
        throw error;
      }
      chunks.push(bytes);
    }
    return { data: Buffer.concat(chunks), name: safeName(request.attachment.name, 'file') };
  }
  const header = scope.sessions?.get?.(request.sessionId)?.header;
  const workspaceRoot = header?.cwd ?? scope.sandboxPolicy?.workspaceRoot;
  const workspaceScope = { sessionId: request.sessionId, workspaceRoot };
  const result = await scope.workspaceFiles.readBytes(workspaceScope, request.path, {}, undefined);
  const data = Buffer.from(result.data);
  if (data.length > MAX_DOWNLOAD_BYTES) {
    const error = new Error('file is too large');
    error.status = 413;
    throw error;
  }
  return { data, name: request.name };
}

/**
 * Разрешить абсолютный путь к файлу: durable-вложение или workspace-файл.
 * @param {object} scope - контекст с attachments/workspaceFiles.
 * @param {object} request - разобранный запрос.
 * @returns {Promise<string>} абсолютный путь.
 */
export async function resolveFilePath(scope, request) {
  if (request.kind === 'attachment') {
    const path = scope.attachments.fileHostPath?.(request.attachment);
    if (typeof path !== 'string' || path === '') {
      const error = new Error('attachment has no host path');
      error.status = 404;
      throw error;
    }
    return path;
  }
  const header = scope.sessions?.get?.(request.sessionId)?.header;
  const workspaceRoot = header?.cwd ?? scope.sandboxPolicy?.workspaceRoot;
  const stat = await scope.workspaceFiles.stat({ sessionId: request.sessionId, workspaceRoot }, request.path, undefined);
  if (typeof stat?.absolutePath !== 'string' || stat.absolutePath === '') {
    const error = new Error('file has no host path');
    error.status = 404;
    throw error;
  }
  return stat.absolutePath;
}

/**
 * Зарегистрировать роуты скачивания и копирования пути.
 * @param {object} ctx - хост-контекст плагина.
 * @returns {void}
 */
export function activate(ctx) {
  ctx.inject(['webServer', 'connection', 'attachments', 'workspaceFiles', 'sessions', 'sandboxPolicy'], (scope) => {
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
      const request = parseDownload(parsed);
      if (request.error !== undefined) {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: request.error });
        return;
      }
      try {
        const { data, name } = await readDownload(scope, request);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
        res.end(data);
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        const message = error instanceof Error && error.message !== '' ? error.message : 'download failed';
        sendJson(res, status, { ok: false, code: 'download-failed', message });
      }
    };
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: DOWNLOAD_PATH, handler }), 'dsh-tweaks: download route');

    const pathHandler = async (req, res) => {
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
      let request;
      try {
        request = parseDownload(JSON.parse(raw));
      } catch (_error) {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'invalid JSON' });
        return;
      }
      if (request.error !== undefined) {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: request.error });
        return;
      }
      try {
        const path = await resolveFilePath(scope, request);
        sendJson(res, 200, { ok: true, path });
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        const message = error instanceof Error && error.message !== '' ? error.message : 'path lookup failed';
        sendJson(res, status, { ok: false, code: 'path-failed', message });
      }
    };
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: FILE_PATH_PATH, handler: pathHandler }), 'dsh-tweaks: file path route');
  });
}
