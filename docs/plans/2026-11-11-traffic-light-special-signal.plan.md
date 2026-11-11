# План: светофор v2 — пауза всех, «спецсигнал» на чат/дерево, статус в UI (`dsh-tweaks`)

> Ревизия 5. История: rev=5 (финальные правки: 1 maj qa-F1 «тумблер ломает док-дерево» + 12 min arch/ui). Предыдущее: rev=4 (26 находок diff-аудита: 2 maj E1/E2 + 19 min: контракты §4.4/§4.5, P1/P3/P5, §11). rev=1 (GO) → rev=2 (32 находки панели) → rev=3 (26 находок diff-аудита + уточнение руководителя про субагентский промпт + результат исследования отправителей).
> **Ключевое решение (rev=3, подтверждено rev=4):** разовый пропуск от сообщения **отменён** — пропуск даёт только переключатель «Спецсигнал» (evidence: §2, §8.1). Это правило руководителя «если надёжного признака для сообщений нет, пропуск даёт только кнопка», и оно убирает majors A2/A3/A4 и весь UI «снять пропуск».
> Ветка `fix/traffic-light-manual-lineage`, база `9b9ac36`; новый коммит(ы); без push/PR/merge; `/home/goxa/dsh-tweaks` и инстансы DSH не трогаются.

## Кратко для человека

1. **Что**: на красном встают **все** ходы (цель, итоги субагентов, agent/team-message, расписания, внешние сообщения); на зелёном всё продолжается само; рядом с лампой — переключатель «Спецсигнал» (синяя мигалка), пускающий этот чат и всё его дерево субагентов на красном.
2. **Зачем**: ночной прогон 04–07 и 09–13 МСК должен сам вставать и сам продолжаться; осознанный обход (вдвое дороже) человек включает кнопкой и выключает кнопкой.
3. **Почему пропуск только кнопкой**: отличить человека от сервиса по сообщению нельзя — `harness-relay` и `deputy-wake-prompt.py` шлют тот же `clientTimeZone`, ту же owner-cookie и **байт-в-байт такой же `source`**; `principal` в этой установке отсутствует у всех; UA/IP в сессию не пишутся (evidence §2, §8.1).
4. **Как**: `paused = red && !hasSignal(session)`; `hasSignal` = подъём по `parentSession` до предка со спецсигналом (`special.json` → конфиг → seed).
5. **Файлы**: `tweaks/traffic-light-host.js`, `index.js`, `client.js`, `README.md`, `test/check-traffic-light.cjs`, `test/check-client.cjs`, стенд `test/traffic-light-stand.html`.
6. **Цена**: 4 места ≈ **150–220k токенов** (оценка), `cost_est=150–220k`; состав тот же (rev=3 стал проще по коду).
7. **Риски**: клиент с owner-cookie технически может дёрнуть `configForms` (модель угроз §11); дочерний чат не видит унаследованный спецсигнал в UI (D7); `parentSession` читается только у живых агентов (fail-closed).
8. **Скриншоты** снимает руководитель; от нас — автономный стенд без сети + машинные ассерты стенда.
9. **Персистентность**: `special.json` (атомарная запись) → конфиг → seed; явное выключение из UI после рестарта не воскресает (обязательные подкейсы P3).
10. **От вас**: ничего; прод-действий нет.

## 1. Что меняется относительно `9b9ac36`

- Правило «итоги ручного субагента проходят» **отменяется**. Удаляются: `manualChildren`, `senderSessionIdOf`, `MANUAL_LINEAGE_KINDS`, `MANUAL_CHILDREN_LIMIT`, `AUTOMATIC_KINDS`, `USER_KINDS`, `classifyMessage`, `classifyBatch`, `stepAutomatic`, `autoMode`, обработчик `subagent/start`, `rememberManualChild`, `forgetManualChildrenOf`. `NEUTRAL_KINDS` остаётся (нужен для отклонения пустого хода).

## 2. Факты по коду (проверено инспекцией)

