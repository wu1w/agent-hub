import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import { i18nPrelude, i18nSandbox } from "./ui-vm.ts";

const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
type Listener = (...args: any[]) => any;

function element(onFocus: (node: unknown) => void = () => {}) {
  const listeners = new Map<string, Listener[]>();
  return {
    value: "", textContent: "", title: "", className: "", disabled: false, hidden: false,
    nextElementSibling: null, parentElement: null as any,
    dataset: {} as Record<string, string>, attributes: {} as Record<string, string>, children: [] as any[],
    classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
    append(...items: any[]) { for (const item of items) if (typeof item === "object") item.parentElement = this; this.children.push(...items); },
    replaceChildren() { for (const child of this.children) child.parentElement = null; this.children = []; },
    addEventListener(type: string, handler: Listener) { listeners.set(type, [...listeners.get(type) ?? [], handler]); },
    async dispatch(type: string, event: unknown = {}) { for (const handler of listeners.get(type) ?? []) await handler(event); },
    focus() { onFocus(this); }, select() {},
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    removeAttribute(name: string) { delete this.attributes[name]; },
    querySelector: (_selector: string): any => null,
  };
}

async function ui(targets: string[] | null = ["grok", "codex", "disabled-adapter"]) {
  const elements = new Map<string, ReturnType<typeof element>>();
  let activeElement: unknown = null;
  const onFocus = (node: unknown) => { activeElement = node; };
  const get = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, element(onFocus));
    return elements.get(selector)!;
  };
  const writes: { url: string; method: string; body: any }[] = [];
  let failure = false;
  const fixture = {
    agents: [
      { id: "grok", label: "Grok", bind: { skills: "hub" } },
      { id: "codex", label: "Codex", bind: { skills: "own" } },
      { id: "doubao", label: "Doubao", memoryOnly: true, bind: { skills: "own" } },
    ],
    config: { layers: { skills: { default_targets: ["grok", "disabled-adapter"] } } },
    skills: [{ name: "sample", targets }, { name: "next", targets: ["grok"] }],
  };
  const context = vm.createContext(i18nSandbox({
    document: { querySelector: get, querySelectorAll: () => [], createElement: () => element(onFocus), get activeElement() { return activeElement; } },
    window: element(), confirm: () => true,
    fixtures: {
      snapshot: fixture,
      request: async (url: string, options?: { method: string; body: string }) => {
        if (!options?.method) return { path: "/skills/sample/SKILL.md", content: "LOADED BODY", revision: "r1" };
        const body = JSON.parse(options.body);
        writes.push({ url, method: options.method, body });
        if (failure) throw new Error("409 newer file");
        const file = { content: body.content, revision: "r2" };
        if (url === "/api/skill-targets") {
          fixture.skills[0]!.targets = body.targets;
          return { file, snapshot: fixture };
        }
        return file;
      },
    },
  }));
  vm.runInContext(await i18nPrelude() + "\n" + source.replace(/^(?:import[^\n]+\n)+/, "").split("/* ================= boot ================= */")[0], context);
  vm.runInContext("api = fixtures.request; snap = fixtures.snapshot; renderNav = () => {}; renderOverview = () => {}; renderSkills = () => {}; bindChrome();", context);
  await context.openSkill("sample");
  return {
    context, get, writes, fixture,
    state: (expression: string) => vm.runInContext(expression, context),
    fail: (value: boolean) => { failure = value; },
    targets: () => get("#skill-targets").children,
    button: (label: string) => get("#skill-targets").children.find(btn => btn.textContent === label || btn.textContent.startsWith(`${label} · `))!,
    mode: (mode: "inherit" | "custom") => get("#skill-targets").children.find(btn => btn.textContent === vm.runInContext(`t("skills.${mode}")`, context))!,
    active: () => activeElement,
  };
}

test("skill targets stay local until the Save button submits body, scope and revision together", async () => {
  const x = await ui();
  x.get("#skill-editor").value = "UNSAVED BODY";
  await x.get("#skill-editor").dispatch("input");
  await x.button("Grok").dispatch("click");
  assert.equal(x.writes.length, 0);
  assert.equal(x.get("#skill-editor").value, "UNSAVED BODY");
  assert.equal(x.state("skillDirty"), true);
  assert.deepEqual(x.fixture.skills[0]!.targets, ["grok", "codex", "disabled-adapter"]);
  assert.deepEqual(JSON.parse(x.state("JSON.stringify(skillTargetsDraft)")), ["codex", "disabled-adapter"]);
  x.context.renderSkillTargets();
  assert.equal(x.button("Grok").className.includes("is-on"), false);

  await x.get("#btn-save-skill").dispatch("click");
  assert.deepEqual(x.writes, [{ url: "/api/skill-targets", method: "POST", body: {
    name: "sample", targets: ["codex", "disabled-adapter"], content: "UNSAVED BODY", revision: "r1",
  } }]);
  assert.equal(x.state("skillDirty"), false);
  assert.equal(x.state("skillTargetsDraft"), undefined);
  assert.equal(x.state("skillRevision"), "r2");
});

