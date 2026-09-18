import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import { i18nPrelude, i18nSandbox } from "./ui-vm.ts";
const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
const prelude = await i18nPrelude();
function fn(name: string) {
  const start = source.indexOf(`async function ${name}(`) >= 0 ? source.indexOf(`async function ${name}(`) : source.indexOf(`function ${name}(`);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}
const helpers = fn("allowsCtxHub") + "\n" + fn("ctxHubBlockReason");
test("Ctx UI rejects unsupported projection before confirmation or API and preserves allowlist", async () => {
  let calls = 0, confirmations = 0, message = "";
  const snap = { config: { layers: { ctx: { global_targets: ["hyper"] } } } };
  const context = vm.createContext(i18nSandbox({ snap, banner: (text: string) => { message = text; }, api: async () => { calls++; return { snapshot: snap }; }, confirmBox: async () => { confirmations++; return "ok"; }, renderSkills() {}, renderMemory() {}, renderAgents() {} }));
  vm.runInContext(prelude + helpers + "\n" + fn("onBind"), context);
  for (const [id, projection, reason] of [["grok", null, "无 USER.md 投影路径"], ["cursor", "/test/rule", "未列入 Ctx 可投影名单"]]) {
    const sel = { value: "hub", disabled: false };
    await context.onBind({ id, label: id, userMdProjection: projection, bind: { ctx: "own" } }, "ctx", "hub", sel);
    assert.equal(sel.value, "own"); assert.match(message, new RegExp(reason!));
  }
  assert.equal(calls, 0); assert.equal(confirmations, 0);
  await context.onBind({ id: "hyper", label: "Hyper", userMdProjection: "/test/USER.md", bind: { ctx: "own" } }, "ctx", "hub", { value: "hub" });
  assert.equal(calls, 1); assert.equal(confirmations, 1);
  await context.onBind({ id: "cursor", label: "Cursor", userMdProjection: "/test/rule", bind: { ctx: "hub" } }, "ctx", "own", { value: "own" });
  assert.equal(calls, 2);
  assert.deepEqual(snap.config.layers.ctx.global_targets, ["hyper"]);
});
test("Ctx render disables only disallowed Hub options with an actionable reason", () => {
  class Node {
    children: Node[] = []; nodes = new Map<string, Node>(); dataset: Record<string,string> = {}; disabled = false; title = ""; value = ""; textContent = ""; innerHTML = ""; className = "";
    append(...nodes: Node[]) { this.children.push(...nodes); }
    replaceChildren() { this.children = []; }
    querySelector(key: string): Node { if (!this.nodes.has(key)) this.nodes.set(key, new Node()); return this.nodes.get(key)!; }
    addEventListener() {} remove() {}
  }
  const root = new Node();
  const agents = [["grok", null], ["cursor", "/test/rule"], ["hyper", "/test/USER.md"]].map(([id, userMdProjection]) => ({id,label:id,userMdProjection,present:true,bind:{ctx:"own",memory:"own",sessions:"own",vault:"off"}}));
  const context = vm.createContext(i18nSandbox({ snap: { agents, config: { layers: { ctx: { global_targets: ["hyper"] } } }, vault: {entries:[]} }, LAYER_META: {ctx:{label:"Ctx",labelKey:"layer.ctx",options:[["hub","opt.hub"],["own","opt.own"]]}}, document:{createElement:()=>new Node()}, $:()=>root, esc:(s: string)=>s, apiErrorText:(s: string)=>s, loadIdentity:async()=>{}, wirePreview(){}, renderSubagents(){}, filterAgentCards(){}, renderCatalog(){}, renderSnapshotWarnings(){}, onBind(){}, banner(){} }));
  vm.runInContext(prelude + helpers + "\n" + fn("renderAgents"), context); context.renderAgents();
  root.children.forEach((card, i) => {
    const select = card.querySelector(".bind").children[1]!;
    assert.equal(select.children[0]!.disabled, i !== 2);
    assert.equal(select.children[1]!.disabled, false);
    if (i !== 2) assert.match(select.title, /无 USER.md 投影路径|未列入 Ctx 可投影名单/);
  });
});