| Факт | Evidence |
| --- | --- |
| Браузерный промпт: `{kind:'user', rpcId, clientTimeZone?, principal?}` | `dsh-api-session-controller/lib/types/types.d.ts:370-381`; `lib/index.js:4049-4059` |
| **`clientTimeZone` — не признак человека**: relay/deputy шлют константу `Europe/Moscow` | `/usr/local/bin/harness-relay:113-117`; `/usr/local/sbin/deputy-wake-prompt.py:11-16` |
| **`source` сервисной вставки байт-в-байт как у браузера** (реальные сессии) | `/home/dshagent/.dsh/storages/session_projcache/sessions/session-11e30c5d-…json:139`; `…/session-3631e999…/session.v4.jsonl.zstd` (relay-строки 53, `principal`=0) |
| **`principal` отсутствует у всех peer'ов**: browserPeer и API-креденшл публикуются как `owner` | `dsh-client-connection/lib/index.js:714,746,783`; `dsh-typert-protocol/lib/index.js:294-297` |
| IP/UA в сессию не пишутся; заголовки доступны только на HTTP-слое через `connection/request` (так делает scope-guard) | `dsh-api-session-controller/lib/types/types.d.ts:370-381`; `/home/goxa/dsh-scope-guard/tools/scope_guard_patch.py:57-76` |
| Надёжный признак «браузер, а не сервис» на хосте — только внешний nginx-лог (relay/deputy идут на loopback мимо nginx) | `/usr/local/sbin/gate2-verify:16-20,115-116` |
| Первое сообщение субагента: `source: {kind:'user'}`; продолжение continuable-ребёнка — `{kind:'user', rpcId, clientTimeZone?}` | `dsh-subagent/lib/index.js:1467`, `:3200-3212` |
| Дерево: `agent.session.header.parentSession` + `origin:'subagent'`; `agents.get/list` — только живые | `dsh-agent/lib/types/index.d.ts:67,357,371`; образец подъёма — `dsh-subagent/lib/index.js:1742-1754` |
| `volatile`-значения конфига персистентны; событие `loader/volatile-update` приходит на любое volatile-изменение с `paths` | `dsh-settings/lib/index.js:488-545`; `index.js:416` |
| Конфликт ревизий у двух вкладок | `dsh-settings/lib/index.js:513-515` |
| Конец красного окна — `nextSwitchAt` | `tweaks/traffic-light-policy.js:159` |
| Канал клиент→хост без своего RPC: `configForms.mutate([{op:'set',…}], revision)` | `client.js:8237`, `:7976-7980` |
| UI-строки — в словарях `client.js:416,498`; `locale/*.json` — только `meta` | `client.js:416,498`; `locale/ru.json`, `locale/en.json` |
| Headless-браузера на хосте нет | инспекция 2026-11-11 (скриншоты — за руководителем) |

## 3. Решения (rev=5)

| ID | Решение |
| --- | --- |
| D1 | `paused = light==='red' && !hasSignal(sessionId)`; иначе `llm/stream` ждёт зелёного |
| D2 | `hasSignal(id)`: подъём по `parentSession` (≤32, `visited`); вход — `special` (постоянно). Предок не найден/реестра нет ⇒ сигнала нет (fail-closed) |
| **D3** | **Пропуск даёт только переключатель.** Сообщения (любые: человек, агент, сервис) пропуск не дают; `momentary`/`pass`/`pass-deny`/`isHumanPrompt` из плана удалены. Причина — §2 (неотличимость). Тест фиксирует: человеческий промпт, промпт субагента/continuable-ребёнка, стиринг и `subagent-settled` на красном ждут |
| D4 | `special = special.json ?? configValue ?? SEED`; файл пишется атомарно (tmp+rename), пустой массив пишется; `appliedSpecial` = **последнее увиденное нормализованное значение поля конфига** (не эффективный набор; `undefined` и `null` нормализуются одинаково — F1); реакция `update()` — только на отличие нормализованных списков; при ошибке записи файла — строка `save-error` и до следующей успешной записи авторитетен конфиг; повтор записи в `refresh()` через `savePending` (F3r), подкейс «file старый ON, config OFF, запись сорвана → после рестарта OFF» |
| D5 | Seed: `['session-e4698bf8-717f-4e1a-9390-a2b40c03d985']`, комментарий «включено по решению Игоря t1447u»; при `activate` — строка `signal … actor=seed|config|file | rev=0` на каждую сессию набора; расхождение файла и конфига — строка `state-conflict` (файл авторитетен) |
| D6 | «Снять пропуск» = **выключить переключатель**; отдельной кнопки «разовый пропуск» нет (D3) |
| D7 | Статус `paused|bypass|free` считает клиент (политика+конфиг); `bypass` — только прямое попадание сессии в список; дочерний чат показывает базовый статус (ограничение §11, кейс (д2)) |
| D8 | Расписания — как сейчас (снятие + `held.json` + возврат на зелёном); прочие виды сообщений не вынимаем (ход просто ждёт) |
| D9 | Лог: существующие строки `trafficLight: …` (в т.ч. `red → green`) **не меняются**; новые — только в файл: `pause | session=<id> | until=<ISO>`, `resume | session=<id> | after=green`, `signal | session=<id> | state=on|off | actor=ui-config|seed|config|file | rev=<n>`, `state-conflict | file=<n> | config=<n> | authority=file`, `save-error | reason=<код>` (F2r), `signal-less | reason=no-initiator` (F5); `rev` — host-локальный монотонный `specialRev`; пауза логируется раз на сессию за окно |
| D10 | Анимация только CSS; `prefers-reduced-motion: reduce` → статичный синий; цвета из токенов темы |
| D11 | Отклонение пустого шага (`reject`) сохраняется; у сессии со спецсигналом пустой ход не отклоняется — кейс (п2) |
| D12 | Вызовы с `options.purpose !== undefined` — сервисное исключение, на красном проходят сразу (README + кейс (п1)) |
| D13 | Спецсигнал действует через любое число красных окон, пока человек его не выключит (README явно) |
| D14 | Отказ `mutate` по устаревшей ревизии: **перечитать снимок и применить дельту к свежему списку** (add/remove id), один повтор; `title` переключателя на 5 с = `light.signal.blocked`, затем возврат к `light.signal.title`; `aria-invalid` — машинный маркер для теста, людям — строка `role="alert"`/`aria-live` в панели (F4, F-ui8) |
| D15 | Спецсигнал не хранится в `localStorage` (только `configForms`); `dsh.ui-light.settings.v1` не трогаем — ассерт в P3 |

