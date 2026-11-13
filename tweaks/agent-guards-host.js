import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Хост-половина твика «страховка агентов» (agentGuards) бандла volna-tweaks.
 *
 * Механическая страховка к правилам агентов HARNESS (аудит промахов DeepSeek
 * 13.11.2026, план П0.1–П0.4): правило в пресете объясняет «почему», а хук
 * отказывает в вызове инструмента до исполнения. Каждый отказ называет номер
 * промаха из аудита и скилл с объяснением.
 *
 * Четыре проверки на `tools/pre-execute` (до тела инструмента):
 *  1. secrets — секрет в аргументах bash: `PGPASSWORD=<литерал>`, DSN
 *     `postgres://user:<пароль>@`, `--password=<литерал>`, `Bearer <токен>`,
 *     известные префиксы токенов (ghp_, gho_, github_pat_, re_, sk-…, xox?-).
 *     Ссылка на переменную (`$VAR`, `${VAR}`, `$(…)`) разрешена.
 *  2. wip — выкат грязного дерева: команда с `+wip` рядом со словом выката;
 *     `dev-stand.sh deploy|resume` с `--allow-shared-tree`; `--worktree`
 *     или worktree лейна с незакоммиченными правками (`git status --porcelain`).
 *     `--ref <sha>` — чистый источник, пропускается.
 *  3. rootWrite — write/edit/apply_patch в основном checkout репозитория на
 *     ветке main/master внутри `agentGuardsRootWriteRoots`. Linked worktree
 *     (`.git` — файл) и пути из `agentGuardsRootWriteAllow` пропускаются.
 *  4. loop — N одинаковых вызовов подряд (имя + аргументы без description)
 *     у одного агента: N-й и следующие такие же получают отказ, другой вызов
 *     сбрасывает счётчик.
 *
 * Отказ пишется строкой JSON в `$DSH_HOME/dsh-tweaks/agent-guards.jsonl`
 * (ротация 1 МБ): время, правило, инструмент, сессия, № промаха. Значение
 * секрета в журнал не попадает — только вид совпадения.
 *
 * Отказоустойчивость: любая ошибка проверки = пропуск вызова (fail-open) и
 * строка `guard-error` в журнале; хук не должен останавливать работу агента
 * из-за собственного сбоя. git вызывается с таймаутом 3 с.
 *
 * Интерфейс модуля: `activate(ctx, config)`, `update(config)`, `deactivate()`;
 * для тестов — `checkSecrets`, `checkWipCommand`, `parseDevStand`,
 * `checkRootWrite`, `createLoopDetector`, `evaluate`.
 *
 * @module volna-tweaks/agent-guards-host
 */

/** Имя журнала отказов. */
const LOG_NAME = 'agent-guards.jsonl';
/** Порог ротации журнала. */
const LOG_MAX_BYTES = 1024 * 1024;
/** Таймаут git-проверок. */
const GIT_TIMEOUT_MS = 3000;

/** Пути, запись в которые в основном checkout разрешена (относительно корня репо). */
export const DEFAULT_ROOT_WRITE_ALLOW = ['docs/plans/', '.cursor/plans/', 'reports/', '.local/', '.wt/', 'INFRA-CHANGES.md'];
/** Корни, внутри которых действует проверка записи в основной checkout. */
export const DEFAULT_ROOT_WRITE_ROOTS = ['/home/goxa/project'];

/** Ссылка на скилл и промахи для каждого правила. */
const RULE_INFO = {
  secrets: { skill: 'data-safety', misses: '18, 21' },
  wip: { skill: 'clean-worktree', misses: '1, 2, 8, 13' },
  rootWrite: { skill: 'clean-worktree', misses: '1, 2, 20, 26' },
  loop: { skill: 'ready-gate', misses: '16, 22' },
};

