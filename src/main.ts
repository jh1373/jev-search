import { Plugin, ItemView, WorkspaceLeaf, Modal, Setting, PluginSettingTab, TFile, getAllTags, Notice } from 'obsidian';
import { SearchIndex, isExcluded, type SearchHit } from './core/search';
import { prepare, evaluate, MODEL, GATEWAY_MODEL, ENDPOINTS, PRICE_PER_MTOK, type Target } from './core/jev';
const VIEW='jev-search-view';
type Settings={folders:string[];tags:string[];enabled:boolean;endpoint:Target};
const DEFAULT:Settings={folders:['Templates','Attachments'],tags:['private','secret'],enabled:false,endpoint:'gateway'};
const asTarget=(value:unknown):Target=>value==='direct'?'direct':'gateway';
const modelName=(target:Target)=>target==='direct'?MODEL:GATEWAY_MODEL;
export default class JevSearch extends Plugin {
  index=new SearchIndex(); settings:Settings={...DEFAULT}; keys:Record<Target,string>={gateway:'',direct:''}; generation=0; loaded=true; busy=false;
  /** Session-only keys, one per destination; never persisted to disk. */
  get key(){return this.keys[this.settings.endpoint];}
  set key(value:string){this.keys[this.settings.endpoint]=value;}
  controller:AbortController|null=null; skipped=0; indexed=false;
  private updates=new Map<string,number>(); private queue:Promise<void>=Promise.resolve(); private saves:Promise<void>=Promise.resolve();
  async onload(){
    const raw=await this.loadData();
    if(raw&&typeof raw==='object') this.settings={folders:this.list(raw.folders,DEFAULT.folders),tags:this.list(raw.tags,DEFAULT.tags),enabled:raw.enabled===true,endpoint:asTarget(raw.endpoint)};
    this.registerView(VIEW,leaf=>new SearchView(leaf,this));
    this.addRibbonIcon('search','Jev Search',()=>void this.open());
    this.addCommand({id:'open-search',name:'Open search',callback:()=>void this.open()});
    this.addSettingTab(new Preferences(this.app,this));
    const changed=(file:TFile)=>{this.index.remove(file.path);this.invalidate();this.schedule(file);};
    this.registerEvent(this.app.vault.on('modify',f=>{if(f instanceof TFile)changed(f);}));
    this.registerEvent(this.app.vault.on('create',f=>{if(f instanceof TFile)changed(f);}));
    this.registerEvent(this.app.vault.on('delete',f=>{this.updates.set(f.path,(this.updates.get(f.path)??0)+1);this.index.remove(f.path);this.invalidate();}));
    this.registerEvent(this.app.vault.on('rename',(f,old)=>{this.invalidate();this.index.remove(old);if(f instanceof TFile)this.schedule(f);}));
    this.registerEvent(this.app.metadataCache.on('changed',f=>changed(f)));
    this.app.workspace.onLayoutReady(()=>{if(this.loaded)void this.rebuild();});
  }
  list(v:unknown,fallback:string[]):string[]{return Array.isArray(v)&&v.length<=100&&v.every(x=>typeof x==='string'&&x.length<=256)?v:[...fallback];}
  invalidate(){this.generation++;this.controller?.abort();for(const leaf of this.app.workspace.getLeavesOfType(VIEW)){if(leaf.view instanceof SearchView){leaf.view.invalidate();leaf.view.search();}}}
  allowed(file:TFile){const metadata=this.app.metadataCache.getFileCache(file);return file.extension==='md'&&file.stat.size<=1048576&&!!metadata&&!isExcluded(file.path,getAllTags(metadata)??[],this.settings.folders,this.settings.tags,this.app.vault.configDir);}
  schedule(file:TFile){const stamp=(this.updates.get(file.path)??0)+1;this.updates.set(file.path,stamp);this.queue=this.queue.then(async()=>{
    if(!this.loaded||this.updates.get(file.path)!==stamp)return;
    this.index.remove(file.path);if(!this.allowed(file))return;
    const mtime=file.stat.mtime;const text=await this.app.vault.cachedRead(file);
    if(!this.loaded||file.stat.mtime!==mtime||this.updates.get(file.path)!==stamp||!this.allowed(file))return;
    this.index.upsert({path:file.path,title:file.basename,text,tags:[]});
    await new Promise(resolve=>setTimeout(resolve,0));
  }).catch(()=>{if(this.loaded)new Notice('Jev Search: a note could not be indexed.');});}
  async rebuild(){this.invalidate();this.index.clear();this.skipped=0;this.indexed=false;
    for(const file of this.app.vault.getMarkdownFiles()){if(file.stat.size>1048576)this.skipped++;this.schedule(file);}
    await this.queue;if(this.loaded){this.indexed=true;for(const leaf of this.app.workspace.getLeavesOfType(VIEW))if(leaf.view instanceof SearchView)leaf.view.search();}
  }
  async open(){let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];if(!leaf){leaf=this.app.workspace.getRightLeaf(false)??this.app.workspace.getLeaf(true);await leaf.setViewState({type:VIEW,active:true});}await this.app.workspace.revealLeaf(leaf);}
  async save(){this.index.clear();this.invalidate();const snapshot=structuredClone(this.settings);this.saves=this.saves.then(()=>this.saveData(snapshot)).catch(()=>{if(this.loaded)new Notice('Settings could not be saved');});await this.saves;await this.rebuild();}
  onunload(){this.loaded=false;this.invalidate();this.keys={gateway:'',direct:''};this.index.clear();}
}
class Consent extends Modal {
  private done=false; private finish:(value:boolean)=>void;
  constructor(private plugin:JevSearch,private body:string,finish:(value:boolean)=>void){super(plugin.app);this.finish=finish;}
  onOpen(){const target=this.plugin.settings.endpoint;this.titleEl.setText('外部送信を確認 / Confirm transmission');
    this.contentEl.createEl('p',{text:`宛先: ${ENDPOINTS[target].host} | Model: ${modelName(target)}`});
    if(target==='gateway')this.contentEl.createEl('p',{text:'Vercel AI Gateway を経由して TypeSafe AI に転送されます。保持・学習の条件はGatewayと提供元の方針に従い、当プラグインは保証しません。'});
    this.contentEl.createEl('p',{text:'クエリ・タイトル・抜粋を送信します。短いノートは全文を含みます。以下が送信するJSON全体です。取消しても送信済みデータは回収できません。'});
    this.contentEl.createEl('p',{text:`${Buffer.byteLength(this.body)} bytes · 概算 $${(Buffer.byteLength(this.body)*PRICE_PER_MTOK[target]/1e6).toFixed(6)}（課金上限ではありません）`});
    this.contentEl.createEl('pre',{text:this.body,cls:'jev-preview'});
    new Setting(this.contentEl).addButton(b=>b.setButtonText('キャンセル / Cancel').onClick(()=>this.close())).addButton(b=>b.setButtonText('送信 / Send').setCta().onClick(()=>{this.done=true;this.finish(true);this.close();}));
  }
  onClose(){this.contentEl.empty();if(!this.done)this.finish(false);}
}

