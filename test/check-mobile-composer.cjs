/** Dependency-free contract tests for the real mobileComposer region. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');
const region = source.split('/* #region tweak-mobile-composer */')[1].split('/* #endregion tweak-mobile-composer */')[0];
const context = vm.createContext({});
vm.runInContext(region + '\nthis.bind = bindMobileComposer; this.mobile = mobileComposerDevice;', context);
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
    root, listeners, off,
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
test('cleanup removes every capture listener', () => { const f=fixture(); assert.equal(f.listeners.size,3); f.off(); assert.equal(f.listeners.size,0); });
test('schema/default/registration are inside the existing tweak package', () => { assert(source.includes("titleKey: 'tweak.mobileComposer'")); assert(source.includes("slots.inject('conversation.input.overlay'")); assert(fs.readFileSync(path.join(__dirname,'..','index.js'),'utf8').includes('mobileComposer: Schema.boolean().default(true).volatile()')); });
console.log(`PASS ${passed} mobile composer contract tests`);