/** Значение — ссылка на переменную или подстановку, а не литерал. */
function isReference(value) {
  const v = String(value ?? '').replace(/^['"]/, '');
  return v.length === 0 || v.startsWith('$') || v.startsWith('`');
}

/**
 * Найти секрет-литерал в тексте команды.
 * @param {string} command - текст bash-команды.
 * @returns {string | null} вид совпадения либо null.
 */
export function checkSecrets(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  const pg = /\bPG(?:PASSWORD)=(\S*)/g;
  for (let m = pg.exec(command); m !== null; m = pg.exec(command)) {
    if (!isReference(m[1]) && m[1] !== "''" && m[1] !== '""') return 'PGPASSWORD=<литерал>';
  }
  const dsn = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:@/'"]+:([^\s@/'"]+)@/gi;
  for (let m = dsn.exec(command); m !== null; m = dsn.exec(command)) {
    if (!isReference(m[1])) return 'DSN с паролем';
  }
  const pw = /--password[= ](\S+)/g;
  for (let m = pw.exec(command); m !== null; m = pw.exec(command)) {
    if (!isReference(m[1]) && !m[1].startsWith('-')) return '--password <литерал>';
  }
  const bearer = /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/;
  const b = bearer.exec(command);
  if (b !== null && !isReference(b[1])) return 'Bearer <токен>';
  if (/\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}/.test(command)) return 'токен GitHub';
  if (/\bgithub_pat_[A-Za-z0-9_]{30,}/.test(command)) return 'токен GitHub';
  if (/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{12,}/.test(command)) return 'ключ Resend';
  if (/\bsk-[A-Za-z0-9_-]{32,}/.test(command)) return 'API-ключ sk-…';
  if (/\bxox[abpr]-[A-Za-z0-9-]{20,}/.test(command)) return 'токен Slack';
  return null;
}

/** Слова выката рядом с `+wip`. */
const DEPLOY_WORDS = /\b(?:dev-stand\.sh|deploy|rollout|promote|release|staging|docker\s+compose|systemctl\s+restart)\b/i;

/**
 * `+wip` в команде выката.
 * @param {string} command - текст bash-команды.
 * @returns {boolean} отказать ли.
 */
export function checkWipCommand(command) {
  if (typeof command !== 'string' || !command.includes('+wip')) return false;
  // Чтение журналов и поиск по ним разрешены: grep/rg/ag по строке «+wip».
  if (/^\s*(?:grep|rg|ag|git\s+log|git\s+grep)\b/.test(command)) return false;
  return DEPLOY_WORDS.test(command);
}

/** Аргументы строки shell без кавычек (достаточно для разбора флагов dev-stand). */
function shellWords(text) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

/**
 * Найти вызовы `dev-stand.sh deploy|resume` в команде.
 * @param {string} command - текст bash-команды.
 * @returns {Array<{script: string, sub: string, lane?: string, worktree?: string, ref?: string, shared: boolean}>}
 */
export function parseDevStand(command) {
  if (typeof command !== 'string' || !command.includes('dev-stand.sh')) return [];
  const calls = [];
  for (const part of command.split(/&&|\|\||;|\n|\|/)) {
    const words = shellWords(part);
    const i = words.findIndex((w) => /(?:^|\/)dev-stand\.sh$/.test(w));
    if (i < 0) continue;
    const sub = words[i + 1];
    if (sub !== 'deploy' && sub !== 'resume') continue;
    const call = { script: words[i], sub, shared: false };
    for (let j = i + 2; j < words.length; j += 1) {
      const w = words[j];
      if (w === '--lane') call.lane = words[++j];
      else if (w === '--worktree') call.worktree = words[++j];
      else if (w === '--ref') call.ref = words[++j];
      else if (w === '--allow-shared-tree') call.shared = true;
      else if (w === '--dry-run') call.dry = true;
    }
    calls.push(call);
  }
  return calls;
}

/** Выполнить git с таймаутом; ошибка = null. */
function git(args, cwd) {
  return new Promise((done) => {
    execFile('git', ['-c', 'safe.directory=*', ...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      done(error ? null : String(stdout));
    });
  });
}

/**
 * Проверить выкат dev-stand на грязное дерево.
 * @param {string} command - текст bash-команды.
 * @param {string | undefined} cwd - рабочий каталог вызова.
 * @param {(args: string[], cwd: string) => Promise<string | null>} [runGit] - для тестов.
 * @returns {Promise<string | null>} причина отказа либо null.
 */
export async function checkDevStand(command, cwd, runGit = git) {
  for (const call of parseDevStand(command)) {
    if (call.dry) continue;
    if (call.shared) return 'dev-stand --allow-shared-tree: общее дерево с чужими правками';
    if (call.ref) continue;
    const scriptPath = isAbsolute(call.script) ? call.script : cwd ? resolve(cwd, call.script) : null;
    let tree = call.worktree;
    if (tree && !isAbsolute(tree)) tree = cwd ? resolve(cwd, tree) : null;
    if (!tree && scriptPath && call.lane) tree = join(dirname(dirname(dirname(scriptPath))), '.local', 'worktrees', call.lane);
    if (!tree || !existsSync(tree)) continue;
    const status = await runGit(['status', '--porcelain'], tree);
    if (status === null) continue;
    if (status.trim().length > 0) {
      const n = status.trim().split('\n').length;
      return `в ${tree} ${n} незакоммиченных путей — стенд получил бы «+wip»`;
    }
  }
  return null;
}

/**
 * Найти ближайший `.git` вверх от пути.
 * @param {string} file - абсолютный путь файла.
 * @returns {{root: string, kind: 'dir' | 'file'} | null}
 */
export function findGitRoot(file) {
  let dir = dirname(file);
  for (let k = 0; k < 64; k += 1) {
    const dotgit = join(dir, '.git');
    try {
      const st = statSync(dotgit);
      return { root: dir, kind: st.isDirectory() ? 'dir' : 'file' };
    } catch (_error) {
      /* нет .git — выше */
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** Ветка основного checkout по .git/HEAD; detached — null. */
function headBranch(root) {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref: refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Запись в основной checkout на main/master.
 * @param {string} file - путь файла (абсолютный).
 * @param {{roots?: string[], allow?: string[]}} [options]
 * @returns {string | null} причина отказа либо null.
 */
export function checkRootWrite(file, options = {}) {
  if (typeof file !== 'string' || !isAbsolute(file)) return null;
  const roots = options.roots ?? DEFAULT_ROOT_WRITE_ROOTS;
  const allow = options.allow ?? DEFAULT_ROOT_WRITE_ALLOW;
  const normalized = resolve(file);
  if (!roots.some((r) => normalized === r || normalized.startsWith(r.endsWith(sep) ? r : r + sep))) return null;
  const repo = findGitRoot(normalized);
  if (repo === null || repo.kind !== 'dir') return null;
  const branch = headBranch(repo.root);
  if (branch !== 'main' && branch !== 'master') return null;
  const rel = relative(repo.root, normalized).split(sep).join('/');
  if (allow.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a || rel.endsWith('/' + a)))) return null;
  return `${rel} — в основном checkout ${repo.root} на ветке ${branch}`;
}

/**
 * Детектор зацикливания: одинаковые вызовы подряд у одного агента.
 * @param {number} limit - на каком по счёту одинаковом вызове отказывать.
 */
export function createLoopDetector(limit = 3) {
  const last = new WeakMap();
  const fallback = new Map();
  return {
    limit,
    /**
     * @param {object | undefined} agent - агент вызова (ключ состояния).
     * @param {string} name - имя инструмента.
     * @param {unknown} args - аргументы.
     * @returns {number} сколько раз подряд повторён вызов (1 — первый).
     */
    hit(agent, name, args) {
      let key;
      try {
        const copy = args !== null && typeof args === 'object' ? { ...args } : args;
        if (copy && typeof copy === 'object') delete copy.description;
        key = `${name}\u0000${JSON.stringify(copy)}`;
      } catch (_error) {
        return 1;
      }
      const store = agent && typeof agent === 'object' ? last : fallback;
      const id = agent && typeof agent === 'object' ? agent : 'none';
      const prev = store.get(id);
      const count = prev && prev.key === key ? prev.count + 1 : 1;
      store.set(id, { key, count });
      return count;
    },
  };
}

/** Флаг включён: явный false выключает, отсутствие поля = дефолт true. */
function on(config, field) {
  return config?.[field] !== false;
}

/** Путь файла из аргументов write/edit/apply_patch. */
function targetPaths(name, args) {
  if (args === null || typeof args !== 'object') return [];
  if (name === 'write' || name === 'edit') return typeof args.file_path === 'string' ? [args.file_path] : [];
  if (name === 'apply_patch') {
    const text = typeof args.patch === 'string' ? args.patch : typeof args.input === 'string' ? args.input : '';
    const out = [];
    const re = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1].trim());
    return out;
  }
  return [];
}

/**
 * Решение по вызову инструмента.
 * @param {{name: string, arguments?: unknown, agent?: object}} exec - вызов.
 * @param {object} config - развёрнутая конфигурация твика.
 * @param {{loop: ReturnType<typeof createLoopDetector>, cwdOf?: (agent: object) => string | undefined, runGit?: Function}} deps
 * @returns {Promise<{rule: string, reason: string} | null>}
 */
export async function evaluate(exec, config, deps) {
  const name = exec?.name;
  const args = exec?.arguments;
  if (typeof name !== 'string') return null;
  const cwdOf = deps.cwdOf ?? (() => undefined);
  if (on(config, 'agentGuardsLoop')) {
    const count = deps.loop.hit(exec.agent, name, args);
    const limit = Number(config?.agentGuardsLoopLimit) > 1 ? Number(config.agentGuardsLoopLimit) : deps.loop.limit;
    if (count >= limit) return { rule: 'loop', reason: `${count}-й одинаковый вызов «${name}» подряд` };
  }
  if (name === 'bash') {
    const command = typeof args?.command === 'string' ? args.command : '';
    if (on(config, 'agentGuardsSecrets')) {
      const kind = checkSecrets(command);
      if (kind) return { rule: 'secrets', reason: kind };
    }
    if (on(config, 'agentGuardsWip')) {
      if (checkWipCommand(command)) return { rule: 'wip', reason: 'команда выката с «+wip»' };
      let cwd = typeof args?.workdir === 'string' && args.workdir.length > 0 ? args.workdir : undefined;
      const base = exec.agent ? cwdOf(exec.agent) : undefined;
      if (cwd && !isAbsolute(cwd)) cwd = base ? resolve(base, cwd) : undefined;
      if (!cwd) cwd = base;
      const dirty = await checkDevStand(command, cwd, deps.runGit);
      if (dirty) return { rule: 'wip', reason: dirty };
    }
    return null;
  }
  if ((name === 'write' || name === 'edit' || name === 'apply_patch') && on(config, 'agentGuardsRootWrite')) {
    const base = exec.agent ? cwdOf(exec.agent) : undefined;
    for (const raw of targetPaths(name, args)) {
      const file = isAbsolute(raw) ? raw : base ? resolve(base, raw) : null;
      if (!file) continue;
      const why = checkRootWrite(file, {
        roots: Array.isArray(config?.agentGuardsRootWriteRoots) ? config.agentGuardsRootWriteRoots : undefined,
        allow: Array.isArray(config?.agentGuardsRootWriteAllow) ? config.agentGuardsRootWriteAllow : undefined,
      });
      if (why) return { rule: 'rootWrite', reason: why };
    }
  }
  return null;
}

/** Текст отказа агенту. */
export function denialText(hit) {
  const info = RULE_INFO[hit.rule] ?? { skill: 'ready-gate', misses: '—' };
  const advice = {
    secrets: 'Пароли, DSN и токены — только из env-файла (`set -a; . <файл>; set +a`, PGPASSFILE), без вывода значения.',
    wip: 'Выкатывай только закоммиченный SHA: закоммить в своей ветке и `dev-stand.sh deploy --lane <лейн> --ref <sha>` или чистый worktree.',
    rootWrite: 'Корень репо и main/master — только чтение. Работай в своём worktree: `git worktree add .local/worktrees/<лейн> -b <ветка> origin/master` (или `dev-stand.sh worktree <лейн>`).',
    loop: 'Ты повторяешь один и тот же вызов. Смени подход: прочитай вывод, проверь гипотезу другой командой или опиши блокер руководителю.',
  }[hit.rule];
  return `volna-tweaks agent-guards [${hit.rule}]: ${hit.reason}. ${advice} Скилл: ${info.skill}. Промахи аудита 13.11: № ${info.misses}. Вызов не выполнен.`;
}

/** Каталог журнала; без DSH_HOME — null. */
function logDir() {
  const home = typeof process === 'object' ? process?.env?.DSH_HOME : undefined;
  return typeof home === 'string' && home.length > 0 ? join(home, 'dsh-tweaks') : null;
}

/** Строка JSON в журнал отказов (ошибки записи глотаются). */
export function logEvent(entry) {
  const dir = logDir();
  if (dir === null) return;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, LOG_NAME);
    try {
      if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
    } catch (_error) {
      /* файла ещё нет */
    }
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch (_error) {
    /* журнал недоступен — отказ всё равно действует */
  }
}

