// One-command GUI acceptance test: builds, launches a dedicated vault, drives Obsidian
// through CDP, saves screenshots, then stops only the process it started.
import { obsidianExe } from './obsidian-exe.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rm, copyFile, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { verifyGui, verifySecretPersistence } from './verify-gui.mjs';

const ROOT=process.cwd();
const BASE='.sandbox/gui-e2e';
const VAULT=`${BASE}/vault`;
const PROFILE=`${BASE}/profile`;
const EVIDENCE=`${BASE}/evidence`;
const PORT=9222;
const OBSIDIAN = obsidianExe();
const NOTES={'Meeting.md':'# 架空チームの会議\n定例会は毎週火曜日です。\n','Cooking.md':'# 料理\n夕食はカレーです。\n'};

function run(command,args){execFileSync(command,args,{stdio:'inherit',shell:false,env:{...process.env,...(process.platform==='win32'?{PATH:process.env.PATH}:{})}});}

await rm(BASE,{recursive:true,force:true});
await mkdir(`${VAULT}/.obsidian/plugins/jev-search`,{recursive:true});
await mkdir(PROFILE,{recursive:true});
await mkdir(EVIDENCE,{recursive:true});
if(!existsSync(OBSIDIAN))throw Error('Obsidian executable not found: '+OBSIDIAN);

run(process.execPath,['scripts/build.mjs']);
for(const file of ['main.js','manifest.json','styles.css'])await copyFile(`dist/${file}`,`${VAULT}/.obsidian/plugins/jev-search/${file}`);
for(const [name,text] of Object.entries(NOTES))await writeFile(`${VAULT}/${name}`,text,'utf8');
await writeFile(`${VAULT}/.obsidian/community-plugins.json`,JSON.stringify(['jev-search']));
await writeFile(`${VAULT}/.obsidian/app.json`,JSON.stringify({safeMode:false}));
await writeFile(`${PROFILE}/obsidian.json`,JSON.stringify({vaults:{jevgui:{path:`${ROOT.replace(/\\/g,'/')}/${VAULT}`,ts:Date.now(),open:true}}}));

let child=spawn(OBSIDIAN,[`--remote-debugging-port=${PORT}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${PROFILE.replace(/\//g,'\\')}`],{detached:true,stdio:'ignore'});
const stop=()=>{if(!child?.pid)return;try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});}catch{};child=null;};
// Obsidian flushes SecretStorage asynchronously, so ask it to close normally before forcing it.
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const gracefulStop=async()=>{
  if(!child?.pid)return;
  const pid=child.pid;
  try{const client=await connectPage(PORT);await client.evaluate(`(()=>{window.close();return true;})()`);client.close();}catch{}
  const deadline=Date.now()+20000;
  while(Date.now()<deadline&&alive(pid))await new Promise(resolve=>setTimeout(resolve,500));
  stop();
};
process.on('SIGINT',()=>{stop();process.exit(130);});

let summary;
try {
  const report=await verifyGui(PORT,'vault - Obsidian',EVIDENCE,'.sandbox/gui-e2e/vault');
  const steps=report.results.slice();
  // Restart Obsidian so the stored secret is proven to survive a real restart, not just an in-memory write.
  // A forced kill can drop a secret written moments earlier, so close the app normally first.
  await gracefulStop();
  await new Promise(resolve=>setTimeout(resolve,3000));
  child=spawn(OBSIDIAN,[`--remote-debugging-port=${PORT}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${PROFILE.replace(/\//g,'\\')}`],{detached:true,stdio:'ignore'});
  steps.push(await verifySecretPersistence(PORT));
  summary={pass:true,steps,rendererErrors:report.rendererErrors,observedRequests:report.observedRequests,evidence:EVIDENCE,finishedAt:new Date().toISOString()};
} catch (error) {
  summary={pass:false,error:String(error?.stack??error),evidence:EVIDENCE,finishedAt:new Date().toISOString()};
} finally {
  stop();
}
if(summary.pass){
  const dataPath=`${VAULT}/.obsidian/plugins/jev-search/data.json`;
  if(existsSync(dataPath)){
    const raw=await readFile(dataPath,'utf8');
    if(raw.includes('probe-value-1234'))throw Error('The secret value reached data.json on disk');
    console.log('PASS: secret value absent from data.json on disk');
  } else {
    console.log('NOTE: data.json was not written, so the on-disk check was skipped');
  }
}
await writeFile(`${EVIDENCE}/summary.json`,JSON.stringify(summary,null,2));
console.log(`\nGUI E2E ${summary.pass?'PASS':'FAIL'} — evidence: ${EVIDENCE}`);
if(!summary.pass)process.exit(1);