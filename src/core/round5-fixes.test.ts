import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { agentHome, adapter, isAgentPresent } from "./adapters.ts";
import { nativeMemoryTarget } from "./autoload.ts";
import { applyBind } from "./bind.ts";
import { hubPaths, loadConfig, syncPathWarning } from "./config.ts";
import { readText, writeText } from "./fsx.ts";
import { writeAllowed } from "./files.ts";
import { buildSnapshot, vaultSummary } from "./snapshot.ts";
import { closeSessionIndex } from "./sessions.ts";
import { saveVaultFromMarkdown } from "./vault.ts";
const previous = {...process.env};
const keys = ["HOME","PATH","AGENT_HUB_ROOT","AGENT_HUB_VAULT_KEY","HERMES_HOME","CLAUDE_CONFIG_DIR","XDG_CONFIG_HOME","CONTEXT_FILE_NAMES"];
let home: string;
beforeEach(async () => {
 home=await fs.mkdtemp(path.join(os.tmpdir(),"hub-round5-"));
 for(const key of keys) delete process.env[key];
 process.env.HOME=home; process.env.AGENT_HUB_ROOT=path.join(home,".agent-hub");
 process.env.PATH=path.join(home,"bin") + ":/usr/bin:/bin"; process.env.AGENT_HUB_VAULT_KEY="a1".repeat(32);
});
afterEach(async () => {
 closeSessionIndex(); await fs.rm(home,{recursive:true,force:true});
 for(const key of keys) {if(previous[key]===undefined) delete process.env[key]; else process.env[key]=previous[key];}
});
test("saving a Claude or Hermes identity cannot manufacture an installed runtime", async () => {
 for(const id of ["claude","hermes"] as const) {
  await writeAllowed("identity","PERSONA ONLY",id);
  assert.equal(isAgentPresent(id),false);
  await assert.rejects(applyBind({agent:id,layer:"memory",value:"hub"}),e=>(e as {status:number}).status===409);
  assert.equal((await loadConfig()).bind[id].memory,"own");
  assert.equal(await readText(adapter(id).memoryInjectPath(home)),null);
  const config=path.join(agentHome(id),id==="claude"?"settings.json":"config.yaml");
  await writeText(config,"{}"); assert.equal(isAgentPresent(id),true);
  await fs.unlink(config);
  await writeText(path.join(home,"bin",id),"#!/bin/sh\nexit 0\n"); await fs.chmod(path.join(home,"bin",id),0o700);
  assert.equal(isAgentPresent(id),true);
 }
});
test("custom context names cannot write foreign rules; mixed lists use a dedicated file", async () => {
 for(const agent of ["gemini","qwen","goose"] as const) {
  await fs.mkdir(path.join(agentHome(agent), "sessions"),{recursive:true});
  const foreign=path.join(agentHome(agent),"CLAUDE.md"); await writeText(foreign,"FOREIGN");
  const configure=async (names:string[]) => {
   if(agent==="goose") await writeText(path.join(agentHome(agent),"config.yaml"), JSON.stringify({CONTEXT_FILE_NAMES:names}));
   else await writeText(path.join(agentHome(agent),"settings.json"),JSON.stringify({context:{fileName:names}}));
  };
  await configure(["CLAUDE.md", ".cursorrules"]);
  await assert.rejects(applyBind({agent,layer:"memory",value:"hub"}),e=>(e as {status:number}).status===409);
  assert.equal(await readText(foreign),"FOREIGN");
  assert.equal(await readText(adapter(agent).memoryInjectPath(home)),null);
  await configure(["CLAUDE.md","HUB-MEMORY.md"]);
  assert.equal((await nativeMemoryTarget(agent))!.path,path.join(agentHome(agent),"HUB-MEMORY.md"));
  await applyBind({agent,layer:"memory",value:"hub"});
  assert.match((await readText(path.join(agentHome(agent),"HUB-MEMORY.md")))!,/Hub Memory/);
  assert.equal(await readText(foreign),"FOREIGN");
  await applyBind({agent,layer:"memory",value:"own"});
 }
});
test("snapshot distinguishes an empty vault from wrong key or damaged ciphertext and recovers", async () => {
 await loadConfig();
 assert.deepEqual((await vaultSummary()).count,0);
 assert.equal((await vaultSummary()).status,"ready");
 await saveVaultFromMarkdown("## test\n密钥: SECRET_FIXTURE");
 const encrypted=await fs.readFile(hubPaths().vaultBin);
 process.env.AGENT_HUB_VAULT_KEY="b2".repeat(32);
 const wrong=await buildSnapshot(); assert.equal(wrong.vault.status,"unavailable"); assert.equal(wrong.vault.count,null);
 assert.match(wrong.vault.error!,/条目数未知/); assert.doesNotMatch(JSON.stringify(wrong.vault),/SECRET_FIXTURE/);
 assert.deepEqual(await fs.readFile(hubPaths().vaultBin),encrypted);
 process.env.AGENT_HUB_VAULT_KEY="a1".repeat(32);
 assert.equal((await vaultSummary()).count,1);
 await fs.writeFile(hubPaths().vaultBin,"broken");
 assert.equal((await vaultSummary()).status,"unavailable");
 assert.equal(await readText(hubPaths().vaultBin),"broken");
});
test("sync-directory warning is exposed on snapshots and clears after choosing a local root", async () => {
 assert.equal(syncPathWarning(path.join(home,".agent-hub")),null);
 for(const part of ["Documents","Desktop","Library/Mobile Documents","Library/CloudStorage"]) assert.match(syncPathWarning(path.join(home,part,"hub"))!,/同步/);
 process.env.AGENT_HUB_ROOT=path.join(home,"Documents/hub");
 const snapshot=await buildSnapshot(); assert.equal(snapshot.warnings.length,1); assert.match(snapshot.warnings[0]!,/Documents/);
 closeSessionIndex(); process.env.AGENT_HUB_ROOT=path.join(home,"local-hub");
 assert.deepEqual((await buildSnapshot()).warnings,[]);
});
