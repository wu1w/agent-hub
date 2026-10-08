import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

type UiEvent = {
  target: ElementStub; key?: string; isComposing?: boolean; clientX?: number; clientY?: number;
  defaultPrevented: boolean; preventDefault: () => void;
};
type Item = { id: string; label: string; detail?: string; group?: string; keywords?: string | string[] };
type Switcher = { open: () => Promise<void> };

class ElementStub {
  children: ElementStub[] = [];
  parent: ElementStub | null = null;
  className = "";
  id = "";
  value = "";
  hidden = false;
  open = false;
  type = "";
  tabIndex = 0;
  placeholder = "";
  scrollTop = 0;
  private ownText = "";
  private listeners = new Map<string, ((event: UiEvent) => void)[]>();
  private attributes = new Map<string, string>();
  classList = {
    toggle: (name: string, enabled: boolean) => {
      const names = new Set(this.className.split(" ").filter(Boolean));
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(" ");
    },
  };
  constructor(readonly tagName: string, private readonly document: DocumentStub) {}
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(text: string) { this.ownText = text; this.replaceChildren(); }
  get isConnected(): boolean { return this === this.document.body || Boolean(this.parent?.isConnected); }
  append(...elements: ElementStub[]) { for (const element of elements) { element.parent = this; this.children.push(element); } }
  replaceChildren(...elements: ElementStub[]) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...elements);
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(type: string, listener: (event: UiEvent) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  emit(type: string, options: Partial<UiEvent> = {}, bubbles = true): UiEvent {
    const event: UiEvent = {
      target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options,
    };
    this.dispatch(type, event, bubbles);
    return event;
  }
  private dispatch(type: string, event: UiEvent, bubbles: boolean) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    if (bubbles) this.parent?.dispatch(type, event, true);
  }
  focus() { this.document.activeElement = this; }
  showModal() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    queueMicrotask(() => this.emit("close", {}, false));
  }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 100, right: 700, top: 100, bottom: 600 }; }
  all(className: string): ElementStub[] {
    return [this, ...this.children.flatMap(child => child.all(className))]
      .filter(element => element.className.split(" ").includes(className));
  }
}

class DocumentStub {
  body = new ElementStub("BODY", this);
  activeElement: ElementStub = this.body;
  createElement(tagName: string) { return new ElementStub(tagName.toUpperCase(), this); }
}

const source = (await fs.readFile(new URL("../../web/quick-switcher.js", import.meta.url), "utf8")).replace(/^export /gm, "");
async function fixture(items: Item[], onSelect: (item: Item) => void | Promise<void> = () => {}) {
  const document = new DocumentStub();
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  let currentItems = items;
  let language = "en";
  let reads = 0;
  const context = vm.createContext({ document });
  vm.runInContext(source + ";globalThis.create = createQuickSwitcher; globalThis.strings = QS_STRINGS;", context);
  const strings = context.strings as Record<string, Record<string, string>>;
  const switcher = context.create({
    getItems: () => { reads++; return currentItems; }, onSelect,
    t: (key: string, vars: Record<string, unknown> = {}) => strings[language]![key]!.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name])),
  }) as Switcher;
  const node = (name: string) => {
    const found = document.body.all(name)[0];
    assert.ok(found, `missing ${name}`);
    return found;
  };
  return {
    document, trigger, switcher, node,
    items: (next: Item[]) => { currentItems = next; },
    language: (next: string) => { language = next; },
    reads: () => reads,
    type: (text: string) => { node("qs-input").value = text; node("qs-input").emit("input"); },
  };
}

test("quick navigation finds words across labels, canonical IDs, details and keywords without parsing HTML", async () => {
  const item = { id: "codex:i18n", label: "<img src=x onerror=alert(1)>", detail: "UI conventions", group: "Skills", keywords: ["multilingual", "CLI"] };
  const f = await fixture([item, { id: "memory", label: "Memory", group: "Pages" }]);
  const done = f.switcher.open();
  assert.equal(f.node("qs-dialog").open, true);
  assert.equal(f.document.activeElement, f.node("qs-input"));
  assert.equal(f.node("qs-input").getAttribute("aria-labelledby"), f.node("qs-title").id);
  f.type("  ＣＬＩ Codex ui ");
  assert.equal(f.document.body.all("qs-result").length, 1);
  assert.equal(f.node("qs-result").tagName, "BUTTON");
  assert.equal(f.node("qs-result-label").textContent, item.label);
  assert.equal(f.node("qs-result-label").children.length, 0);
  assert.equal(f.node("qs-result").getAttribute("aria-selected"), "true");
  assert.equal(f.reads(), 1);
  f.node("qs-close").emit("click");
  await done;
});

