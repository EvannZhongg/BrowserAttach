import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { collectElementContext, createContextReader } from '../extension/element-context.js';
import { controlOptions } from '../extension/control.js';
import { deadline } from '../extension/actionability.js';

function tree() {
  let serial=0;
  const all=[];
  const make=(id,tag='DIV',text='',attrs={})=>{
    const element={nodeType:1,backendNodeId:++serial,id,tagName:tag,innerText:text,classList:[],isConnected:true,parentElement:null,parentNode:null,children:[],
      get childElementCount(){return this.children.length},
      get previousElementSibling(){const siblings=this.parentNode?.children||[];return siblings[siblings.indexOf(this)-1]||null},
      get nextElementSibling(){const siblings=this.parentNode?.children||[];return siblings[siblings.indexOf(this)+1]||null},
      getRootNode(){return {host:null}},getAttribute:name=>attrs[name]??null,matches:()=>false,
      getBoundingClientRect:()=>({x:0,y:0,width:400,height:300}),
      ownerDocument:{defaultView:{getComputedStyle:()=>({visibility:'visible',position:'fixed',zIndex:'11001',pointerEvents:'auto'})}}};
    all.push(element);return element;
  };
  const append=(parent,...children)=>{parent.children.push(...children);for(const child of children){child.parentElement=parent;child.parentNode=parent}};
  const root=make('root','HTML'),body=make('body','BODY'),overlay=make('overlay','DIV','',{'aria-hidden':'true'}),portal=make('portal'),close=make('close','BUTTON','',{'aria-label':'关闭引导'});
  append(root,body);append(body,make('page'),overlay,portal);append(portal,close);
  return {all,make,append,root,body,overlay,portal,close};
}

test('DOM context reports bounded structural relatives and labels without guessing a close action',()=>{
  const f=tree(), nodes=collectElementContext.call(f.overlay,20), facts=nodes.facts;
  assert.equal(nodes[0],f.overlay);assert.equal(facts.entries[0].dom.aria_hidden,'true');
  assert.deepEqual(facts.entries.filter(x=>x.relation==='ancestor').map(x=>x.dom.tag),['body','html']);
  assert.equal(facts.entries.find(x=>x.dom.id==='portal').relation,'sibling');
  assert.equal(facts.entries.some(x=>x.dom.id==='close'),false);
  const child=collectElementContext.call(f.portal,20).facts.entries.find(x=>x.relation==='child');
  assert.equal(child.dom.aria_label,'关闭引导');assert.equal(child.close_hint,undefined);
  const password=f.make('secret','INPUT','password text',{'aria-disabled':'x'.repeat(1000)});
  password.value='password value';f.append(f.portal,password);
  const field=collectElementContext.call(password,1).facts.entries[0].dom;
  assert.equal(field.text,'');assert.equal(field.value,undefined);assert.equal(field.aria_disabled.length,300);
  assert.deepEqual(field.truncated_attributes,['aria-disabled']);
});

test('DOM context bounds direct children and nearest siblings, with explicit omission counts',()=>{
  const f=tree();
  for(let i=0;i<100;i++)f.append(f.overlay,f.make(`child-${i}`));
  for(let i=0;i<100;i++)f.append(f.body,f.make(`sibling-${i}`));
  const nodes=collectElementContext.call(f.overlay,10),facts=nodes.facts;
  assert.equal(nodes.length,10);
  assert.equal(facts.omitted.children+facts.entries.filter(x=>x.relation==='child').length,100);
  assert.equal(facts.omitted.siblings+facts.entries.filter(x=>x.relation==='sibling').length,102);
  assert.equal(facts.entries.some(x=>x.dom.id==='portal'),true);
  const one=collectElementContext.call(f.overlay,1);
  assert.equal(one.length,1);assert.equal(one.facts.omitted.ancestors_more,true);
  assert.equal(one.facts.omitted.children,100);
  for(const args of [{view:'unknown'},{view:'context',max_options:1},{view:'context',popup_selector:'#portal'},{max_nodes:5},{view:'context',max_nodes:51}])assert.throws(()=>controlOptions({selector:'#overlay',...args}));
});

function readerFixture(onRemember=()=>{}) {
  const f=tree(), calls=[],objects=new Map(f.all.map(node=>[node.id,node])), state={version:0,frame:0,claim:{}};
  const target={tabId:9};let serial=0;
  const cdp=async(actual,method,args)=>{
    calls.push({target:actual,method,args});
    if(method==='Page.createIsolatedWorld')return {executionContextId:2};
    if(method==='DOM.resolveNode')return {object:{objectId:f.all.find(node=>node.backendNodeId===args.backendNodeId).id}};
    if(method==='Runtime.callFunctionOn'){
      const value=vm.runInNewContext(`(${args.functionDeclaration}).apply(element,args)`,{element:objects.get(args.objectId),args:args.arguments?.map(x=>x.value)||[]});
      if(args.returnByValue)return {result:{value:structuredClone(value)}};
      const id=`collected-${++serial}`;objects.set(id,value);return {result:{objectId:id}};
    }
    if(method==='Runtime.getProperties')return {result:objects.get(args.objectId).map((node,index)=>({name:String(index),value:{objectId:node.id}}))};
    if(method==='Runtime.releaseObjectGroup')return {};
    throw new Error(`Unexpected command ${method}`);
  };
  const observations={version:()=>state.version,frameVersion:()=>state.frame,rememberElement:async(tab,actual,id,frame)=>{await onRemember(id,state,f);return {ref:`ref-${id}`,frame_id:frame}}};
  const read=createContextReader(cdp,r=>r.result?.value,{target:()=>target},observations,async()=>({target,objectId:'overlay',backendNodeId:f.overlay.backendNodeId,frameId:'main'}),()=>state.claim);
  return {...f,calls,state,read:(args={})=>read(9,args,deadline(1000,'snapshot'))};
}

test('context reads avoid full AX, preserve DOM facts when a ref is unavailable and honor output budgets',async()=>{
  const f=readerFixture(id=>{if(id==='portal')throw new Error('AX identity unavailable')});
  const result=await f.read({});
  assert.equal(result.view,'context');assert.equal(result.target.ref,'ref-overlay');
  const portal=result.siblings.find(x=>x.dom.id==='portal');assert.equal(portal.ref,null);assert.match(portal.ref_unavailable,/AX identity/);
  assert.ok(!f.calls.some(x=>/^(?:Input\.|Accessibility\.)/.test(x.method)));
  const small=await f.read({max_chars:1600});assert.ok(JSON.stringify(small).length<=1600);
  assert.ok(small.omitted.siblings>0||small.omitted.ancestors_more);
  assert.equal(f.calls.filter(x=>x.method==='Runtime.releaseObjectGroup').length,4);
});

test('context reads reject changed documents, frames, control and detached targets',async()=>{
  for(const change of ['document','frame','claim','detach']){
    let once=false;
    const f=readerFixture((id,state,dom)=>{
      if(once)return;once=true;
      if(change==='document')state.version++;
      if(change==='frame')state.frame++;
      if(change==='claim')state.claim={};
      if(change==='detach')dom.overlay.isConnected=false;
    });
    await assert.rejects(f.read(),/changed|detached/);
    assert.equal(f.calls.filter(x=>x.method==='Runtime.releaseObjectGroup').length,2);
  }
});
