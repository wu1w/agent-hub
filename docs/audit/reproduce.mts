/**
 * Historical defect-reproduction script (2026-09-16).
 * It asserts the pre-fix bugs still exist and MUST NOT be used as a pass gate.
 * Desired secure behavior is covered by src/core/audit-regressions.test.ts and src/server.test.ts.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {ensureHub,hubPaths,loadConfig,saveConfig,setBind} from '../../src/core/config.ts';
import {adoptSkills,relinkHubSkills,setSkillTargets,skillRecords,repairLinks,writeHubSkill} from '../../src/core/skills.ts';
import {writeProjectMemory,composeInject} from '../../src/core/memory.ts';
import {injectCtx} from '../../src/core/deliver.ts';
import {writeAllowed} from '../../src/core/files.ts';
import {saveVaultFromMarkdown} from '../../src/core/vault.ts';
import {rebuildIndex,getSession,closeSessionIndex} from '../../src/core/sessions.ts';
import {createHandoff,resumePlan} from '../../src/core/handoff.ts';
import {startServer} from '../../src/server.ts';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'hub-audit-'));
// Scoped to this disposable process; no shell HOME is changed.
process.env.HOME=tmp; process.env.AGENT_HUB_ROOT=path.join(tmp,'.agent-hub'); process.env.AGENT_HUB_VAULT_KEY=randomBytes(32).toString('hex');
const put=async(p:string,s:string)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,s)};
const has=async(p:string)=>fs.lstat(p).then(()=>true,()=>false);
const ok=(name:string)=>console.log('REPRODUCED '+name);
let server;
try {
 await ensureHub(); const p=hubPaths();
 await put(path.join(p.skills,'demo','SKILL.md'),'# demo'); await relinkHubSkills(); await setSkillTargets('demo',['grok']);
 assert.equal((await fs.lstat(path.join(tmp,'.cursor/skills/demo'))).isSymbolicLink(),true);
 assert.equal((await skillRecords(await loadConfig())).find(x=>x.name==='demo')?.links.cursor,'excluded'); ok('F01 excluded skill stays linked while status says excluded');
 const cfg=await loadConfig();cfg.layers.skills.default_targets=['grok'];await saveConfig(cfg);await put(path.join(p.skills,'defaults','SKILL.md'),'# defaults');await relinkHubSkills();assert.equal(await has(path.join(tmp,'.cursor/skills/defaults')),true);ok('F02 default_targets ignored');
 await put(path.join(tmp,'.workbuddy/skills/private','SKILL.md'),'# private');await adoptSkills();assert.equal(await has(path.join(tmp,'.workbuddy/skills/private')),false);assert.equal(await has(path.join(p.skills,'private')),true);ok('F03 global adopt removes Own skill without relinking');
 const external=path.join(tmp,'external');await put(path.join(external,'SKILL.md'),'# external');const dest=path.join(tmp,'.cursor/skills/defaults');await fs.unlink(dest);await fs.symlink(external,dest);await repairLinks();assert.equal(await fs.realpath(dest),await fs.realpath(path.join(p.skills,'defaults')));ok('F04 repair overwrites valid foreign symlink');
 const vendor=path.join(tmp,'.grok/bundled/skills/vendor-demo');await put(path.join(vendor,'SKILL.md'),'# vendor original');await fs.symlink(vendor,path.join(tmp,'.grok/skills/vendor-demo'));await adoptSkills();await writeHubSkill('vendor-demo','# overwritten');assert.equal(await fs.readFile(path.join(vendor,'SKILL.md'),'utf8'),'# overwritten');ok('F05 vendor symlink adopted and vendor file writable');
 await writeProjectMemory('alpha','ALPHA_ONLY');await writeProjectMemory('beta','BETA_ONLY');assert.match(await composeInject('alpha'),/BETA_ONLY/);ok('F06 project alpha injection contains beta');
 assert.equal(await injectCtx('hyper'),null);assert.equal((await loadConfig()).bind.hyper.ctx,'hub');ok('F07 Hyper Hub Ctx has no projection');
 await put(path.join(tmp,'.grok/IDENTITY.md'),'# original');await writeAllowed('identity','# changed','grok');assert.equal(await has(path.join(p.backups,'identity')),false);ok('F08 identity save has no backup');
 const secret='audit-fake-secret-09876';await saveVaultFromMarkdown(`# Vault\n\n## test\n说明: synthetic\n密钥: ${secret}\n`);
 const sid='audit-session';await put(path.join(tmp,'.grok/sessions',encodeURIComponent(tmp),sid,'summary.json'),JSON.stringify({info:{id:sid,cwd:tmp},generated_title:'synthetic',session_summary:secret}));await rebuildIndex();assert.match(getSession('grok',sid)!.summary,new RegExp(secret));const hand=await createHandoff({from:'grok',to:'codex',sessionId:sid});assert.match(hand.markdown,new RegExp(secret));ok('F09 known vault value copied into index and handoff');
 assert.deepEqual(resumePlan({from:'cursor',to:'grok',sessionId:sid,cwd:tmp,handoffPath:'/tmp/example-handoff.md'}).argv,['grok','--cwd',tmp]);ok('F10 executed cross-agent command carries no handoff prompt');
 server=await startServer(0);const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
 const response=await fetch(base+'/api/vault');assert.equal(response.status,200);assert.match((await response.json() as any).markdown,new RegExp(secret));ok('F11 unauthenticated HTTP exposes full vault despite empty grants');
 const cross=await fetch(base+'/api/bind',{method:'POST',headers:{'Origin':'https://untrusted.example','Content-Type':'text/plain'},body:JSON.stringify({agent:'grok',layer:'vault',value:'hub'})});assert.equal(cross.status,200);ok('F11 cross-origin simple POST accepted');
 const implicit=await fetch(base+'/api/bind',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent:'workbuddy',layer:'skills',value:'hub'})});assert.equal(implicit.status,200);ok('F13 Own to Hub accepted without migration mode');
 await fs.mkdir(path.join(tmp,'.grok/memory/hub-generated.md'),{recursive:true});
 const failed=await fetch(base+'/api/bind',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent:'grok',layer:'memory',value:'hub'})});assert.equal(failed.status,500);assert.equal((await loadConfig()).bind.grok.memory,'hub');ok('F13 failed delivery leaves binding committed');
 const c=await loadConfig();c.agents.enabled=[];await saveConfig(c);assert.equal((await loadConfig()).agents.enabled.length,5);ok('F12 empty enabled list reactivates all five agents');
} finally {if(server)await new Promise<void>(r=>server!.close(()=>r()));closeSessionIndex();await fs.rm(tmp,{recursive:true,force:true});}
