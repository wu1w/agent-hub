/**
 * Historical round-2 defect script (2026-09-16).
 * Asserts the pre-fix bugs still exist and MUST NOT be used as a pass gate.
 * Desired behavior is covered by src/core/round2-regressions.test.ts and src/server.test.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureHub,hubPaths,loadConfig,saveConfig,setBind } from '../../src/core/config.ts';
import {applyBind} from '../../src/core/bind.ts';
import {relinkHubSkills,setSkillTargets,skillRecords,adoptSkills} from '../../src/core/skills.ts';
import {writeAllowed,restoreIdentity,listIdentityBackups} from '../../src/core/files.ts';
import {saveVaultFromMarkdown,vaultCatalogFor} from '../../src/core/vault.ts';
import {rebuildIndex,getSession,closeSessionIndex} from '../../src/core/sessions.ts';
import {writeProjectMemory} from '../../src/core/memory.ts';
import {syncMemoryInjects} from '../../src/core/deliver.ts';
import {startServer} from '../../src/server.ts';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'hub-review2-'));
const put=async(p:string,v:string)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,v)};
const exists=async(p:string)=>fs.lstat(p).then(()=>true,()=>false);
let count=0;
async function test(name:string,fn:()=>Promise<void>){closeSessionIndex();const h=path.join(temp,String(++count));process.env.HOME=h;process.env.AGENT_HUB_ROOT=path.join(h,'.agent-hub');process.env.AGENT_HUB_VAULT_KEY=randomBytes(32).toString('hex');await ensureHub();await fn();console.log('REPRODUCED '+name)}
try {
 await test('R1 public bootstrap cookie unlocks full vault',async()=>{await saveVaultFromMarkdown('# Vault\n\n## synthetic\n密钥: synthetic-secret-12345\n');const server=await startServer(0);try {const {port}=server.address() as {port:number};const base=`http://127.0.0.1:${port}`;assert.equal((await fetch(base+'/api/vault?reveal=1')).status,401);const first=await fetch(base+'/api/snapshot');const cookie=first.headers.get('set-cookie')!.split(';')[0];assert.ok(cookie);const revealed=await fetch(base+'/api/vault?reveal=1',{headers:{cookie}});assert.equal(revealed.status,200);assert.match((await revealed.json() as any).markdown,/synthetic-secret-12345/);}finally{await new Promise<void>(r=>server.close(()=>r()))}});
 await test('R2 conflict leaves Own skill removed and distributed to other Agents',async()=>{const h=process.env.HOME!;const p=hubPaths();await put(path.join(p.skills,'clash/SKILL.md'),'# hub');await put(path.join(h,'.workbuddy/skills/clash/SKILL.md'),'# own');await put(path.join(h,'.workbuddy/skills/unique/SKILL.md'),'# unique');const result=await applyBind({agent:'workbuddy',layer:'skills',value:'hub',skillsMode:'adopt'});assert.ok((result.extra as any).conflicts.length>=1);assert.equal(result.config.bind.workbuddy.skills,'own');assert.equal(await exists(path.join(h,'.workbuddy/skills/unique')),false);assert.equal(await exists(path.join(h,'.grok/skills/unique')),true);});
 await test('R2b fresh unique Own skill is falsely classified as a conflict',async()=>{const h=process.env.HOME!;await put(path.join(h,'.workbuddy/skills/only-new/SKILL.md'),'# unique');const result=await applyBind({agent:'workbuddy',layer:'skills',value:'hub',skillsMode:'adopt'});assert.ok((result.extra as any).conflicts.some((x:any)=>x.name==='only-new'));assert.equal(result.config.bind.workbuddy.skills,'own');assert.equal(await exists(path.join(h,'.workbuddy/skills/only-new')),false);});
 await test('R3 Soul backup restores into Identity',async()=>{const h=process.env.HOME!;await put(path.join(h,'.workbuddy/IDENTITY.md'),'IDENTITY_ORIGINAL');await put(path.join(h,'.workbuddy/SOUL.md'),'SOUL_ORIGINAL');await writeAllowed('soul','SOUL_CHANGED','workbuddy');const backups=await listIdentityBackups('workbuddy');assert.equal(backups.length,1);await restoreIdentity('workbuddy',backups[0].name);assert.equal(await fs.readFile(path.join(h,'.workbuddy/IDENTITY.md'),'utf8'),'SOUL_ORIGINAL');assert.equal(await fs.readFile(path.join(h,'.workbuddy/SOUL.md'),'utf8'),'SOUL_CHANGED');});
 await test('R4 explicit wildcard collapses to restricted config defaults',async()=>{const p=hubPaths();const cfg=await loadConfig();cfg.layers.skills.default_targets=['grok'];await saveConfig(cfg);await put(path.join(p.skills,'demo/SKILL.md'),'# demo');await setSkillTargets('demo',['*']);const rec=(await skillRecords(await loadConfig())).find(x=>x.name==='demo')!;assert.equal(rec.targets,null);assert.equal(rec.links.cursor,'excluded');});
 await test('R5 initial Vault Hub binding writes empty authorized catalog',async()=>{const h=process.env.HOME!;await fs.mkdir(path.join(h,'.grok'),{recursive:true});await saveVaultFromMarkdown('# Vault\n\n## synthetic\n说明: testing\n密钥: synthetic-secret\n',{synthetic:['grok']});await applyBind({agent:'grok',layer:'vault',value:'hub'});assert.equal((await vaultCatalogFor('grok')).length,1);assert.doesNotMatch(await fs.readFile(path.join(h,'.grok/memory/hub-generated-vault.md'),'utf8'),/`synthetic`/);});
 await test('R6 unavailable Vault fails open and persists known secret',async()=>{const h=process.env.HOME!;const secret='synthetic-fail-open-12345';await saveVaultFromMarkdown(`# Vault\n\n## synthetic\n密钥: ${secret}\n`);await put(path.join(h,'.grok/sessions/group/sid/summary.json'),JSON.stringify({info:{id:'sid',cwd:h},generated_title:'example',session_summary:secret}));process.env.AGENT_HUB_VAULT_KEY=randomBytes(32).toString('hex');await rebuildIndex('grok');assert.equal(getSession('grok','sid')!.summary,secret);});
 await test('R7 setSkillTargets follows adopted internal SKILL symlink into vendor',async()=>{const h=process.env.HOME!;const vendor=path.join(h,'.grok/bundled/skills/vendor/SKILL.md');await put(vendor,'---\nname: vendor\n---\n\nVENDOR_ORIGINAL');await fs.mkdir(path.join(h,'.grok/skills/alias'),{recursive:true});await fs.symlink(vendor,path.join(h,'.grok/skills/alias/SKILL.md'));await adoptSkills();await setSkillTargets('alias',['grok']);assert.match(await fs.readFile(vendor,'utf8'),/targets: \[grok\]/);});
 await test('R8 global memory sync erases previously selected project context',async()=>{const h=process.env.HOME!;await fs.mkdir(path.join(h,'.grok'),{recursive:true});await setBind('grok','memory','hub');await writeProjectMemory('alpha','ALPHA_ONLY');await syncMemoryInjects('alpha');const dest=path.join(h,'.grok/memory/hub-generated.md');assert.match(await fs.readFile(dest,'utf8'),/ALPHA_ONLY/);await syncMemoryInjects();assert.doesNotMatch(await fs.readFile(dest,'utf8'),/ALPHA_ONLY/);});
}finally{closeSessionIndex();await fs.rm(temp,{recursive:true,force:true})}