/** Одно активное состояние. */
let runtime = null;

/**
 * Поставить хук `tools/pre-execute`.
 * @param {object} ctx - хост-контекст плагина.
 * @param {object} config - развёрнутая конфигурация.
 */
export function activate(ctx, config) {
  if (runtime !== null) deactivate();
  const state = { config: config ?? {}, loop: createLoopDetector(3), dispose: null };
  const cwdOf = (agent) => {
    try {
      const wd = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined;
      const value = wd?.get?.(agent.session);
      return typeof value === 'string' ? value : undefined;
    } catch (_error) {
      return undefined;
    }
  };
  const handler = async (exec, next) => {
    let hit = null;
    try {
      if (state.config?.agentGuards !== false) hit = await evaluate(exec, state.config, { loop: state.loop, cwdOf });
    } catch (error) {
      logEvent({ rule: 'guard-error', tool: exec?.name, error: String(error?.message ?? error).slice(0, 200) });
      hit = null;
    }
    if (hit === null) return next();
    logEvent({
      rule: hit.rule,
      tool: exec?.name,
      session: exec?.agent?.session?.id,
      sub: exec?.parent !== undefined,
      reason: hit.rule === 'secrets' ? hit.reason : String(hit.reason).slice(0, 300),
      misses: RULE_INFO[hit.rule]?.misses,
    });
    return { kind: 'deny', reason: denialText(hit), info: { name: 'VolnaAgentGuard', code: `agent-guards/${hit.rule}` } };
  };
  const off = ctx.on('tools/pre-execute', handler, { prepend: true });
  state.dispose = typeof off === 'function' ? off : null;
  runtime = state;
  logEvent({ rule: 'start', pid: process.pid, config: summary(state.config) });
}

/** Сводка флагов для журнала. */
function summary(config) {
  return {
    secrets: on(config, 'agentGuardsSecrets'),
    wip: on(config, 'agentGuardsWip'),
    rootWrite: on(config, 'agentGuardsRootWrite'),
    loop: on(config, 'agentGuardsLoop'),
  };
}

/** Новые значения без перестановки хука. */
export function update(config) {
  if (runtime === null) return;
  runtime.config = config ?? {};
  logEvent({ rule: 'update', config: summary(runtime.config) });
}

/** Снять хук. */
export async function deactivate() {
  const state = runtime;
  runtime = null;
  if (state?.dispose) {
    try {
      state.dispose();
    } catch (_error) {
      /* уже снят */
    }
  }
}
