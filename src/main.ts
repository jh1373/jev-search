import { Plugin, ItemView, WorkspaceLeaf, Modal, Setting, PluginSettingTab, SecretComponent, TFile, getAllTags, Notice } from 'obsidian';
import { SearchIndex, isExcluded, type SearchHit } from './core/search';
import { prepare, evaluate, MODEL, OPENROUTER_MODEL, GATEWAY_MODEL, ENDPOINTS, PRICE_PER_MTOK, type Target } from './core/jev';
import { JudgementCache, judgementKey } from './core/cache';
const VIEW='jev-search-view';
/** Indexing yields to the event loop on this time budget rather than after every note. */
const YIELD_BUDGET_MS=8;
type Settings={folders:string[];tags:string[];enabled:boolean;endpoint:Target;secrets:Record<Target,string>;cacheTtlMinutes:number;confirmTransmission:boolean};
const DEFAULT:Settings={folders:['Templates','Attachments'],tags:['private','secret'],enabled:false,endpoint:'openrouter',secrets:{openrouter:'',direct:'',gateway:''},cacheTtlMinutes:30,confirmTransmission:true};
/** Cache TTL in minutes. 0 disables the cache; anything outside 0-60 falls back to the default. */
const asTtl=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=60?value:DEFAULT.cacheTtlMinutes;
const asTarget=(value:unknown):Target=>value==='direct'?'direct':value==='gateway'?'gateway':'openrouter';
/** SecretStorage ids must be lowercase alphanumeric with optional dashes. Only the name is persisted, never the value. */
const asSecretId=(value:unknown)=>typeof value==='string'&&/^[a-z0-9-]{0,64}$/.test(value)?value:'';
const modelName=(target:Target)=>target==='direct'?MODEL:target==='openrouter'?OPENROUTER_MODEL:GATEWAY_MODEL;
/** Prefer the actual charged cost when the route reports it; otherwise show a token-based estimate. */
const costText=(r:{inputTokens:number|null;cost:number|null},target:Target)=>r.cost!==null?`$${r.cost.toFixed(6)} (actual)`:(r.inputTokens===null?'$unknown':`$${(r.inputTokens*PRICE_PER_MTOK[target]/1e6).toFixed(6)} (est.)`);
export default class JevSearch extends Plugin {
  index=new SearchIndex(); settings:Settings={...DEFAULT}; keys:Record<Target,string>={openrouter:'',direct:'',gateway:''}; generation=0; loaded=true; busy=false;
  /** In-memory session toggle: skip transmission preview modal until Obsidian unloads or settings change. */
  sessionSkipConsent=false;
  /** Session override for the current destination; cleared on unload. */
  set key(value:string){this.keys[this.settings.endpoint]=value;}
  get secretName(){return this.settings.secrets[this.settings.endpoint];}
  set secretName(value:string){this.settings.secrets[this.settings.endpoint]=value;}
  /**
   * Resolve the session override first, then the vault-keyed SecretStorage entry.
   * The secret value is never written to data.json; only its name is stored there.
   */
  get key(){const session=this.keys[this.settings.endpoint];if(session)return session;const name=this.settings.secrets[this.settings.endpoint];if(!name)return '';try{return this.app.secretStorage.getSecret(name)??'';}catch{return '';}}
  controller:AbortController|null=null; skipped=0; indexed=false;
  private updates=new Map<string,number>(); private queue:Promise<void>=Promise.resolve(); private saves:Promise<void>=Promise.resolve(); private yielded=0; private pending=new Set<string>(); private stamp=0; cache=new JudgementCache(DEFAULT.cacheTtlMinutes);
  async onload(){
    const raw=await this.loadData();
    if(raw&&typeof raw==='object') this.settings={folders:this.list(raw.folders,DEFAULT.folders),tags:this.list(raw.tags,DEFAULT.tags),enabled:raw.enabled===true,endpoint:asTarget(raw.endpoint),secrets:this.secrets(raw.secrets),cacheTtlMinutes:asTtl(raw.cacheTtlMinutes),confirmTransmission:raw.confirmTransmission!==false};
    this.syncCache();
    this.registerView(VIEW,leaf=>new SearchView(leaf,this));
    this.addRibbonIcon('search','Jev Search',()=>void this.open());
    this.addCommand({id:'open-search',name:'Open search',callback:()=>void this.open()});
    this.addSettingTab(new Preferences(this.app,this));
    const changed=(file:TFile)=>{this.index.remove(file.path);this.invalidate();this.schedule(file);};
    this.registerEvent(this.app.vault.on('modify',f=>{if(f instanceof TFile)changed(f);}));
    this.registerEvent(this.app.vault.on('create',f=>{if(f instanceof TFile)changed(f);}));
    // Dropping the entry both invalidates a queued schedule for this path and keeps the map bounded.
    this.registerEvent(this.app.vault.on('delete',f=>{this.updates.delete(f.path);this.index.remove(f.path);this.invalidate();}));
    this.registerEvent(this.app.vault.on('rename',(f,old)=>{this.updates.delete(old);this.invalidate();this.index.remove(old);if(f instanceof TFile)this.schedule(f);}));
    this.registerEvent(this.app.metadataCache.on('changed',f=>changed(f)));
    this.app.workspace.onLayoutReady(()=>{if(this.loaded)void this.rebuild();});
  }
  list(v:unknown,fallback:string[]):string[]{return Array.isArray(v)&&v.length<=100&&v.every(x=>typeof x==='string'&&x.length<=256)?v:[...fallback];}
  /** Sanitize stored secret names. A value can never round-trip through here. */
  secrets(v:unknown):Record<Target,string>{const source=v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};return {openrouter:asSecretId(source.openrouter),direct:asSecretId(source.direct),gateway:asSecretId(source.gateway)};}
  invalidate(){this.generation++;this.controller?.abort();for(const leaf of this.app.workspace.getLeavesOfType(VIEW)){if(leaf.view instanceof SearchView){leaf.view.invalidate();leaf.view.search();}}}
  eligible(file:TFile){return file.extension==='md'&&file.stat.size<=1048576&&!isExcluded(file.path,[],this.settings.folders,[],this.app.vault.configDir);}
  allowed(file:TFile){const metadata=this.app.metadataCache.getFileCache(file);return this.eligible(file)&&!!metadata&&!isExcluded(file.path,getAllTags(metadata)??[],this.settings.folders,this.settings.tags,this.app.vault.configDir);}
  // Stamps come from one global counter, so a deleted and recreated path can never reuse a stamp.
  schedule(file:TFile){const stamp=++this.stamp;this.updates.set(file.path,stamp);this.queue=this.queue.then(async()=>{
    if(!this.loaded||this.updates.get(file.path)!==stamp)return;
    this.index.remove(file.path);
    if(!this.allowed(file)){
      // An eligible note with no metadata cache entry yet is retried once the cache catches up.
      if(this.eligible(file)&&!this.app.metadataCache.getFileCache(file))this.pending.add(file.path);else this.pending.delete(file.path);
      return;
    }
    this.pending.delete(file.path);
    const mtime=file.stat.mtime;const text=await this.app.vault.cachedRead(file);
    if(!this.loaded||file.stat.mtime!==mtime||this.updates.get(file.path)!==stamp||!this.allowed(file))return;
    this.index.upsert({path:file.path,title:file.basename,text,tags:[]});
    // A timer after every note costs more than the indexing it protects, so yield on a time budget.
    const now=performance.now();if(now-this.yielded>=YIELD_BUDGET_MS){this.yielded=now;await new Promise(resolve=>setTimeout(resolve,0));}
  }).catch(()=>{if(this.loaded)new Notice('Jev Search: a note could not be indexed.');});}
  async rebuild(){this.invalidate();this.index.clear();this.skipped=0;this.indexed=false;this.yielded=0;this.pending.clear();
    for(const file of this.app.vault.getMarkdownFiles()){if(file.stat.size>1048576)this.skipped++;this.schedule(file);}
    await this.queue;
    // Reporting ready while eligible notes are still missing would be wrong, so retry the notes whose
    // metadata cache entry had not resolved yet before flipping the flag.
    for(let pass=0;pass<80&&this.loaded&&this.pending.size;pass++){
      const retry=[...this.pending];
      await new Promise(resolve=>setTimeout(resolve,250));
      for(const path of retry){const file=this.app.vault.getFileByPath(path);if(file)this.schedule(file);}
      await this.queue;
    }
    if(this.loaded){this.indexed=true;for(const leaf of this.app.workspace.getLeavesOfType(VIEW))if(leaf.view instanceof SearchView)leaf.view.search();}
  }
  async open(){let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];if(!leaf){leaf=this.app.workspace.getRightLeaf(false)??this.app.workspace.getLeaf(true);await leaf.setViewState({type:VIEW,active:true});}await this.app.workspace.revealLeaf(leaf);}
  async persist(){const snapshot=structuredClone(this.settings);this.saves=this.saves.then(()=>this.saveData(snapshot)).catch(()=>{if(this.loaded)new Notice('Settings could not be saved');});await this.saves;}
  /** The cache follows the configured TTL; changing a setting drops every entry it holds. */
  syncCache(){this.cache=new JudgementCache(this.settings.cacheTtlMinutes);}
  /** Counts and versions only. No path, note text, query or key can reach this object. */
  diagnostics(){return {pluginVersion:this.manifest?.version??'',minAppVersion:this.manifest?.minAppVersion??'',notes:this.index.size,indexed:this.indexed,oversizedSkipped:this.skipped,endpoint:this.settings.endpoint,enabled:this.settings.enabled,confirmTransmission:this.settings.confirmTransmission,sessionSkipConsent:this.sessionSkipConsent,excludedFolders:this.settings.folders.length,excludedTags:this.settings.tags.length,cacheEntries:this.cache.size,cacheTtlMinutes:this.settings.cacheTtlMinutes};}
  async save(){this.sessionSkipConsent=false;this.index.clear();this.invalidate();this.syncCache();await this.persist();await this.rebuild();}
  onunload(){this.loaded=false;this.sessionSkipConsent=false;this.invalidate();this.keys={openrouter:'',direct:'',gateway:''};this.index.clear();this.pending.clear();this.cache.clear();}
}
class Consent extends Modal {
  private done=false; private remember=false; private finish:(approved:boolean,remember:boolean)=>void;
  constructor(private plugin:JevSearch,private body:string,finish:(approved:boolean,remember:boolean)=>void){super(plugin.app);this.finish=finish;}
  onOpen(){const target=this.plugin.settings.endpoint;this.titleEl.setText('外部送信を確認 / Confirm transmission');
    this.contentEl.createEl('p',{text:`宛先: ${ENDPOINTS[target].host} | Model: ${modelName(target)}`});
    if(target==='gateway')this.contentEl.createEl('p',{text:'Vercel AI Gateway を経由して TypeSafe AI に転送されます。保持・学習の条件はGatewayと提供元の方針に従い、当プラグインは保証しません。'});
    if(target==='openrouter')this.contentEl.createEl('p',{text:'OpenRouter を経由して TypeSafe AI に転送されます。プロバイダを TypeSafe に固定し、ZDR（ゼロデータ保持）を要求しています。保持・学習の最終条件は OpenRouter と提供元の方針に従い、当プラグインは保証しません。'});
    this.contentEl.createEl('p',{text:'クエリ・タイトル・抜粋を送信します。短いノートは全文を含みます。以下が送信するJSON全体です。取消しても送信済みデータは回収できません。'});
    this.contentEl.createEl('p',{text:`${Buffer.byteLength(this.body)} bytes · 概算 $${(Buffer.byteLength(this.body)*PRICE_PER_MTOK[target]/1e6).toFixed(6)}（課金上限ではありません）`});
    this.contentEl.createEl('pre',{text:this.body,cls:'jev-preview'});
    new Setting(this.contentEl)
      .setName('Obsidianを閉じるまで次回から確認しない / Skip preview until Obsidian closes')
      .setDesc('Obsidianを終了するか設定を変更するまで、確認ダイアログを省略します / Suppress confirmation until Obsidian closes or settings change.')
      .addToggle(t=>t.setValue(this.remember).onChange(v=>{this.remember=v;}));
    new Setting(this.contentEl).addButton(b=>b.setButtonText('キャンセル / Cancel').onClick(()=>this.close())).addButton(b=>b.setButtonText('送信 / Send').setCta().onClick(()=>{this.done=true;this.finish(true,this.remember);this.close();}));
  }
  onClose(){this.contentEl.empty();if(!this.done)this.finish(false,false);}
}