## 4. Контракты (rev=5)

1. **Конфиг** (`index.js`, только `volatile`): `trafficLightSpecial: Schema.array(Schema.string()).default(TRAFFIC_LIGHT_SPECIAL_SEED)`.
2. **Состояние**: `$DSH_HOME/dsh-tweaks/special.json` = `{"sessions":["<id>",…]}`; авторитетный при наличии; `activate()`: `file → config → SEED`; запись атомарная; пустой массив пишется (иначе выключение воскреснет).
3. **Лог**: строки D9; существующие `trafficLight: …` не меняются.
4. **UI**: `[data-dsh-light-signal]=on|off` — **только** на переключателе у лампы; копия в панели — тот же компонент с `data-dsh-light-signal-in="panel"` (маркер не дублируется); `aria-pressed`; классы `dsh-ui-light-signal--on|--off`; `data-motion=full|reduced`; `[data-dsh-light-status]=paused|bypass|free`; элемент оповещения об отказе записи — `[data-dsh-light-alert]` с `role="alert"`/`aria-live="polite"` (F7r).
5. **Локаль** — только словари `client.js:416` (en) и `:498` (ru), шаблоны с `{{time}}` (`paused` = «ждёт зелёного до {{time}}», `bypass` = «спецсигнал: работа на красном (вдвое дороже) до {{time}}», `free` = «вне пика — до {{time}}»; подстановка `formatTarget(...)` без дублирования «до», F-ui9); `light.signal.title` («Спецсигнал: чат и его команда работают на красном (дороже вдвое)»), `light.signal.on|off|blocked` (точная строка ассертится в (д) — F-ui6/F8). `locale/*.json` не трогаем.

## 5. Полосы и пакеты

| ID | Домен | Зона записи | Что | AC | deps | tier |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | arch | план | контракты §4 (README — только P7) | контракты зафиксированы | R (готово) | complex |
| P1 | backend | `index.js`, `tweaks/traffic-light-host.js` | гейт/спецсигнал/дерево/леджер/логи/release | `node --check`; кейсы (а)(б)(б2)(в)(г)(ж)(з)(е)(п1)(п2)(л)(м) | P0 | critical |
| P2 | frontend | `client.js` | переключатель-мигалка, статус у лампы и в панели | `node --check`; кейсы (д)(д2) | P0 | complex |
| P3 | qa | `test/check-traffic-light.cjs`, `test/check-client.cjs` | все кейсы + моки (реестр агентов, `matchMedia`, `[data-conversation-session]`, курсор хуков, TZ) | кейсы зелёные; старые 3.2/3.4/3.4а **инвертированы по D3** (помечено), два локатора переведены на маркеры, остальные не ослаблены | P1,P2 | complex |
| P4 | qa | `test/traffic-light-stand.html` + его ассерты | автономный стенд всех состояний | 7 секций, без сети, ассерты в тесте | P2 | standard |
| P5 | qa | — | 16 × `test/check-*.cjs`, `node --check`, `/tmp`-проверка | таблица ожиданий §6 | P1–P4 | mechanical |
| P6 | arch | — | приёмка «план → факт» | pass + grep мёртвых имён + режим 644 | P5 | complex |
| P7 | arch | `README.md` | README под факт | README ↔ код, §11 | P5 | standard |

### P1 — хост (`backend-lead`)
1. Удалить (полный список): `AUTOMATIC_KINDS`, `USER_KINDS`, `MANUAL_LINEAGE_KINDS`, `MANUAL_CHILDREN_LIMIT`, `senderSessionIdOf`, `classifyMessage`, `classifyBatch`, `rememberManualChild`, `forgetManualChildrenOf`, `stepAutomatic`, `autoMode`, слушатель `subagent/start`. `NEUTRAL_KINDS` оставить.
2. Импорт `nextSwitchAt`; консты `SEED_SPECIAL`, `PARENT_HOPS_LIMIT=32`.
3. Файл состояния: `loadSpecialFile()` → `string[]|null`; `saveSpecialFile(list)` — атомарно (tmp+rename), пустой массив пишется; `normalizeSpecialList`.
4. `runtime`: `special:Set`, `waiters:Map<id,Set>`, `pauseLogged:Set`, `specialRev:number`, `appliedSpecial:string[]|null` (последнее значение **поля конфига**).
5. `activate()`: `special = file ?? configValue ?? SEED`; `appliedSpecial = configValue ?? null`; лог `signal … actor=seed|config|file | rev=0` на каждую сессию; при расхождении файла и конфига — `state-conflict`.
6. `update(config)`: сравнивать **поэлементно нормализованные** списки (`normalizeSpecialList`, `undefined ≡ null`, порядок нормализуется) — не по ссылке: `Volatile.get()` отдаёт новый массив на каждый `flatten` (F1r); при отличии — при изменении — применить в `special`, `appliedSpecial = newList`, `specialRev+=1`, `saveSpecialFile`, лог `signal | state=on|off | actor=ui-config | rev=<n>` на каждую изменённую сессию, `releaseSignalled()`.
7. `hasSignal(id)`: подъём по `agents.get(id)?.session?.header?.parentSession` ≤32 с `visited`; нет агента → сигнала нет.
8. `releaseSignalled()`, `releaseSession(id)`, `releaseAll()`; `untilGreen(id, signal)` через `waiters` по сессиям.
9. `refresh()`: на `red→green` — `releaseAll()` + очистка `pauseLogged`; на границе окон — сброс `pauseLogged`.
10. `llm/stream`: `purpose !== undefined` → пропустить (D12); гейт `hasSignal(id)`; `id === ''` → пропустить (fail-open только при полностью неизвестной сессии); иначе лог `pause` (раз на сессию/окно) и `await untilGreen`.
11. `agent/pre-step`: отклонение пустого хода сохранить; у сессии со сигналом — `enter` (D11). Классификации сообщений нет; **предикат пустого хода** (E5, F5r): `light === 'red' && !hasSignal(id) && step === 1` и все сообщения батча принадлежат `NEUTRAL_KINDS` (или батч пуст); на зелёном отклонения нет.
12. `agent/inbox/inserted`: удержание только `schedule`.
13. `agent/disposed`: `releaseSession(id)`, чистка `pauseLogged`.
14. `deactivate()`: `releaseAll()` до обнуления, очистка карт, `redeliverHeld` как есть.
15. Docstring — новая модель (пауза всех, спецсигнал, fail-closed, §11).
16. `index.js`: `TRAFFIC_LIGHT_SPECIAL_SEED` + поле §4.1 + комментарий t1447u; docstring `attachTrafficLight` — список проходит через `update`.

