import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const nativeRequire=createRequire(import.meta.url);
class Plugin {
  commands=[];events=[];views=[];
  app={vault:{on:()=>({})},metadataCache:{on:()=>({})},workspace:{onLayoutReady:()=>{},getLeavesOfType:()=>[]}};
  async loadData(){return null;}
  registerView(type){this.views.push(type);}
  addRibbonIcon(){} addCommand(command){this.commands.push(command);}
  addSettingTab(){} registerEvent(event){this.events.push(event);}
}
const module={exports:{}};
runInNewContext(readFileSync('dist/main.js','utf8'),{module,exports:module.exports,require:(name)=>{
  if(name==='obsidian')return {Plugin,ItemView:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},TFile:class{},Notice:class{}};
  if(name==='node:https')return nativeRequire(name);
  throw Error('Unexpected runtime dependency');
},TextEncoder,Buffer,AbortController,setTimeout,clearTimeout,structuredClone});
const instance=new module.exports.default();
await instance.onload();
assert.equal(instance.commands[0].id,'open-search');
assert.equal(instance.views[0],'jev-search-view');
assert.equal(instance.key,'');
assert.equal(instance.settings.enabled,false);
assert.equal(instance.settings.endpoint,'gateway','Gateway must be the default destination');
// The mocked plugin runs in a separate vm context, so compare values rather than deepStrictEqual.
assert.equal(instance.keys.gateway,'');assert.equal(instance.keys.direct,'');
assert.ok(typeof instance.keys==='object'&&instance.keys!==null,'Session keys must never be persisted');
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
