import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import { i18nPrelude, i18nSandbox } from "./ui-vm.ts";

const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
type Listener = (...args: any[]) => any;

function node() {
  const listeners = new Map<string, { listener: Listener; once?: boolean }[]>();
  const element = {
    value: "", textContent: "", disabled: false, hidden: false, readOnly: false,
    returnValue: "", open: false, isConnected: true, nextElementSibling: null, dataset: {} as Record<string, string>,
    style: {}, children: [] as any[],
    classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
    append(...children: any[]) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    addEventListener(type: string, listener: Listener, options?: { once?: boolean }) {
      const list = listeners.get(type) ?? []; list.push({ listener, once: options?.once }); listeners.set(type, list);
    },
    async dispatch(type: string, event: unknown = {}) {
      const current = listeners.get(type) ?? [];
      listeners.set(type, current.filter(item => !item.once));
      await Promise.all(current.map(item => item.listener(event)));
    },
    dispatchEvent(event: { type: string }) {
      if (event.type === "input") this.oninput?.(event);
      void this.dispatch(event.type, event);
      return true;
    },
    showModal() { this.open = true; },
    close(value?: string) {
      if (value !== undefined) this.returnValue = value;
      this.open = false;
      void this.dispatch("close");
    },
    // Escape closes a native dialog without replacing its existing returnValue.
    escape() { this.close(); },
    focus() {}, select() {}, querySelector: (_selector: string): any => null,
    onsubmit: undefined as Listener | undefined,
    onclick: undefined as Listener | undefined,
    oninput: undefined as Listener | undefined,
  };
  return element;
}

