import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, validate, evaluate, requestFor, MODEL, GATEWAY_MODEL, ENDPOINTS, type Transport } from '../src/core/jev.ts';
const answer={type:'score',score:2,confidence:1,probabilities:{'0':0,'1':0,'2':1},legend:{'0':'a','1':'b','2':'c'}};
const response=()=>({model:MODEL,answers:{d0:structuredClone(answer)},usage:{input_tokens:100}});
/** Gateway answers carry no legend and may omit probabilities/confidence; usage is camelCase. */
const gatewayResponse=()=>({answers:{d0:{type:'score',score:1.6,probabilities:{'0':0.05,'1':0.3,'2':0.65}}},usage:{inputTokens:312,outputTokens:48}});
test('payload is bounded and excludes paths and arbitrary metadata',()=>{
 const p=prepare('会議',Array.from({length:30},()=>({title:'議事録',heading:'定例',text:'あ'.repeat(2000),path:'PRIVATE'})));
 assert.ok(p.count>0&&p.count<=20);assert.ok(Buffer.byteLength(p.body)<=24576);assert.ok(!p.body.includes('PRIVATE'));
 assert.throws(()=>prepare('',[]));
});
test('direct response validation and missing usage',()=>{assert.deepEqual(validate(response(),1,'direct'),{scores:[2],inputTokens:100});const r:Record<string,unknown>=response();delete r.usage;assert.equal(validate(r,1,'direct').inputTokens,null);});
test('direct rejects missing answers, malformed probabilities, score, confidence and model',()=>{
 for(const mutate of [(r:any)=>r.model='other',(r:any)=>delete r.answers.d0,(r:any)=>r.answers.d0.score=3,(r:any)=>r.answers.d0.confidence=NaN,(r:any)=>r.answers.d0.probabilities['2']=.5]){const r=response();mutate(r);assert.throws(()=>validate(r,1,'direct'));}
});
test('gateway payload pins the destination, the model header and no fallback',()=>{
 const body=JSON.parse(prepare('会議',[{title:'議事録',heading:'定例',text:'本文'}]).body);
 assert.equal(body.model,undefined);assert.deepEqual(body.providerOptions,{gateway:{only:['typesafe-ai'],zeroDataRetention:true}});assert.equal(body.questions.d0.type,'score');
 const direct=JSON.parse(prepare('会議',[{title:'議事録',heading:'定例',text:'本文'}],'direct').body);
 assert.equal(direct.model,MODEL);assert.equal(direct.providerOptions,undefined);
 assert.deepEqual(requestFor('gateway'),{url:ENDPOINTS.gateway.url,headers:{'ai-evaluation-model-specification-version':'4','ai-model-id':GATEWAY_MODEL}});
 assert.deepEqual(requestFor('direct'),{url:ENDPOINTS.direct.url,headers:{}});
});
test('gateway response is accepted with or without probabilities',()=>{
 assert.deepEqual(validate(gatewayResponse(),1,'gateway'),{scores:[1.6],inputTokens:312});
 assert.deepEqual(validate({answers:{d0:{type:'score',score:1.25}}},1,'gateway'),{scores:[1.25],inputTokens:null});
});
test('gateway rejects provider warnings, wrong answer type and unverifiable model values',()=>{
 assert.throws(()=>validate({...gatewayResponse(),warnings:[{type:'unsupported',feature:'score'}]},1,'gateway'),/provider-warning/);
 assert.throws(()=>validate({answers:{d0:{type:'boolean',probability:0.9}}},1,'gateway'));
 assert.throws(()=>validate({...gatewayResponse(),model:''},1,'gateway'));
});
test('declared rounding widens the tolerance, unknown or excessive rounding is rejected',()=>{
 const loose={answers:{d0:{type:'score',score:1.6,probabilities:{'0':0.05,'1':0.35,'2':0.6}}},rounding:{probabilityDecimals:1}};
 assert.deepEqual(validate(loose,1,'gateway').scores,[1.6]);
 assert.throws(()=>validate({...loose,rounding:{}},1,'gateway'));
 assert.throws(()=>validate({...loose,rounding:{probabilityDecimals:11}},1,'gateway'));
});
test('the transport receives the fixed destination and model headers',async()=>{
 let seen:unknown;const send:Transport=async(_body,_key,_signal,endpoint)=>{seen=endpoint;return{status:200,body:JSON.stringify(gatewayResponse())};};
 const result=await evaluate('{}',1,'fake',new AbortController().signal,'gateway',send);
 assert.deepEqual(seen,requestFor('gateway'));assert.equal(result.scores[0],1.6);
});
test('429 retries once and returns valid answer',async()=>{
 let calls=0;const send:Transport=async()=>++calls===1?{status:429,retryAfter:'0',body:''}:{status:200,body:JSON.stringify(response())};
 const result=await evaluate('{}',1,'fake',new AbortController().signal,'direct',send);assert.equal(calls,2);assert.equal(result.scores[0],2);
});
test('unauthorized and uncertain network failures are not retried',async()=>{
 for(const status of [401,422]){let n=0;await assert.rejects(evaluate('{}',1,'fake',new AbortController().signal,'direct',async()=>{n++;return{status,body:''};}));assert.equal(n,1);}
 let n=0;await assert.rejects(evaluate('{}',1,'fake',new AbortController().signal,'direct',async()=>{n++;throw new Error('network');}));assert.equal(n,1);
});
test('pre-cancelled requests do not send',async()=>{const c=new AbortController();c.abort();let sent=false;await assert.rejects(evaluate('{}',1,'fake',c.signal,'gateway',async()=>{sent=true;return{status:200,body:''};}));assert.equal(sent,false);});
test('long Retry-After stops without retrying',async()=>{let n=0;await assert.rejects(evaluate('{}',1,'fake',new AbortController().signal,'direct',async()=>{n++;return{status:529,retryAfter:'120',body:''};}),/rate-limit/);assert.equal(n,1);});