### P2 — клиент (`frontend-sr`, только `client.js`)
1. Константы `LIGHT_SIGNAL_FIELD`, `data-*` (§4.4) рядом с `LIGHT_PREFS_KEY` (~2924).
2. `lightHub`: `special:Set` + `getSpecial()`; в `setConfig` нормализовать `trafficLightSpecial`.
3. Хелперы: `lightSessionId()` через `[data-conversation-session]`; `lightFormsController()`; `useLightController()`; `useReducedMotion()` (guard); `writeSignal()` (единственное имя записи поля `trafficLightSpecial`) по образцу `writeFlag`; при отказе **перечитать снимок и применить add/remove к свежему списку**, один повтор + `aria-invalid`/`title` 5 с + `role="alert"` (F4r); `lightSignalStatus(now,id)`.
4. `TrafficLightSignalToggle` рядом с лампой: `aria-pressed`, `data-dsh-light-signal`, `data-motion`, `title`; без текстовых детей; без `animation` в срезе индикатора. **Порядок детей док-строки фиксирован** (qa-F1): `Fragment( button-лампа, toggle, panel|null )` — тумблер вторым; лампа обязана иметь `data-light`, панель — `data-dsh-light-panel` (маркеры для локаторов).
5. `TrafficClockPanel`: строка `[data-dsh-light-status]`; в блоке спецсигнала — тот же toggle с `data-dsh-light-signal-in="panel"`; **статус обязан быть и у лампы** (`aria-label`/`title` кнопки-лампы = `light.status.*` с подстановкой `formatTarget(until, now, t)` — без доп. «до», шаблон его уже содержит (F-ui11); новых `data-*` у лампы не вводим).
6. `LIGHT_STYLE_TEXT`: `-signal`, `-signal-dot`, `@keyframes -strobe` (двойная вспышка); стили — от классов `-signal--on|--off` (маркер `[data-dsh-light-signal="on"]` остаётся алиасом), `data-motion` ставится **на каждую копию** компонента, `[data-motion="reduced"]` → статика (F-ui7).
7. Словари en ~416 / ru ~498 — ключи §4.5. `locale/*.json` не трогаем. `localStorage` не используем (D15).