class SearchView extends ItemView {
  input!:HTMLInputElement; results!:HTMLElement; status!:HTMLElement;
  local:SearchHit[]=[]; epoch=0; timer:ReturnType<typeof setTimeout>|null=null; composing=false;
  plugin:JevSearch;
  constructor(leaf:WorkspaceLeaf,plugin:JevSearch){super(leaf);this.plugin=plugin;}
  getViewType(){return VIEW;} getDisplayText(){return 'Jev Search';} getIcon(){return 'search';}
  async onOpen(){const root=this.contentEl;root.empty();root.addClass('jev-search');
    this.input=root.createEl('input',{type:'search',placeholder:'ノートを検索 / Search notes',attr:{'aria-label':'Search notes'}});
    // An IME fires input events while the reading is still being converted, so a search scheduled then
    // would run against half-composed text and flicker the results. Wait for compositionend instead.
    this.registerDomEvent(this.input,'input',()=>{this.invalidate();if(this.timer)clearTimeout(this.timer);if(this.composing)return;this.timer=setTimeout(()=>this.search(),150);});
    this.registerDomEvent(this.input,'compositionstart',()=>{this.composing=true;if(this.timer)clearTimeout(this.timer);});
    this.registerDomEvent(this.input,'compositionend',()=>{this.composing=false;this.search();});
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
    if(!hits.length)return;const prepared=prepare(query,hits,p.settings.endpoint);
    const shouldConfirm=p.settings.confirmTransmission!==false&&!p.sessionSkipConsent;
    if(shouldConfirm){
      const result=await new Promise<{approved:boolean;remember:boolean}>(resolve=>new Consent(p,prepared.body,(approved,remember)=>resolve({approved,remember})).open());
      if(!result.approved||!p.loaded||epoch!==this.epoch||generation!==p.generation||p.busy)return;
      if(result.remember)p.sessionSkipConsent=true;
    }else{
      if(!p.loaded||epoch!==this.epoch||generation!==p.generation||p.busy)return;
    }
    for(const hit of hits.slice(0,prepared.count)){const f=this.app.vault.getFileByPath(hit.path);if(!f||!p.allowed(f)){new Notice('対象が変更されました。再検索してください。');return;}}
    p.busy=true;const controller=new AbortController();p.controller=controller;this.status.setText('Jevへ送信中 / Sending…');
    try {
      // The body is content-addressed, so an edited note or a changed exclusion cannot hit a stale entry.
      const cacheKey=judgementKey(prepared.body,p.settings.endpoint,p.key);
      const hit=p.cache.get(cacheKey);const fromCache=hit!==null;
      const r=hit??(await evaluate(prepared.body,prepared.count,p.key,controller.signal,p.settings.endpoint));
      if(!fromCache)p.cache.set(cacheKey,r);
      if(!p.loaded||generation!==p.generation||epoch!==this.epoch)return;
      const scores=new Map(hits.slice(0,prepared.count).map((h,i)=>[h.id,r.scores[i]]));
      const ranked=hits.slice(0,prepared.count).sort((a,b)=>scores.get(b.id)!-scores.get(a.id)!);
      const allLow=r.scores.every(s=>s<1);this.render(allLow?this.local:[...ranked,...this.local.slice(prepared.count)],scores);
      this.status.setText(`${allLow?'関連度が低いため元順を保持':'Jev ranked'} · ${prepared.count} chunks · ${fromCache?'cache hit · no new charge':`input tokens: ${r.inputTokens??'unknown'} · ${costText(r,p.settings.endpoint)}`}`);
    } catch(error){if(p.loaded&&generation===p.generation&&epoch===this.epoch){this.render(this.local);this.status.setText(`Local fallback: ${error instanceof Error?error.message:'failed'}`);}}
    finally{p.busy=false;if(p.controller===controller)p.controller=null;}
  }
  async onClose(){if(this.timer)clearTimeout(this.timer);this.invalidate();this.contentEl.empty();}
}

