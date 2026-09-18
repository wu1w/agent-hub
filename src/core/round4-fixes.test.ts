import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, afterEach, test } from "node:test";
import { agentHome, adapter } from "./adapters.ts";
import { nativeMemoryTarget } from "./autoload.ts";
import { applyBind } from "./bind.ts";
import { hubPaths, loadConfig } from "./config.ts";
import { selectMemoryProject, workspaceMemoryPath } from "./deliver.ts";
import { readText, writeText } from "./fsx.ts";
import { resumePlan, createHandoff } from "./handoff.ts";
import { setVaultGrants, saveVaultFromMarkdown } from "./vault.ts";
import { adoptSkills, scanUserSkills, scanVendorSkills } from "./skills.ts";
const exec = promisify(execFile);
const old = {...process.env};
let home: string, cwd: string;
const keys = ["HOME","AGENT_HUB_ROOT","AGENT_HUB_VAULT_KEY","XDG_CONFIG_HOME","PI_CODING_AGENT_DIR","CONTEXT_FILE_NAMES"];
beforeEach(async () => {
 home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-round4-")); cwd = path.join(home,"project");
 for (const key of keys) delete process.env[key];
 process.env.HOME=home; process.env.AGENT_HUB_ROOT=path.join(home,".agent-hub"); process.env.AGENT_HUB_VAULT_KEY="a1".repeat(32);
 await fs.mkdir(cwd);
});
afterEach(async () => { await fs.rm(home,{recursive:true,force:true}); for(const key of keys) { if(old[key]===undefined) delete process.env[key]; else process.env[key]=old[key]; } });
test("foreign runtime fallbacks are read-only and cannot silently be shadowed", async () => {
 const foreign=path.join(home,".claude/CLAUDE.md"); await writeText(foreign,"PERSONAL IDENTITY");
 await fs.mkdir(path.join(agentHome("opencode"), "sessions"),{recursive:true});
 await assert.rejects(applyBind({agent:"opencode",layer:"memory",value:"hub"}), /回退/);
 assert.equal(await readText(foreign),"PERSONAL IDENTITY");
 assert.equal(await readText(adapter("opencode").memoryInjectPath(home)),null);
 for(const agent of ["opencode","pi","hermes"] as const) {
  await writeText(path.join(cwd,"CLAUDE.md"),"ORIGINAL");
  await assert.rejects(nativeMemoryTarget(agent,cwd), /回退/);
  assert.equal(await readText(path.join(cwd,"CLAUDE.md")),"ORIGINAL");
 }
});
test("Cline uses an explicit workspace and never creates a Documents projection", async () => {
 await fs.mkdir(path.join(agentHome("cline"), "sessions"),{recursive:true});
 assert.equal(await nativeMemoryTarget("cline"),null);
 await applyBind({agent:"cline",layer:"memory",value:"hub"});
 assert.equal(await readText(path.join(agentHome("cline"),"hub/memory.md")),null);
 await selectMemoryProject("cline",undefined,cwd,true);
 assert.match((await readText(path.join(cwd,".clinerules/hub-memory.md")))!, /Hub Memory/);
 const cloud=path.join(home,"Documents/project"); await fs.mkdir(cloud,{recursive:true});
 await assert.rejects(selectMemoryProject("cline",undefined,cloud,true), /云盘/);
});
test("tracked native rules block atomically; untracked projections are locally excluded", async () => {
 await fs.mkdir(path.join(agentHome("copilot"), "sessions"),{recursive:true});
 await exec("git",["init","-q",cwd]);
 const file=path.join(cwd,".github/copilot-instructions.md"); await writeText(file,"TRACKED");
 await exec("git",["-C",cwd,"add","."]);
 await applyBind({agent:"copilot",layer:"memory",value:"hub"});
 const exclude=path.join(cwd,".git/info/exclude"); const before=await readText(exclude);
 await assert.rejects(selectMemoryProject("copilot",undefined,cwd,true), e => {
 const message=(e as Error).message;
 assert.match(message,/已跟踪/); assert.match(message,/rm --cached/); assert.match(message,/暂存/); assert.match(message,/Hyper/); return true;
 });
 assert.equal(await readText(file),"TRACKED"); assert.equal(await readText(exclude),before);
 assert.equal(await readText(workspaceMemoryPath("copilot",cwd)),null);
 await exec("git",["-C",cwd,"rm","--cached","--", ".github/copilot-instructions.md"]);
 await selectMemoryProject("copilot",undefined,cwd,true);
 for(const target of [file,workspaceMemoryPath("copilot",cwd)]) assert.ok((await exec("git",["-C",cwd,"check-ignore",path.relative(cwd,target)])).stdout.trim());
 await applyBind({agent:"copilot",layer:"memory",value:"own"}); assert.equal(await readText(file),"TRACKED");
});
test("uninstalled binding and unsupported handoff, grants and sessions have actionable client errors", async () => {
 await assert.rejects(applyBind({agent:"roo",layer:"memory",value:"hub"}), e => (e as {status:number}).status===409);
 await assert.rejects(applyBind({agent:"workbuddy",layer:"sessions",value:"index"}), /扫描器/);
 assert.throws(()=>resumePlan({from:"grok",to:"aider",sessionId:"s",cwd,handoffPath:"/tmp/h"}), /不支持交接/);
 await assert.rejects(createHandoff({from:"grok",to:"aider",sessionId:"s"}), /不支持/);
 await assert.rejects(setVaultGrants("x",["aider"]), /不支持 Vault/);
 await assert.rejects(saveVaultFromMarkdown("## x\n密钥: test", {x:["aider"]}), /不支持 Vault/);
 await writeText(path.join(home,".config/goose/config.yaml"),"CONTEXT_FILE_NAMES: broken");
 await assert.rejects(nativeMemoryTarget("goose"), /文件名数组/);
 assert.equal("targets" in (await loadConfig()).layers.memory,false);
});
test("onboarding selection adopts only selected user skills", async () => {
 for(const name of ["yes","no"]) await writeText(path.join(home,".grok/skills",name,"SKILL.md"), name);
 const report=await adoptSkills("adopt",{names:["yes"]});
 assert.deepEqual(report.moved,["yes"]);
 assert.equal(await readText(path.join(hubPaths().skills,"no/SKILL.md")),null);
 assert.equal(await readText(path.join(home,".grok/skills/no/SKILL.md")),"no");
});

test("Codex system skills stay vendor-owned during onboarding", async () => {
 const file=path.join(home,".codex/skills/.system/system-demo/SKILL.md"); await writeText(file,"SYSTEM");
 const config=await loadConfig();
 assert.equal((await scanUserSkills(config)).some(s=>s.name==="system-demo"),false);
 assert.equal((await scanVendorSkills(config)).some(s=>s.name==="system-demo"),true);
 await adoptSkills("adopt",{names:["system-demo"]});
 assert.equal(await readText(file),"SYSTEM");
 assert.equal(await readText(path.join(hubPaths().skills,"system-demo/SKILL.md")),null);
});