class SearchView extends ItemView {
  input!:HTMLInputElement; results!:HTMLElement; status!:HTMLElement;
  local:SearchHit[]=[]; epoch=0; timer:ReturnType<typeof setTimeout>|null=null;
  plugin:JevSearch;
  constructor(leaf:WorkspaceLeaf,plugin:JevSearch){super(leaf);this.plugin=plugin;}
  getViewType(){return VIEW;} getDisplayText(){return 'Jev Search';} getIcon(){return 'search';}
  async onOpen(){const root=this.contentEl;root.empty();root.addClass('jev-search');
    this.input=root.createEl('input',{type:'search',placeholder:'ノートを検索 / Search notes',attr:{'aria-label':'Search notes'}});
    this.registerDomEvent(this.input,'input',()=>{this.invalidate();if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>this.search(),150);});
    this.registerDomEvent(this.input,'compositionstart',()=>{if(this.timer)clearTimeout(this.timer);});
    this.registerDomEvent(this.input,'compositionend',()=>this.search());
    new Setting(root).addButton(b=>b.setButtonText('ローカル順').onClick(()=>this.search())).addButton(b=>b.setButtonText('Jevで並べ替え').onClick(()=>void this.rerank())).addButton(b=>b.setButtonText('取消').onClick(()=>{this.plugin.controller?.abort();this.invalidate();}));
    this.status=root.createDiv({attr:{'role':'status','aria-live':'polite'}});this.results=root.createDiv();this.search();
  }
  invalidate(){this.epoch++;this.plugin.controller?.abort();if(this.status)this.status.setText('更新されました。再検索してください / Results invalidated.');}
  search(){if(!this.input)return;this.local=this.plugin.index.search(this.input.value,50);this.render(this.local);
    this.status.setText(`${this.plugin.index.size} notes · ${this.local.length} chunks · ${this.plugin.indexed?'Ready':'Indexing'} · oversized skipped: ${this.plugin.skipped}`);}
  render(hits:SearchHit[],scores?:Map<string,number>){this.results.empty();const seen=new Set<string>();
    for(const hit of hits){if(seen.has(hit.path))continue;seen.add(hit.path);
      const row=this.results.createDiv({cls:'jev-result'});const button=row.createEl('button',{text:hit.path});
      button.onclick=()=>{const file=this.app.vault.getFileByPath(hit.path);if(!file){new Notice('Note no longer exists');return;}void this.app.workspace.getLeaf(false).openFile(file,{eState:{line:Math.max(0,hit.startLine-1)}});};
      row.createEl('small',{text:hit.heading});row.createEl('p',{text:hit.text.slice(0,240)});
      if(scores)row.createEl('small',{text:scores.has(hit.id)?`Jev relevance: ${scores.get(hit.id)!.toFixed(2)} / 2 (not correctness probability)`:'未評価 / Not evaluated'});
    }
  }
  async rerank(){const p=this.plugin;if(!p.settings.enabled||!p.key){new Notice('設定でJevを有効化し、セッション用APIキーを入力してください。');return;}if(p.busy){new Notice('通信中です / Request in progress');return;}
    this.search();const query=this.input.value;const generation=p.generation,epoch=this.epoch;const hits=this.local.slice(0,20);
    if(!hits.length)return;const prepared=prepare(query,hits,p.settings.endpoint);const approved=await new Promise<boolean>(resolve=>new Consent(p,prepared.body,resolve).open());
    if(!approved||!p.loaded||epoch!==this.epoch||generation!==p.generation||p.busy)return;
    for(const hit of hits.slice(0,prepared.count)){const f=this.app.vault.getFileByPath(hit.path);if(!f||!p.allowed(f)){new Notice('対象が変更されました。再検索してください。');return;}}
    p.busy=true;const controller=new AbortController();p.controller=controller;this.status.setText('Jevへ送信中 / Sending…');
    try {const r=await evaluate(prepared.body,prepared.count,p.key,controller.signal,p.settings.endpoint);
      if(!p.loaded||generation!==p.generation||epoch!==this.epoch)return;
      const scores=new Map(hits.slice(0,prepared.count).map((h,i)=>[h.id,r.scores[i]]));
      const ranked=hits.slice(0,prepared.count).sort((a,b)=>scores.get(b.id)!-scores.get(a.id)!);
      const allLow=r.scores.every(s=>s<1);this.render(allLow?this.local:[...ranked,...this.local.slice(prepared.count)],scores);
      this.status.setText(`${allLow?'関連度が低いため元順を保持':'Jev ranked'} · ${prepared.count} chunks · input tokens: ${r.inputTokens??'unknown'} · $${r.inputTokens===null?'unknown':(r.inputTokens*PRICE_PER_MTOK[p.settings.endpoint]/1e6).toFixed(6)}`);
    } catch(error){if(p.loaded&&generation===p.generation&&epoch===this.epoch){this.render(this.local);this.status.setText(`Local fallback: ${error instanceof Error?error.message:'failed'}`);}}
    finally{p.busy=false;if(p.controller===controller)p.controller=null;}
  }
  async onClose(){if(this.timer)clearTimeout(this.timer);this.invalidate();this.contentEl.empty();}
}

