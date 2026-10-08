import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
function fn(name: string) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `missing ${name}`);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  className = "";
  type = "";
  textContent = "";
  value = "";
  hidden = false;
  style = {};
  listeners = new Map<string, (() => unknown)[]>();
  classList = {
    contains: (name: string) => this.className.split(" ").includes(name),
    toggle: (name: string, on: boolean) => {
      const names = new Set(this.className.split(" ").filter(Boolean));
      if (on) names.add(name); else names.delete(name);
      this.className = [...names].join(" ");
    },
  };
  constructor(readonly tagName: string, readonly document: Document) {}
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  contains(element: Element | null): boolean { return element === this || this.children.some(child => child.contains(element)); }
  replaceChildren(...children: Element[]) {
    if (this.document.activeElement !== this && this.contains(this.document.activeElement)) this.document.activeElement = this.document.body;
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...(selector.startsWith(".") && child.classList.contains(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  focus() { this.document.activeElement = this; }
  addEventListener(name: string, listener: () => unknown) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  async pressEnter() {
    assert.equal(this.document.activeElement, this);
    assert.equal(this.tagName, "button");
    assert.equal(this.type, "button");
    // Native focused buttons dispatch click for Enter; no bespoke key handler is needed.
    await Promise.all((this.listeners.get("click") ?? []).map(listener => listener()));
  }
}

class Document {
  body = new Element("body", this);
  activeElement = this.body;
  createElement(tag: string) { return new Element(tag, this); }
}

function fixture(request: (url: string) => Promise<unknown> = async () => ({ content: "delivered", exists: true, path: "/native" })) {
  const document = new Document();
  const elements = new Map<string, Element>();
  const get = (selector: string) => {
    if (!elements.has(selector)) {
      const node = document.createElement("div");
      document.body.append(node); elements.set(selector, node);
    }
    return elements.get(selector)!;
  };
  const agents = ["a", "b"].map(id => ({ id, label: id.toUpperCase(), userMdProjection: `/native/${id}`, bind: { ctx: "hub", memory: "hub" } }));
  const context = vm.createContext({
    document, $: get, t: (key: string) => key, api: request,
    snap: { agents, memory: { projects: [{ id: "project" }] } },
    ctxView: "user", ctxAgentSel: null, memView: "source", memAgentSel: null, selectedMemory: "global",
    memoryBusy: false, memoryDirty: false, memoryLoaded: false, memoryPending: false,
    memoryLoadEpoch: 0, memoryEditEpoch: 0,
    banner: (message: string) => assert.fail(message), notice() {},
    updateMemoryControls() {}, fillHandoffTargets() {}, renderMemoryConflict() {},
    apiErrorText: (value: string) => value, item: () => document.createElement("li"),
  });
  vm.runInContext([
    "setSourceCurrent", "replaceSourceRows", "showCtxView", "renderCtxAgentList", "openCtxAgent",
    "renderMemory", "showMemView", "renderMemoryAgentList", "openMemAgent", "openMemory", "applyMemoryFile",
  ].map(fn).join("\n"), context);
  const button = (list: string, id: string) => {
    const found = get(list).querySelectorAll(".source-item").find(node => node.dataset.id === id);
    assert.ok(found, `missing ${list}/${id}`);
    return found;
  };
  return { context, document, get, button, agents };
}

test("keyboard selection preserves context source focus and exposes the sole current source", async () => {
  const f = fixture();
  f.context.renderCtxAgentList();
  assert.equal(f.get("#ctx-src-user").getAttribute("aria-current"), "true");
  const original = f.button("#ctx-agent-list", "b");
  original.focus();
  await original.pressEnter();
  const selected = f.button("#ctx-agent-list", "b");
  assert.notEqual(selected, original);
  assert.equal(f.document.activeElement, selected);
  assert.equal(selected.getAttribute("aria-current"), "true");
  assert.equal(f.button("#ctx-agent-list", "a").getAttribute("aria-current"), null);
  assert.equal(f.get("#ctx-src-user").getAttribute("aria-current"), null);
  f.context.showCtxView("project");
  assert.equal(selected.getAttribute("aria-current"), null);
  assert.equal(f.get("#ctx-src-project").getAttribute("aria-current"), "true");
});

test("memory source and delivered view keep keyboard focus and clear the other group's current state", async () => {
  const f = fixture(async url => ({ content: url, exists: true, path: "/source", revision: "1" }));
  f.context.renderMemory();
  f.button("#memory-list", "project").focus();
  await f.button("#memory-list", "project").pressEnter();
  assert.equal(f.document.activeElement, f.button("#memory-list", "project"));
  assert.equal(f.button("#memory-list", "project").getAttribute("aria-current"), "true");
  assert.equal(f.button("#memory-list", "global").getAttribute("aria-current"), null);
  f.button("#memory-agent-list", "a").focus();
  await f.button("#memory-agent-list", "a").pressEnter();
  assert.equal(f.document.activeElement, f.button("#memory-agent-list", "a"));
  assert.equal(f.button("#memory-agent-list", "a").getAttribute("aria-current"), "true");
  assert.equal(f.button("#memory-list", "project").getAttribute("aria-current"), null);
});

test("a delayed memory load does not steal focus after the user moves into the editor", async () => {
  let resolve!: (value: unknown) => void;
  const f = fixture(() => new Promise(yes => { resolve = yes; }));
  f.context.renderMemory();
  const project = f.button("#memory-list", "project");
  project.focus();
  const loading = project.pressEnter();
  const editor = f.get("#memory-editor");
  editor.focus();
  resolve({ content: "loaded", revision: "1", path: "/source" });
  await loading;
  assert.equal(f.document.activeElement, editor);
  assert.equal(f.button("#memory-list", "project").getAttribute("aria-current"), "true");
});

test("background list refresh preserves the focused item rather than jumping to the current source", () => {
  const f = fixture();
  f.context.renderMemory();
  f.context.renderCtxAgentList();
  f.button("#memory-list", "project").focus();
  f.context.renderMemory();
  assert.equal(f.document.activeElement, f.button("#memory-list", "project"));
  assert.equal(f.button("#memory-list", "global").getAttribute("aria-current"), "true");
  const editor = f.get("#user-editor");
  editor.focus();
  f.context.renderMemory();
  f.context.renderCtxAgentList();
  assert.equal(f.document.activeElement, editor);
});

test("memory titles translate when rerendered and project names remain unchanged", () => {
  const f = fixture();
  f.context.t = (key: string) => key === "knowledge.globalMemory" ? "全局记忆" : key;
  f.context.renderMemory();
  assert.equal(f.get("#memory-title").textContent, "全局记忆");
  f.context.t = (key: string) => key === "knowledge.globalMemory" ? "Global memory" : key;
  f.context.renderMemory();
  assert.equal(f.get("#memory-title").textContent, "Global memory");
  f.context.selectedMemory = "project";
  f.context.renderMemory();
  assert.equal(f.get("#memory-title").textContent, "project");
});
