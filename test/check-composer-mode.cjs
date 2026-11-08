/** Real installed HARNESS composer, native claims, public scoped APIs, simulated 412x915 touch DOM.
 * HARNESS_COMPOSER_CLIENT=/path/to/upstream/client.js MOBILE_TEST_RUNTIME=/path/to/dependencies node test/check-composer-mode.cjs
 */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');const {pathToFileURL}=require('node:url');
const req=createRequire(path.join(process.env.MOBILE_TEST_RUNTIME||path.resolve(__dirname,'..'),'package.json'));
(async()=>{
 assert(process.env.HARNESS_COMPOSER_CLIENT,'Set HARNESS_COMPOSER_CLIENT to the installed upstream bundle');
 const {Window}=await import(pathToFileURL(req.resolve('happy-dom')).href);
 const w=new Window({url:'http://localhost/'});let coarse=true;
 w.matchMedia=()=>({matches:coarse,addEventListener(){},removeEventListener(){}});
 w.innerWidth=412;w.innerHeight=915;
 const viewport=new w.EventTarget();Object.assign(viewport,{width:412,height:915,offsetTop:0,offsetLeft:0});w.visualViewport=viewport;
 for(const key of ['window','document','navigator','HTMLElement','Node','Element','MutationObserver'])Object.defineProperty(global,key,{value:key==='window'?w:w[key],configurable:true,writable:true});
 const React=req('react');const {createRoot}=req('react-dom/client');
 const store=initial=>{let state=initial;const subs=new Set();return{getSnapshot:()=>state,set(next){state=next;for(const fn of subs)fn()},subscribe(fn){subs.add(fn);return()=>subs.delete(fn)}}};
 let appZoom=1;w.readScale=()=>appZoom;
 const context=vm.createContext(w);w.React=React;
 w.__ModuleLoader__={load({factory}){w.lib=factory(name=>{
  if(['react','react-dom','react/jsx-runtime','zod'].includes(name))return req(name);
  if(name==='@deepseek-ai/cordis')return{Service:class{}};
  if(name==='@deepseek-ai/dsh-client-store')return{createSnapshotStore:store};return{};
 })}};
 let source=fs.readFileSync(process.env.HARNESS_COMPOSER_CLIENT,'utf8');
 source=source.replace('exports.Config = Config;','exports.test={SessionInputShell,registerComposerKeymap,selectSpan,layout:$composerLayout,DecoratorPortals}; exports.Config = Config;');vm.runInContext(source,context);
 const client=fs.readFileSync(path.join(__dirname,'..','client.js'),'utf8');
 const region=client.split('/* #region tweak-mobile-composer */')[1].split('/* #endregion tweak-mobile-composer */')[0];vm.runInContext(region,context);
 const api=w.lib.test;let sentArgs=[],menuHit=null,sends=0,unsafeFocus=0;
 const claim={name:'plan',token:'/plan ',submit:async args=>{sentArgs.push(args);return{kind:'success'}}};
 const actx={bail(_ctx,name,request){if(name==='slash/input-begin-command')return shell.beginCommand(request.claim,request.span);if(name==='slash/input-consume-token')return shell.consumeToken(request.guard)}};
 const trigger={lexicon:{getSnapshot:()=>new Map([['/',['plan']]]),subscribe:()=>()=>{}},track(){},resolveClaim:async token=>token==='/plan'?claim:undefined,toggleSource(_source,hit){menuHit=hit}};
 const shell=new api.SessionInputShell({actx,inputTriggers:()=>trigger,defaultSink:async()=>({kind:'success'})});
 const services={sessions:{scope:()=>actx},inputTriggers:{sessionOf:()=>trigger},conversation:{input:{for:()=>shell}}};
 const bridge=w.mobileCommandBridge({get:name=>services[name]},'test-session');assert(bridge);
 const card=w.document.createElement('div');card.setAttribute('data-composer-card','');
 card.innerHTML='<div id="overlay"></div><div data-input-scroll><div data-composer-input contenteditable="true" role="textbox" aria-multiline="true" style="white-space:pre-wrap"></div></div><div><button id="plus" aria-haspopup="listbox">+</button><button id="send">Send</button></div>';
 w.document.body.append(card);const dock=w.document.createElement('div');w.document.body.append(dock);
 const root=card.querySelector('[data-composer-input]'),plus=card.querySelector('#plus');shell.editor.setRootElement(root);
 plus.addEventListener('click',()=>{unsafeFocus++;root.focus()});
 let anchor={top:800,bottom:834,left:14,right:48,width:34,height:34};plus.getBoundingClientRect=()=>anchor;
 const style=w.document.createElement('style');style.textContent='[data-tweaks-mode-chip] [data-composer-command]{display:none!important}';w.document.head.append(style);
 const overlayRoot=createRoot(card.querySelector('#overlay'));overlayRoot.render(React.createElement(React.Fragment,null,React.createElement(w.MobileComposerBinding,{inputActions:shell.actions,commandBridge:bridge}),React.createElement(api.DecoratorPortals,{editor:shell.editor})));
 const dockRoot=createRoot(dock);const useInput=select=>select(React.useSyncExternalStore(shell.state.subscribe,shell.state.getSnapshot));dockRoot.render(React.createElement(w.ComposerModeChip,{useInput,commandBridge:bridge}));
 const keymapOff=api.registerComposerKeymap(shell.editor,{arbitrate:()=> 'pass',dismissPopup(){},space:()=>false,canSubmit:()=>true,submit(){sends++},intakeFiles(){},pasteText(text){shell.paste(text)}});
 const flush=async()=>{await w.happyDOM.waitUntilComplete();await new Promise(setImmediate);await new Promise(setImmediate)};
 await flush();
 const state=()=>shell.state.getSnapshot(),text=()=>state().draft;
 const plainBody='Унификация характеристик.\n\nВот тут прочитай...\n\n'+('Проверь паспорта, ссылки и все источники.\n\n'.repeat(100));
 const payload=('/plan '+plainBody).slice(0,3084);assert.equal(payload.length,3084);
 const body=payload.slice(6);
 const reset=async text=>{shell.actions.setDraft(text);await flush()};
 const paste=async(plain,html)=>{const data=new w.DataTransfer();if(plain!==null)data.setData('text/plain',plain);if(html)data.setData('text/html',html);const e=new w.ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});root.dispatchEvent(e);await flush();return e};
 const before=async(type,data,cancelable=true)=>{const e=new w.InputEvent('beforeinput',{inputType:type,data,bubbles:true,cancelable,isComposing:type==='insertCompositionText'});root.dispatchEvent(e);if(!cancelable)root.dispatchEvent(new w.InputEvent('input',{inputType:type,data,bubbles:true}));await flush();return e};
 let count=0;const check=async(name,fn)=>{await fn();count++;console.log('PASS',name)};
 await check('3084-char leading /plan + blank paragraphs becomes one native mode, complete body',async()=>{await reset('');await paste(payload);assert.equal(text(),payload);assert.equal(state().claim.name,'plan');assert.equal(root.querySelectorAll('[data-composer-command]').length,1);assert.equal(dock.querySelectorAll('[data-tweaks-command-mode]').length,1);assert(!root.innerText.includes('/plan'));assert(root.innerText.includes('Вот тут прочитай'));});
 await check('existing empty /plan mode does not duplicate pasted prefix',async()=>{await reset('');shell.beginCommand(claim,{start:0,end:0,draftRev:state().draftRev});await paste(payload);assert.equal(text(),payload);assert.equal(root.querySelectorAll('[data-composer-command]').length,1)});
 await check('native mode submission receives the whole body once, not a pasted /plan duplicate',async()=>{shell.actions.submit();await flush();assert.equal(sentArgs.length,1);assert.equal(sentArgs[0],body)});
 await check('Android insertText-only clipboard',async()=>{await reset('');await before('insertText',payload);assert.equal(text(),payload);assert.equal(state().claim.name,'plan')});
 await check('Android insertCompositionText-only clipboard',async()=>{await reset('');await before('insertCompositionText',payload);assert.equal(text(),payload);assert.equal(state().claim.name,'plan')});
 await check('noncancelable Android composition reconciles once on input',async()=>{await reset('');await before('insertCompositionText',payload,false);assert.equal(text(),payload);assert.equal(root.querySelectorAll('[data-composer-command]').length,1)});
 await check('real composition lifecycle ending with newline must never submit',async()=>{
  await reset('');shell.focus();root.dispatchEvent(new w.CompositionEvent('compositionstart',{data:'',bubbles:true}));
  await before('insertCompositionText',payload+'\n',false);
  root.dispatchEvent(new w.CompositionEvent('compositionend',{data:payload+'\n',bubbles:true}));await flush();
  assert.equal(sends,0);assert.equal(text(),payload+'\n');assert.equal(shell.editor.isComposing(),false);
 });
 await check('HTML-only Notes clipboard retains all paragraphs, ignores executable HTML',async()=>{await reset('');await paste(null,'<p>/plan Унификация характеристик.</p><p>Вот тут прочитай...</p><p>Последний абзац.</p><script>window.BAD=1</script>');assert.equal(text(),'/plan Унификация характеристик.\n\nВот тут прочитай...\n\nПоследний абзац.');assert.equal(w.BAD,undefined);assert.equal(state().claim.name,'plan')});
 await check('truncated plain first paragraph recovers full HTML body',async()=>{await reset('');await paste('/plan Первая строка','<p>/plan Первая строка</p><p>Второй абзац.</p>');assert.equal(text(),'/plan Первая строка\n\nВторой абзац.')});
 await check('mode can be chosen after long plain text, without consuming selection/body or focusing editor',async()=>{
  await reset(body);shell.editor.update(()=>api.selectSpan(api.layout(),{start:0,end:body.length}),{discrete:true});root.blur();const active=w.document.activeElement;
  const down=new w.PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch'});plus.dispatchEvent(down);assert(down.defaultPrevented);plus.click();await flush();
  assert.equal(unsafeFocus,0);assert.equal(w.document.activeElement,active);assert.equal(menuHit.position,'leading');assert.equal(menuHit.span.start,0);assert.equal(menuHit.span.end,0);
  assert(shell.beginCommand(claim,menuHit.span));await flush();assert.equal(text(),'/plan '+body);
 });
 await check('removing dock mode keeps body and does not open keyboard',async()=>{const active=w.document.activeElement;dock.querySelector('button').click();await flush();assert.equal(text(),body);assert.equal(state().claim,undefined);assert.equal(w.document.activeElement,active)});
 await check('412x915 touch scroll cap = 183px, menu adjacent and inside viewport',async()=>{
  const menu=w.document.createElement('div');menu.setAttribute('data-trigger-menu','');Object.defineProperty(menu,'scrollHeight',{value:250,configurable:true});menu.getBoundingClientRect=()=>({height:250});card.querySelector('#overlay').append(menu);await flush();
  assert.equal(card.style.getPropertyValue('--dsh-mobile-text-cap'),'183px');assert.equal(menu.style.position,'fixed');const y=parseFloat(menu.style.top),x=parseFloat(menu.style.left);assert(y>=8&&y+250<=915-8);assert(x>=8&&x+parseFloat(menu.style.width)<=412-8);assert(y<anchor.top);
 });
 await check('visualViewport keyboard resize caps text at 20% and repositions menu',async()=>{viewport.height=400;anchor={...anchor,top:320,bottom:354};viewport.dispatchEvent(new w.Event('resize'));await flush();assert.equal(card.style.getPropertyValue('--dsh-mobile-text-cap'),'80px');const menu=card.querySelector('[data-trigger-menu]');assert(parseFloat(menu.style.top)>=8);assert(parseFloat(menu.style.top)+250<=392)});
 await check('mobile geometry compensates the existing 150% app zoom',async()=>{
  appZoom=1.5;w.document.documentElement.style.setProperty('--dsh-ui-zoom','1.5');await flush();
  assert(Math.abs(parseFloat(card.style.getPropertyValue('--dsh-mobile-text-cap'))*appZoom-80)<0.01);
  const menu=card.querySelector('[data-trigger-menu]');assert(parseFloat(menu.style.left)*appZoom>=8);assert(parseFloat(menu.style.width)*appZoom<=396);
  assert(parseFloat(menu.style.top)*appZoom>=7.99);assert(parseFloat(menu.style.top)*appZoom+parseFloat(menu.style.maxHeight)*appZoom<=392.01);
  appZoom=1;w.document.documentElement.style.setProperty('--dsh-ui-zoom','1');await flush();
 });
 await check('desktop mode chip/paste works, Enter and Shift+Enter keep native keymap',async()=>{
  coarse=false;w.dispatchEvent(new w.Event('resize'));await flush();assert(!card.hasAttribute('data-mobile-composer'));
  await reset('');await paste(payload);assert.equal(state().claim.name,'plan');assert.equal(text(),payload);
  shell.focus();root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));assert.equal(sends,1);
  root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',code:'Enter',shiftKey:true,bubbles:true,cancelable:true}));shell.editor.update(()=>{},{discrete:true});assert.equal(sends,1);assert.equal(text(),payload+'\n');
 });
 await check('late command catalog result cannot overwrite a subsequent edit',async()=>{
  await reset('');let resolve;const slow={snapshot:bridge.snapshot,claim:bridge.claim,resolve:()=>new Promise(r=>resolve=r)};
  const temp=w.document.createElement('div'),ed=w.document.createElement('div');ed.setAttribute('data-composer-input','');ed.setAttribute('contenteditable','true');temp.append(ed);w.document.body.append(temp);
  const off=w.bindMobileComposer(temp,shell.actions,w,slow);const data=new w.DataTransfer();data.setData('text/plain','/plan start');ed.dispatchEvent(new w.ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));shell.actions.setDraft('edited afterwards');resolve(claim);await flush();assert.equal(text(),'edited afterwards');off();temp.remove();
 });
 await check('all component effects detach cleanly',async()=>{overlayRoot.unmount();dockRoot.unmount();await flush();assert(!card.hasAttribute('data-tweaks-mode-chip'));assert(!card.hasAttribute('data-mobile-composer'));});
 keymapOff();shell.dispose();w.happyDOM.cancelAsync();console.log(`PASS ${count} native mode / clipboard / mobile geometry checks (DOM simulation, not a real Android browser)`);
})().catch(e=>{console.error(e);process.exitCode=1});