### P3 — тесты (`qa-sr`)
Хост (`test/check-traffic-light.cjs`): в шапке `process.env.TZ='Europe/Moscow'` до первого `Date`; **та же строка в шапке `test/check-client.cjs`** (там `getHours()` даёт HH:MM статуса) — E3; моки — реестр `agents.list/get` с цепочкой `parentSession` (цикл, >32), `currentInitiator` (уже есть в харнессе), `logSince(mark)`; кейсы «id берётся из `currentInitiator`, а не из `options`» и «пустой id → вызов проходит + строка `signal-less`» (F5); все проверки через `settle()`+флаг (`startCall`), «ждёт» дополнительно подтверждается строкой `pause`; фикстуры старых 3.2/3.4/3.4а переводятся на браузерный payload (иначе смысл кейсов меняется).
- (а) автоход на красном `done===false`; на зелёном `done===true`; удержанное расписание доехало;
- (б) сигнал на `session-parent` → проходят она/`child`/`grandchild`; `session-other` ждёт; **подкейс fail-closed**: `agents.get` не знает сессию (или служба `agents` спрятана) + `options.sessionId` задан → `hasSignal` false, строка `pause` (E2);
- (б2) пределы: цикл из 3 и цепочка 33 — подъём конечен, за 32-м хопом сигнала нет;
- (в) **сообщения пропуск не дают**: человеческий промпт `{kind:'user', rpcId, clientTimeZone}` на красном ждёт; промпт continuable-ребёнка (та же форма) ждёт; `agent-message`/`subagent-settled`/`team-message` ждут; экспорт модуля ровно `{activate,update,deactivate}`, в `index.js` нет регистрации tools;
- **внимание (E1)**: старые кейсы 3.2/3.4/3.4а («ручной шаг на красном проходит») под D3 **инвертируются** — они начинают ожидать ожидание (ждёт + строка `pause`); это осознанная потеря, помеченная в AC и в fail-expected, а не ослабление тестов;
- (г) сигнал действует через несколько красных окон, пока не выключен (второе окно — снова проходит);
- (ж) персистентность через `await deactivate()` + `activate(newCtx, cfg)`: файл `[]` + поля нет → off; файла нет + поля нет → seed on; битый файл + поле `['x']` → `['x']`; битый файл + поля нет → SEED; конфиг со seed + файл `[]` → off; конфиг `[]` + файл со старым списком → файл авторитетен + `state-conflict`; `update()` от постороннего volatile-поля (`zoom`) не пишет файл и не логирует `signal`;
- (з) seed в `index.js` содержит `session-e4698bf8-…`;
- (е) ночные окна через гейт: 04:00 без сигнала ждёт / с сигналом проходит; 07:30 и 13:30 — свободно; триггер `goal`, окна из `normalizePolicy(null)`;
- (п1) `purpose` на красном проходит сразу; (п2) пустой шаг: без сигнала на красном → `reject`, со сигналом → `enter`, **на зелёном — `enter`** (F5r);
- (л) лог: структурированные строки только в файле; `trafficLight: …` не изменились; `until` = конец окна; `pause` дедуплицирован;
- (м) `activate` пишет `signal … rev=0` для каждой сессии сида.
Клиент (`test/check-client.cjs`): песочница получает `matchMedia` (matches переключаемо), ветку `querySelector('[data-conversation-session]')` и **курсор хуков** (переживание `useState` между рендерами + снятие эффектов предыдущего рендера, как в React, ~15 строк; код плагина не меняется) — E6, иначе подписки/таймеры копятся и `formsSubscribers()===1` становится ложным.
- **перевод локаторов (qa-F1, не ослабление)**: старые ассерты `check-client.cjs:2240,2245` (`tree.children[0].type==='button'`, `tree.children[1]===null`) переводятся на маркеры: лампа — `data-light`, панель — `data-dsh-light-panel` (или `null`), с явной пометкой в AC P3;
- (д) toggle у лампы, `data-dsh-light-signal` единственный в DOM (копия в панели — `data-dsh-light-signal-in="panel"`), `aria-pressed`, `title` переключателя **точно равен** «Спецсигнал: чат и его команда работают на красном (дороже вдвое)» (F-ui12), `aria-label` лампы содержит статус; клик → ровно один `mutate(['trafficLightSpecial'])` с id из DOM (два — только подкейс stale revision), повторный клик убирает; `writable:false` → disabled; `localStorage` не изменился; stale revision → один повтор + `aria-invalid`;
- (д2) дочерний чат: сигнал родителя клиенту не виден → базовый `paused`;
- `[data-dsh-light-alert]` появляется при отказе записи и содержит `light.signal.blocked` (F7r);
- reduced-motion → `data-motion="reduced"` + правило в тексте CSS + нет `animation` в inline-стиле тумблера;
- статусы `paused|bypass|free` с корректным HH:MM; паритет ключей §4.5 в обоих словарях; `?tweaks=off` и `trafficLight:false` — элементов нет.

### P4 — стенд (`qa-sr`)
`test/traffic-light-stand.html` — автономно, без сети: зелёный, жёлтый, красный `paused` («ждёт зелёного до HH:MM»), красный со спецсигналом вкл и выкл, `reduced-motion`, таблица «состояние → ожидание». Ассерты стенда (offline, 7 секций, `data-*`) — в этом же пакете, в `check-traffic-light.cjs` (P3 их не содержит).

### P5 — прогон (`qa-sr`)
`node --check` ×3; 16 × `timeout 120 node test/check-*.cjs`; `/tmp`: `git -c safe.directory="$PWD" worktree add /tmp/tl-base 9b9ac36` + копия трёх тест-файлов. **fail-expected**: {(б),(б2),(в),(г),(ж),(з),(е),(п2),(л),(м),(д),(д2), «пустой id + `signal-less`», стенд-кейс, инвертированные 3.2/3.4/3.4а}; «id из `currentInitiator`» → pass-expected; **pass-expected**: {(а),(п1), 3.1, 3.3, 3.5, 3.6, 3.7}. `exit=124` = FAIL. Неожиданный fail/pass — стоп и разбор, а не правка ожиданий (E1, F6).

