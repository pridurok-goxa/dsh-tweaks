/** Dependency-free contract tests for the real mobileComposer region. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');
const region = source.split('/* #region tweak-mobile-composer */')[1].split('/* #endregion tweak-mobile-composer */')[0];
const context = vm.createContext({AbortController});
vm.runInContext(region + '\nthis.bind = bindMobileComposer; this.mobile = mobileComposerDevice; this.queueEnter = queueEditorEnter; this.bindQueue = bindQueueEditorEnter; this.caretDelta = caretScrollDelta; this.goalEnter = goalEditorEnter; this.textareaEnter = textareaEnterNewline;', context);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok', name); }
function fixture(coarse = true, mobile = false) {
  const listeners = new Map();
  const root = { attrs: {contenteditable: 'true'}, getAttribute(key) { return this.attrs[key]; } };
  const card = {
    contains: (el) => el === root,
    addEventListener(type, fn, capture) { assert.equal(capture, true); listeners.set(type, fn); },
    removeEventListener(type, fn, capture) { assert.equal(capture, true); if (listeners.get(type) === fn) listeners.delete(type); },
  };
  let draft = 'prefix suffix', start = 7, end = 7, insertions = 0, reject = false;
  const actions = {
    captureInsertion() { return {start, end, draftRev: 1}; },
    insertText(text, span) { if (reject) return false; insertions++; draft = draft.slice(0, span.start) + text + draft.slice(span.end); start = end = span.start + text.length; return true; },
  };
  const off = context.bind(card, actions, {matchMedia: () => ({matches: coarse}), navigator: {userAgentData: {mobile}}});
  return {
    root, card, listeners, off,
    get draft() { return draft; }, get insertions() { return insertions; },
    select(a, b) { start = a; end = b; }, reject() { reject = true; },
    event(type, props = {}) {
      const e = { target: {closest: () => root}, key: 'Enter', defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...props };
      listeners.get(type)?.(e); return e;
    },
  };
}
const clipboard = (text, items = []) => ({getData: () => text, items});
test('mobile Enter inserts at caret, never reaches send', () => { const f = fixture(); const e = f.event('keydown'); assert.equal(f.draft, 'prefix \nsuffix'); assert(e.defaultPrevented && e.stopped); });
test('mobile Shift/Ctrl/Meta Enter all remain button-only', () => { for (const mod of ['shiftKey', 'ctrlKey', 'metaKey']) { const f = fixture(); assert(f.event('keydown', {[mod]:true}).stopped); assert.equal(f.insertions, 1); } });
test('desktop Enter and Shift+Enter pass through unchanged', () => { const f = fixture(false); for (const shiftKey of [false,true]) assert(!f.event('keydown', {shiftKey}).stopped); assert.equal(f.insertions, 0); });
test('coarse pointer detection does not rely on width/touch count', () => { assert.equal(context.mobile({matchMedia:()=>({matches:false}), navigator:{maxTouchPoints:10},innerWidth:390}), false); });
test('userAgentData.mobile fallback', () => { const f = fixture(false, true); assert(f.event('keydown').stopped); });
test('beforeinput-only Android Enter inserts newline', () => { const f = fixture(); assert(f.event('beforeinput', {inputType:'insertParagraph'}).stopped); assert.equal(f.draft, 'prefix \nsuffix'); });
test('beforeinput insertLineBreak inserts newline', () => { const f = fixture(); f.event('beforeinput', {inputType:'insertLineBreak'}); assert.equal(f.insertions, 1); });
test('IME Enter is not a send or an extra newline', () => { for (const props of [{isComposing:true},{keyCode:229}]) { const f = fixture(); const e = f.event('keydown', props); assert(e.stopped && !e.defaultPrevented); assert.equal(f.insertions,0); } });
test('IME Enter commits composition and adds the newline once', () => {
  const f = fixture(); let now = 1000; context.Date = {now:()=>now};
  f.event('compositionstart'); assert(f.event('keydown').stopped); assert.equal(f.insertions,0);
  f.event('compositionend'); assert.equal(f.insertions,1, 'первый Enter после композиции уже даёт перенос');
  now += 11; f.event('keydown'); assert.equal(f.insertions,2, 'следующий Enter — обычный перенос'); delete context.Date;
});
test('ordinary composition/text input remains native', () => { const f = fixture(); assert(!f.event('beforeinput', {inputType:'insertCompositionText',data:'字',isComposing:true}).stopped); });
test('paste preserves all lines, blank lines, tabs and trailing newline', () => { const f = fixture(); f.event('paste', {clipboardData:clipboard('first\n\nsecond\tя\n')}); assert.equal(f.draft,'prefix first\n\nsecond\tя\nsuffix'); assert.equal(f.insertions,1); });
test('CRLF/CR normalize without truncation', () => { const f = fixture(); f.event('paste', {clipboardData:clipboard('first\r\n\r\nsecond\rthird')}); assert.equal(f.draft,'prefix first\n\nsecond\nthirdsuffix'); });
test('paste replaces selected span without losing suffix', () => { const f = fixture(); f.select(0,6); f.event('paste', {clipboardData:clipboard('а\nб')}); assert.equal(f.draft,'а\nб suffix'); });
test('beforeinput-only clipboard data fallback', () => { const f = fixture(); f.event('beforeinput', {inputType:'insertFromPaste',data:'a\nb'}); assert.equal(f.draft,'prefix a\nbsuffix'); });
test('beforeinput DataTransfer plain text fallback', () => { const f = fixture(); f.event('beforeinput', {inputType:'insertFromPaste',dataTransfer:clipboard('a\n\nb')}); assert.equal(f.draft,'prefix a\n\nbsuffix'); });
test('file/image and mixed text+file paste stay upstream-owned', () => { for (const type of ['paste','beforeinput']) { const f=fixture(); assert(!f.event(type,{inputType:'insertFromPaste',clipboardData:clipboard('a\nb',[{kind:'file'}]),dataTransfer:clipboard('a\nb',[{kind:'file'}])}).stopped); assert.equal(f.insertions,0); } });
test('empty clipboard and missing text pass through', () => { const f=fixture(); assert(!f.event('paste',{clipboardData:clipboard('')}).stopped); assert.equal(f.insertions,0); });
test('readonly composer and unrelated input are ignored', () => { const f=fixture(); f.root.attrs.contenteditable='false'; assert(!f.event('keydown').stopped); f.root.attrs.contenteditable='true'; assert(!f.event('keydown',{target:{closest:()=>null}}).stopped); });
test('already consumed events are not repeated', () => { const f=fixture(); f.event('keydown',{defaultPrevented:true}); assert.equal(f.insertions,0); });
test('revision rejection cannot fall through to send', () => { const f=fixture(); f.reject(); assert(f.event('keydown').stopped); assert.equal(f.draft,'prefix suffix'); });
test('two quick Returns are both preserved', () => { const f=fixture(); f.event('keydown'); f.event('keydown'); assert.equal(f.draft,'prefix \n\nsuffix'); });
test('session/card isolation', () => { const a=fixture(), b=fixture(); a.event('keydown'); assert.equal(b.insertions,0); });
test('cleanup removes every capture listener', () => { const f=fixture(); assert.equal(f.listeners.size,6); f.off(); assert.equal(f.listeners.size,0); });
test('overlay component binds public actions and cleans up on unmount', () => {
  const f=fixture(); f.off(); const effects=[];
  const view={matchMedia:()=>({matches:true})}; f.card.ownerDocument={defaultView:view};
  context.React={useRef:()=>({current:{closest:()=>f.card}}),useEffect:fn=>effects.push(fn),createElement:(type,props)=>({type,props})};
  const node=context.MobileComposerBinding({inputActions:{captureInsertion:()=>({start:0,end:0,draftRev:1}),insertText:()=>true}});
  assert.equal(node.props.hidden,true); const cleanup=effects[0](); assert.equal(f.listeners.size,6);cleanup();assert.equal(f.listeners.size,0);
});
test('caret scroll delta reveals the caret below and above the draft viewport', () => {
  assert.equal(context.caretDelta({ top: 120, bottom: 140 }, { top: 0, bottom: 100 }), 40);
  assert.equal(context.caretDelta({ top: -20, bottom: 0 }, { top: 0, bottom: 100 }), -20);
  assert.equal(context.caretDelta({ top: 10, bottom: 30 }, { top: 0, bottom: 100 }), 0);
});

