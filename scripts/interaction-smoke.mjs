// Private CDP is test setup/observation only. Browser actions use the real extension and Hub.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { ROOT } from '../src/config.mjs';
import { setup } from '../src/setup.mjs';
import { startHub } from '../src/hub.mjs';
import { AttachClient } from '../src/client.mjs';
import { normalizeHit } from '../extension/pointer.js';
import { checkSnapshotDiff } from './snapshot-diff-cases.mjs';
import { checkWaitVerification } from './wait-verify-cases.mjs';
import { checkActionEvidence } from './action-evidence-cases.mjs';
import { checkObservability } from './observability-cases.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' }, family: { type: 'string', default: 'chromium' }, headless: { type: 'boolean', default: false }, observability: { type: 'boolean', default: false }, evidence: { type: 'boolean', default: false }, verify: { type: 'boolean', default: false }, snapshots: { type: 'boolean', default: false }, controls: { type: 'boolean', default: false }, preparation: { type: 'boolean', default: false }, issues: { type: 'boolean', default: false }, primitives: { type: 'boolean', default: false }, extended: { type: 'boolean', default: false }, forms: { type: 'boolean', default: false }, regressions: { type: 'boolean', default: false }, 'input-capture': { type: 'boolean', default: false }, 'tab-indicators': { type: 'boolean', default: false } } });
if (!values.executable) throw new Error('Pass --executable PATH to a Chrome or Edge 125+ build that permits --enable-unsafe-extension-debugging');
const dir = await mkdtemp(join(tmpdir(), 'attach-interaction-'));
const rows = Array.from({ length: 200 }, (_, i) => `<li>Row ${i+1}: alpha beta gamma delta epsilon</li>`).join('');
const fixture = `<!doctype html><meta charset="utf-8"><title>Attach issue probe</title>
<style>#go{position:fixed;left:200px;top:200px;width:120px;height:40px}#state{white-space:pre-wrap}</style>
<button id="go" onclick="window.__count++">Go</button>
<input id="edit" aria-label="Name" style="position:fixed;left:20px;top:20px">
<input id="file" type="file" hidden><button style="position:fixed;left:400px;top:20px" onclick="document.querySelector('#file').click()">Choose file</button>
<div id="state"></div><ul>${rows}</ul>
<script>window.__count=0;window.__events=[];for(const type of ['pointermove','pointerdown','pointerup','click'])document.addEventListener(type,e=>{const r=document.querySelector('#go').getBoundingClientRect();window.__events.push({type,target:e.target.id,x:e.clientX,y:e.clientY,trusted:e.isTrusted,rect:{x:r.x,y:r.y,width:r.width,height:r.height}})},true);</script>`;
const sockets = new Set();
const reactSources = values.forms ? await Promise.all([
 'https://unpkg.com/react@18.3.1/umd/react.development.js',
 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js',
].map(async url => { const r = await fetch(url); if (!r.ok) throw new Error(`React fixture dependency: ${r.status}`); return r.text(); })) : [];
const extendedFixture = values.extended ? await readFile(join(ROOT, 'tests/fixtures/extended.html'), 'utf8') : '';
const primitivesFixture = values.primitives ? await readFile(join(ROOT, 'tests/fixtures/primitives.html'), 'utf8') : '';
const formFixture = values.forms ? await readFile(join(ROOT, 'tests/fixtures/controlled-form.html'), 'utf8') : '';
const issueFixture = values.issues ? await readFile(join(ROOT, 'tests/fixtures/issues.html'), 'utf8') : '';
const server = http.createServer((req, res) => {
  if (req.url === '/react.js' || req.url === '/react-dom.js') { res.setHeader('content-type', 'text/javascript'); res.end(reactSources[req.url === '/react.js' ? 0 : 1]); return; }
  if (req.url.startsWith('/slow.js')) { setTimeout(() => { res.setHeader('content-type','application/javascript');res.end('window.slowScriptReady=true;'); }, 1000); return; }
  if (req.url.startsWith('/echo')) { let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.setHeader('content-type','application/json');res.setHeader('Set-Cookie','secret_cookie=hidden');res.end(JSON.stringify({ok:true,method:req.method,body:JSON.parse(body||'{}'),Authorization:'hidden response credential'}))});return; }
  res.setHeader('content-type','text/html; charset=utf-8');
  if (req.url.startsWith('/issue-frame')) {res.end(`<!doctype html><title>Issue child</title><style>body{margin:0;height:900px}#inner-scroll{position:absolute;left:25px;top:100px;width:350px;height:140px;overflow:auto}button{margin-top:260px;width:140px;height:40px}</style><div id="inner-scroll"><button id="inner-button">Inner submit</button><div style="height:250px"></div></div><script>window.clicks=[];document.querySelector('button').onclick=e=>{clicks.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted});parent.postMessage({issueClick:true,trusted:e.isTrusted},'*')};</script>`);return;}
  if (req.url==='/outer') {res.end('<!doctype html><title>Outer document</title><iframe title="Inner" src="/inner"></iframe>');return;}
  if (req.url==='/inner') {res.end('<!doctype html><title>Inner document</title><input aria-label="Inner input"><button onclick="window.count=(window.count||0)+1">Inner button</button>');return;}
  if (req.url.startsWith('/ad')) { res.end('<!doctype html><title>Ad frame</title><button>Ad control</button>'); return; }
  if (req.url.startsWith('/slow')) { res.end('<!doctype html><title>Slow probe</title><script src="/slow.js"></script><button id="ready">Ready</button>'); return; }
  res.end(values.issues ? issueFixture : values.extended ? extendedFixture.replace('src="/outer"',`src="http://localhost:${server.address().port}/outer"`) : values.primitives ? primitivesFixture : values.forms ? formFixture : fixture);
});
server.on('connection', socket => { sockets.add(socket);socket.on('close',()=>sockets.delete(socket)); });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const reserve = http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const paired = await setup({ configPath:join(dir,'config.json'), port });
const hub=await startHub(paired.config);
const profile=join(dir,'profile');await mkdir(profile);
const browser=spawn(values.executable,[
 `--user-data-dir=${profile}`,
 '--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--enable-unsafe-extension-debugging','--window-size=1000,800','about:blank',
 ...(values.headless?['--headless=new']:[]), ...(values.extended || values.issues || values.snapshots || values.verify?['--site-per-process']:[]),
],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn, description) { for(let i=0;i<100;i++){const value=await fn();if(value)return value;await pause(100)}throw new Error(description); }
let ws,client,claim,closeBrowser;
const results={family:values.family,headless:values.headless,cases:[],snapshots:[],navigation:null};
try {
 const active=await until(async()=>{try{return(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/)}catch{return null}},'DevTools not ready');
 ws=new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`);await once(ws,'open');
 const pending=new Map();let serial=0;
 ws.on('message',raw=>{const data=JSON.parse(raw);const p=pending.get(data.id);if(p){pending.delete(data.id);data.error?p.reject(new Error(data.error.message)):p.resolve(data.result)}});
 const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))});
 // Branded Chrome/Edge ignore --load-extension, and --disable-extensions-except keeps a CDP-loaded extension from starting; load it through the Extensions domain instead.
 try{await cdp('Extensions.loadUnpacked',{path:paired.extensionDir})}catch(error){if(!/not found|wasn't found/i.test(error.message))throw error}
 closeBrowser=async()=>{let timer;try{await Promise.race([cdp('Browser.close'),new Promise(resolve=>{timer=setTimeout(resolve,3000)})])}finally{clearTimeout(timer)}};
 client=new AttachClient(paired.config);
 if(process.env.ATTACH_TEST_VERBOSE){const call=client.call.bind(client);client.call=(method,args)=>{console.error(method,args);return call(method,args)};}
 const browserInfo=await until(async()=>{const r=await client.call('list_browsers');return r.browsers[0]},'Extension not connected');
 const worker=await until(async()=>{const r=await cdp('Target.getTargets');return r.targetInfos.find(t=>t.type==='service_worker'&&t.url.includes(paired.config.extension_id))},'Worker missing');
 const {sessionId}=await cdp('Target.attachToTarget',{targetId:worker.targetId,flatten:true});
 const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
 const tab=await evaluate(`chrome.tabs.create({url:${JSON.stringify(base+'/probe')},active:true})`);
 const info=await until(async()=>(await client.call('list_tabs',{browser_id:browserInfo.browser_id})).tabs
  .find(t=>t.tab_id===tab.id&&t.url===base+'/probe'&&t.title==='Attach issue probe'),'Fixture tab not loaded');
 // Leave the existing startup settling interval after readiness, not before it.
 await pause(350);
 claim=await client.call('claim_tab',{browser_id:browserInfo.browser_id,tab_id:tab.id,expected_url:info.url,expected_title:info.title});
 const h={tab_handle:claim.tab_handle};
 const page=async expression=>(await evaluate(`chrome.debugger.sendCommand({tabId:${tab.id}},'Runtime.evaluate',{expression:${JSON.stringify(expression)},returnByValue:true,awaitPromise:true})`)).result.value;
 const state=()=>page(`(()=>{const r=document.querySelector('#go')?.getBoundingClientRect();return {count:window.__count,events:window.__events,visibility:document.visibilityState,dpr:devicePixelRatio,rect:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null}})()`);
 const cover=await evaluate(`chrome.tabs.create({url:${JSON.stringify(base+'/cover')},active:false})`);
 const focus = () => evaluate(`chrome.windows.getAll({populate:true}).then(w=>w.map(x=>({id:x.id,focused:x.focused,state:x.state,active:x.tabs.filter(t=>t.active).map(t=>t.id)})).sort((a,b)=>a.id-b.id))`);
 await evaluate(`chrome.tabs.update(${cover.id},{active:true})`);await pause(250);
 const operationsFocus=await focus();
 if (values.observability) {
  await checkObservability({ call: (method, args = {}) => { results.last_operation = { method, args }; return client.call(method, { ...h, ...args }); }, page, base, focus, results });
 } else if (values.evidence) {
  await checkActionEvidence({ call: (method, args = {}) => { results.last_operation = { method, args }; return client.call(method, { ...h, ...args }); }, page, base, focus, results });
 } else if (values.verify) {
  await checkWaitVerification({ call: (method, args = {}) => { results.last_operation = { method, args }; return client.call(method, { ...h, ...args }); }, page, base, focus, results });
 } else if (values.snapshots) {
  await checkSnapshotDiff({ call: (method, args = {}) => { results.last_operation = { method, args }; return client.call(method, { ...h, ...args }); }, page, base, focus, results });
 } else if (values.controls) {
  const call=(method,args={})=>{results.last_operation={method,args};return client.call(method,{...h,...args})};
  await page(`(() => {
    document.querySelector('#go').remove();document.querySelector('#edit').remove();
    const section=document.createElement('section');section.id='control-probe';section.style.marginTop='80px';
    section.innerHTML='<button id="control-keep">Keep ref</button><div id="control-picker" role="combobox" aria-label="学历" aria-expanded="false" aria-controls="control-portal" tabindex="0" style="width:300px;padding:12px"><input id="control-filter" readonly value=""><span id="control-display">请选择</span></div><input id="control-other"><div id="control-portal" role="listbox" aria-label="学历选项" hidden><div id="control-bachelor" role="option" aria-selected="false">本科</div><div id="control-master" role="option" aria-selected="false">硕士</div></div><div id="control-unrelated" role="listbox"><div role="option">日语</div></div>';
    document.body.prepend(section);window.controlWrites=0;window.controlTrusted=[];
    const picker=section.querySelector('#control-picker'),portal=section.querySelector('#control-portal'),filter=section.querySelector('#control-filter');
    Object.assign(portal.style,{height:'0px',overflow:'visible',position:'relative',zIndex:'10'});section.querySelector('#control-unrelated').style.marginTop='48px';
    picker.onclick=()=>{portal.hidden=false;picker.setAttribute('aria-expanded','true');picker.setAttribute('aria-activedescendant','control-bachelor');filter.focus()};
    const choose=(id,event)=>{section.querySelector('#control-display').textContent=document.getElementById(id).textContent;for(const option of portal.children)option.setAttribute('aria-selected',String(option.id===id));portal.hidden=true;picker.setAttribute('aria-expanded','false');picker.removeAttribute('aria-activedescendant');controlWrites++;controlTrusted.push(event.isTrusted)};
    picker.onkeydown=e=>{if(e.key==='ArrowDown'){picker.setAttribute('aria-activedescendant','control-master');e.preventDefault()}if(e.key==='Enter'&&!portal.hidden)choose(picker.getAttribute('aria-activedescendant'),e)};
    for(const option of portal.children)option.onclick=e=>choose(option.id,e);
  })()`);
  const snapshot=await call('snapshot',{query:'Keep ref'}),oldRef=snapshot.snapshot.match(/\[([^\]]+)\] button/)[1];
  const opened=await call('click',{selector:'#control-picker',observe:{selector:'#control-picker',max_options:1}});
  assert.equal(opened.delivery_verified,true);assert.equal(opened.observation.available,true);
  assert.equal(opened.observation.control.ax.expanded,true);assert.equal(opened.observation.observed_options,2);
  assert.equal(opened.observation.popups[0].dom.visible,false);
  assert.equal(opened.observation.options.length,1);assert.equal(opened.observation.omitted_options,1);
  assert.ok(!JSON.stringify(opened.observation).includes('日语'));
  const moved=await call('press_key',{selector:'#control-picker',key:'ArrowDown',observe:{selector:'#control-picker',max_options:1}});
  assert.equal(moved.target_verified,true);assert.equal(moved.keyboard_target.received.id,'control-filter');
  assert.equal(moved.observation.active_option.ax.name,'硕士');assert.ok(moved.observation.active_option.ref);
  const committed=await call('press_key',{selector:'#control-picker',key:'Enter',observe:{selector:'#control-picker'}});
  assert.equal(committed.observation.control.dom.text,'硕士');assert.equal(committed.observation.control.ax.expanded,false);
  assert.equal((await call('read_control',{selector:'#control-filter'})).control.dom.value,'');
  assert.equal(await page('controlWrites'),1);assert.deepEqual(await page('controlTrusted'),[true]);
  await call('click',{ref:oldRef});
  await page('document.querySelector("#control-other").focus();true');
  await assert.rejects(call('press_key',{selector:'#control-picker',key:'Enter'}),error=>error.input_dispatched===false&&error.diagnostics.reason==='keyboard_focus_mismatch');
  const unguarded=await call('press_key',{key:'Enter'});assert.equal(unguarded.target_verified,null);assert.equal(unguarded.keyboard_target.received.id,'control-other');
  const reopened=await call('click',{selector:'#control-picker',observe:{selector:'#control-picker'}});
  await page(`(() => {const hint=document.createElement('span');hint.id='control-long-preview';hint.textContent='p'.repeat(700);document.querySelector('#control-portal').append(hint)})()`);
  const preview=await call('read_control',{selector:'#control-picker'});
  assert.equal(preview.popups[0].dom.text.length,120);assert.equal(preview.popups[0].dom.text_truncated,true);
  assert.deepEqual(preview.options.map(option=>option.ax.name),['本科','硕士']);
  assert.equal(preview.active_option.ref,reopened.observation.active_option.ref);
  await page('document.querySelector("#control-long-preview").remove();true');
  const option=reopened.observation.options.find(option=>option.ax.name==='硕士');
  await call('click',{ref:option.ref,observe:{selector:'#control-picker'}});assert.equal(await page('controlWrites'),2);
  const missing=await call('click',{selector:'#control-keep',observe:{selector:'#missing-control',timeout_ms:100}});
  assert.equal(missing.delivery_verified,true);assert.equal(missing.observation.available,false);
  await page(`(() => {const picker=document.querySelector('#control-picker');picker.scrollIntoView({block:'center'});const r=picker.getBoundingClientRect();const cover=document.createElement('div');cover.id='control-cover';cover.textContent='Blocking popup';Object.assign(cover.style,{position:'fixed',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',zIndex:'9999999',background:'gray'});document.body.append(cover)})()`);
  await assert.rejects(call('click',{selector:'#control-picker',scroll:false}),error=>{
    assert.equal(error.input_dispatched,false);assert.equal(error.diagnostics.requested_target.id,'control-picker');assert.equal(error.diagnostics.blocked_by.id,'control-cover');return true;
  });
  await page('document.querySelector("#control-cover").remove();true');
  await client.call('activate_tab',h);
  await page(`(() => {
    const host=document.createElement('div');host.style.display='inline-block';host.id='control-shadow-host';
    const root=host.attachShadow({mode:'closed'});root.innerHTML='<input aria-label="Closed shadow field" id="control-shadow-input">';document.querySelector('#control-probe').append(host);
    const frame=document.createElement('iframe');frame.id='control-frame';frame.srcdoc='<input id="control-frame-input" aria-label="Frame field" role="combobox" aria-controls="frame-popup"><div id="frame-popup" role="listbox"><div role="option">Frame option</div></div>';document.querySelector('#control-probe').append(frame);
    const remote=document.createElement('iframe');remote.id='control-remote';remote.src=${JSON.stringify(base.replace('127.0.0.1','localhost')+'/inner')};document.querySelector('#control-probe').append(remote);
  })()`);
  const shadow=await call('type',{selector_type:'role',selector:'textbox',name:'Closed shadow field',text:'A中'});
  assert.equal(shadow.typed,2);assert.equal(shadow.delivery_verified,true);
  const shadowRead=await call('read_control',{selector_type:'role',selector:'textbox',name:'Closed shadow field'});
  assert.equal(shadowRead.control.dom.value,'A中');
  const shadowKey=await call('press_key',{ref:shadowRead.control.ref,key:'End'});
  assert.equal(shadowKey.target_verified,true);assert.equal(shadowKey.keyboard_target.received.id,'control-shadow-input');
  const frameRead=await call('read_control',{selector:'#control-frame-input',frame:{path:['#control-frame']}});
  assert.equal(frameRead.options[0].ax.name,'Frame option');
  await call('click',{ref:frameRead.control.ref});
  const frameKey=await call('press_key',{ref:frameRead.control.ref,key:'ArrowDown'});
  assert.equal(frameKey.target_verified,true);assert.equal(frameKey.keyboard_target.received.id,'control-frame-input');
  assert.equal(frameKey.keyboard_target.frame_id,frameRead.frame_id);
  const remoteRead=await call('read_control',{selector:'input',frame:{path:['#control-remote']},timeout_ms:5000});
  await call('click',{ref:remoteRead.control.ref});
  const remoteKey=await call('press_key',{ref:remoteRead.control.ref,key:'ArrowDown'});
  assert.equal(remoteKey.target_verified,true);assert.equal(remoteKey.keyboard_target.frame_id,remoteRead.frame_id);
  const steps=Array.from({length:30},()=>({action:'press_key',key:'Tab'}));
  const suffix=await call('batch',{steps,start_at:29,observe:{selector:'#control-picker'}});
  assert.equal(suffix.completed,true);assert.equal(suffix.results.length,1);assert.equal(suffix.observation.available,true);
  await assert.rejects(call('batch',{steps:[...steps,steps[0]]}),/1..30/);
  results.cases.push({scenario:'control_popup_active_option_observation_and_keyboard_targets',opened,moved,committed,preview,missing,suffix,shadowKey,frameKey,remoteKey,writes:await page('controlWrites')});
 } else if (values.preparation) {
  const call=(method,args={})=>client.call(method,{...h,...args});
  await page(`(() => {
    const section=document.createElement('section');section.id='preparation';
    section.innerHTML='<div style="height:1000px"></div><button id="prep-target" style="width:160px;height:40px">Preparation submit</button><div style="height:1000px"></div><div id="prep-footer" style="position:fixed;bottom:0;left:0;right:0;height:180px;z-index:9999;background:gray">Sticky footer</div>';
    document.body.append(section);window.prepClicks=[];
    document.querySelector('#prep-target').onclick=e=>prepClicks.push(e.isTrusted);
    const r=document.querySelector('#prep-target').getBoundingClientRect();scrollTo({top:scrollY+r.top-innerHeight+60,behavior:'instant'});
  })()`);
  assert.equal((await call('click',{selector:'#prep-target'})).delivery_verified,true);
  assert.deepEqual(await page('prepClicks'),[true]);
  const targetRef=(await call('snapshot',{query:'Preparation submit'})).snapshot.match(/\[([^\]]+)\] button/)[1];
  await page(`(() => { const r=document.querySelector('#prep-target').getBoundingClientRect();scrollTo({top:scrollY+r.top-innerHeight+60,behavior:'instant'}); })()`);
  assert.equal((await call('click',{ref:targetRef})).delivery_verified,true);
  assert.deepEqual(await page('prepClicks'),[true,true]);
  await page(`(() => { const cover=document.createElement('div');cover.id='prep-cover';cover.style='position:fixed;inset:0;z-index:10000';document.body.append(cover); })()`);
  await assert.rejects(call('click',{selector:'#prep-target'}),error=>error.input_dispatched===false&&error.diagnostics.reason==='obstructed');
  assert.deepEqual(await page('prepClicks'),[true,true]);
  await page(`document.querySelector('#prep-cover').remove()`);
  results.cases.push({scenario:'bounded_center_before_selector_and_ref_click_full_overlay_still_blocks',clicks:await page('prepClicks')});
  await page(`document.querySelector('#preparation').remove()`);

  await page(`(() => {
    const wrapper=document.createElement('div');wrapper.id='prep-wrapper';wrapper.style='position:fixed;top:100px;left:400px;width:350px;height:240px';
    wrapper.innerHTML='<div id="prep-nested" style="height:240px;overflow:auto"><div style="height:500px"></div><button id="prep-inner" style="height:40px">Nested submit</button><div style="height:500px"></div></div><div style="position:absolute;bottom:0;width:100%;height:100px;z-index:9;background:gray">Nested footer</div>';
    document.body.append(wrapper);window.nestedClicks=0;document.querySelector('#prep-inner').onclick=()=>nestedClicks++;
    document.querySelector('#prep-nested').scrollTop=300;
  })()`);
  await call('click',{selector:'#prep-inner'});assert.equal(await page('nestedClicks'),1);
  assert.ok(await page('document.querySelector("#prep-nested").scrollTop>300'));
  results.cases.push({scenario:'nested_container_center_avoids_footer',clicks:await page('nestedClicks')});
  await page(`document.querySelector('#prep-wrapper').remove()`);

  await page(`(() => {
    const input=document.createElement('input');input.id='prep-format';input.setAttribute('aria-label','Preparation month');document.body.append(input);
    window.prepInputs=0;input.oninput=()=>{prepInputs++;input.value=String(Number(input.value))};
  })()`);
  await assert.rejects(call('fill',{selector:'#prep-format',text:'06'}),error=>error.diagnostics.reason==='value_not_retained');
  assert.equal(await page('document.querySelector("#prep-format").value'),'6');assert.equal(await page('prepInputs'),1);
  for(const mode of ['native','dom']){
    const filled=await call('fill',{selector:'#prep-format',text:'06',expected_value:'6',mode});
    assert.equal(filled.value_verified,true);assert.equal(filled.verification_basis,'expected_value');
  }
  const formattedBatch=await call('batch',{steps:[{action:'fill',selector:'#prep-format',text:'06',expected_value:'6'},{action:'wait',selector:'#prep-format',condition:'value',expected:'6'}]});
  assert.equal(formattedBatch.completed,true);
  await assert.rejects(call('fill',{selector:'#prep-format',text:'06',expected_value:'7'}),error=>error.diagnostics.reason==='value_not_retained'&&error.diagnostics.verification_basis==='expected_value');
  assert.equal(await page('prepInputs'),5);
  await page(`document.querySelector('#prep-format').oninput=()=>prepInputs++`);
  const exact=await call('fill',{selector:'#prep-format',text:'06'});assert.equal(exact.verification_basis,'text');
  assert.equal(await page('document.querySelector("#prep-format").value'),'06');
  results.cases.push({scenario:'explicit_expected_value_native_dom_batch_mismatch_no_replay_default_leading_zeros',inputs:await page('prepInputs')});
  await page(`document.querySelector('#prep-format').remove()`);

  await page(`(() => {
    const section=document.createElement('section');section.id='prep-inputs';section.style='position:fixed;top:100px;left:20px';
    section.innerHTML=['text','search','email','password','tel','url'].map(type=>'<input id="prep-'+type+'" type="'+type+'" value="old">').join('')+'<textarea id="prep-textarea">original</textarea><div id="prep-contenteditable" contenteditable="true">old</div>';
    document.body.append(section);window.prepInputEvents=0;
    section.addEventListener('input',()=>prepInputEvents++);
  })()`);
  for(const type of ['text','search','email','password','tel','url']){
    const text=type==='email'?'new@example.test':'replacement';
    const filled=await call('fill',{selector:'#prep-'+type,text});
    assert.equal(filled.verification_source,'dom_value');assert.equal((await call('read_text',{selector:'#prep-'+type,mode:'value'})).text,text);
  }
  await page(`document.querySelector('#prep-textarea').select=function(){this.setSelectionRange(2,2)}`);
  const eventsBefore=await page('prepInputEvents');
  await assert.rejects(call('fill',{selector:'#prep-textarea',text:'must not append'}),error=>error.diagnostics.reason==='fill_selection_lost'&&error.input_dispatched===true);
  assert.equal(await page('document.querySelector("#prep-textarea").value'),'original');assert.equal(await page('prepInputEvents'),eventsBefore);
  await page(`delete document.querySelector('#prep-textarea').select`);
  assert.equal((await call('fill',{selector:'#prep-textarea',text:'first\nsecond'})).verification_source,'dom_value');
  for(const mode of ['native','dom']){
    const filled=await call('fill',{selector:'#prep-contenteditable',text:'first\nsecond',mode});
    assert.equal(filled.verification_source,mode==='native'?'selection_text':'inner_text');
    assert.equal((await call('read_text',{selector:'#prep-contenteditable',mode:'value'})).text,'first\nsecond');
  }
  results.cases.push({scenario:'native_fill_field_types_and_collapsed_textarea_selection_no_insert',events:await page('prepInputEvents')});
  await page(`document.querySelector('#prep-inputs').remove()`);

  await page(`(() => {
    const section=document.createElement('section');section.id='prep-editors';section.style='position:fixed;top:100px;left:20px';
    section.innerHTML='<div class="monaco-editor"><textarea id="prep-monaco" class="inputarea">proxy</textarea></div><div class="CodeMirror"><textarea id="prep-cm">proxy</textarea></div><input id="prep-editor-focus">';
    document.body.append(section);document.querySelector('#prep-editor-focus').focus();
    window.prepEditorEvents=[];for(const type of ['focusin','input','change'])section.addEventListener(type,e=>prepEditorEvents.push(type));
    window.__privateTestEditor={getValue:()=> 'private full model'};
    window.monaco={_prevClass:'private'};
  })()`);
  for(const selector of ['#prep-monaco','#prep-cm'])for(const mode of ['native','dom']){
    await assert.rejects(call('fill',{selector,text:'must not write',mode}),error=>error.input_dispatched===false&&error.diagnostics.reason==='editor_proxy');
    assert.equal((await call('read_text',{selector,mode:'value'})).text,'proxy');
  }
  assert.equal(await page('document.activeElement.id'),'prep-editor-focus');assert.deepEqual(await page('prepEditorEvents'),[]);
  await assert.rejects(call('read_text',{selector:'.monaco-editor',mode:'editor'}),error=>error.diagnostics.reason==='editor_model_unavailable'&&/browser_evaluate/.test(error.message));
  assert.equal((await call('evaluate',{expression:'() => window.__privateTestEditor.getValue()'})).value,'private full model');
  await page(`window.monaco={editor:{getEditors:()=>[{getDomNode:()=>document.querySelector('.monaco-editor'),getModel:()=>({getValue:()=> 'full model\\nsecond line'})}]}}`);
  const model=await call('read_text',{selector:'.monaco-editor',mode:'editor'});assert.equal(model.text,'full model\nsecond line');assert.equal(model.complete_source,true);
  await page(`window.monaco.editor.getEditors=1`);
  await assert.rejects(call('read_text',{selector:'.monaco-editor',mode:'editor'}),error=>error.diagnostics.reason==='editor_model_unavailable'&&!/TypeError/.test(error.message));
  await page(`document.querySelector('#prep-cm').parentElement.CodeMirror={getValue:()=> 'CM full model'}`);
  assert.equal((await call('read_text',{selector:'.CodeMirror',mode:'editor'})).source,'codemirror5_model');
  results.cases.push({scenario:'editor_proxy_no_focus_or_input_and_public_private_model_readback',events:await page('prepEditorEvents')});
  await page(`document.querySelector('#prep-editors').remove();delete window.monaco;delete window.__privateTestEditor`);

  await page(`(() => {const state=document.createElement('div');state.id='prep-long-status';state.textContent='x'.repeat(1200)+'Completed';document.body.append(state)})()`);
  const longWait=await call('wait',{selector:'#prep-long-status',condition:'text',expected:'Completed'});
  assert.equal(longWait.results[0].actual.total_chars,1209);assert.equal(longWait.results[0].actual.text_truncated,true);assert.equal(longWait.results[0].actual.text.length,500);
  const prior=(await call('read_text',{selector:'#prep-long-status'})).text;
  const unchanged=await call('wait',{selector:'#prep-long-status',condition:'text',previous:prior,timeout_ms:150});
  assert.equal(unchanged.status,'fail');assert.equal(unchanged.results[0].actual.total_chars,1209);assert.equal(unchanged.results[0].actual.text_truncated,true);
  results.cases.push({scenario:'full_text_wait_comparison_beyond_truncated_diagnostics',current:longWait.results[0].actual});
  await page(`document.querySelector('#prep-long-status').remove()`);

  await page(`(() => {
    const section=document.createElement('section');section.id='prep-related';
    section.innerHTML='<input role="combobox" aria-label="Preparation source" aria-expanded="true" aria-controls="prep:portal"><div id="prep:other" role="listbox"><button role="option">China</button></div><div id="prep:portal" role="listbox"><button role="option">China</button></div>';
    document.body.append(section);window.prepPicked=[];for(const b of section.querySelectorAll('button'))b.onclick=()=>prepPicked.push(b.parentElement.id);
  })()`);
  await assert.rejects(call('click',{selector:'[role="option"]'}),error=>error.diagnostics.reason==='selector_ambiguous');
  const field=(await call('snapshot',{profile:'fields',query:'Preparation source'})).fields[0];
  assert.deepEqual(field.ax.controls,['prep:portal']);
  const scoped=await page(`'#'+CSS.escape(${JSON.stringify(field.ax.controls[0])})+' [role="option"]'`);
  await call('click',{selector:scoped});assert.deepEqual(await page('prepPicked'),['prep:portal']);
  results.cases.push({scenario:'explicit_portal_id_scopes_duplicate_options_with_existing_tools',selector:scoped});
 } else if (values.issues) {
  await client.call('activate_tab',h);
  const call=(method,args={})=>client.call(method,{...h,...args});
  const shadow=await call('click',{selector_type:'role',selector:'button',name:'Shadow submit'});
  assert.equal(shadow.target_verified,true);assert.equal(shadow.delivery_verified,true);
  assert.equal(shadow.target_verification.hit_relation,'same_node');
  assert.deepEqual(await page('window.shadowClicks'),[{trusted:true,activation:true}]);
  const shadowRect=await page('(()=>{const r=issueShadow.querySelector("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  assert.equal((await call('evaluate',{expression:`(${normalizeHit.toString()}).call(window.issueShadow,${shadowRect.x},${shadowRect.y}).id`})).value,'cp_form_submit_i');
  const shadowPoint=await call('click',shadowRect);assert.equal(shadowPoint.target_verified,null);assert.equal(shadowPoint.delivery_verified,true);
  results.cases.push({scenario:'closed_shadow_native_and_root_normalization',shadow,shadowPoint});

  let blocked;
  try{await call('click',{selector:'#covered'})}catch(error){blocked=error}
  assert.equal(blocked.input_dispatched,false);assert.equal(blocked.diagnostics.reason,'obstructed');
  assert.equal(blocked.diagnostics.hit_target.id,'overlay');assert.equal(blocked.diagnostics.hit_target.z_index,'99');
  assert.ok(blocked.diagnostics.hit_target.rect.width>0);
  const background=await call('click',{x:500,y:60});assert.equal(background.target_verified,null);assert.equal(background.delivery_verified,true);
  results.cases.push({scenario:'structured_obstruction_and_coordinate_scope',diagnostics:blocked.diagnostics,background});

  const single=await call('select_option',{selector:'#hidden-select',value:'b'});
  const batch=await call('batch',{steps:[{action:'select_option',selector:'#hidden-select',value:'a'}]});
  assert.equal(single.value_verified,true);assert.equal(batch.completed,true);
  assert.deepEqual(await page('window.selectEvents'),[{value:'b',trusted:false},{value:'a',trusted:false}]);
  for(const selector of ['#disabled-select','#inert-select']){
    let rejected;try{await call('select_option',{selector,index:1})}catch(error){rejected=error}
    assert.equal(rejected.input_dispatched,false);assert.match(rejected.message,/disabled or inert/);
  }
  results.cases.push({scenario:'hidden_select_single_and_batch',single,batch});

  let missing;
  try{await call('fill',{selector:'button',frame:{path:['same-frame']},text:'x',timeout_ms:150})}catch(error){missing=error}
  assert.equal(missing.input_dispatched,false);assert.equal(missing.diagnostics.path_index,0);
  assert.ok(missing.diagnostics.candidates.some(frame=>frame.url.endsWith('/issue-frame')));
  await call('wait',{selector:'body',condition:'text',expected:'Offscreen evidence'});
  results.cases.push({scenario:'frame_diagnostics_and_scoped_text_wait',diagnostics:missing.diagnostics});

  await page('window.issueClicks=0;addEventListener("message",e=>{if(e.data.issueClick)window.issueClicks++});true');
  for(const remote of [false,true]){
    if(remote){await page(`document.querySelector('#same-frame').src=${JSON.stringify(base.replace('127.0.0.1','localhost')+'/issue-frame')};true`);}
    await call('wait',{selector:'#inner-button',frame:{path:['#same-frame']},condition:'attached'});
    await page('document.querySelector("#same-frame").style.height="480px";document.querySelector("#same-frame").style.transform="scale(.85)";document.querySelector("#frame-scroll").scrollTop=110;true');
    const before=await page('window.issueClicks');
    const clicked=await call('click',{selector:'#inner-button',frame:{path:['#same-frame']}});
    await until(async()=>await page('window.issueClicks')===before+1,'frame native click');
    assert.equal(clicked.target_verified,true);assert.equal(clicked.events_trusted,true);
    const replayPoint=await call('click',clicked.clicked);
    await until(async()=>await page('window.issueClicks')===before+2,'frame coordinate click');
    assert.equal(replayPoint.delivery_verified,true);assert.equal(replayPoint.target_verified,null);
    const frameShot=await call('screenshot',{selector:'#inner-button',frame:{path:['#same-frame']}});
    results.cases.push({scenario:remote?'oopif_nested_scroll_scaled_resized':'same_process_nested_scroll_scaled_resized',clicked,capture:frameShot.capture});
  }

  const scrollBefore=await page('({window:scrollY,clip:document.querySelector("#clip").scrollTop})');
  for(const selector of ['#offscreen','#clipped']){
    const shot=await call('screenshot',{selector});
    assert.ok(shot.capture.css_width>0);assert.ok(shot.capture.css_height>0);
    await writeFile(join(ROOT,'test-results',`issues-${values.family}-${selector.slice(1)}.png`),Buffer.from(shot.data,'base64'));
    results.cases.push({scenario:`screenshot_${selector.slice(1)}`,capture:shot.capture});
  }
  assert.deepEqual(await page('({window:scrollY,clip:document.querySelector("#clip").scrollTop})'),scrollBefore);

  await call('fill',{selector:'#street',text:'Example street'});await call('fill',{selector:'#zip',text:'12345'});
  const file=join(dir,'resume.txt');await writeFile(file,'Local upload reload fixture');
  await call('upload_file',{selector:'#upload',files:[file]});
  await until(async()=>await page('sessionStorage.uploadChanges')==='1'&&await page('document.querySelector("#street")?.value')==='','upload-triggered reload');
  await call('wait',{selector:'#street',condition:'visible'});
  assert.equal(await page('document.querySelector("#zip").value'),'');
  const restored=await call('batch',{steps:[{action:'fill',selector:'#street',text:'Example street'},{action:'fill',selector:'#zip',text:'12345'}]});
  assert.equal(restored.completed,true);assert.equal(await page('sessionStorage.uploadChanges'),'1');
  results.cases.push({scenario:'upload_reload_clears_fields_then_explicit_restore',restored});

  let uncertain;
  try{await call('evaluate',{expression:'new Promise(resolve=>{setTimeout(()=>{history.pushState({},"","#evaluated");document.body.dataset.evaluated="yes"},20);setTimeout(resolve,15000)})',timeout_ms:200})}catch(error){uncertain=error}
  assert.equal(uncertain.input_dispatched,true);assert.equal(uncertain.post_action.delivery,'unknown');
  assert.equal(uncertain.post_action.navigation_observed,true);assert.ok(uncertain.post_action.current_url.endsWith('#evaluated'));
  results.cases.push({scenario:'evaluation_timeout_with_observed_navigation',post_action:uncertain.post_action});
 } else if (values.extended) {
  await client.call('activate_tab',h);const call=(method,args={})=>client.call(method,{...h,...args});
  await call('fill',{selector:'#edit',text:'seed'});assert.equal(await page('window.keys.filter(e=>e.type==="keydown").length'),0);
  await page('window.keys=[];true');
  const typed=await call('type',{selector:'#edit',text:'A中+',delay_ms:30});
  assert.equal(typed.typed,3);assert.equal(await page('document.querySelector("#edit").value'),'seedA中+');
  const keys=await page('window.keys');for(const type of ['keydown','keypress','input','keyup'])assert.equal(keys.filter(e=>e.type===type&&e.trusted).length,3,type);
  const downs=keys.filter(e=>e.type==='keydown');assert.ok(downs[1].time-downs[0].time>=30);
  await call('type',{selector:'#edit',text:'#'});assert.equal(await page('document.querySelector("#edit").value'),'seedA中+');
  results.cases.push({scenario:'character_events',keys});
  await call('wait',{selector:'input',frame:{path:['iframe[title="Outer"]','iframe[title="Inner"]']},condition:'visible'});
  await call('fill',{selector:'input',frame:{path:['iframe[title="Outer"]','iframe[title="Inner"]']},text:'nested'});
  assert.equal((await call('read_text',{selector:'input',mode:'value',frame:{title:'Inner document'}})).text,'nested');
  assert.equal((await call('evaluate',{expression:'() => document.title',frame:{url:base.replace('127.0.0.1','localhost')+'/inner'}})).value,'Inner document');
  results.cases.push({scenario:'stable_frame_path_title_url'});
  await call('fill',{selector:'textbox',selector_type:'role',name:'Inner input',frame:{title:'Inner document'},text:'OOPIF'});
  await call('type',{focused:true,text:'中'});
  assert.equal((await call('read_text',{selector:'textbox',selector_type:'role',name:'Inner input',frame:{title:'Inner document'},mode:'value'})).text,'OOPIF中');
  results.cases.push({scenario:'oopif_role_and_focused_type'});
  let f=await call('evaluate',{expression:'async () => Array.from({length:10},(_,i)=>i)',max_chars:5});let valuesRead=[...f.value];while(f.next_cursor){f=await call('evaluate',{cursor:f.next_cursor,max_chars:5});valuesRead.push(...f.value)}assert.equal(valuesRead.length,10);
  const handle=await call('evaluate',{expression:'() => document.querySelector("#increment")',result_type:'element'});await call('click',{ref:handle.ref});assert.equal(await page('window.count'),1);
  const found=await call('scroll',{selector:'#list',until:{text:'Row 0487',selector:'button'},delta_y:200,max_steps:60,timeout_ms:15000});await call('click',{ref:found.ref});assert.equal(await page('window.selectedRow'),'Row 0487');
  results.cases.push({scenario:'virtual_row_ref',found});
  const steps=[{action:'click',selector:'#increment'},{action:'wait',selector:'#later',condition:'visible',timeout_ms:150},{action:'click',selector:'#increment'}];
  const failed=await call('batch',{steps});assert.equal(failed.failed_step,1);assert.equal(failed.retry_failed_step_safe,true);assert.equal(await page('window.count'),2);
  await page('const later=document.createElement("button");later.id="later";later.textContent="Later";document.body.append(later);true');
  const resumed=await call('batch',{steps,start_at:1});assert.equal(resumed.completed,true);assert.equal(await page('window.count'),3);
  const extendedBatch=await call('batch',{steps:[{action:'hover',selector:'#increment'},{action:'scroll',selector:'#list',delta_y:-200},{action:'select_option',selector:'#select',value:'b'},{action:'wait',selector:'#later',condition:'attached'}]});assert.equal(extendedBatch.completed,true);
  results.cases.push({scenario:'batch_deadline_resume',failed});
  await call('logs',{kind:'network',capture:{enabled:true,max_body_bytes:4096}});
  await call('evaluate',{expression:'() => fetch("/echo",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer hidden"},body:JSON.stringify({field:"kept",password:"hidden password"})}).then(r=>r.json())'});
  const network=await call('logs',{kind:'network',url_contains:'/echo',max_chars:100000});
  assert.ok(network.entries.some(e=>e.method==='POST'));assert.ok(network.entries.some(e=>e.status===200));
  assert.ok(network.entries.some(e=>e.request_body?.text.includes('kept')));assert.ok(network.entries.some(e=>e.response_body?.text.includes('kept')));
  assert.ok(!JSON.stringify(network).includes('Bearer hidden'));assert.ok(!JSON.stringify(network).includes('hidden password'));assert.ok(!JSON.stringify(network).includes('hidden response credential'));assert.ok(!JSON.stringify(network).includes('secret_cookie=hidden'));
  await call('logs',{kind:'network',capture:{enabled:false}});results.cases.push({scenario:'network_details',network});
  const shot=await call('screenshot',{selector:'#capture'}),png=Buffer.from(shot.data,'base64');assert.equal(shot.capture.scope,'element');assert.equal(png.readUInt32BE(16),160);assert.equal(png.readUInt32BE(20),80);assert.equal(shot.capture.image_origin_css.y,1400);
  await writeFile(join(ROOT,'test-results','element-evidence.png'),png);
  const full=await call('screenshot',{full_page:true});assert.ok(full.capture.css_height>=1480);results.cases.push({scenario:'element_and_full_capture',capture:shot.capture});
  const file1=join(dir,'one.txt'),file2=join(dir,'two.txt');await writeFile(file1,'one');await writeFile(file2,'two');
  const fileRef=await call('evaluate',{expression:'() => window.closedInput',result_type:'element'});await call('upload_file',{ref:fileRef.ref,files:[file1,file2]});assert.equal(await page('window.closedInput.files.length'),2);await call('upload_file',{ref:fileRef.ref,files:[]});assert.equal(await page('window.closedInput.files.length'),0);
  await call('click',{selector:'#chooseclosed'});await call('upload_file',{files:[file1,file2]});assert.equal(await page('window.closedInput.files.length'),2);
  await call('click',{selector:'#chooseclosed'});await call('upload_file',{files:[]});assert.equal(await page('window.closedInput.files.length'),0);
  const uploadEvents=await page('window.uploadEvents');assert.equal(uploadEvents[0].trusted,true);assert.equal(uploadEvents[2].trusted,false);
  results.cases.push({scenario:'closed_shadow_multiple_clear',uploadEvents});
  const alertBatch=await call('batch',{dialog_policy:'accept',steps:[{action:'click',selector:'#alert'},{action:'click',selector:'#increment'}]});assert.equal(alertBatch.completed,true);assert.ok(alertBatch.dialogs.some(d=>d.message==='Continue alert'&&d.accepted));
  const dismissed=await call('click',{selector:'#confirm',dialog_policy:'dismiss'});assert.equal(await page('window.confirmed'),false);assert.equal(dismissed.dialogs[0].accepted,false);
  results.cases.push({scenario:'automatic_dialog_policy',alertBatch,dismissed});
  let unknown;try{await call('click',{selector:'#unreceipt',timeout_ms:10000})}catch(e){unknown=e}assert.match(unknown.message,/Outcome is unknown/);assert.equal(unknown.post_action.dom_changed,true);assert.equal(await page('document.querySelector("#mark").textContent'),'Effect observed');results.cases.push({scenario:'post_action_observation',post_action:unknown.post_action});
  const whole=await call('read_text');assert.ok(whole.text.includes('Increment'));assert.ok(whole.text.includes('Element evidence'));results.cases.push({scenario:'whole_rendered_text'});
  await call('navigate',{url:base+'/second',include_snapshot:false});await call('navigate',{direction:'back',include_snapshot:false,wait_until:'load'});assert.equal(await page('location.pathname'),'/probe');await call('navigate',{direction:'forward',include_snapshot:false,wait_until:'load'});assert.equal(await page('location.pathname'),'/second');
  await page('history.pushState({},"","#spa");true');await call('navigate',{direction:'back',include_snapshot:false});assert.equal(await page('location.hash'),'');
  results.cases.push({scenario:'history_document_and_spa'});
  await call('click',{selector:'#increment'});await page('window.onbeforeunload=e=>{e.preventDefault();e.returnValue=""};true');
  const cancelled=await call('navigate',{url:base+'/blocked',dialog_policy:'dismiss',include_snapshot:false,timeout_ms:3000});assert.equal(cancelled.cancelled_by_dialog,true);assert.equal(await page('location.pathname'),'/second');
  const accepted=await call('navigate',{url:base+'/accepted',dialog_policy:'accept',include_snapshot:false,timeout_ms:5000});assert.ok(accepted.dialogs.some(d=>d.type==='beforeunload'&&d.accepted));assert.equal(await page('location.pathname'),'/accepted');
  results.cases.push({scenario:'beforeunload_policy',cancelled,accepted});
 } else if (values.primitives) {
  await client.call('activate_tab',h);
  const call=(method,args={})=>client.call(method,{...h,...args});
  const menuSnap=await call('snapshot'),menuRef=menuSnap.snapshot.match(/\[([^\]]+)\] button "Menu"/)[1];
  await call('hover',{ref:menuRef});
  assert.equal(await page('window.enters'),1);assert.equal(await page('window.childClicks'),0);
  assert.ok((await page('window.events')).every(e=>!['mousedown','mouseup','click'].includes(e.type)));
  await pause(350);
  await call('click',{selector:'#child'});
  assert.equal(await page('window.enters'),1);assert.equal(await page('window.leaves'),0);assert.equal(await page('window.childClicks'),1);
  results.cases.push({scenario:'hover_then_child',enters:1,leaves:0,clicks:1});
  await page(`(() => {
    const button=document.createElement('button');button.id='motion-probe';button.textContent='Motion';
    button.style='position:fixed;left:760px;top:180px;width:120px;height:40px;padding:0;border:0';document.body.append(button);
    window.motionClicks=[];button.onclick=e=>window.motionClicks.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted});
    window.motionKeys=[];document.querySelector('#edit').addEventListener('keydown',e=>window.motionKeys.push({time:performance.now(),trusted:e.isTrusted}));
    return true;
  })()`);
  const offsetClick=await call('click',{selector:'#motion-probe',offset:{x_ratio:.25,y_ratio:.75},settle_ms:[80,120]});
  assert.deepEqual(offsetClick.clicked,{x:790,y:210});
  assert.deepEqual(await page('window.motionClicks'),[{x:790,y:210,trusted:true}]);
  await call('fill',{selector:'#edit',text:''});
  await call('type',{selector:'#edit',text:'Ab中+',delay_ms:[40,80]});
  assert.equal(await page('document.querySelector("#edit").value'),'Ab中+');
  const motionKeys=await page('window.motionKeys');assert.equal(motionKeys.length,4);
  assert.ok(motionKeys.every(k=>k.trusted));
  for(let i=1;i<motionKeys.length;i++)assert.ok(motionKeys[i].time-motionKeys[i-1].time>=39);
  results.cases.push({scenario:'optional_offset_settle_and_type_delay_range',offsetClick,motionKeys});
  await page('document.querySelector("#motion-probe").remove();true');
  await page(`(() => {
    const section=document.createElement('section');section.id='semantic-probe';
    section.style='position:fixed;left:20px;top:360px;width:700px;background:white;z-index:10';
    section.innerHTML='<label for="semantic-field">工作 职责</label><input id="semantic-field" placeholder="Write here">'
      +'<div><div>性别</div><input id="context-field" aria-label="必填项未填写"></div>'
      +'<label>Repeated<input class="repeat-field"></label><label>Repeated<input class="repeat-field"></label>'
      +'<button id="choose-year" type="button">Choose year</button><div id="year-list" role="listbox" hidden><div role="option" tabindex="0">2026</div></div>'
      +'<div id="semantic-shadow"></div><div id="semantic-open-shadow"></div><iframe id="semantic-frame" title="Semantic frame"></iframe>';
    section.querySelector('iframe').src='/inner';
    section.querySelector('#choose-year').onclick=()=>setTimeout(()=>section.querySelector('#year-list').hidden=false,100);
    section.querySelector('[role=option]').onclick=e=>{window.chosenYear=e.target.textContent;window.yearTrusted=e.isTrusted};
    const root=section.querySelector('#semantic-shadow').attachShadow({mode:'closed'});
    root.innerHTML='<button>Shadow action</button>';root.querySelector('button').onclick=()=>window.shadowAction=true;
    section.querySelector('#semantic-open-shadow').attachShadow({mode:'open'}).innerHTML='<input aria-label="Open shadow input">';
    document.body.append(section);return true;
  })()`);
  await call('fill',{selector:'工作  职责',selector_type:'label',text:'Responsibilities'});
  assert.equal((await call('read_text',{selector:'Write here',selector_type:'placeholder',mode:'value'})).text,'Responsibilities');
  await call('fill',{selector:'textbox',selector_type:'role',name:'工作 职责',text:'Role fill'});
  assert.equal((await call('read_text',{selector:'textbox',selector_type:'role',name:'工作 职责',mode:'value'})).text,'Role fill');
  const point=await page('(()=>{const r=document.querySelector("#semantic-field").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await call('click',point);await call('press_key',{key:'End'});await call('type',{focused:true,text:'中+'});
  assert.equal(await page('document.querySelector("#semantic-field").value'),'Role fill中+');
  await assert.rejects(call('fill',{selector:'Repeated',selector_type:'label',text:'wrong'}),/matched 2/);
  assert.deepEqual(await page('Array.from(document.querySelectorAll(".repeat-field"),e=>e.value)'),['','']);
  const ctx=await call('snapshot',{profile:'interactive',text:false,query:'性别'});
  assert.match(ctx.snapshot,/textbox "必填项未填写".*context="性别"/);
  const contextRef=ctx.snapshot.match(/\[([^\]]+)\] textbox/)[1];
  await call('fill',{ref:contextRef,text:'Context ref'});
  assert.equal(await page('document.querySelector("#context-field").value'),'Context ref');
  const dropdown=await call('batch',{steps:[
    {action:'click',selector:'button',selector_type:'role',name:'Choose year'},
    {action:'wait',selector:'option',selector_type:'role',name:'2026',condition:'visible'},
    {action:'click',selector:'option',selector_type:'role',name:'2026'},
    {action:'fill',selector:'Write here',selector_type:'placeholder',text:'Batch'},
    {action:'type',focused:true,text:'!'},
  ]});
  assert.equal(dropdown.completed,true);assert.equal(await page('window.chosenYear'),'2026');assert.equal(await page('window.yearTrusted'),true);
  assert.equal(await page('document.querySelector("#semantic-field").value'),'Batch!');
  await call('click',{selector:'button',selector_type:'role',name:'Shadow action'});
  assert.equal(await page('window.shadowAction'),true);
  await call('fill',{selector:'textbox',selector_type:'role',name:'Open shadow input',text:'Shadow'});
  await call('type',{focused:true,text:'中'});
  assert.equal((await call('read_text',{selector:'textbox',selector_type:'role',name:'Open shadow input',mode:'value'})).text,'Shadow中');
  await call('fill',{selector:'textbox',selector_type:'role',name:'Inner input',frame:{title:'Inner document'},text:'Frame'});
  await call('type',{focused:true,text:'中'});
  assert.equal((await call('read_text',{selector:'textbox',selector_type:'role',name:'Inner input',frame:{title:'Inner document'},mode:'value'})).text,'Frame中');
  await page('document.querySelector("#semantic-field").focus();document.querySelector("#semantic-field").value="";document.querySelector("#semantic-field").oninput=()=>document.querySelector("#context-field").focus();true');
  await assert.rejects(call('type',{focused:true,text:'abc'}),/stopped after 1.*lost focus/);
  assert.equal(await page('document.querySelector("#semantic-field").value'),'a');
  assert.equal(await page('document.querySelector("#context-field").value'),'Context ref');
  const nested=await call('evaluate',{expression:'(window.evalRuns=(window.evalRuns||0)+1,{count:104,items:Array.from({length:104},(_,i)=>({i,text:"x".repeat(240)}))})'});
  assert.equal(nested.next_item.key,'items');assert.ok(nested.next_item.required_chars>20000);
  const continued=await call('evaluate',{cursor:nested.next_cursor,max_chars:nested.next_item.required_chars});
  assert.equal(continued.value.items.length,104);assert.equal(await page('window.evalRuns'),1);
  results.cases.push({scenario:'semantic_locators_focused_type_context_and_nested_budget',dropdown,context_snapshot:ctx.snapshot,next_item:nested.next_item});
  await page('document.querySelector("#semantic-probe").remove();true');
  const offsetHover=await call('hover',{selector:'#menu',offset:{x_ratio:.25,y_ratio:.25}});
  assert.equal(offsetHover.target_verified,true);
  await page(`(()=>{const section=document.createElement('section');section.id='density';section.setAttribute('role','region');section.setAttribute('aria-label','Density controls');for(let i=0;i<200;i++){const p=document.createElement('p');p.textContent='Reading row '+i+': '+ 'long prose '.repeat(25);section.append(p)}const button=document.createElement('button');button.setAttribute('aria-label','Density action');button.textContent='Extra context '.repeat(30);section.append(button);document.body.append(section);return true})()`);
  const fullView=await call('snapshot'),interactiveView=await call('snapshot',{profile:'interactive'});
  assert.equal(fullView.truncated,true);assert.equal(interactiveView.truncated,false);
  assert.doesNotMatch(interactiveView.snapshot,/Reading row/);assert.match(interactiveView.snapshot,/region "Density controls"/);
  assert.match(interactiveView.snapshot,/button "Density action"/);assert.ok(interactiveView.snapshot.includes('Extra context '.repeat(30).slice(0,80)+'…'));
  assert.ok(interactiveView.snapshot.length<fullView.snapshot.length/5);
  const noTextView=await call('snapshot',{profile:'interactive',text:false});
  assert.doesNotMatch(noTextView.snapshot,/StaticText|Extra context/);assert.match(noTextView.snapshot,/button "Density action"/);
  results.cases.push({scenario:'snapshot_interactive_density',full_chars:fullView.snapshot.length,interactive_chars:interactiveView.snapshot.length,full_has_more:fullView.truncated,interactive_has_more:interactiveView.truncated});
  await page('document.querySelector("#density").remove();true');
  // One observation, two inputs and an intervening expression evaluation.
  const snap=await call('snapshot',{profile:'interactive'});const ref=snap.snapshot.match(/\[([^\]]+)\] textbox "Edit"/)[1];
  await call('fill',{ref,text:'first'});await call('evaluate',{expression:'document.title'});await call('fill',{ref,text:'second'});
  assert.equal(await page('document.querySelector("#edit").value'),'second');
  results.cases.push({scenario:'ref_two_inputs_one_snapshot',survives_evaluation:true});
  await page('document.querySelector("#edit").setAttribute("aria-label","Different");true');
  await assert.rejects(call('fill',{ref,text:'must not reach repurposed node'}),/identity changed/);
  await page('document.querySelector("#edit").outerHTML=\'<input id="edit" aria-label="Edit">\';true');
  await assert.rejects(call('fill',{ref,text:'must not reach replacement'}),/detached|stale|identity changed|[Nn]o node|[Cc]ould not find/);
  assert.equal(await page('document.querySelector("#edit").value'),'');
  results.cases.push({scenario:'ref_replaced_node_refused'});
  for (const choice of [{label:'Beta'},{value:'a'},{index:1}]) {
   const selected=await call('select_option',{selector:'#select',...choice});assert.equal(selected.value_verified,true);assert.equal(selected.events_trusted,false);
  }
  assert.ok((await page('window.selectedEvents')).every(e=>e.trusted===false));
  let error;const before=performance.now();try{await call('click',{selector:'#select',timeout_ms:30000})}catch(e){error=e.message}
  assert.match(error,/No input was dispatched.*browser_select_option/);assert.ok(performance.now()-before<2000);
  results.cases.push({scenario:'select_without_popup',error,ms:Math.round(performance.now()-before)});
  await page('setTimeout(()=>{const b=document.createElement("button");b.id="late";b.textContent="Later";document.body.append(b)},2500);true');
  await call('wait',{selector:'#late',condition:'visible',timeout_ms:4000});
  await page('setTimeout(()=>{document.querySelector("#late").textContent="Ready";history.pushState({},"","/probe#done")},100);true');
  await call('wait',{selector:'#late',condition:'text',expected:'Ready'});await call('wait',{condition:'url',expected:'#done'});
  await page('setTimeout(()=>document.querySelector("#late").textContent="Completed",100);true');
  assert.equal((await call('wait',{selector:'#late',condition:'text',previous:'Ready'})).results[0].actual.text,'Completed');
  await call('wait',{selector:'#child',condition:'actionable'});
  await page('fetch("/slow.js?wait");true');await call('wait',{condition:'network_idle',idle_ms:200,timeout_ms:4000});
  for(const [selector,condition] of [['#absent','attached'],['#hidden','visible'],['#disabled','actionable']]) {
   const result=await call('wait',{selector,condition,timeout_ms:150});
   assert.equal(result.status,'fail',JSON.stringify(result));assert.equal(result.timed_out,true);results.cases.push({scenario:'wait_failure',selector,result});
  }
  await page(`(() => {
    const section=document.createElement('section');section.id='wait-probe';
    section.innerHTML='<button id="wait-trigger" style="position:fixed;left:20px;top:460px;z-index:999">Change state</button>'
      +'<input id="wait-value" value="before"><input id="wait-check" type="checkbox">'
      +'<select id="wait-select"><option>Before</option><option id="wait-option">After</option></select>'
      +'<button role="combobox" aria-label="State picker" id="wait-expanded" aria-expanded="false">Picker</button>'
      +'<div role="listbox"><div role="option" aria-selected="false" id="wait-aria-option">State option</div></div>'
      +'<button id="wait-gone">Gone state probe</button><div id="wait-hidden" hidden></div><div id="wait-unknown"></div>';
    window.waitWrites=0;
    section.querySelector('#wait-trigger').onclick=()=>{window.waitWrites++;setTimeout(()=>{
      section.querySelector('#wait-value').outerHTML='<input id="wait-value" value="after">';
      section.querySelector('#wait-check').checked=true;section.querySelector('#wait-select').selectedIndex=1;
      section.querySelector('#wait-expanded').setAttribute('aria-expanded','true');
      section.querySelector('#wait-aria-option').setAttribute('aria-selected','true');section.querySelector('#wait-gone').remove();
    },100)};
    document.body.append(section);return true;
  })()`);
  await call('wait',{selector:'#wait-check',condition:'checked',expected:false});
  const stateWaits=await call('batch',{steps:[
    {action:'click',selector:'#wait-trigger',mode:'dom'},
    {action:'wait',selector:'#wait-value',condition:'value',expected:'after'},
    {action:'wait',selector:'#wait-check',condition:'checked',expected:true},
    {action:'wait',selector:'#wait-option',condition:'selected',expected:true},
    {action:'wait',selector:'combobox',selector_type:'role',name:'State picker',condition:'expanded',expected:true},
    {action:'wait',selector:'option',selector_type:'role',name:'State option',condition:'selected',expected:true},
    {action:'wait',selector:'#wait-gone',condition:'absent'},
    {action:'wait',selector:'button',selector_type:'role',name:'Gone state probe',condition:'absent'},
  ]});
  assert.equal(stateWaits.completed,true);assert.ok(stateWaits.results.slice(1).every(r=>r.status==='pass'));
  for (const [selector,condition,expected] of [['#wait-hidden','absent',undefined],['#wait-unknown','expanded',false]]) {
    const result=await call('wait',{selector,condition,expected,timeout_ms:150});
    assert.equal(result.status,condition==='absent'?'fail':'unavailable');assert.equal(result.retry_safe,true);
    assert.equal(result.results[0].actual.state,condition==='absent'?'attached':'unavailable');
  }
  assert.equal(await page('window.waitWrites'),1);
  await call('wait',{selector:'#wait-check',condition:'checked',expected:true});
  await page('document.querySelector("#wait-check").indeterminate=true;true');
  await call('wait',{selector:'#wait-check',condition:'checked',expected:'mixed'});
  const newObservation=await call('snapshot',{query:'State picker'}),oldStateRef=newObservation.snapshot.match(/\[([^\]]+)\] combobox/)[1];
  await call('snapshot',{query:'State picker'});
  await assert.rejects(call('click',{ref:oldStateRef}),error=>{assert.equal(error.diagnostics.cause,'snapshot_replaced');return true});
  results.cases.push({scenario:'explicit_state_waits_and_ref_diagnostics',stateWaits,writes:1});
  await page('document.querySelector("#wait-probe").remove();true');
  await page('window.events=[];true');
  const pointer=await call('drag',{source:{selector:'#slider'},destination:{x:550,y:255},steps:8,mode:'pointer',timeout_ms:5000});
  assert.equal(pointer.delivery_verified,true);assert.ok(await page('window.pointerMoves>=8'));
  results.cases.push({scenario:'pointer_drag',result:pointer,events:await page('window.events')});
  await page('window.motionMoves=[];document.addEventListener("mousemove",e=>{if(e.buttons===1)window.motionMoves.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted,time:performance.now()})});true');
  const curved=await call('drag',{source:{selector:'#slider'},destination:{x:550,y:255},steps:24,settle_ms:[80,120],trajectory:{curve_px:12,duration_ms:600}});
  const curvedMoves=await page('window.motionMoves');
  assert.deepEqual(curved.to,{x:550,y:255});assert.equal(curvedMoves.length,25);
  assert.ok(curvedMoves.every(e=>e.trusted));assert.ok(curvedMoves.some(e=>e.y>256));
  assert.equal(curvedMoves.at(-1).x,550);assert.equal(curvedMoves.at(-1).y,255);
  results.cases.push({scenario:'optional_curved_pointer_drag',result:curved,events:curvedMoves});
  await page('window.events=[];window.pointerMoves=0;document.querySelector("#slider").addEventListener("pointerdown",e=>e.preventDefault(),{once:true});true');
  const cancelledMouse=await call('drag',{source:{selector:'#slider'},destination:{x:550,y:255},steps:8,mode:'pointer'});
  assert.equal(cancelledMouse.delivery_verified,true);assert.ok(await page('window.pointerMoves>=8'));
  assert.ok(!(await page('window.events')).some(e=>['mousedown','mouseup'].includes(e.type)));
  results.cases.push({scenario:'pointer_drag_without_mouse_compatibility',result:cancelledMouse});
  await page(`(() => {
    const slider=document.createElement('div');slider.id='document-slider';slider.style='position:absolute;left:700px;top:900px;width:150px;height:600px;touch-action:none';
    document.body.append(slider);window.documentDragEvents=[];
    for(const type of ['pointerdown','pointermove','pointerup'])slider.addEventListener(type,e=>{
      if(type==='pointerdown')slider.setPointerCapture(e.pointerId);
      if(type!=='pointermove'||e.buttons===1)window.documentDragEvents.push({type,x:e.clientX,y:e.clientY,pageY:e.pageY});
    });return true;
  })()`);
  const documentDrag=await call('drag',{source:{x:750,y:1000,coordinate_space:'document'},destination:{x:750,y:1200,coordinate_space:'document'},steps:8});
  const documentEvents=await page('window.documentDragEvents');
  assert.equal(documentDrag.to.y-documentDrag.from.y,200);
  assert.equal(documentEvents.at(-1).y-documentEvents[0].y,200);
  const documentMoves=documentEvents.filter(e=>e.type==='pointermove').slice(-8);
  assert.equal(documentMoves.length,8);
  documentMoves.forEach((event,index)=>assert.ok(Math.abs(event.y-documentEvents[0].y-(index+1)*25)<1));
  results.cases.push({scenario:'document_coordinate_vertical_drag',result:documentDrag,events:documentEvents});
  await page('window.events=[];true');
  const html5=await call('drag',{source:{selector:'#drag'},destination:{selector:'#drop'},steps:8,mode:'html5',timeout_ms:5000});
  const events=await page('window.events');
  for(const type of ['dragstart','dragover','drop','dragend'])assert.ok(events.some(e=>e.type===type&&e.trusted),type);
  results.cases.push({scenario:'html5_drag',result:html5,events});
  await page('window.events=[];true');
  const curvedHtml5=await call('drag',{source:{selector:'#drag'},destination:{selector:'#drop'},steps:16,mode:'html5',trajectory:{curve_px:-12,duration_ms:300}});
  assert.equal(curvedHtml5.delivery_verified,true);
  assert.ok((await page('window.events')).some(e=>e.type==='drop'&&e.target==='drop'&&e.trusted));
  results.cases.push({scenario:'optional_curved_html5_drag',result:curvedHtml5});
  await page('window.events=[];true');
  const far=await call('drag',{source:{selector:'#drag'},destination:{selector:'#far'},steps:8,mode:'html5',timeout_ms:5000});
  assert.ok(await page('scrollY>1000'));assert.ok((await page('window.events')).some(e=>e.type==='drop'&&e.target==='far'&&e.trusted));
  results.cases.push({scenario:'html5_offscreen',result:far});
  await page('window.events=[];document.querySelector("#drag").style.top="1000px";document.querySelector("#drop").style.top="1200px";true');
  const documentHtml5=await call('drag',{source:{x:370,y:1040,coordinate_space:'document'},destination:{x:650,y:1260,coordinate_space:'document'},steps:8,mode:'html5'});
  assert.equal(documentHtml5.to.y-documentHtml5.from.y,220);
  assert.equal(documentHtml5.to.x-documentHtml5.from.x,280);
  assert.ok((await page('window.events')).some(e=>e.type==='drop'&&e.target==='drop'&&e.trusted));
  results.cases.push({scenario:'document_coordinate_html5_drag',result:documentHtml5});
  await page(`(() => {
    const probe=document.createElement('section');probe.id='scroll-probe';
    probe.innerHTML='<div><div style="visibility:hidden"><button style="visibility:visible">Scroll needle</button></div></div><div hidden>Scroll needle</div>';
    document.body.append(probe);return true;
  })()`);
  const deepest=await call('scroll',{selector:'#scroll-probe',until:{text:'Scroll needle'},max_steps:1});
  assert.equal(deepest.name,'Scroll needle');assert.equal(deepest.role,'button');assert.equal(deepest.scroll_steps,0);
  await page(`document.querySelector('#scroll-probe').insertAdjacentHTML('beforeend','<div><button>Scroll needle</button></div>');true`);
  await assert.rejects(call('scroll',{selector:'#scroll-probe',until:{text:'Scroll needle'},max_steps:1}),/matched 2.*Scope until.selector/);
  const scoped=await call('scroll',{selector:'#scroll-probe',until:{text:'Scroll needle',selector:'button[style]'},max_steps:1});
  assert.equal(scoped.name,'Scroll needle');assert.equal(scoped.scroll_steps,0);
  await page(`document.querySelector('#scroll-probe').remove();true`);
  results.cases.push({scenario:'scroll_deepest_filtered_descendant_and_sibling_ambiguity',result:deepest});
  await page(`(() => {
    const list=document.createElement('div');list.id='lazy-list';list.style='position:fixed;left:20px;top:350px;width:200px;height:100px;overflow:auto';
    document.body.append(list);
    list.addEventListener('scroll',()=>setTimeout(()=>{const b=document.createElement('button');b.textContent='Delayed result';list.append(b)},200),{once:true});
    setTimeout(()=>{const filler=document.createElement('div');filler.style.height='400px';list.append(filler)},500);
    return true;
  })()`);
  const delayed=await call('scroll',{selector:'#lazy-list',until:{text:'Delayed result',selector:'button'},max_steps:20,timeout_ms:3000});
  assert.equal(delayed.found,true);assert.ok(delayed.scroll_steps>=2);
  results.cases.push({scenario:'scroll_boundary_delayed_growth',result:delayed});
  await page(`(() => {for(let i=0;i<3;i++){const b=document.createElement('button');b.className='ambiguity-probe';b.textContent='Choice '+i;b.disabled=i===2;if(i===1)b.hidden=true;document.body.append(b)}return true})()`);
  await assert.rejects(call('wait',{selector:'.ambiguity-probe',condition:'attached'}),error=>{
    assert.match(error.message,/matched 3/);
    assert.match(error.message,/"nth":1,"tag":"button","text":"Choice 1","disabled":false,"visible":false/);
    assert.match(error.message,/"nth":2,"tag":"button","text":"Choice 2","disabled":true,"visible":true/);
    return true;
  });
  results.cases.push({scenario:'ambiguity_candidates'});
 } else if (values.forms) {
  await client.call('activate_tab',h);
  const fill = (selector, text, mode='native', nth) => client.call('fill',{...h,selector,text,mode,...(nth==null?{}:{nth})});
  const click = selector => client.call('click',{...h,selector});
  const inspect = () => page('({state:window.formState,events:window.formEvents,error:document.querySelector("#error").textContent})');
  assert.equal((await fill('input[placeholder="公司名称"]','DOM company','dom',0)).application_result,'not_checked');
  assert.equal((await inspect()).state.rows[0].company,'DOM company','native setter + untrusted input can update an ordinary React controlled field');
  await click('#add');
  assert.equal(await page('document.querySelector("input").value'),'DOM company','React state survives remount');
  const beforeAmbiguity=await inspect();
  await assert.rejects(fill('input[placeholder="公司名称"]','ambiguous'),/matched 2/);
  assert.deepEqual((await inspect()).state,beforeAmbiguity.state);
  const batch=await client.call('batch',{...h,steps:[
   {action:'fill',selector:'input[placeholder="公司名称"]',nth:1,text:'Native company'},
   {action:'press_key',key:'Tab'},
   {action:'click',selector:'#year'},
   {action:'fill',selector:'#year',text:'2026'},
   {action:'click',selector:'.year-option[data-value="2026"]'},
   {action:'click',selector:'#month'},
   {action:'fill',selector:'#month',text:'9'},
   {action:'click',selector:'.month-option[data-value="9"]'},
  ]});
  assert.equal(batch.completed,true,JSON.stringify(batch));
  const saved=await inspect();
  assert.equal(saved.state.rows[1].company,'Native company');assert.equal(saved.state.year,2026);assert.equal(saved.state.month,9);assert.equal(saved.error,'');
  await click('#add');assert.equal((await inspect()).state.month,9);assert.equal(await page('document.querySelectorAll("input[placeholder=公司名称]")[1].value'),'Native company');
  // Typing a filter is deliberately different from selecting the option.
  await click('#year');await fill('#year','2025','dom');
  assert.equal((await inspect()).state.year,2026);
  await client.call('press_key',{...h,key:'Tab'});await click('#add');
  assert.equal((await inspect()).state.year,2026);
  const rect=await page('(()=>{const r=document.querySelector("#previous").getBoundingClientRect();return {x:r.x-15,y:r.y+r.height/2}})()');
  const pseudo=await client.call('click',{...h,...rect,detailed:true});
  assert.equal(pseudo.delivery_verified,true);assert.equal(pseudo.hit_target.pseudo_element,true);assert.equal((await inspect()).state.previous,1);
  const blocker=await evaluate(`chrome.windows.create({url:${JSON.stringify(base+'/cover')},focused:true})`);
  let occludedState;
  try {
   const result=await client.call('click',{...h,selector:'#add',detailed:true}); assert.equal(result.target_verified,true);
   occludedState=result.page_state;
   if(!values.headless){assert.equal(result.page_state.window_focused,false);assert.equal((await focus()).find(w=>w.id===blocker.id).focused,true);}
  } finally {await evaluate(`chrome.windows.remove(${blocker.id})`);}
  results.cases.push({scenario:'controlled_form',react:'18.3.1',dom_state_survives_remount:true,native_batch_steps:batch.results.length,filter_is_not_selection:true,blur_verified:true,pseudo_verified:true,occluded_page_state:occludedState});
  console.log(JSON.stringify(results.cases.at(-1)));
 } else if (values['tab-indicators']) {
  const nativeTab=await evaluate(`chrome.tabs.get(${tab.id})`);
  const marker=await evaluate(`chrome.tabGroups.get(${nativeTab.groupId})`);
  assert.equal(marker.title,'');assert.equal(marker.color,'red');assert.equal(marker.collapsed,false);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-attach]").length'),0);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-attach-click]").length'),0);
  const snap=await client.call('snapshot',h),ref=snap.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
  await assert.rejects(client.call('hover',{...h,ref}),/TAB_NOT_READY.*No input was dispatched/);
  await client.call('activate_tab',h);
  assert.equal((await client.call('click',{...h,ref})).target_verified,true);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-attach]").length'),0);
  await until(()=>page('document.querySelectorAll("[data-local-browser-attach-click]").length===1'),'transient click visual');
  await client.call('activate_tab',{...h,focus_window:false});
  const shot=await client.call('screenshot',h);
  assert.equal(shot.capture.agent_indicators_included,false);
  await client.call('navigate',{...h,url:base+'/slow'});
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,marker.id);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-attach]").length'),0);
  await client.call('release_tab',h);claim=null;
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,-1);
  results.cases.push({scenario:'native_marker_without_page_overlay',marker,screenshot_clean:true,navigation_preserved:true,release_removed:true});

  const original=await evaluate(`chrome.tabs.group({tabIds:[${tab.id},${cover.id}]})`);
  await evaluate(`chrome.tabGroups.update(${original},{title:'User research',color:'blue',collapsed:false})`);
  await evaluate(`chrome.tabs.update(${cover.id},{active:true})`);
  const claimAgain=async()=>{
   const current=(await client.call('list_tabs',{browser_id:browserInfo.browser_id})).tabs.find(t=>t.tab_id===tab.id);
   claim=await client.call('claim_tab',{browser_id:browserInfo.browser_id,tab_id:tab.id,expected_url:current.url,expected_title:current.title});
   assert.equal(claim.visual_warning,undefined);return {tab_handle:claim.tab_handle};
  };
  const groupedHandle=await claimAgain();
  assert.notEqual((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,original);
  await client.call('release_tab',groupedHandle);claim=null;
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,original);
  assert.equal((await evaluate(`chrome.tabGroups.get(${original})`)).title,'User research');
  assert.equal((await evaluate(`chrome.tabs.get(${cover.id})`)).active,true);
  results.cases.push({scenario:'original_group_restored',group_id:original,background_preserved:true});

  const disconnectedHandle=await claimAgain();
  await client.close();client=new AttachClient(paired.config);
  await until(async()=>(await evaluate(`chrome.tabs.get(${tab.id})`)).groupId===original,'session disconnect group restoration');
  await assert.rejects(client.call('snapshot',disconnectedHandle),/expired/);claim=null;
  results.cases.push({scenario:'session_disconnect_restores_group',restored:true});
 } else if (values['input-capture']) {
  await client.call('activate_tab',h);
  const refFor = (snapshot, role, label) => snapshot.snapshot.match(new RegExp(`\\[([^\\]]+)\\] ${role} "${label}"`))[1];
  const inputRef = async () => refFor(await client.call('snapshot',h),'textbox','Name');
  const buttonRef = async () => refFor(await client.call('snapshot',h),'button','Go');
  // Deterministically suppress browser-native input in a disposable tab. This
  // exercises ignored-input recovery, not an OS menu/tab-drag UI reproduction.
  const suppress = ignore => evaluate(`chrome.debugger.sendCommand({tabId:${tab.id}},'Input.setIgnoreInputEvents',{ignore:${ignore}})`);
  const fill = await client.call('fill',{...h,ref:await inputRef(),text:'native baseline'});
  assert.equal(fill.value_verified,true);
  const key = await client.call('press_key',{...h,key:'Control+A'});
  assert.equal(key.delivery_verified,true);
  results.cases.push({scenario:'native_baseline',fill,key});
  await page('window.__count=0;window.__events=[];true');
  await suppress(true);
  try {
   let clickError;const clickStart=performance.now();
   try { await client.call('click',{...h,ref:await buttonRef(),timeout_ms:30000}); } catch(error) { clickError=error.message; }
   assert.ok(clickError,'suppressed native click must fail');
   assert.match(clickError,/Outcome is unknown.*press Esc/);assert.ok(performance.now()-clickStart<2000);
   assert.equal((await state()).count,0);
   let keyError;const keyStart=performance.now();
   try { await client.call('press_key',{...h,key:'Z',timeout_ms:30000}); } catch(error) { keyError=error.message; }
   assert.ok(keyError,'suppressed keyboard input must fail');
   assert.match(keyError,/Outcome is unknown.*press Esc/);assert.ok(performance.now()-keyStart<2000);
   assert.equal(await page('document.querySelector("#edit").value'),'native baseline');
   results.cases.push({scenario:'native_input_suppressed',click_error:clickError,key_error:keyError,no_replay:true});
   const focusBefore=await page('document.activeElement.id');
   const domFill=await client.call('fill',{...h,ref:await inputRef(),text:'中文 DOM works',mode:'dom'});
   assert.equal(domFill.value_verified,true);assert.equal(domFill.events_trusted,false);
   assert.equal(await page('document.querySelector("#edit").value'),'中文 DOM works');
   assert.equal(await page('document.activeElement.id'),focusBefore);
   const domClick=await client.call('click',{...h,ref:await buttonRef(),mode:'dom'});
   assert.equal(domClick.events_trusted,false);assert.equal(domClick.method,'dom');
   const observed=await state();assert.equal(observed.count,1);
   assert.equal(observed.events.filter(e=>e.type==='click').at(-1).trusted,false);
   assert.equal(observed.events.filter(e=>e.type==='pointerdown').length,0);
   results.cases.push({scenario:'dom_during_suppression',fill:domFill,click:domClick,observed});
  } finally { await suppress(false); }
  await client.call('fill',{...h,ref:await inputRef(),text:'recovered'});
  await client.call('press_key',{...h,key:'Control+A'});
  assert.equal((await client.call('press_key',{...h,key:'Z'})).delivery_verified,true);
  assert.equal(await page('document.querySelector("#edit").value'),'z');
  assert.equal((await client.call('click',{...h,ref:await buttonRef()})).target_verified,true);
  assert.equal((await state()).count,2);
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,true);
  results.cases.push({scenario:'native_recovered',value:'z',count:2,background:false});
  await page(`document.body.insertAdjacentHTML('beforeend','<textarea aria-label="Extra area" style="position:fixed;left:20px;top:60px"></textarea><div contenteditable="true" role="textbox" aria-label="Rich editor" style="position:fixed;left:20px;top:120px;width:120px;height:50px;white-space:pre-wrap"></div>');true`);
  for (const label of ['Extra area','Rich editor']) {
   for (const mode of ['native','dom']) {
    const snap=await client.call('snapshot',h), text=`${mode} first\n第二行`;
    const result=await client.call('fill',{...h,ref:refFor(snap,'textbox',label),text,mode});
    assert.equal(result.value_verified,true);
    assert.equal(await page(`(()=>{const e=document.querySelector('[aria-label="${label}"]');return ${mode==='dom'?'e.isContentEditable?e.textContent:e.value':'e.isContentEditable?e.innerText:e.value'}})()`),text);
   }
  }
  results.cases.push({scenario:'textarea_and_contenteditable_multiline',modes:['native','dom'],verified:true});
  await page(`window.__frameReady=false;const f=document.createElement('iframe');f.style='position:fixed;left:600px;top:50px';f.onload=()=>{f.contentDocument.body.innerHTML='<input id="child" aria-label="Child input">';window.__frameReady=true};f.src='/ad';document.body.append(f);true`);
  await until(()=>page('window.__frameReady'),'child fixture');
  const childSnap=await client.call('snapshot',h);
  await client.call('fill',{...h,ref:refFor(childSnap,'textbox','Child input'),text:'child text'});
  await client.call('press_key',{...h,key:'Control+A'});
  assert.equal((await client.call('press_key',{...h,key:'Z'})).delivery_verified,true);
  assert.equal(await page('document.querySelector("iframe").contentDocument.querySelector("#child").value'),'z');
  results.cases.push({scenario:'keyboard_delivery_in_child_frame',verified:true});
 } else if (values.regressions) {
  // These actions use only the disposable fixture and the public Attach API.
  const refFor = snapshot => snapshot.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
  for (const target of ['ref', 'selector', 'viewport', 'document', 'offset']) for (let run=1;run<=3;run++) {
   await page('window.__count=0;window.__events=[];true');
   const snap = await client.call('snapshot', h), before = await focus(), start = performance.now();
   const args = target === 'ref' ? {ref:refFor(snap)} : target === 'selector' ? {selector:'#go'} :
    target === 'offset' ? {selector:'#go',offset:{x_ratio:.25,y_ratio:.75},settle_ms:20} :
    {x:260,y:220,...(target==='document'?{coordinate_space:'document'}:{})};
   const result = await client.call('click', {...h, ...args, detailed:true, ...(run===2?{button:'left',click_count:1,modifiers:[]}:{})});
   const observed = await state();
   assert.equal(result.delivery_verified,true);assert.equal(result.events_trusted,true);
   assert.equal(result.target_verified,['viewport','document'].includes(target)?null:true);
   assert.equal(result.page_state.tab_active,false);assert.equal(observed.count,1);
   assert.ok(observed.events.some(e=>e.type==='click'&&e.trusted&&e.target==='go'));
   const after = await focus();assert.deepEqual(after.map(({focused,...w})=>w),before.map(({focused,...w})=>w));
   for(const window of before)if(!window.focused)assert.equal(after.find(w=>w.id===window.id).focused,false);
   assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
   results.cases.push({scenario:`background_${target}`,run,ms:Math.round(performance.now()-start),verified:true,count:observed.count,focus_not_stolen:true,page_state:result.page_state});
  }
  const call = (method,args={}) => client.call(method,{...h,...args});
  for (const [method,args] of [
   ['hover',{selector:'#go'}],
   ...['pointer','html5'].map(mode=>['drag',{source:{selector:'#go'},destination:{x:500,y:220},mode}]),
   ...[{button:'right'},{button:'middle'},{click_count:2},...['Alt','Control','Meta','Shift'].map(key=>({modifiers:[key]}))]
    .map(options=>['click',{selector:'#go',...options}]),
  ]) {
   await page('window.__count=0;window.__events=[];true');const before=await focus();
   await assert.rejects(call(method,args),error=>{assert.match(error.message,/TAB_NOT_READY.*No input was dispatched/);assert.equal(error.input_dispatched,false);return true;});
   const observed=await state();assert.equal(observed.count,0);assert.equal(observed.events.length,0);
   const after=await focus();assert.deepEqual(after.map(({focused,...w})=>w),before.map(({focused,...w})=>w));
   for(const window of before)if(!window.focused)assert.equal(after.find(w=>w.id===window.id).focused,false);
   results.cases.push({scenario:'background_restricted_action',method,args,not_dispatched:true});
  }
  await page('window.__count=0;true');
  const batch = await call('batch',{steps:[{action:'click',selector:'#go'},{action:'click',selector:'#go'}]});
  assert.equal(batch.completed,true);assert.equal(await page('window.__count'),2);
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
  results.cases.push({scenario:'background_batch',clicks:2});
  await page(`window.__count=0;window.__swallow=e=>{if(e.target.id==='go'){window.__count++;e.stopImmediatePropagation()}};addEventListener('click',window.__swallow,true);true`);
  try {
   await assert.rejects(call('click',{selector:'#go',timeout_ms:30000}),error=>{assert.match(error.message,/Outcome is unknown/);assert.equal(error.input_dispatched,true);return true;});
   await pause(200);assert.equal(await page('window.__count'),1);
   results.cases.push({scenario:'background_lost_receipt',effect_count:1,no_replay:true});
  } finally {await page(`removeEventListener('click',window.__swallow,true);delete window.__swallow;true`);}
  await page(`window.__count=0;const overlay=document.createElement('div');overlay.id='cover-go';overlay.style='position:fixed;left:200px;top:200px;width:120px;height:40px;z-index:999;background:white';document.body.append(overlay);true`);
  try {
   await assert.rejects(call('click',{selector:'#go'}),error=>{assert.equal(error.input_dispatched,false);assert.equal(error.diagnostics.reason,'obstructed');return true;});
   assert.equal(await page('window.__count'),0);results.cases.push({scenario:'background_obstruction',not_dispatched:true});
  } finally {await page('document.querySelector("#cover-go").remove();true');}
  await client.call('activate_tab',h);
  await page('window.__count=0;true');
  const settling = call('click',{selector:'#go',settle_ms:500,detailed:true});
  await pause(200);await evaluate(`chrome.tabs.update(${cover.id},{active:true})`);
  assert.equal((await settling).page_state.tab_active,false);assert.equal(await page('window.__count'),1);
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
  results.cases.push({scenario:'tab_switch_during_click_settle',verified:true,clicks:1});
  await client.call('activate_tab',h);
  await page(`window.__adLoads=0;const ad=document.createElement('iframe');ad.id='ad';ad.style='position:fixed;left:600px;top:20px;width:200px;height:100px';ad.onload=()=>window.__adLoads++;ad.src='/ad';document.body.append(ad);true`);
  await until(()=>page('window.__adLoads>0'),'initial iframe load');
  const snap = await client.call('snapshot',h), mainRef = refFor(snap);
  await page(`document.querySelector('#ad').src='/ad?next';true`);
  await until(()=>page('window.__adLoads>1'),'iframe navigation');
  assert.equal((await client.call('click',{...h,ref:mainRef})).target_verified,true);
  results.cases.push({scenario:'main_ref_survives_iframe_navigation',target_verified:true});
  await page(`window.__adTimer=setInterval(()=>document.querySelector('#ad').src='/ad?tick='+Date.now(),60);true`);
  for(let i=0;i<20;i++) assert.match((await client.call('snapshot',h)).snapshot,/button "Go"/);
  await page(`clearInterval(window.__adTimer);document.querySelector('#ad').remove();true`);
  results.cases.push({scenario:'snapshot_during_iframe_refresh',snapshots:20});
  await client.call('activate_tab', h);
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,true);
  await page(`const style=document.createElement('style');style.textContent='@keyframes drift{from{transform:translateX(-5px)}to{transform:translateX(5px)}}#go{animation:drift 0.7s linear infinite alternate}';document.head.append(style);true`);
  for(let i=0;i<3;i++) {
   await page('window.__count=0;window.__events=[];true');
   const snap=await client.call('snapshot',h),start=performance.now();
   let result, error;
   try { result=await client.call('click',{...h,ref:refFor(snap),timeout_ms:500}); } catch(failure) { error=failure.message; }
   const observed=await state();
   if(result) {
    assert.equal(result.target_verified,true);assert.equal(observed.count,1);
    assert.ok(observed.events.some(e=>e.type==='click'&&e.trusted&&e.target==='go'));
   } else {
    // Compositor timing can either expose stable bounds or continuous motion.
    // Both a verified click and a pre-dispatch refusal are valid; uncertainty
    // or duplicate effects must never be accepted as animation-test success.
    assert.match(error,/no input was dispatched/i);assert.equal(observed.count,0);
   }
   results.cases.push({scenario:'infinite_css_animation',run:i+1,ms:Math.round(performance.now()-start),target_verified:!!result,error});
  }
  const opened=await client.call('open_tab',{browser_id:browserInfo.browser_id,url:base+'/ad',active:false});
  await until(async()=>{const tabs=(await client.call('list_tabs',{browser_id:browserInfo.browser_id})).tabs;return tabs.find(t=>t.tab_id===opened.tab_id&&t.title==='Ad frame')},'opened tab loaded');
  const tabs=(await client.call('list_tabs',{browser_id:browserInfo.browser_id})).tabs,created=tabs.find(t=>t.tab_id===opened.tab_id);
  const createdClaim=await client.call('claim_tab',{browser_id:browserInfo.browser_id,tab_id:created.tab_id,expected_url:created.url,expected_title:created.title});
  const ch={tab_handle:createdClaim.tab_handle};
  await client.call('activate_tab',ch);
  assert.equal((await evaluate(`chrome.tabs.get(${created.tab_id})`)).active,true);
  assert.equal((await evaluate(`chrome.windows.get(${created.window_id})`)).focused,true);
  assert.equal((await client.call('close_tab',ch)).closed,true);
  await assert.rejects(client.call('snapshot',ch),/expired/);
  assert.ok(!(await client.call('list_tabs',{browser_id:browserInfo.browser_id})).tabs.some(t=>t.tab_id===created.tab_id));
  results.cases.push({scenario:'open_activate_close_tab',handle_expired:true});
  console.log(JSON.stringify(results.cases));
 } else {
 const backgroundFocus=await evaluate(`chrome.tabs.get(${cover.id})`);
 const nameSnapshot=await client.call('snapshot',h);
 const nameRef=nameSnapshot.snapshot.match(/\[([^\]]+)\] textbox "Name"/)[1];
 await client.call('fill',{...h,ref:nameRef,text:'后台输入'});
 assert.equal(await page('document.querySelector("#edit").value'),'后台输入');
 await client.call('press_key',{...h,key:'Control+A'});await client.call('press_key',{...h,key:'Z'});
 assert.equal(await page('document.querySelector("#edit").value'),'z');
 await client.call('scroll',{...h,x:900,y:500,delta_y:500});assert.ok(await page('scrollY > 0'));
 const file=join(dir,'background.txt');await writeFile(file,'background upload');
 const uploadSnapshot=await client.call('snapshot',h);
 const uploadRef=uploadSnapshot.snapshot.match(/\[([^\]]+)\] button "Choose file"/)[1];
 await client.call('click',{...h,ref:uploadRef,mode:'dom'});await client.call('upload_file',{...h,files:[file]});
 assert.equal(await page('document.querySelector("#file").files[0].text()'),'background upload');
 assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
 assert.equal((await evaluate(`chrome.tabs.get(${cover.id})`)).active,backgroundFocus.active);
 const operationsAfter=await focus();
 assert.deepEqual(operationsAfter.map(({focused,...w})=>w),operationsFocus.map(({focused,...w})=>w));
 for(const window of operationsFocus)if(!window.focused)assert.equal(operationsAfter.find(w=>w.id===window.id).focused,false);
 results.background_operations=['fill','press_key','scroll','DOM click chooser','upload_file'];
 const s=await client.call('snapshot',h);
 assert.equal(s.truncated,false);assert.match(s.snapshot,/Row 200:/);assert.doesNotMatch(s.snapshot,/InlineTextBox/);
 results.snapshots.push({node_count:s.node_count,chars:s.snapshot.length,total:s.total_node_count,all_200_rows:true});
 let part=await client.call('snapshot',{...h,max_nodes:10,max_chars:1000}), combined=part.snapshot, pages=1;
 const firstRef=part.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
 while(part.next_cursor){part=await client.call('snapshot',{...h,cursor:part.next_cursor,max_nodes:10,max_chars:1000});combined+='\n'+part.snapshot;pages++;}
 assert.equal((combined.match(/Row \d+:/g)||[]).length,200);
 await client.call('activate_tab',h);
 await client.call('click',{...h,ref:firstRef});
 results.snapshots.push({pages,all_200_rows:true,first_page_ref_survived:true});
 for(const scenario of ['foreground_ref','background_ref','background_coordinate','occluded_window_ref']){
  let coverWindow;
  if(scenario==='occluded_window_ref'){
   await evaluate(`chrome.tabs.update(${tab.id},{active:true})`);
   coverWindow=await evaluate(`chrome.windows.create({url:${JSON.stringify(base+'/cover-window')},focused:true,width:${values.headless?800:1100},height:${values.headless?600:900},left:0,top:0})`);
  }else if(scenario==='foreground_ref') await client.call('activate_tab',h);
  else await evaluate(`chrome.tabs.update(${cover.id},{active:true})`);
  await pause(350);
  const before=await focus();
  for(let run=1;run<=3;run++){
   await page('window.__count=0;window.__events=[];true');
   const snap=await client.call('snapshot',h),ref=snap.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
   const start=performance.now();
   let result, clickError;
   try { result=await client.call('click',{...h,detailed:true,...(scenario==='background_coordinate'?{x:260,y:220}:{ref})}); }
   catch(error) { clickError=error.message; }
   const ms=Math.round(performance.now()-start),observed=await state();
   assert.equal(clickError,undefined);assert.equal(result.target_verified,scenario==='background_coordinate'?null:true);assert.equal(result.delivery_verified,true);assert.equal(observed.count,1);
   assert.ok(observed.events.some(e=>e.type==='click'&&e.trusted&&e.target==='go'));
   const after=await focus();
   assert.deepEqual(after.map(({focused,...w})=>w),before.map(({focused,...w})=>w),'Attach must not activate tabs or change window state');
   for(const window of before)if(!window.focused)assert.equal(after.find(w=>w.id===window.id).focused,false,'Attach must not bring an unfocused window forward');
   if(scenario.startsWith('background'))assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
   if(coverWindow)assert.equal(after.find(w=>w.id===tab.windowId).focused,before.find(w=>w.id===tab.windowId).focused);
   results.cases.push({scenario,run,ms,visibility:observed.visibility,count:observed.count,focus_not_stolen:true,page_state:result.page_state});
   console.log(JSON.stringify(results.cases.at(-1)));
  }
  if(coverWindow)await evaluate(`chrome.windows.remove(${coverWindow.id})`);
 }
 await client.call('activate_tab',h);
 for(const zoom of [0.8,1.25]){
  await evaluate(`chrome.tabs.setZoom(${tab.id},${zoom})`);await pause(200);
  await page('window.__count=0;window.__events=[];true');
  const snap=await client.call('snapshot',h),ref=snap.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
  const result=await client.call('click',{...h,ref});const observed=await state();assert.equal(observed.count,1);
  results.cases.push({scenario:'zoom_ref',zoom,result,observed});
 }
 await evaluate(`chrome.tabs.setZoom(${tab.id},1)`);await pause(150);
 await evaluate(`chrome.debugger.sendCommand({tabId:${tab.id}},'Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:10})`);
 await page(`window.__count=0;window.__events=[];const b=document.querySelector('#go');b.style.width='40px';b.onmouseenter=()=>{b.style.transform='translateX(30px)';b.onmouseenter=null};true`);
 const hs=await client.call('snapshot',h),hoverRef=hs.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
 let hoverError;try{await client.call('click',{...h,ref:hoverRef})}catch(error){hoverError=error.message}
 assert.match(hoverError,/target changed/);const hoverState=await state();assert.equal(hoverState.count,0);
 results.cases.push({scenario:'hover_shift_30px',error:hoverError,observed:hoverState});
 await page(`(()=>{window.__shadowCount=0;const host=document.createElement('div');host.style='position:fixed;left:500px;top:150px';document.body.append(host);const root=host.attachShadow({mode:'closed'});const b=document.createElement('button');b.textContent='Closed control';b.onclick=()=>window.__shadowCount++;root.append(b);return true})()`);
 const shadowSnapshot=await client.call('snapshot',h);
 const shadowRef=shadowSnapshot.snapshot.match(/\[([^\]]+)\] button "Closed control"/)[1];
 assert.equal((await client.call('click',{...h,ref:shadowRef})).target_verified,true);
 assert.equal(await page('window.__shadowCount'),1);
 assert.equal(await page('Object.getOwnPropertyNames(window).filter(n=>n.startsWith("__attachClick_")).length'),0);
 results.cases.push({scenario:'closed_shadow_target',target_verified:true,count:1,page_binding_exposed:false});
 // A verified click may destroy its own execution context through normal link navigation.
 await page(`(()=>{const a=document.createElement('a');a.href='/slow';a.textContent='Open slow';a.style='position:fixed;left:500px;top:100px';document.body.append(a);return true})()`);
 const linkSnapshot=await client.call('snapshot',h);
 const linkRef=linkSnapshot.snapshot.match(/\[([^\]]+)\] link "Open slow"/)[1];
 assert.equal((await client.call('click',{...h,ref:linkRef})).target_verified,true);
 await until(async()=>{try{return await page('!!document.querySelector("#ready")')}catch{return false}},'link destination');
 results.cases.push({scenario:'click_link_navigation',target_verified:true,destination_ready:true});
 await evaluate(`chrome.tabs.update(${cover.id},{active:true})`);
 const navigationFocus=await focus(), start=performance.now();
 const nav=await client.call('navigate',{...h,url:base+'/slow'});
 const ms=performance.now()-start;const immediate=await page(`({ready:document.readyState,hasTarget:!!document.querySelector('#ready'),title:document.title})`);
 const immediateSnapshot=await client.call('snapshot',h);
 assert.ok(nav.snapshot.includes('\"Ready\"'));assert.equal(nav.title,'Slow probe');assert.equal(nav.url,base+'/slow');assert.equal(immediate.hasTarget,true);
 assert.deepEqual((await focus()).map(({focused,...w})=>w),navigationFocus.map(({focused,...w})=>w));
 assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
 await pause(50);
 const later=await page(`({ready:document.readyState,hasTarget:!!document.querySelector('#ready'),title:document.title})`);
 results.navigation={ms:Math.round(ms),result:nav,immediate,later,immediate_snapshot_has_ready:immediateSnapshot.snapshot.includes('"Ready"')};
 const fragment=await client.call('navigate',{...h,url:base+'/slow#fragment',include_snapshot:false});
 assert.equal(fragment.same_document,true);assert.equal(fragment.snapshot,undefined);assert.equal(fragment.url,base+'/slow#fragment');
 }
 results.browser=browserInfo.user_agent;results.extension_version=browserInfo.extension_version;
 console.log(JSON.stringify({observability:values.observability?results.cases:undefined,evidence:values.evidence?results.cases:undefined,verification:values.verify?results.cases:undefined,snapshot_diffs:values.snapshots?results.cases:undefined,controls:values.controls?results.cases:undefined,preparation:values.preparation?results.cases:undefined,issues:values.issues?results.cases:undefined,extended:values.extended?results.cases:undefined,primitives:values.primitives?results.cases:undefined,tab_indicators:values['tab-indicators']?results.cases:undefined,input_capture:values['input-capture']?results.cases:undefined,snapshots:results.snapshots,background_operations:results.background_operations,
  hover:results.cases.find(c=>c.scenario==='hover_shift_30px'),navigation:results.navigation}));
 if(claim)await client.call('release_tab',{tab_handle:claim.tab_handle});claim=null;
} finally {
 if(claim)await client?.call('release_tab',{tab_handle:claim.tab_handle}).catch(()=>{});
 await client?.close();await closeBrowser?.().catch(()=>{});ws?.terminate();browser.kill();await hub.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));
 await mkdir(join(ROOT,'test-results'),{recursive:true});
  await writeFile(join(ROOT,'test-results',`${values.observability?'observability':values.evidence?'action-evidence':values.verify?'wait-verify':values.snapshots?'snapshot-diffs':values.controls?'controls':values.preparation?'preparation':values.issues?'issues':values.extended?'extended':values.primitives?'primitives':values.forms?'forms':values['tab-indicators']?'tab-indicators':values['input-capture']?'input-capture':values.regressions?'regressions':'interaction'}-${values.family}.json`),JSON.stringify(results,null,2));
 await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
}