### P6 — приёмка (`arch-lead`)
Контракты §4; grep по 13 удалённым именам (`manualChildren`, `stepAutomatic`, `autoMode`, `subagent/start`, `rememberManualChild`, `forgetManualChildrenOf`, `classifyMessage`, `classifyBatch`, `senderSessionIdOf`, `AUTOMATIC_KINDS`, `USER_KINDS`, `MANUAL_LINEAGE_KINDS`, `MANUAL_CHILDREN_LIMIT`) — пусто; `special.json` перекрывает конфиг и держит выключение; сообщения пропуск не дают (кейс (в)); политика байт-в-байт в `client.js`; режим файлов планов `644` (`git -c safe.directory="$PWD" add --chmod=-x docs/plans/*.plan.md` перед коммитом); один коммит, дерево чисто; прод/push не тронуты.

### P7 — README под факт (`arch-lead`, после P5)
Раздел светофора: пауза всех, спецсигнал (+seed t1447u), **пропуск только кнопкой и почему** (relay/deputy evidence), статус, ночные окна МСК, строки лога, `actor=ui-config`, границы §11, `gate2-verify` сильнее (nginx-лог + браузерный POST с внешнего IP), усиление — `principal` для сервисных учёток хаба или транспортный хук `connection/request` (предложение, не делать).

## 6. Команда и оценка

| # | Имя | Дисциплина | Ур. | Модель / усилие | Зона | AC | deps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `arch-lead` | arch | lead | inherited (Lead) / high | `README.md`, план | панель 0 bl; README ↔ код | — |
| 2 | `backend-lead` | backend | lead | inherited (Lead) / high | `index.js`, `tweaks/traffic-light-host.js` | P1 AC | P0 |
| 3 | `frontend-sr` | frontend | sr | inherited (Lead) / high | `client.js` | P2 AC | P0 |
| 4 | `qa-sr` | qa | sr | inherited (Lead) / low | `test/*.cjs`, стенд | P3–P5 AC | P1,P2 |

Панель: `arch-lead` + `qa-sr` + `frontend-sr`; `backend-lead` — автор host-зоны. `|lanes ∪ панель| = 4`, `+2 = 6 ≤ maxMembers`.
**Оценка**: ≈4 места ≈ **150–220k токенов** (оценка) — без изменений относительно rev=1 (rev=3 сокращает код, не команду).

## 7. UI-макет

```
 ( ● )  ( ⬤ )   лампa + переключатель спецсигнала; off — тускло-серый,
                 on — синий стробоскоп (двойная вспышка), reduced-motion — статика

Панель:
│ Сейчас: пн, красный
│ Статус: ждёт зелёного до 13:00            [data-dsh-light-status=paused]
│ Спецсигнал: [ ⬤ выкл ] «чат и команда работают на красном (дороже вдвое)»
│ Смена тарифа: пн 14:00 (через 1 ч)
on → «спецсигнал: работа на красном (вдвое дороже) до 13:00»; free → «вне пика — до пн 04:00»
```

## 8. Аудит

### 8.1 Исследование отправителей промптов (read-only, 2 explorer'а)
| Отправитель | `clientTimeZone` | Аутентификация | Отличимость хосту |
| --- | --- | --- | --- |
| браузер владельца | да (`Intl…timeZone`) | cookie v1 → `owner` | UA/IP только в nginx, в сессии нет |
| `harness-relay` (deputy/reply) | **да, константа `Europe/Moscow`** | cookie владельца, loopback мимо nginx | `source` байт-в-байт как у браузера; UA `Python-urllib` в сессию не пишется |
| `deputy-wake-prompt.py` | **да, константа** | cookie владельца, loopback | то же |
| `poseidon-watchdog.sh` | через relay | наследует | то же |
| `ask.py` (инбокс) | нет | файл + wake | промптов не шлёт |
| хаб-прокси nginx | не формирует | SSO + подстановка owner-cookie | канал, не отправитель |
**Вывод:** `clientTimeZone`, `rpcId`, `principal` человека не отделяют; единственный надёжный признак на хосте — nginx-лог (как в `gate2-verify`) либо транспортный хук `connection/request` с AsyncLocalStorage (как scope-guard). Отсюда D3: пропуск только кнопкой.

### 8.1а Требования Игоря (дословно, для сверки P6/P7)
- t1446u: «Нужно сделать так, чтобы автоматически запущенные процессы на красном свете ставились на паузу и автоматически продолжались при зелёном свете»; «я конкретному агенту говорю "продолжай" (или нажимаю какую-то кнопку) и он продолжает работать при красном свете вместе со своей командой субагентов и субсубагентов»; «с 4 до 7 утра она бы сама приостанавливалась, а с 7 до 9 продолжалась и снова на паузу до 13».
- t1447u: «рядом с индикатором красным поставить ещё один индикатор-переключатель… повышает приоритет, и он работает при красном свете. Анимацию… синей мигалкой, как спецсигнал президентского кортежа»; «остаётся включённым через любое число красных окон, пока человек его не выключит»; «начальное значение… session-e4698bf8-717f-4e1a-9390-a2b40c03d985 с пометкой "включено по решению Игоря t1447u"».
- Отступление, согласованное руководителем: «продолжай» словами **не** даёт пропуска (неотличимо от сервиса, §8.1); работает кнопка. Следствие D3 шире: **любой** человеческий ввод на красном (в том числе новый вопрос) ждёт до зелёного — F6r, §11.2.

