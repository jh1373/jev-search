import { connectPage, listTargets } from './cdp-client.mjs';
const client = await connectPage(9222);
console.log('MAIN ' + await client.evaluate('(()=>{try{window.app.setting.open();window.app.setting.openTabById("jev-search");return "opened";}catch(e){return "ERR "+e.message;}})()'));
await new Promise(r => setTimeout(r, 2500));
const targets = await listTargets(9222);
for (const t of targets.filter(x => x.type === 'page')) {
  console.log('TARGET ' + t.url + ' | ' + t.title);
}
const modal = await connectPage(9222, { match: 'about:blank', origin: null, probe: '!!document.body' });
console.log('MODAL ' + await modal.evaluate('(()=>{const names=Array.from(document.querySelectorAll(".setting-item-name")).map(e=>e.textContent);return JSON.stringify({items:names.slice(0,25),hasSecret:!!document.querySelector(".secret-component, select, input[type=password]")});})()'));
modal.close(); client.close();