test('composer wiring keeps the new mobile behaviors', () => {
  assert.match(source, /function filterPlusMenu\(\)/);
  assert.equal(source.includes('plusMenuOpen = true'), false, 'твик больше не перехватывает клик «+»');
  assert.equal(source.includes('setMenu(menu, name, value)'), false, 'твик не переписывает позицию меню');
  assert.match(source, /PLUS_MENU_ALIASES/, 'фильтр «+» знает канонические alias');
  assert.match(source, /_itemAlias/, 'alias читается из разметки, независимо от локали');
  assert.ok(source.includes("'Файл', 'Цель', 'План'"), 'русские подписи тоже разрешены');
  assert.match(source, /guardSlash\(\)/);
  assert.match(source, /dismissMenu\(\)/);
  assert.match(source, /revealComposerSoon\(card, view\)/);
  assert.match(source, /height \* 0\.2/, 'высота черновика вдвое меньше');
  assert.ok(source.includes("setAttribute('spellcheck', 'false')"), 'подчёркивание проверки орфографии снято');
  assert.ok(source.includes("setAttribute('autocorrect', 'off')"), 'автокоррекция не подчёркивает слово');
  assert.match(source, /finishCompositionEnter\(\)/, 'перенос после IME-композиции');
  assert.ok(source.includes('webkit-composition-frame-color'), 'рамка IME-композиции скрыта');
  assert.equal(source.includes("name: 'conversation.input.left'"), false, 'кастомного чипа режима нет — остаётся системный');
  assert.ok(source.includes("'session.copyId'"), 'пункт копирования id объявлен');
});