test("a rejected skill save retains both drafts and their revision for retry", async () => {
  const x = await ui();
  x.get("#skill-editor").value = "KEEP MY BODY";
  await x.button("Grok").dispatch("click");
  x.fail(true);
  await x.get("#btn-save-skill").dispatch("click");
  assert.equal(x.state("skillDirty"), true);
  assert.equal(x.state("skillRevision"), "r1");
  assert.deepEqual(JSON.parse(x.state("JSON.stringify(skillTargetsDraft)")), ["codex", "disabled-adapter"]);
  assert.equal(x.get("#skill-editor").value, "KEEP MY BODY");
  assert.equal(x.get("#skill-editor").disabled, false);
  assert.equal(x.get("#btn-save-skill").disabled, false);
  x.fail(false);
  await x.get("#btn-save-skill").dispatch("click");
  assert.equal(x.writes.length, 2);
  assert.equal(x.state("skillDirty"), false);
});

test("Own and unsupported agents are labelled, disabled, and never displayed as active recipients", async () => {
  const x = await ui(["*"]);
  for (const btn of [x.button("Codex"), x.button("Doubao")]) {
    assert.equal(btn.disabled, true);
    assert.equal(btn.className.includes("is-on"), false);
    assert.equal(btn.attributes["aria-pressed"], "false");
    assert.ok(btn.title);
    assert.ok(btn.textContent.includes(" · "));
    await btn.dispatch("click");
  }
  assert.equal(x.state("skillDirty"), false);
  assert.equal(x.writes.length, 0);
  assert.equal(x.fixture.agents[1]!.bind.skills, "own");
});

test("switching inheritance is a draft and preserves configured targets outside the active catalog", async () => {
  const x = await ui(null);
  assert.equal(x.button("Grok").disabled, true);
  assert.equal(x.mode("inherit").attributes["aria-pressed"], "true");
  assert.equal(x.mode("custom").attributes["aria-pressed"], "false");
  await x.mode("inherit").dispatch("click");
  assert.equal(x.state("skillDirty"), false);
  assert.equal(x.state("skillTargetsDraft"), undefined);
  await x.mode("custom").dispatch("click");
  assert.equal(x.writes.length, 0);
  assert.equal(x.button("Grok").disabled, false);
  assert.equal(x.mode("inherit").attributes["aria-pressed"], "false");
  assert.equal(x.mode("custom").attributes["aria-pressed"], "true");
  assert.deepEqual(JSON.parse(x.state("JSON.stringify(skillTargetsDraft)")), ["grok", "disabled-adapter"]);
  await x.button("Grok").dispatch("click");
  assert.deepEqual(JSON.parse(x.state("JSON.stringify(skillTargetsDraft)")), ["disabled-adapter"]);
  const editEpoch = x.state("skillEditEpoch");
  await x.mode("custom").dispatch("click");
  assert.equal(x.state("skillEditEpoch"), editEpoch);
  assert.deepEqual(JSON.parse(x.state("JSON.stringify(skillTargetsDraft)")), ["disabled-adapter"]);
  await x.mode("inherit").dispatch("click");
  assert.equal(x.state("skillTargetsDraft"), null);
  assert.equal(x.writes.length, 0);
});

test("scope-only changes participate in discard confirmation and reset on successful skill switch", async () => {
  const x = await ui();
  await x.button("Grok").dispatch("click");
  let confirms = 0;
  x.context.confirm = () => { confirms++; return false; };
  await x.context.openSkill("next");
  assert.equal(confirms, 1);
  assert.equal(x.state("selectedSkill"), "sample");
  assert.equal(x.state("skillDirty"), true);
  x.context.confirm = () => true;
  await x.context.openSkill("next");
  assert.equal(x.state("selectedSkill"), "next");
  assert.equal(x.state("skillTargetsDraft"), undefined);
  assert.equal(x.state("skillDirty"), false);
});

test("target and mode controls expose selected state and retain only their own focus after rerender", async () => {
  const x = await ui(null);
  x.mode("custom").focus();
  await x.mode("custom").dispatch("click");
  assert.equal(x.active(), x.mode("custom"));
  assert.equal(x.mode("custom").attributes["aria-pressed"], "true");

  x.button("Grok").focus();
  assert.equal(x.button("Grok").attributes["aria-pressed"], "true");
  await x.button("Grok").dispatch("click");
  assert.equal(x.active(), x.button("Grok"));
  assert.equal(x.button("Grok").attributes["aria-pressed"], "false");
  await x.button("Grok").dispatch("click");
  assert.equal(x.active(), x.button("Grok"));
  assert.equal(x.button("Grok").attributes["aria-pressed"], "true");

  const editor = x.get("#skill-editor");
  editor.focus();
  x.context.renderSkillTargets();
  assert.equal(x.active(), editor);
  assert.equal(x.writes.length, 0);
});

test("body-only save preserves manually edited frontmatter instead of replacing it from a snapshot", async () => {
  const x = await ui();
  const content = "---\nhub:\n  targets: [grok]\n---\nNEW BODY";
  x.get("#skill-editor").value = content;
  await x.get("#skill-editor").dispatch("input");
  await x.get("#btn-save-skill").dispatch("click");
  assert.deepEqual(x.writes, [{ url: "/api/file?kind=skill&name=sample", method: "PUT", body: { content, revision: "r1" } }]);
});