test("search limits the displayed results while still finding items beyond the first fifty", async () => {
  const f = await fixture(Array.from({ length: 90 }, (_, n) => ({ id: `agent-${n}`, label: `Agent ${n}` })));
  const done = f.switcher.open();
  assert.equal(f.document.body.all("qs-result").length, 50);
  assert.equal(f.node("qs-count").textContent, "Showing 50");
  f.node("qs-results").scrollTop = 400;
  f.type("agent-89");
  assert.equal(f.document.body.all("qs-result").length, 1);
  assert.equal(f.node("qs-result-label").textContent, "Agent 89");
  assert.equal(f.node("qs-results").scrollTop, 0);
  assert.equal(f.node("qs-count").getAttribute("aria-live"), "polite");
  f.node("qs-close").emit("click");
  await done;
});

test("arrow keys wrap selection, IME Enter is ignored, and async navigation runs after modal dismissal and focus restoration", async () => {
  let finishSelection!: () => void;
  const selected: string[] = [];
  const f = await fixture([{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], async item => {
    assert.equal(f.node("qs-dialog").open, false);
    assert.equal(f.document.activeElement, f.trigger);
    selected.push(item.id);
    await new Promise<void>(resolve => { finishSelection = resolve; });
  });
  const done = f.switcher.open();
  const input = f.node("qs-input");
  assert.equal(input.emit("keydown", { key: "ArrowUp" }).defaultPrevented, true);
  assert.equal(f.document.body.all("qs-active")[0]?.textContent, "Beta");
  input.emit("keydown", { key: "ArrowDown" });
  assert.equal(f.document.body.all("qs-active")[0]?.textContent, "Alpha");
  input.emit("keydown", { key: "ArrowDown" });
  input.emit("keydown", { key: "Enter", isComposing: true });
  assert.equal(f.node("qs-dialog").open, true);
  assert.deepEqual(selected, []);
  input.emit("keydown", { key: "Enter" });
  await Promise.resolve();
  assert.deepEqual(selected, ["b"]);
  let settled = false;
  void done.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  finishSelection();
  await done;
  assert.equal(input.getAttribute("aria-expanded"), "false");
});

test("Escape returns focus and reopening refreshes items and language without adding duplicate listeners", async () => {
  const selected: string[] = [];
  const f = await fixture([{ id: "old", label: "Old" }], item => { selected.push(item.id); });
  const first = f.switcher.open();
  assert.equal(f.switcher.open(), first);
  assert.equal(f.reads(), 1);
  const cancel = f.node("qs-dialog").emit("cancel");
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(f.document.activeElement, f.trigger);
  f.items([{ id: "new", label: "New" }]);
  f.language("zh");
  const next = f.switcher.open();
  await first;
  assert.equal(f.node("qs-dialog").open, true, "a queued prior close must not dismiss the new modal");
  assert.equal(f.node("qs-title").textContent, "快速跳转");
  assert.equal(f.node("qs-input").placeholder, "搜索页面、技能或 Agent");
  f.node("qs-result-label").emit("click");
  await next;
  assert.deepEqual(selected, ["new"]);
  assert.equal(f.document.body.all("qs-dialog").length, 1);
});

test("empty queries display the empty state and Enter does not select a stale result", async () => {
  let selected = false;
  const f = await fixture([{ id: "skill", label: "Skill" }], () => { selected = true; });
  const done = f.switcher.open();
  f.type("missing");
  assert.equal(f.node("qs-empty").hidden, false);
  assert.equal(f.node("qs-results").hidden, true);
  assert.equal(f.node("qs-input").getAttribute("aria-activedescendant"), null);
  f.node("qs-input").emit("keydown", { key: "Enter" });
  assert.equal(selected, false);
  assert.equal(f.node("qs-dialog").open, true);
  f.node("qs-dialog").emit("click", { clientX: 30, clientY: 30 });
  await done;
  assert.equal(f.document.activeElement, f.trigger);
});

test("selection failures reject the open promise after closing so the owner can display its error UI", async () => {
  const error = new Error("selection failed");
  const f = await fixture([{ id: "bad", label: "Bad" }], async () => { throw error; });
  const done = f.switcher.open();
  f.node("qs-result").emit("click");
  await assert.rejects(done, value => value === error);
  assert.equal(f.node("qs-dialog").open, false);
  assert.equal(f.document.activeElement, f.trigger);
});
