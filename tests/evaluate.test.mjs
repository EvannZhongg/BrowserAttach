import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createEvaluations } from '../extension/evaluate.js';

function fixture() {
  const page = vm.createContext({ runs: 0 });
  const evaluations = createEvaluations(async (tab, method, args) => ({ result: { value: await vm.runInContext(args.expression, page) } }));
  return { page, read: args => evaluations.read(9, args), forget: () => evaluations.forget(9) };
}

test('escaped and unicode string pages are individually JSON safe and reconstruct without replay', async () => {
  const f = fixture(); const original = '\\"\n中文😀'.repeat(20);
  let result = await f.read({ expression: `(runs++, ${JSON.stringify(original)})`, max_chars: 17 });
  let text = result.value;
  while (result.next_cursor) {
    assert.ok(JSON.stringify(result.value).length <= 17);
    result = await f.read({ cursor: result.next_cursor, max_chars: 17 }); text += result.value;
  }
  assert.equal(text, original); assert.equal(f.page.runs, 1); assert.equal(result.capture_truncated, false);
});

test('object entries survive continuation and an oversized nested item can be read with a larger budget', async () => {
  const f = fixture();
  let result = await f.read({ expression: '(runs++, {a:{nested:"x".repeat(40)},b:2})', max_chars: 8 });
  assert.equal(result.budget_too_small, true); assert.ok(result.required_chars > 40);
  result = await f.read({ cursor: result.next_cursor, max_chars: result.required_chars });
  assert.equal(result.value.a.nested.length, 40); assert.equal(result.has_more, true);
  const rest = await f.read({ cursor: result.next_cursor, max_chars: 8 });
  assert.equal(rest.value.b, 2); assert.equal(rest.next_cursor, null); assert.equal(f.page.runs, 1);
});

test('a partial object immediately identifies the next oversized field without replaying the expression', async () => {
  const f = fixture();
  const first = await f.read({ expression: '(runs++, {count:104,items:Array.from({length:104},(_,i)=>({i,text:"x".repeat(240)}))})' });
  assert.deepEqual(Object.keys(first.value), ['count']);
  assert.equal(first.next_item.key, 'items');
  assert.equal(first.next_item.exceeds_max_chars, false);
  assert.ok(first.next_item.required_chars > 20000);
  const rest = await f.read({ cursor: first.next_cursor, max_chars: first.next_item.required_chars });
  assert.equal(rest.value.items.length, 104);
  assert.equal(rest.has_more, false); assert.equal(rest.next_item, undefined); assert.equal(f.page.runs, 1);
  const oversized = await f.read({ expression: '({count:1,items:["x".repeat(110000)]})' });
  assert.equal(oversized.next_item.exceeds_max_chars, true);
  assert.ok(oversized.next_item.required_chars > 100000);
});

test('capture loss is separate from pagination, and forgotten results cannot be read by cursor', async () => {
  const f = fixture();
  const deep = await f.read({ expression: '({a:{a:{a:{a:{a:{a:{a:{a:{a:1}}}}}}}}})' });
  assert.equal(deep.capture_truncated, true);
  const result = await f.read({ expression: '[1,2,3]', max_chars: 3 });
  f.forget();
  await assert.rejects(f.read({ cursor: result.next_cursor }), /stale/);
});

test('a late evaluation reply cannot resurrect a result after control cleanup', async () => {
  let finish;
  const evaluations = createEvaluations(() => new Promise(resolve => { finish = () => resolve({ result: { value: { value: [1, 2], truncated: false } } }); }));
  const pending = evaluations.read(9, { expression: '[1,2]', max_chars: 3 });
  evaluations.forget(9); finish();
  await assert.rejects(pending, /late result was discarded.*do not replay/);
  await assert.rejects(evaluations.read(9, { cursor: 'unknown' }), /stale/);
});


test('a returned function is invoked once, its Promise awaited, and JSON cursor reads never invoke it again', async () => {
  const f=fixture();let result=await f.read({expression:'async () => { runs++; return [1,2,3,4]; }',max_chars:3});
  const values=[...result.value];while(result.next_cursor){result=await f.read({cursor:result.next_cursor,max_chars:3});values.push(...result.value)}
  assert.deepEqual(Array.from(values),[1,2,3,4]);assert.equal(f.page.runs,1);
});

test('frame-scoped captured JSON is discarded on that frame navigation', async () => {
  const evaluations=createEvaluations(async()=>({result:{value:{value:[1,2],truncated:false,scope:'frame'}}}));
  const result=await evaluations.read(9,{expression:'[1,2]',evaluation_frame:'child',max_chars:3});
  evaluations.invalidate(9,'frame_changed','other');assert.equal((await evaluations.read(9,{cursor:result.next_cursor,max_chars:3})).value[0],2);
  const next=await evaluations.read(9,{expression:'[1,2]',evaluation_frame:'child',max_chars:3});evaluations.invalidate(9,'frame_changed','child');
  await assert.rejects(evaluations.read(9,{cursor:next.next_cursor}),/stale/);
});