### 8.2 Находки и решения
| ID | sev | Находка | Решение в rev=3 |
| --- | --- | --- | --- |
| qa-F1 | bl | старые фикстуры `{kind:'user'}` виснут под новым правилом | кейс (в) + перевод фикстур 3.2/3.4/3.4а на браузерный payload (P3) |
| arch-A1 | maj | `appliedSpecial` из эффективного набора → правка чужого флага включает обход | D4: `appliedSpecial` = последнее значение **поля конфига**; P1.6; подкейс (ж) |
| arch-A2 | maj | у «снять пропуск» не было источника данных | **снято**: разового пропуска нет (D3/D6), кнопка не рендерится |
| arch-A3 | maj | `pass-deny` для неизвестных видов противоречил P1 | **снято**: линий `pass/pass-deny` больше нет (D3/D9) |
| qa-D1 | maj | таблица ожиданий P5 неверна | §5/P5 таблица fail/pass-expected переписана |
| qa-D2 | maj | клиентские кейсы панели неисполнимы без курсора хуков | P3: курсор хуков в песочнице + кейс (д) |
| ui-F-ui1 | min | неоднозначный `[data-dsh-light-signal]` при открытой панели | §4.4: маркер только у лампы, копия — `-in="panel"` |
| ui-F-ui2 | maj | потерян статус в тултипе лампы | P2.5: `aria-label`/`title` лампы = `light.status.*` + HH:MM |
| ui-F-ui3..5 | min | условия рендера «снять», место подсказки D14, формирование revoke | кнопки «снять» больше нет; подсказка D14 — на переключателе; revoke-поле не вводим |
| arch-A4..A7 | min | revoke/логи/сид/конфликт файла | D5/D9: `revokeSeen` не нужен; `signal … rev=0` при старте; `state-conflict` |
| arch-A8 | min | двойное владение README (P0/P7) | P0 — только контракты; README — P7 |
| arch-A9 = qa-D1 | — | дубль | закрыто qa-D1 |
| arch-A10 | min | `purpose`-исключение не отражено | D12 + §11.8 |
| qa-D3..D11 | min | формулировки подкейсов, TZ, лимиты, порядок P3/P4, запрет `await`, reduced-motion | P3/P4/P5 переписаны (§5) |
| арх-F1..F15 (rev=1) | 9 maj/6 min | леджер/фильтр/предикат/fail-open/AC/README/локаль/статус/тест(ж) | закрыты в rev=2 и уточнены в rev=3 (§3, §4, P7) |
| уточнение рук. | — | субагентский промпт похож на человеческий | **снято**: сообщения пропуск не дают вообще (кейс (в)) |

Квитанции: rev=1 — qa 1 bl/9 maj/6 min (fail), arch 0 bl/9 maj/6 min, ui 1 maj/3 min; rev=2 — arch 2 maj/8 min (fail), qa 2 maj/9 min (fail), ui 1 maj/4 min (fail). rev=3 снимает majors сокращением механики (D3/D6) и правками P3/P5 — требуется diff-аудит рубрик arch/security, qa, ui.

## 9. Журнал (MSK)

