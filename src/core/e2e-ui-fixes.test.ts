import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import { i18nPrelude, i18nSandbox } from "./ui-vm.ts";

const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
function fn(name: string) {
  const start = source.indexOf(`async function ${name}(`) >= 0 ? source.indexOf(`async function ${name}(`) : source.indexOf(`function ${name}(`);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

class Node {
  tagName: string;
  type = "";
  className = "";
  title = "";
  innerHTML = "";
  textContent = "";
  hidden = false;
  checked = false;
  children: Node[] = [];
  listeners: [string, (...args: unknown[]) => unknown][] = [];
  classList = { contains: () => false, toggle() {}, add() {}, remove() {} };
  constructor(tag = "div") { this.tagName = tag; }
  addEventListener(event: string, fn: (...args: unknown[]) => unknown) { this.listeners.push([event, fn]); }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
}

test("clickable skill rows are buttons", () => {
  const context = vm.createContext(i18nSandbox({
    selectedSkill: null,
    esc: (value: string) => value,
    document: { createElement: (tag: string) => new Node(tag) },
  }));
  vm.runInContext(fn("skillRowEl"), context);
  const clickable = context.skillRowEl({ name: "e2e-demo", src: "user", time: "", onClick: () => {} });
  assert.equal(clickable.tagName, "button");
  assert.equal(clickable.type, "button");
  assert.match(clickable.className, /skill-row/);
  assert.equal(clickable.listeners.some((entry: [string, (...args: unknown[]) => unknown]) => entry[0] === "click"), true);
  const readonly = context.skillRowEl({ name: "vendor", src: "grok", time: "", readonly: true });
  assert.equal(readonly.tagName, "div");
});

test("session transcript UI hides raw jsonl once a spoken turn exists", async () => {
  const flow = new Node("div");
  const context = vm.createContext(i18nSandbox({
    document: { createElement: (tag: string) => new Node(tag) },
    $: (sel: string) => sel === "#sess-c-flow" ? flow : new Node(),
  }));
  vm.runInContext(await i18nPrelude() + "\n" + fn("renderSessionMessages"), context);
  context.renderSessionMessages({
    messages: [{ role: "user", text: "Fix the audit report" }],
    raw: '{"type":"session_meta"}\n{"type":"response_item"}',
  });
  assert.equal(flow.children.some((child) => child.tagName === "pre"), false);
  assert.equal(flow.children.some((child) => child.className === "msg user"), true);

  context.renderSessionMessages({ messages: [], raw: '{"type":"session_meta"}' });
  assert.equal(flow.children.some((child) => child.tagName === "pre"), true);
});

test("session nav count includes own-only rows when the checkbox is on", () => {
  const els: Record<string, Node> = {
    "#nav-n-overview": new Node(),
    "#nav-n-skills": new Node(),
    "#nav-n-memory": new Node(),
    "#nav-n-sessions": new Node(),
    "#nav-n-vault": new Node(),
    "#nav-n-agents": new Node(),
    "#session-own": Object.assign(new Node("input"), { checked: true }),
  };
  const context = vm.createContext(i18nSandbox({
    snap: { sessions: { count: 2, all: 3 }, skills: [], memory: { projects: [] }, vault: { status: "ready", count: 1 }, agents: [], conflicts: [], broken: [], unadopted: [] },
    $: (sel: string) => els[sel] ?? new Node(),
  }));
  vm.runInContext(fn("fmtCount") + "\n" + fn("renderNav"), context);
  context.renderNav();
  assert.equal(els["#nav-n-sessions"]!.textContent, "3");
  els["#session-own"]!.checked = false;
  context.renderNav();
  assert.equal(els["#nav-n-sessions"]!.textContent, "2");
});

test("language switch replays keyed banners; disk-change does not clobber them", async () => {
  const bannerEl = new Node("p");
  bannerEl.hidden = true;
  const context = vm.createContext(i18nSandbox({
    $: (sel: string) => sel === "#banner" ? bannerEl : null,
    bannerState: null,
    LAYER_META: { vault: { labelKey: "layer.vault" } },
  }));
  vm.runInContext(
    await i18nPrelude() + "\n" +
    fn("paintBanner") + "\n" + fn("banner") + "\n" + fn("bannerParams") + "\n" + fn("notice") + "\n" + fn("refreshBanner") + "\n" + fn("keepDiskChangedQuiet"),
    context,
  );
  context.notice("banner.bound", { label: "Grok CLI", layer: "vault", value: "hub" });
  assert.equal(bannerEl.hidden, false);
  assert.match(bannerEl.textContent, /保险库/);
  assert.equal(context.keepDiskChangedQuiet(), true);
  vm.runInContext("setLang('en')", context);
  context.refreshBanner();
  assert.match(bannerEl.textContent, /Vault/);
  context.banner("");
  assert.equal(context.keepDiskChangedQuiet(), false);
});