test('any textarea on touch keeps Enter as a newline', () => {
  const view = { matchMedia: () => ({ matches: true }) };
  assert.equal(context.textareaEnter({ key: 'Enter', target: { tagName: 'TEXTAREA' } }, view), true);
  assert.equal(context.textareaEnter({ key: 'Enter', target: { tagName: 'INPUT' } }, view), false);
  assert.equal(context.textareaEnter({ key: 'Enter', isComposing: true, target: { tagName: 'TEXTAREA' } }, view), false);
  assert.equal(context.textareaEnter({ key: 'Enter', target: { tagName: 'TEXTAREA' } }, { matchMedia: () => ({ matches: false }) }), false);
  assert.match(source, /bindTextareaEnterNewline\(document, window\)/);
});

test('goal editor Enter inserts a newline instead of saving', () => {
  const view = { matchMedia: () => ({ matches: true }) };
  const textarea = (root) => ({ tagName: 'TEXTAREA', closest: (selector) => (root && selector === '[data-goal-bar]' ? {} : null) });
  assert.equal(context.goalEnter({ key: 'Enter', target: textarea(true) }, view), true);
  assert.equal(context.goalEnter({ key: 'Enter', target: textarea(false) }, view), false);
  assert.equal(context.goalEnter({ key: 'Enter', isComposing: true, target: textarea(true) }, view), false);
  assert.equal(context.goalEnter({ key: 'x', target: textarea(true) }, view), false);
  assert.equal(context.goalEnter({ key: 'Enter', target: textarea(true) }, { matchMedia: () => ({ matches: false }) }), false);
  assert.match(source, /bindGoalEditorEnter\(document, window\)/);
  const css = source.split('function mobileDrawerStyleText')[1].split('function MobileSidebarIcon')[0];
  assert.ok(css.includes('[data-goal-bar]{width:100vw!important'));
  assert.ok(css.includes('column-reverse!important'), 'крестик сверху, галочка снизу');
  assert.ok(css.includes('[data-goal-bar] textarea{width:100%!important'));
});

