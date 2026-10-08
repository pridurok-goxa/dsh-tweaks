/**
 * Local Whisper speech recognition provider for the DeepSeek Harness
 * speech-to-text seam (`ctx.speechToText`).
 *
 * It registers one `host-local` recognizer backed by a persistent Python
 * worker (`worker.py`, faster-whisper). Preparation is Host-owned: ensure the
 * managed virtual environment, download the model weights, load them into the
 * worker. Inference happens on the machine that runs DSH; audio arrives as one
 * complete 16 kHz mono PCM16 WAV recording and never becomes a Session event.
 *
 * No runtime dependencies beyond Node built-ins: the plugin lives outside the
 * dsh installation tree, so it must not import Harness packages.
 *
 * Config (Loader row `speech-whisper-local`):
 *   dataRoot       managed root (venv, models, temp); default $DSH_HOME/speech-to-text/whisper
 *   model          faster-whisper model or Hub repo id; default `medium`
 *   device         cpu | cuda | auto; default cpu
 *   computeType    int8 | int8_float32 | float32; default int8
 *   threads        CPU threads for inference; 0 lets CTranslate2 decide
 *   beamSize       decoding beam; default 5
 *   idleTimeoutMs  release the worker after this idle period; default 5 min
 *   maxAudioBytes  largest accepted recording; default 4 MiB
 *
 * @module @local/dsh-speech-whisper
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(PACKAGE_DIR, 'worker.py');
const IS_WINDOWS = process.platform === 'win32';
const PROVIDER_ID = 'whisper-local';
const STEP_ORDER = ['check', 'model', 'load'];
const LANGUAGES = ['auto', 'ru', 'en', 'uk', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'tr', 'nl', 'cs', 'zh', 'ja', 'ko'];
const DOWNLOAD_SOURCES = ['https://huggingface.co', 'https://hf-mirror.com'];
const DEFAULT_IDLE_TIMEOUT_MS = 300000;

function text(value, fallback) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function integer(value, fallback) {
	return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function dshHomeOf(config) {
	const configured = text(config?.dshHome, '');
	if (configured !== '') return configured;
	const fromEnv = text(process.env.DSH_HOME, '');
	return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh');
}

/** One provider: preparation state machine plus a serialized Python worker. */
class WhisperProvider {
	constructor(ctx, config = {}) {
		this.ctx = ctx;
		this.dataRoot = text(config.dataRoot, join(dshHomeOf(config), 'speech-to-text', 'whisper'));
		this.model = text(config.model, 'medium');
		this.device = text(config.device, 'auto');
		this.computeType = text(config.computeType, 'default');
		this.threads = integer(config.threads, 4);
		this.beamSize = integer(config.beamSize, 5) || 5;
		this.idleTimeoutMs = integer(config.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS) || DEFAULT_IDLE_TIMEOUT_MS;
		this.maxAudioBytes = integer(config.maxAudioBytes, 4 * 1024 * 1024) || 4 * 1024 * 1024;
		this.prepareTimeoutMs = integer(config.prepareTimeoutMs, 3600000) || 3600000;
		this.inferenceTimeoutMs = integer(config.inferenceTimeoutMs, 600000) || 600000;

		this.venvDir = join(this.dataRoot, 'venv');
		this.venvPython = IS_WINDOWS ? join(this.venvDir, 'Scripts', 'python.exe') : join(this.venvDir, 'bin', 'python');
		this.venvPip = IS_WINDOWS ? join(this.venvDir, 'Scripts', 'pip.exe') : join(this.venvDir, 'bin', 'pip');
		this.modelDir = join(this.dataRoot, 'models', this.model.replaceAll('/', '__'));
		this.tempDir = join(this.dataRoot, 'tmp');

		this.listeners = new Set();
		this.worker = undefined;
		this.requests = new Map();
		this.sequence = 0;
		this.prepareTask = undefined;
		this.bootstrap = undefined;
		this.disposed = false;
		this.prepared = existsSync(join(this.modelDir, 'model.bin')) && existsSync(this.venvPython);
		this.state = this.prepared
			? { phase: 'standby', step: 'load', steps: this.#steps({ check: 'complete', model: 'complete', load: 'pending' }) }
			: { phase: 'unprepared', steps: this.#steps({}) };
	}

	get info() {
		return {
			id: PROVIDER_ID,
			name: 'Whisper (local)',
			location: 'host-local',
			languages: LANGUAGES,
			setupEstimate: {
				recommendedDiskBytes: 4 * 1024 * 1024 * 1024,
				expectedMemoryBytes: 2 * 1024 * 1024 * 1024,
				minimumMinutes: 3,
				maximumMinutes: 20,
			},
			downloadSources: DOWNLOAD_SOURCES,
		};
	}

	get preparation() {
		return {
			snapshot: () => this.state,
			subscribe: (listener) => {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			},
			prepare: (options) => {
				const source = text(options?.downloadSource, '');
				void this.#prepare(source).catch((error) => this.#fail(error));
			},
			cancel: () => this.#cancel(),
		};
	}

	#steps(status) {
		return STEP_ORDER.map((kind) => ({ kind, status: status[kind] ?? 'pending' }));
	}

	#publish(state) {
		this.state = state;
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch (error) {
				this.ctx.logger?.warn?.(`speech-whisper-local: listener failed: ${String(error)}`);
			}
		}
	}

	#failedStep() {
		for (const step of this.state.steps ?? []) if (step.status === 'failed') return step.kind;
		return this.state.step ?? 'model';
	}

	#fail(error) {
		const message = error instanceof Error ? error.message : String(error);
		const step = this.#failedStep();
		const steps = (this.state.steps ?? this.#steps({})).map((entry) => (entry.kind === step ? { kind: entry.kind, status: 'failed' } : entry));
		this.#publish({ phase: 'failed', message, download: error?.download, step, steps });
		this.ctx.logger?.warn?.(`speech-whisper-local: ${message}`);
	}

	#markStep(kind, status, steps) {
		return (steps ?? this.state.steps ?? this.#steps({})).map((entry) => (entry.kind === kind ? { kind, status } : entry));
	}

	// -- preparation ----------------------------------------------------
	async #prepare(downloadSource) {
		if (this.disposed) throw new Error('provider was disposed');
		if (this.prepareTask !== undefined) return this.prepareTask;
		const task = (async () => {
			const deadline = Date.now() + this.prepareTimeoutMs;
			let steps = this.#steps({});
			steps = this.#markStep('check', 'running', steps);
			this.#publish({ phase: 'checking', startedAt: Date.now(), step: 'check', steps });
			await this.#ensureVenv();
			steps = this.#markStep('check', 'complete', steps);
			steps = this.#markStep('model', 'running', steps);
			if (existsSync(join(this.modelDir, 'model.bin'))) {
				steps = this.#markStep('model', 'complete', steps);
			} else {
				this.#publish({ phase: 'downloading', resource: this.model, completedBytes: 0, step: 'model', steps });
			}
			steps = this.#markStep('model', 'complete', steps);
			steps = this.#markStep('load', 'running', steps);
			this.#publish({ phase: 'loading', startedAt: Date.now(), step: 'load', steps });
			await this.#ensureWorker({ downloadSource, remainingMs: Math.max(1000, deadline - Date.now()) });
			steps = this.#markStep('load', 'complete', steps);
			this.prepared = true;
			this.#publish({ phase: 'ready', steps });
			this.#scheduleIdle();
		})();
		this.prepareTask = task;
		try {
			await task;
		} finally {
			if (this.prepareTask === task) this.prepareTask = undefined;
		}
	}

	async #ensureVenv() {
		if (existsSync(this.venvPython)) {
			try {
				await this.#run(this.venvPython, ['-c', 'import faster_whisper'], new AbortController().signal);
				return;
			} catch {
				this.ctx.logger?.warn?.('speech-whisper-local: managed environment is incomplete, reinstalling');
			}
		}
		await mkdir(this.dataRoot, { recursive: true });
		const controller = new AbortController();
		this.bootstrap = controller;
		try {
			const launcher = await this.#pythonLauncher(controller.signal);
			await this.#run(launcher.command, [...launcher.args, '-m', 'venv', this.venvDir], controller.signal);
			await this.#run(this.venvPip, ['install', '--quiet', '--upgrade', 'pip', 'wheel'], controller.signal);
			await this.#run(this.venvPip, ['install', 'faster-whisper'], controller.signal);
		} finally {
			if (this.bootstrap === controller) this.bootstrap = undefined;
		}
	}

	/** Locate a usable system Python 3 launcher: `py -3` on Windows, `python3` elsewhere. */
	async #pythonLauncher(signal) {
		const candidates = IS_WINDOWS
			? [['py', ['-3']], ['python', []]]
			: [['python3', []], ['python', []]];
		for (const [command, args] of candidates) {
			try {
				await this.#run(command, [...args, '--version'], signal);
				return { command, args };
			} catch {
				// try the next candidate launcher
			}
		}
		throw new Error('python 3 was not found on PATH; install Python 3.10 or newer (with "Add python.exe to PATH") and retry');
	}

	#run(command, args, signal) {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
			let tail = '';
			const collect = (chunk) => {
				tail = `${tail}${String(chunk)}`.slice(-2000);
			};
			child.stdout.on('data', collect);
			child.stderr.on('data', collect);
			const onAbort = () => {
				child.kill('SIGKILL');
				reject(new Error(`${command} was cancelled`));
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			child.on('error', (error) => {
				signal?.removeEventListener('abort', onAbort);
				reject(error);
			});
			child.on('exit', (code) => {
				signal?.removeEventListener('abort', onAbort);
				if (code === 0) resolve();
				else reject(new Error(`${command} exited with code ${String(code)}: ${tail.trim().split('\n').slice(-3).join(' | ')}`));
			});
		});
	}

	async #cancel() {
		this.#publish({ phase: 'cancelling', startedAt: Date.now(), step: this.state.step, steps: this.state.steps });
		this.bootstrap?.abort();
		this.bootstrap = undefined;
		await this.#stopWorker();
		this.prepared = existsSync(join(this.modelDir, 'model.bin')) && existsSync(this.venvPython);
		this.#publish(this.prepared
			? { phase: 'standby', step: 'load', steps: this.#steps({ check: 'complete', model: 'complete', load: 'pending' }) }
			: { phase: 'cancelled', steps: this.#steps({}) });
	}

	// -- worker ---------------------------------------------------------
	async #ensureWorker({ downloadSource = '', remainingMs = this.prepareTimeoutMs } = {}) {
		if (this.worker !== undefined) return this.worker;
		await mkdir(this.tempDir, { recursive: true });
		const child = spawn(this.venvPython, [WORKER_PATH], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
		});
		const worker = { child, buffer: '', tail: '' };
		this.worker = worker;
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk) => this.#consume(worker, chunk));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => {
			worker.tail = `${worker.tail}${chunk}`.slice(-4000);
		});
		child.on('exit', (code, signal) => {
			if (this.worker === worker) this.worker = undefined;
			for (const [, pending] of this.requests) pending.reject(new Error(`whisper worker exited (code ${String(code)}, signal ${String(signal)})`));
			this.requests.clear();
			if (this.disposed) return;
			if (this.prepared) this.#publish({ phase: 'standby', step: 'load', steps: this.#steps({ check: 'complete', model: 'complete', load: 'pending' }) });
		});
		await new Promise((resolve, reject) => {
			child.once('spawn', resolve);
			child.once('error', reject);
		});
		const prepared = await this.#request('prepare', {
			model: this.model,
			downloadRoot: this.dataRoot,
			downloadSource,
			device: this.device,
			computeType: this.computeType,
			threads: this.threads,
		}, remainingMs);
		const effectiveDevice = text(prepared?.device, this.device);
		const effectiveType = text(prepared?.computeType, this.computeType);
		const fellBackFrom = text(prepared?.fallbackFrom, '');
		this.ctx.logger?.info?.(
			`speech-whisper-local: model ${this.model} ready on ${effectiveDevice}/${effectiveType}` +
			(fellBackFrom === '' ? '' : ` (fell back from ${fellBackFrom})`) +
			(prepared?.cached === true ? ' [cached]' : ''),
		);
		return worker;
	}

	#consume(worker, chunk) {
		worker.buffer += chunk;
		let index = worker.buffer.indexOf('\n');
		while (index >= 0) {
			const line = worker.buffer.slice(0, index).trim();
			worker.buffer = worker.buffer.slice(index + 1);
			if (line !== '') this.#handleLine(worker, line);
			index = worker.buffer.indexOf('\n');
		}
	}

	#handleLine(worker, line) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			worker.tail = `${worker.tail}${line}\n`.slice(-4000);
			return;
		}
		if (message.event === 'log') {
			worker.tail = `${worker.tail}${String(message.message)}\n`.slice(-4000);
			return;
		}
		if (message.event === 'progress') {
			if (message.resource === 'model') {
				const steps = this.#markStep('model', 'running');
				const state = {
					phase: 'downloading',
					resource: this.model,
					completedBytes: integer(message.completedBytes, 0),
					step: 'model',
					steps,
				};
				if (Number.isSafeInteger(message.totalBytes) && message.totalBytes > 0) state.totalBytes = message.totalBytes;
				this.#publish(state);
			}
			return;
		}
		const pending = this.requests.get(String(message.id));
		if (pending === undefined) return;
		this.requests.delete(String(message.id));
		clearTimeout(pending.timer);
		if (message.ok === true) pending.resolve(message.result);
		else {
			const error = new Error(text(message.error, 'whisper worker failed'));
			if (message.failure !== undefined) error.download = message.failure;
			pending.reject(error);
		}
	}

	#request(command, payload, timeoutMs) {
		const worker = this.worker;
		if (worker === undefined) throw new Error('whisper worker is not running');
		if (this.disposed) throw new Error('provider was disposed');
		this.sequence += 1;
		const id = String(this.sequence);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.requests.delete(id);
				void this.#stopWorker();
				reject(new Error(`whisper ${command} timed out after ${String(timeoutMs)} ms`));
			}, timeoutMs);
			timer.unref?.();
			this.requests.set(id, { resolve, reject, timer });
			worker.child.stdin.write(`${JSON.stringify({ id, cmd: command, ...payload })}\n`, (error) => {
				if (error === undefined || error === null) return;
				this.requests.delete(id);
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	async #stopWorker() {
		const worker = this.worker;
		this.worker = undefined;
		if (worker === undefined) return;
		for (const [, pending] of this.requests) {
			clearTimeout(pending.timer);
			pending.reject(new Error('whisper worker was stopped'));
		}
		this.requests.clear();
		const exited = new Promise((resolve) => worker.child.once('exit', resolve));
		worker.child.kill('SIGTERM');
		const killTimer = setTimeout(() => worker.child.kill('SIGKILL'), 5000);
		killTimer.unref?.();
		await exited;
		clearTimeout(killTimer);
	}

	#scheduleIdle() {
		clearTimeout(this.idleTimer);
		if (this.idleTimeoutMs === 0) return;
		this.idleTimer = setTimeout(() => {
			if (this.requests.size > 0) return this.#scheduleIdle();
			void this.#stopWorker().then(() => {
				if (!this.disposed && this.prepared) this.#publish({ phase: 'standby', step: 'load', steps: this.#steps({ check: 'complete', model: 'complete', load: 'pending' }) });
			});
		}, this.idleTimeoutMs);
		this.idleTimer.unref?.();
	}

	// -- inference ------------------------------------------------------
	async transcribe(input, signal) {
		if (this.disposed) throw new Error('provider was disposed');
		if (!this.prepared) throw new Error('speech recognition is not prepared; run preparation first');
		const audio = input?.audio;
		if (!(audio instanceof Uint8Array) || audio.length === 0) throw new Error('recording is empty');
		if (audio.length > this.maxAudioBytes) throw new Error(`recording exceeds ${String(this.maxAudioBytes)} bytes`);
		if (signal?.aborted) throw new Error('recording was cancelled');
		if (this.worker === undefined) {
			this.#publish({ phase: 'waking', startedAt: Date.now(), step: 'load', steps: this.#markStep('load', 'running') });
			await this.#ensureWorker();
			this.#publish({ phase: 'ready', steps: this.#markStep('load', 'complete') });
		}
		await mkdir(this.tempDir, { recursive: true });
		const file = join(this.tempDir, `${randomUUID()}.wav`);
		await writeFile(file, audio);
		const onAbort = () => {
			void this.#stopWorker();
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			const result = await this.#request('transcribe', {
				path: file,
				language: text(input?.language, 'auto'),
				beamSize: this.beamSize,
			}, this.inferenceTimeoutMs);
			return {
				text: text(result?.text, ''),
				audioSeconds: Number.isFinite(result?.audioSeconds) ? result.audioSeconds : 0,
				inferenceSeconds: Number.isFinite(result?.inferenceSeconds) ? result.inferenceSeconds : 0,
			};
		} finally {
			signal?.removeEventListener('abort', onAbort);
			await rm(file, { force: true });
			if (!this.disposed && this.worker !== undefined) this.#scheduleIdle();
		}
	}

	async dispose() {
		this.disposed = true;
		clearTimeout(this.idleTimer);
		this.bootstrap?.abort();
		this.listeners.clear();
		await this.#stopWorker();
	}
}

