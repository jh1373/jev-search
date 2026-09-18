import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const nativeRequire=createRequire(import.meta.url);
const secrets={'jev-openrouter':'sk-test-value'};
class Plugin {
  commands=[];events=[];views=[];
  app={vault:{on:()=>({})},metadataCache:{on:()=>({})},workspace:{onLayoutReady:()=>{},getLeavesOfType:()=>[]},secretStorage:{getSecret:(id)=>secrets[id]??null,setSecret:(id,value)=>{secrets[id]=value;},listSecrets:()=>Object.keys(secrets)}};
  async loadData(){return null;}
  async saveData(data){this.saved=data;}
  registerView(type){this.views.push(type);}
  addRibbonIcon(){} addCommand(command){this.commands.push(command);}
  addSettingTab(){} registerEvent(event){this.events.push(event);}
}
const module={exports:{}};
runInNewContext(readFileSync('dist/main.js','utf8'),{module,exports:module.exports,require:(name)=>{
  if(name==='obsidian')return {Plugin,ItemView:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},SecretComponent:class{},TFile:class{},Notice:class{}};
  if(name==='node:https')return nativeRequire(name);
  throw Error('Unexpected runtime dependency');
},TextEncoder,Buffer,AbortController,setTimeout,clearTimeout,structuredClone});
const instance=new module.exports.default();
await instance.onload();
assert.equal(instance.commands[0].id,'open-search');
assert.equal(instance.views[0],'jev-search-view');
assert.equal(instance.key,'');
assert.equal(instance.settings.enabled,false);
assert.equal(instance.settings.endpoint,'openrouter','OpenRouter must be the default destination');
// The mocked plugin runs in a separate vm context, so compare values rather than deepStrictEqual.
assert.equal(instance.keys.openrouter,'');assert.equal(instance.keys.gateway,'');assert.equal(instance.keys.direct,'');
assert.ok(typeof instance.keys==='object'&&instance.keys!==null,'Session keys must never be persisted');
// Secret resolution: the stored name is looked up in SecretStorage; the value never enters settings.
assert.equal(instance.settings.secrets.openrouter,'');assert.equal(instance.settings.secrets.direct,'');assert.equal(instance.settings.secrets.gateway,'','Only secret names live in settings');
instance.settings.secrets.openrouter='jev-openrouter';
assert.equal(instance.key,'sk-test-value','A stored secret must resolve by name');
instance.keys.openrouter='session-override';
assert.equal(instance.key,'session-override','The session override must take precedence');
instance.keys.openrouter='';
assert.equal(instance.key,'sk-test-value');
instance.settings.secrets.openrouter='missing-secret';
assert.equal(instance.key,'','An unknown secret name must resolve to no key');
instance.settings.secrets.openrouter='jev-openrouter';
await instance.persist();
assert.ok(instance.saved,'Settings must be persisted');
const persisted=JSON.stringify(instance.saved);
assert.ok(!persisted.includes('sk-test-value'),'The secret value must never reach data.json');
assert.ok(persisted.includes('jev-openrouter'),'The secret name must be persisted');
assert.ok(!persisted.includes('session-override'),'Session keys must never be persisted');
instance.index.upsert({path:'Meeting.md',title:'架空チームの会議',text:'# 定例会\n定例会は毎週火曜日です。',tags:[]});
instance.index.upsert({path:'Cooking.md',title:'料理',text:'夕食にカレーを作ります。',tags:[]});
const hits=instance.index.search('定例会',50);
assert.ok(hits.length>0,'Search must return a result');
assert.equal(hits[0].path,'Meeting.md','Expected meeting note first');
assert.ok(hits[0].text.includes('火曜日'),'Expected source excerpt');
assert.equal(instance.index.search('存在しない検索語XYZ',50).length,0);
console.log(JSON.stringify({test:'compiled-plugin-search',query:'定例会',firstPath:hits[0].path,excerpt:hits[0].text,pass:true}));
instance.onunload();assert.equal(instance.loaded,false);
assert.equal(instance.index.size,0,'Unload must clear the index');
console.log('PASS: generated CommonJS bundle loads, registers command/view, defaults to no external sending, unloads (Obsidian mock).');