test('stuck pending queue echo can be returned to the editor', () => {
  assert.match(source, /function installStuckQueueRecovery\(/);
  assert.match(source, /installStuckQueueRecovery\(ctx, api\)/);
  assert.match(source, /data-submission-echo/);
  assert.match(source, /retireFailedSubmission/);
  assert.match(source, /mobileComposerActions\.setDraft\(item\.text\)/);
});

test('plus and @ do not blur the editor: keyboard stays in place', () => {
  assert.doesNotMatch(source, /scheduleAtBlur/);
  assert.doesNotMatch(source, /openReferenceMenu/);
});

test('schema/default/registration are inside the existing tweak package', () => { assert(source.includes("titleKey: 'tweak.mobileComposer'")); assert(source.includes("slots.inject('conversation.input.overlay'")); assert(fs.readFileSync(path.join(__dirname,'..','index.js'),'utf8').includes('mobileComposer: Schema.boolean().default(true).volatile()')); });

// Очередь: Enter в InlineEditor сохранял сообщение; на touch он должен дать
// браузеру перенос строки, а сохранение остаться кнопке-галочке.
const touchView = { matchMedia: () => ({ matches: true }) };
const desktopView = { matchMedia: () => ({ matches: false }) };
function queueEvent(overrides = {}) {
  return {
    key: 'Enter',
    defaultPrevented: false,
    isComposing: false,
    keyCode: 13,
    target: { tagName: 'TEXTAREA', closest: (selector) => (selector === '[data-queue-dock]' ? {} : null) },
    stopped: false,
    prevented: false,
    stopPropagation() { this.stopped = true; },
    preventDefault() { this.prevented = true; },
    ...overrides,
  };
}
test('mobile Enter in queued-message editor is left as a newline', () => {
  assert.equal(context.queueEnter(queueEvent(), touchView), true);
});
test('remote input / desktop / other keys keep the editor behavior', () => {
  assert.equal(context.queueEnter(queueEvent({ target: { tagName: 'DIV', closest: () => null } }), touchView), false);
  assert.equal(context.queueEnter(queueEvent({ target: { tagName: 'TEXTAREA', closest: () => null } }), touchView), false);
  assert.equal(context.queueEnter(queueEvent(), desktopView), false);
  assert.equal(context.queueEnter(queueEvent({ key: 'Escape' }), touchView), false);
  assert.equal(context.queueEnter(queueEvent({ defaultPrevented: true }), touchView), false);
});
test('IME confirmation and keyCode 229 are not intercepted', () => {
  assert.equal(context.queueEnter(queueEvent({ isComposing: true }), touchView), false);
  assert.equal(context.queueEnter(queueEvent({ keyCode: 229 }), touchView), false);
});
test('queue wiring stops propagation without preventing the native newline', () => {
  const listeners = new Map();
  const doc = {
    addEventListener(type, fn, capture) { assert.equal(type, 'keydown'); assert.equal(capture, true); listeners.set(type, fn); },
    removeEventListener(type, fn, capture) { assert.equal(capture, true); if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const off = context.bindQueue(doc, touchView);
  assert.equal(listeners.size, 1, 'одна capture-подписка на документ');
  const event = queueEvent();
  listeners.get('keydown')(event);
  assert.equal(event.stopped, true, 'React не получит keydown и не сохранит');
  assert.equal(event.prevented, false, 'браузер сам вставит перевод строки');
  off();
  assert.equal(listeners.size, 0, 'подписка снимается');
});
test('queue listener is owned by the mobile composer setup', () => {
  assert.match(source, /api\?\.own\?\.\(bindQueueEditorEnter\(document, window\)\)/);
});
console.log(`PASS ${passed} mobile composer contract tests`);