/**
 * Whisper tweak host half (`tweaks/whisper-host.js`).
 *
 * The framework (index.js) owns the Config flag lifecycle and calls `activate`
 * when the `whisper` flag turns on, `deactivate` when it turns off. The tweak
 * registers one `whisper-local` recognizer on the shared speech-to-text registry.
 *
 * @param ctx - Host plugin context (carries `ctx.speechToText`).
 * @param config - Loader row configuration; fields are `whisper*`.
 */
let provider = undefined;
let unregister = undefined;

export function activate(ctx, config = {}) {
	if (provider !== undefined) return;
	provider = new WhisperProvider(ctx, {
		model: config.whisperModel,
		device: config.whisperDevice ?? 'auto',
		computeType: config.whisperComputeType ?? 'default',
		threads: config.whisperThreads ?? 6,
		beamSize: config.whisperBeamSize ?? 1,
		idleTimeoutMs: config.whisperIdleTimeoutMs ?? 900000,
		maxAudioBytes: config.whisperMaxAudioBytes,
	});
	unregister = ctx.speechToText.register({
		info: provider.info,
		preparation: provider.preparation,
		transcribe: (input, signal) => provider.transcribe(input, signal),
	});
}

export async function deactivate() {
	const current = provider;
	const currentUnregister = unregister;
	provider = undefined;
	unregister = undefined;
	if (current !== undefined) await current.dispose();
	if (currentUnregister !== undefined) await currentUnregister();
}