| ms | маркер | событие |
| --- | --- | --- |
| 2026-11-11 14:04 | step | разведка ядра: `user-rpc`, `clientTimeZone`, owner-peer, персистентность volatile, `configForms` |
| 2026-11-11 14:16 | gate | GATE-1: `exit_plan_mode` → GO (руководитель), 3 уточнения в журнал |
| 2026-11-11 14:18 | spawn | 4 места + панель (3 из 4) + 2 explorer'а (R) |
| 2026-11-11 14:31 | audit | rev=1: qa 1 bl/9 maj/6 min; arch 0 bl/9 maj/6 min; ui 1 maj/3 min |
| 2026-11-11 14:36 | step | rev=2: 32 находки разобраны, контракты уточнены |
| 2026-11-11 14:38 | audit | rev=2 diff: arch 2 maj (A1,A2); qa 2 maj (D1,D2); ui 1 maj (F-ui2) |
| 2026-11-11 14:40 | finding | R-исследование: `harness-relay:113-117` и `deputy-wake-prompt.py:11-16` шлют `clientTimeZone` const с owner-cookie, `source` байт-в-байт (session-11e30c5d:139); `principal`=0 во всех session store |
| 2026-11-11 14:41 | decision | D3: разовый пропуск отменён, пропуск только кнопкой (правило руководителя «если признака нет — только кнопка»); снимает A2/A3/A4 и UI «снять» |
| 2026-11-11 14:43 | step | rev=3: predicate/pass-lines/momentary/revoke удалены, P3/P5 переписаны, стенд-ассерты → P4 |
| 2026-11-11 14:44 | reaudit | diff | trigger=rev=3 после majors A1/A2/D1/D2/F-ui2 | рубрики arch/security, qa, ui |
| 2026-11-11 14:49 | audit | rev=3 diff: arch 0 bl/0 maj/9 min (GO); ui 0 bl/0 maj/5 min (GO); qa 0 bl/2 maj/4 min (NO-GO: E1,E2) |
| 2026-11-11 14:52 | finding | E1 maj (3.2/3.4/3.4а инвертируются под D3), E2 maj (fail-closed без проверки) → правки rev=4 |
| 2026-11-11 14:55 | step | rev=4: E1–E6, F-ui6–F-ui10, F1–F9 закрыты (контракты §4.4/§4.5, P1/P3/P5, §11) |
| 2026-11-11 15:02 | audit | rev=4: arch GO (0 maj/7 min F1r–F7r); ui GO (0 maj/2 min); qa NO-GO (1 maj qa-F1 + 3 min) |
| 2026-11-11 15:06 | step | rev=5: порядок детей док-строки + маркеры локаторов (qa-F1), `save-error`/`signal-less` в контракт, поэлементное сравнение, `savePending`, предикат пустого хода с red&&!hasSignal, дельта при stale, `[data-dsh-light-alert]`, точный `title`, шаблоны `{{time}}` |
| 2026-11-11 15:07 | reaudit | diff | trigger=rev=5 (maj qa-F1) | рубрики qa (таблица/локаторы), arch (контракт §4.3/§4.4), ui (2 min) |
| 2026-11-11 15:10 | audit | rev=5: qa pass (0 новых), arch GO (0 maj), ui GO (0 maj) → GO на исполнение всем трём зонам |
| 2026-11-11 15:14 | spawn | GO P1 (backend-lead), P2 (frontend-sr), P3/P4 (qa-sr); arch-lead готовит чек-лист P6 |
| 2026-11-11 15:22 | step | P1 готов: `tweaks/traffic-light-host.js` 803 стр., `index.js` 680; гейт `hasSignal`, леджер `special.json` (file→config→SEED, атомарно, `savePending`), строки D9, 13 мёртвых имён удалены; `node --check` 0/0 |
| 2026-11-11 15:26 | step | P2 готов: `client.js` +402/−25; тумблер вторым ребёнком дока из `Fragment(лампа, toggle, panel\|null)`, статус у лампы и в панели, `writeSignal()` с дельтой, `[data-dsh-light-alert]`, CSS-стробоскоп + reduced-motion, 7 ключей локали |
| 2026-11-11 15:33 | step | P3/P4 готовы: host 25 кейсов exit=0 (включая инверсии 3.2/3.4/3.4а), `check-client` все проверки, стенд `test/traffic-light-stand.html` (7 секций, без сети) |
| 2026-11-11 15:35 | step | P5: `node --check` 3/3; 16 сьютов = 15×0 + `composer-mode` env-гейт (на базе тот же exit=1); `/tmp` на `9b9ac36`: host «ожидания совпали (25 кейсов)», client 10 падений ровно в (д)/(д2), `exit=124` нет |
| 2026-11-11 15:37 | step | P7: arch-lead пишет README под факт; далее коммит (backend-lead) и приёмка P6 (arch-lead) |

## 10. Проверки

| Пакет | Проверка | Ожидаемо | Кто | Приёмка |
| --- | --- | --- | --- | --- |
| P1 | `timeout 120 node test/check-traffic-light.cjs` | exit=0, кейсы (а)(б)(б2)(в)(г)(ж)(з)(е)(п1)(п2)(л)(м) | qa-sr | arch-lead |
| P2 | `timeout 120 node test/check-client.cjs` | exit=0, кейсы (д)(д2) + статусы | qa-sr | arch-lead |
| P1+P2 | 16 × `test/check-*.cjs` | 15×0 + env-гейт `composer-mode` | qa-sr | arch-lead |
| всё | `node --check` ×3 | 0/0/0 | qa-sr | arch-lead |
| P1–P3 | `/tmp` (`worktree add 9b9ac36`) | fail-expected падает, pass-expected зелёный, не 124 | qa-sr | arch-lead |
| P4 | стенд + ассерты | 7 секций, без сети | qa-sr | arch-lead |
| всё | `git show --stat`, `status` | 1+ коммит, дерево чисто, режимы 644 | arch-lead | arch-lead |

## 11. Границы (README)
1. Принципал кнопки недоступен (`configForms` без принципала) → `actor=ui-config`; клиент с owner-cookie технически может дёрнуть `configForms` — модель угроз твика; усиление: свой typert-неймспейс либо `principal` для сервисных учёток хаба.
2. Сообщение (человека, агента, сервиса, в т.ч. субагента и relay) **не даёт** пропуска: `clientTimeZone`/`rpcId`/`principal` не отделяют, IP/UA в сессии нет (§8.1).
3. `parentSession` читается только у живых агентов → выгруженный предок = пауза (fail-closed).
4. Дочерний чат показывает базовый статус (наследование не видно клиенту).
5. Спецсигнал действует через любое число окон, пока не выключен (D13).
6. Расписания удерживаются и возвращаются на зелёном; прочие сообщения не изымаются.
7. Скриншоты — за руководителем.
8. Служебные вызовы с `purpose` на красном не ждут (D12).
9. Fail-open только при полностью неизвестной сессии (`id === ''`) — единственный обход без кнопки; пишется строка `signal-less` (F5).
10. UI показывает **конфиг**, гейт работает по **файлу**; расхождение легально и видно только строкой `state-conflict` в логе (F3).

## 12. Откат
`git -c safe.directory="$PWD" reset --hard 9b9ac36` в worktree; `special.json` удаляется; DSH и прод-каталог не тронуты.