class Preferences extends PluginSettingTab {
  plugin:JevSearch;
  constructor(app:JevSearch['app'],plugin:JevSearch){super(app,plugin);this.plugin=plugin;}
  display(){this.containerEl.empty();const p=this.plugin;
    this.containerEl.createEl('p',{text:'Experimental preview. キーはメモリのみ。再起動で消えます。外部送信は毎回確認します。'});
    new Setting(this.containerEl).setName('Jevを有効化 / Enable Jev').addToggle(t=>t.setValue(p.settings.enabled).onChange(async value=>{p.settings.enabled=value;await p.save();}));
    new Setting(this.containerEl).setName('接続先 / Endpoint').setDesc('Vercel AI Gateway 経由（既定）、または TypeSafe API へ直接送信。任意URLは設定できません。').addDropdown(d=>d.addOption('gateway','Vercel AI Gateway').addOption('direct','TypeSafe API (direct)').setValue(p.settings.endpoint).onChange(async value=>{p.invalidate();p.settings.endpoint=asTarget(value);await p.save();}));
    new Setting(this.containerEl).setName('API key (session only)').setDesc(`${ENDPOINTS[p.settings.endpoint].host} 用のキー。接続先ごとにメモリのみ保持し、再起動で消えます。`).addText(t=>{t.inputEl.type='password';t.inputEl.autocomplete='off';t.setValue(p.key).onChange(value=>{p.invalidate();p.key=value.trim();});});
    new Setting(this.containerEl).setName('除外フォルダ / Excluded folders').setDesc('One vault-relative folder per line').addTextArea(t=>t.setValue(p.settings.folders.join('\n')).onChange(async value=>{const folders=value.split('\n').map(s=>s.trim()).filter(Boolean);if(folders.some(s=>s.includes('..')||s.startsWith('/')||s.includes(':'))){new Notice('Invalid folder path');return;}p.settings.folders=folders.slice(0,100);await p.save();}));
    new Setting(this.containerEl).setName('除外タグ / Excluded tags').addTextArea(t=>t.setValue(p.settings.tags.join('\n')).onChange(async value=>{p.settings.tags=value.split('\n').map(s=>s.trim()).filter(Boolean).slice(0,100);await p.save();}));
    new Setting(this.containerEl).setName('索引を再構築 / Rebuild index').addButton(b=>b.setButtonText('Rebuild').onClick(()=>void p.rebuild()));
    new Setting(this.containerEl).setName('合成データで接続確認 / Test connection').addButton(b=>b.setButtonText('Preview test').onClick(async()=>{
      if(!p.key||p.busy){new Notice('Key required / request already running');return;}
      const prepared=prepare('定例会の曜日は？',[{title:'架空チーム',heading:'会議',text:'定例会は毎週火曜日です。'}],p.settings.endpoint);const generation=p.generation;
      if(!await new Promise<boolean>(resolve=>new Consent(p,prepared.body,resolve).open())||p.busy||!p.loaded||p.generation!==generation)return;
      p.busy=true;p.controller=new AbortController();try{const r=await evaluate(prepared.body,1,p.key,p.controller.signal,p.settings.endpoint);if(p.loaded)new Notice(`API OK (${ENDPOINTS[p.settings.endpoint].host}): score ${r.scores[0]} / 2 · input tokens: ${r.inputTokens??'unknown'}`);}catch{if(p.loaded)new Notice('接続確認失敗。キー・ネットワーク・モデルを確認してください。');}finally{p.busy=false;p.controller=null;}
    }));
  }
}