type Request = (url: string, options?: { method?: string; body?: string }) => Promise<any>;
async function ui(request: Request = async () => ({})) {
  const elements = new Map<string, ReturnType<typeof node>>();
  const get = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, node());
    return elements.get(selector)!;
  };
  const context = vm.createContext(i18nSandbox({
    document: { querySelector: get, querySelectorAll: () => [], createElement: node, createTextNode: (text: string) => text },
    window: node(), Event, confirm: () => true, fixtures: { request },
  }));
  vm.runInContext(await i18nPrelude() + "\n" + source.replace(/^(?:import[^\n]+\n)+/, "").split("/* ================= boot ================= */")[0], context);
  vm.runInContext('api = fixtures.request; snap = { agents: [], userMd: {}, skills: [] }; renderSkills = () => {}; renderSkillTargets = () => {}; bindChrome();', context);
  return { context, get, state: (expression: string) => vm.runInContext(expression, context) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const file = (name: string, content = name) => ({ path: `/skills/${name}/SKILL.md`, content, revision: "same-content-revision" });

test("a pending skill read cannot save or delete the visible document under another name", async () => {
  const next = deferred<ReturnType<typeof file>>();
  const writes: { url: string; body: any }[] = [];
  const x = await ui(async (url, options = {}) => {
    if (options.method) { writes.push({ url, body: JSON.parse(options.body ?? "{}") }); return file("A", "EDIT A"); }
    return url.includes("name=B") ? next.promise : file("A", "SAME");
  });
  await x.context.openSkill("A");
  const loading = x.context.openSkill("B");
  assert.equal(x.state("selectedSkill"), "A");
  assert.equal(x.get("#skill-title").textContent, "A");
  assert.equal(x.get("#btn-save-skill").disabled, true);
  await x.get("#btn-save-skill").dispatch("click");
  await x.get("#btn-delete-skill").dispatch("click");
  await x.context.saveSkillTargets(["grok"]);
  assert.equal(writes.length, 0);
  next.resolve(file("B", "SAME"));
  await loading;
  assert.equal(x.state("selectedSkill"), "B");
  assert.equal(x.get("#skill-meta").textContent, "/skills/B/SKILL.md");
  assert.equal(x.get("#btn-save-skill").disabled, false);
});

test("typing while the next skill loads preserves the old document identity and draft", async () => {
  const next = deferred<ReturnType<typeof file>>();
  const x = await ui(async url => url.includes("name=B") ? next.promise : file("A"));
  await x.context.openSkill("A");
  const loading = x.context.openSkill("B");
  x.get("#skill-editor").value = "NEW DRAFT FOR A";
  await x.get("#skill-editor").dispatch("input");
  next.resolve(file("B"));
  await loading;
  assert.equal(x.state("selectedSkill"), "A");
  assert.equal(x.get("#skill-title").textContent, "A");
  assert.equal(x.get("#skill-editor").value, "NEW DRAFT FOR A");
  assert.equal(x.state("skillDirty"), true);
  assert.equal(x.state("skillPending"), false);
  assert.equal(x.get("#btn-save-skill").disabled, false);
});

test("failed or older skill loads cannot corrupt selection or clear the latest pending state", async () => {
  const a = deferred<ReturnType<typeof file>>(), b = deferred<ReturnType<typeof file>>();
  const x = await ui(async url => url.includes("name=A") ? a.promise : url.includes("name=B") ? b.promise : file("initial"));
  await x.context.openSkill("initial");
  const first = x.context.openSkill("A"), second = x.context.openSkill("B");
  a.resolve(file("A"));
  await first;
  assert.equal(x.state("skillPending"), true);
  assert.equal(x.state("selectedSkill"), "initial");
  b.reject(new Error("read failed"));
  await assert.rejects(second, /read failed/);
  assert.equal(x.state("selectedSkill"), "initial");
  assert.equal(x.state("skillPending"), false);
  assert.equal(x.get("#btn-save-skill").disabled, false);
});

test("subagent selection ignores old responses and pending reads cannot save an old editor", async () => {
  const a = deferred<ReturnType<typeof file>>(), b = deferred<ReturnType<typeof file>>();
  let writes = 0;
  const x = await ui(async (url, options = {}) => {
    if (options.method) { writes++; return file("saved"); }
    return url.includes("name=A") ? a.promise : url.includes("name=B") ? b.promise : file("initial");
  });
  const wrap = node(), card = node();
  const children = new Map<string, ReturnType<typeof node>>();
  const sub = (selector: string) => {
    if (!children.has(selector)) children.set(selector, node());
    return children.get(selector)!;
  };
  wrap.querySelector = sub;
  card.querySelector = () => wrap;
  vm.runInContext("wirePreview = () => {};", x.context);
  const agent = { id: "grok", subagents: [] };
  x.context.renderSubagents(card, agent);
  await x.context.openSubagent(wrap, agent, "initial");
  const first = x.context.openSubagent(wrap, agent, "A"), second = x.context.openSubagent(wrap, agent, "B");
  assert.equal(sub(".save-sub").disabled, true);
  await sub(".save-sub").dispatch("click");
  assert.equal(writes, 0);
  b.resolve(file("B"));
  await second;
  a.resolve(file("A"));
  await first;
  assert.equal(wrap.dataset.sub, "B");
  assert.equal(sub(".sub-editor").value, "B");
  assert.equal(x.state("selectedSubagents.get('grok')"), "B");
  assert.equal(sub(".save-sub").disabled, false);
});

test("typing during a subagent read keeps the existing draft and selected file", async () => {
  const next = deferred<ReturnType<typeof file>>();
  const x = await ui(async url => url.includes("name=B") ? next.promise : file("A"));
  const wrap = node(), editor = node(), save = node(), path = node();
  wrap.querySelector = selector => selector === ".sub-editor" ? editor : selector === ".save-sub" ? save : path;
  await x.context.openSubagent(wrap, { id: "grok" }, "A");
  const loading = x.context.openSubagent(wrap, { id: "grok" }, "B");
  editor.value = "DRAFT FOR A";
  (editor as any).oninput();
  next.resolve(file("B"));
  await loading;
  assert.equal(wrap.dataset.sub, "A");
  assert.equal(editor.value, "DRAFT FOR A");
  assert.equal(x.state("agentDrafts.get('subagent:grok:A').dirty"), true);
  assert.equal(save.disabled, false);
});

test("Escape after an earlier confirmation cancels reused confirmation and text dialogs", async () => {
  const x = await ui();
  const confirmed = x.context.confirmBox("first", "OK");
  x.get("#confirm").close("ok");
  assert.equal(await confirmed, "ok");
  const cancelled = x.context.confirmBox("second", "OK");
  x.get("#confirm").escape();
  assert.equal(await cancelled, "cancel");

  const firstText = x.context.askText({ title: "Name" });
  x.get("#text-prompt-input").value = "first";
  await x.get("#text-prompt-form").onsubmit?.({ preventDefault() {} });
  assert.equal(await firstText, "first");
  const secondText = x.context.askText({ title: "Name", value: "must not submit" });
  x.get("#text-prompt").escape();
  assert.equal(await secondText, null);
});

test("Escape after restoring a backup does not silently select the next default backup", { timeout: 1000 }, async () => {
  const x = await ui(async () => ({ backups: [{ name: "backup-1", kind: "identity" }] }));
  const restored = x.context.pickBackup({ id: "grok", label: "Grok" });
  for (let n = 0; n < 10 && !x.get("#backup-picker").open; n++) await Promise.resolve();
  assert.equal(x.get("#backup-picker").open, true);
  x.get("#backup-picker").close("ok");
  assert.equal(await restored, "backup-1");
  const cancelled = x.context.pickBackup({ id: "grok", label: "Grok" });
  for (let n = 0; n < 10 && !x.get("#backup-picker").open; n++) await Promise.resolve();
  assert.equal(x.get("#backup-picker").open, true);
  x.get("#backup-picker").escape();
  assert.equal(await cancelled, null);
});

test("Escape on a reused scope dialog settles as cancelled after a successful submit", { timeout: 1000 }, async () => {
  const x = await ui();
  vm.runInContext('snap.agents = [{ id: "grok", label: "Grok" }]; submitMemoryScope = async () => ({ saved: true });', x.context);
  const saved = x.context.askScope();
  x.get("#scope-agent").value = "grok";
  x.get("#scope-cwd").value = "/workspace";
  await x.get("#scope-form").onsubmit?.({ preventDefault() {} });
  assert.equal((await saved).saved, true);
  const cancelled = x.context.askScope();
  x.get("#scope-dialog").escape();
  assert.equal(await cancelled, null);
});

async function sessionUi(fetch: (url: string) => Promise<unknown>) {
  const x = await ui();
  x.context.fetch = fetch;
  x.context.sessionStorage = { getItem: () => "" };
  const start = source.indexOf("async function api(");
  vm.runInContext(source.slice(start, source.indexOf("\n}\n", start) + 3), x.context);
  vm.runInContext("renderSessions = () => {}; renderNav = () => {};", x.context);
  return x;
}

test("a late 503 from an older session search cannot clear a newer successful search", async () => {
  const old = deferred<unknown>();
  const row = { agent_id: "grok", session_id: "current", source_path: "/current" };
  const x = await sessionUi(async url => url.includes("q=old") ? old.promise : {
    ok: true, status: 200, json: async () => ({ sessions: [row], handoffs: [] }),
  });
  x.get("#session-q").value = "old";
  const first = x.context.loadSessions();
  x.get("#session-q").value = "current";
  await x.context.loadSessions();
  vm.runInContext("sessionState.selected = sessionState.sessions[0]; sessContentKey = 'grok/current';", x.context);
  x.get("#session-path").textContent = "/current";
  old.resolve({ ok: false, status: 503, json: async () => ({ error: "Vault unavailable" }) });
  await first;
  assert.equal(x.state("sessionState.sessions[0].session_id"), "current");
  assert.equal(x.state("sessionState.selected.session_id"), "current");
  assert.equal(x.state("sessionState.unavailable"), false);
  assert.equal(x.get("#session-path").textContent, "/current");
});

test("a 503 from the current session search still clears stale details and launch controls", async () => {
  const x = await sessionUi(async () => ({ ok: false, status: 503, json: async () => ({ error: "Vault unavailable" }) }));
  vm.runInContext("sessionState = { sessions: [{session_id:'old'}], handoffs: [], selected: {agent_id:'grok',session_id:'old'} };", x.context);
  x.get("#session-path").textContent = "/old";
  x.get("#handoff-out").textContent = "old launch";
  await assert.rejects(x.context.loadSessions(), /Vault unavailable/);
  assert.equal(x.state("sessionState.sessions.length"), 0);
  assert.equal(x.state("sessionState.selected"), null);
  assert.equal(x.state("sessionState.unavailable"), true);
  assert.equal(x.get("#session-path").textContent, "");
  assert.equal(x.get("#handoff-out").textContent, "");
  assert.equal(x.get("#btn-handoff").disabled, true);
});

function agentCard(id = "grok") {
  const card = node(); card.dataset.agent = id;
  const fields = new Map<string, ReturnType<typeof node>>();
  const field = (selector: string) => {
    if (!fields.has(selector)) fields.set(selector, node());
    return fields.get(selector)!;
  };
  card.querySelector = field;
  field(".soul-wrap").querySelector = field;
  return { card, field };
}

test("a detached identity response cannot replace the visible card's draft tracking", async () => {
  const old = deferred<ReturnType<typeof file>>(), fresh = deferred<ReturnType<typeof file>>();
  let requests = 0;
  const x = await ui(async () => ++requests === 1 ? old.promise : fresh.promise);
  const previous = agentCard(), current = agentCard();
  const first = x.context.loadIdentity(previous.card, { id: "grok" });
  const second = x.context.loadIdentity(current.card, { id: "grok" });
  fresh.resolve({ ...file("current"), revision: "current-revision" });
  await second;
  previous.card.isConnected = false;
  old.resolve({ ...file("obsolete"), revision: "obsolete-revision" });
  assert.equal(await first, false);
  current.field(".id-editor").value = "MY CURRENT DRAFT";
  current.field(".id-editor").dispatchEvent(new Event("input"));
  assert.equal(x.state("agentDrafts.get('identity:grok').content"), "MY CURRENT DRAFT");
  assert.equal(x.state("agentDrafts.get('identity:grok').revision"), "current-revision");
  assert.equal(x.state("agentDrafts.get('identity:grok').dirty"), true);
});

test("identity loading stays lazy; fresh reads update only open, clean cards and can retry failures", async () => {
  let requests = 0, fail = false;
  const x = await ui(async () => {
    requests++;
    if (fail) throw new Error("read unavailable");
    return file(`version-${requests}`);
  });
  const current = agentCard();
  x.context.document.querySelectorAll = () => [current.card];
  vm.runInContext("renderSubagents = () => {};", x.context);
  x.context.setupAgentIdentity(current.card, { id: "grok" });
  await x.context.refreshOpenAgentEditors();
  assert.equal(requests, 0);
  current.field(".id-block").open = true;
  await current.field(".id-block").dispatch("toggle");
  assert.equal(requests, 1);
  await x.context.refreshOpenAgentEditors();
  assert.equal(requests, 2);
  assert.equal(current.field(".id-editor").value, "version-2");
  current.field(".id-editor").value = "LOCAL DRAFT";
  current.field(".id-editor").dispatchEvent(new Event("input"));
  await x.context.refreshOpenAgentEditors();
  assert.equal(requests, 2);
  assert.equal(current.field(".id-editor").value, "LOCAL DRAFT");
  vm.runInContext("agentDrafts.get('identity:grok').dirty = false;", x.context);
  fail = true;
  await x.context.refreshOpenAgentEditors();
  assert.equal(current.field(".id-editor").disabled, false);
  fail = false;
  await x.context.refreshOpenAgentEditors();
  assert.equal(current.field(".id-editor").value, "version-4");
  current.field(".id-block").open = false;
  await x.context.refreshOpenAgentEditors();
  assert.equal(requests, 4);
});

test("drafting an identity uses snapshot preferences even if the preferences page was never opened", async () => {
  const x = await ui();
  const current = agentCard();
  x.context.attachAgentDraft(current.field(".id-editor"), "identity:grok", file("identity"));
  vm.runInContext("snap.userMd = { content: 'SAVED PREFERENCES' };", x.context);
  assert.equal(x.get("#user-editor").value, "");
  x.context.draftIdentityFromUser(current.card);
  assert.match(current.field(".id-editor").value, /SAVED PREFERENCES/);
  assert.equal(x.state("agentDrafts.get('identity:grok').dirty"), true);
  vm.runInContext("userDirty = true;", x.context);
  x.get("#user-editor").value = "UNSAVED PREFERENCES";
  x.context.draftIdentityFromUser(current.card);
  assert.match(current.field(".id-editor").value, /UNSAVED PREFERENCES/);
});

test("restoring an identity reloads the open editor even when snapshot metadata is unchanged", async () => {
  let content = "BEFORE", reads = 0;
  const x = await ui(async url => {
    if (url.startsWith("/api/identity/backups")) return { backups: [{ name: "chosen", kind: "identity" }] };
    if (url === "/api/identity/restore") { content = "RESTORED"; return { kind: "identity", path: "/identity" }; }
    reads++;
    return { ...file(content), revision: content };
  });
  const current = agentCard();
  x.context.document.querySelectorAll = () => [current.card];
  vm.runInContext("renderSubagents = () => {}; refresh = async () => {}; pickBackup = async () => 'chosen';", x.context);
  x.context.setupAgentIdentity(current.card, { id: "grok" });
  current.field(".id-block").open = true;
  await current.field(".id-block").dispatch("toggle");
  assert.equal(current.field(".id-editor").value, "BEFORE");
  await x.context.restoreIdentity({ id: "grok" });
  assert.equal(reads, 2);
  assert.equal(current.field(".id-editor").value, "RESTORED");
  assert.equal(x.state("agentDrafts.get('identity:grok').revision"), "RESTORED");
});
