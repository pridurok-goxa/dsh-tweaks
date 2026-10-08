'use strict';

// Контрактный тест хост-части твика whisper (tweaks/whisper-host.js).
// Проверяет цикл activate/deactivate на моке ctx.speechToText, без реального
// Python-воркера: регистрация провайдера, id/языки, идемпотентность activate,
// полное снятие провайдера в deactivate и повторное включение.

const assert = require('node:assert');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function main() {
  const hostUrl = pathToFileURL(path.join(__dirname, '..', 'tweaks', 'whisper-host.js')).href;
  const { activate, deactivate } = await import(hostUrl);

  let registered = null;
  let unregisterCount = 0;

  const ctx = {
    speechToText: {
      register(provider) {
        registered = provider;
        return async () => {
          unregisterCount += 1;
        };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  };

  // 1) activate регистрирует провайдера с нужным id, именем и языками.
  activate(ctx, { whisperModel: 'small' });
  assert.ok(registered, 'activate должен зарегистрировать провайдера');
  assert.strictEqual(registered.info.id, 'whisper-local');
  assert.strictEqual(registered.info.name, 'Whisper (local)');
  assert.strictEqual(registered.info.location, 'host-local');
  assert.ok(registered.info.languages.includes('ru'), 'русский есть в списке языков');
  assert.strictEqual(typeof registered.transcribe, 'function');
  assert.strictEqual(typeof registered.preparation.prepare, 'function');
  assert.strictEqual(typeof registered.preparation.snapshot, 'function');

  // 2) повторный activate без deactivate не перерегистрирует.
  const first = registered;
  activate(ctx, { whisperModel: 'medium' });
  assert.strictEqual(registered, first, 'повторный activate не должен перерегистрировать');

  // 3) deactivate снимает провайдера.
  await deactivate();
  assert.strictEqual(unregisterCount, 1, 'deactivate должен вызвать unregister ровно один раз');

  // 4) повторное включение после выключения работает.
  registered = null;
  activate(ctx, { whisperModel: 'medium' });
  assert.ok(registered, 'после deactivate повторный activate регистрирует заново');
  await deactivate();
  assert.strictEqual(unregisterCount, 2);

  console.log('check-whisper: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