class Preferences extends PluginSettingTab {
  plugin:JevSearch;
  constructor(app:JevSearch['app'],plugin:JevSearch){super(app,plugin);this.plugin=plugin;}
  display(){this.containerEl.empty();const p=this.plugin;
    this.containerEl.createEl('p',{text:'Experimental preview. キーはこのVaultの SecretStorage（値は data.json に入りません）か、セッションのみの上書きで保持します。'});
    new Setting(this.containerEl).setName('Jevを有効化 / Enable Jev').addToggle(t=>t.setValue(p.settings.enabled).onChange(async value=>{p.settings.enabled=value;await p.save();}));
    new Setting(this.containerEl).setName('プレビューを表示 / Confirm before transmission').setDesc('外部送信前にモーダルで内容と概算費用を確認します。OFFにすると再起動後も確認を省略して直接送信します。 / Show preview modal with payload and estimated cost before sending. If disabled, requests send immediately without prompt.').addToggle(t=>t.setValue(p.settings.confirmTransmission).onChange(async value=>{p.settings.confirmTransmission=value;p.sessionSkipConsent=false;await p.persist();}));
    new Setting(this.containerEl).setName('接続先 / Endpoint').setDesc('OpenRouter 経由（既定）、または TypeSafe API へ直接送信。Vercel AI Gateway も選択できます。任意URLは設定できません。').addDropdown(d=>d.addOption('openrouter','OpenRouter').addOption('direct','TypeSafe API (direct)').addOption('gateway','Vercel AI Gateway').setValue(p.settings.endpoint).onChange(async value=>{p.invalidate();p.settings.endpoint=asTarget(value);await p.save();}));
    new Setting(this.containerEl).setName('保存するキー / Stored secret').setDesc(`${ENDPOINTS[p.settings.endpoint].host} 用。Obsidian の SecretStorage に保存され、data.json には名前だけが入ります。再起動しても残ります。`).addComponent(el=>new SecretComponent(this.app,el).setValue(p.secretName).onChange(async value=>{p.invalidate();p.secretName=asSecretId(value);await p.persist();}));
    new Setting(this.containerEl).setName('セッションのみのキー / Session-only key').setDesc('メモリのみで再起動すると消えます。上の保存キーより優先されます。').addText(t=>{t.inputEl.type='password';t.inputEl.autocomplete='off';t.setPlaceholder(p.keys[p.settings.endpoint]?'(set)':'(empty)').onChange(value=>{p.invalidate();p.key=value.trim();});});
    new Setting(this.containerEl).setName('除外フォルダ / Excluded folders').setDesc('One vault-relative folder per line').addTextArea(t=>t.setValue(p.settings.folders.join('\n')).onChange(async value=>{const folders=value.split('\n').map(s=>s.trim()).filter(Boolean);if(folders.some(s=>s.includes('..')||s.startsWith('/')||s.includes(':'))){new Notice('Invalid folder path');return;}p.settings.folders=folders.slice(0,100);await p.save();}));
    new Setting(this.containerEl).setName('除外タグ / Excluded tags').addTextArea(t=>t.setValue(p.settings.tags.join('\n')).onChange(async value=>{p.settings.tags=value.split('\n').map(s=>s.trim()).filter(Boolean).slice(0,100);await p.save();}));
    new Setting(this.containerEl).setName('診断をコピー / Copy diagnostics').setDesc('版と計数のみ。ノートのパス・本文・クエリ・キーは含みません。').addButton(b=>b.setButtonText('Copy').onClick(async()=>{const text=JSON.stringify(p.diagnostics(),null,2);try{await navigator.clipboard.writeText(text);new Notice('診断をコピーしました / Diagnostics copied');}catch{new Notice('コピーできませんでした / Copy failed');}}));
    new Setting(this.containerEl).setName('キャッシュ保持 / Cache TTL').setDesc('同じ問い合わせの再送信を避けます（分、0で無効、既定30）。メモリのみで、ディスクには書きません。').addText(t=>{t.inputEl.type='number';t.inputEl.min='0';t.inputEl.max='60';t.setValue(String(p.settings.cacheTtlMinutes)).onChange(async value=>{const n=Number(value);if(!Number.isInteger(n)||n<0||n>60)return;p.settings.cacheTtlMinutes=n;await p.save();});});
    new Setting(this.containerEl).setName('索引を再構築 / Rebuild index').addButton(b=>b.setButtonText('Rebuild').onClick(()=>void p.rebuild()));
    new Setting(this.containerEl).setName('合成データで接続確認 / Test connection').addButton(b=>b.setButtonText('Preview test').onClick(async()=>{
      if(!p.key||p.busy){new Notice('Key required / request already running');return;}
      const prepared=prepare('定例会の曜日は？',[{title:'架空チーム',heading:'会議',text:'定例会は毎週火曜日です。'}],p.settings.endpoint);const generation=p.generation;
      if(!await new Promise<boolean>(resolve=>new Consent(p,prepared.body,approved=>resolve(approved)).open())||p.busy||!p.loaded||p.generation!==generation)return;
      p.busy=true;p.controller=new AbortController();try{const r=await evaluate(prepared.body,1,p.key,p.controller.signal,p.settings.endpoint);if(p.loaded)new Notice(`API OK (${ENDPOINTS[p.settings.endpoint].host}): score ${r.scores[0]} / 2 · ${costText(r,p.settings.endpoint)}`);}catch{if(p.loaded)new Notice('接続確認失敗。キー・ネットワーク・モデルを確認してください。');}finally{p.busy=false;p.controller=null;}
    }));
  }
}
