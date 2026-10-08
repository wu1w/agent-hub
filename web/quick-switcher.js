export const QS_STRINGS = {
  zh: {
    "search.title": "快速跳转",
    "search.placeholder": "搜索页面、技能或 Agent",
    "search.empty": "没有找到匹配项，请换个关键词。",
    "search.hint": "↑ ↓ 选择 · Enter 打开 · Esc 关闭",
    "search.close": "关闭搜索",
    "search.resultCount": "显示 {n} 项",
  },
  en: {
    "search.title": "Quick navigation",
    "search.placeholder": "Search pages, skills, or agents",
    "search.empty": "No matches. Try another keyword.",
    "search.hint": "↑ ↓ Select · Enter Open · Esc Close",
    "search.close": "Close search",
    "search.resultCount": "Showing {n}",
  },
};

let instance = 0;
const normalize = (text) => String(text ?? "").normalize("NFKC").toLocaleLowerCase();

/**
 * @typedef {{id:string, label:string, detail?:string, group?:string, keywords?:string|string[]}} SearchItem
 */

/**
 * Build one reusable native modal. Items and translated labels refresh on open.
 * `open()` resolves on dismissal or completed selection; selection errors reject
 * it so the caller can use its existing error UI. No requests or global key handlers.
 * @param {{getItems:()=>SearchItem[], onSelect:(item:SearchItem)=>void|Promise<void>, t:(key:string, vars?:Record<string, string|number>)=>string}} options
 */
export function createQuickSwitcher({ getItems, onSelect, t }) {
  const prefix = `qs-${++instance}`;
  let dialog, input, title, closeButton, results, empty, count, hint;
  let opener = null;
  let entries = [];
  let visible = [];
  let buttons = [];
  let active = -1;
  let pending = null;

  function restoreFocus() {
    const target = opener;
    opener = null;
    if (target?.isConnected && typeof target.focus === "function") target.focus();
  }

  function finish(item) {
    if (!pending) return;
    const completion = pending;
    pending = null;
    input.setAttribute("aria-expanded", "false");
    if (dialog.open) dialog.close();
    restoreFocus();
    if (item) Promise.resolve().then(() => onSelect(item)).then(completion.resolve, completion.reject);
    else completion.resolve();
  }

  function select(index, scroll = false) {
    active = index;
    buttons.forEach((button, i) => {
      button.classList.toggle("qs-active", i === active);
      button.setAttribute("aria-selected", String(i === active));
    });
    if (active < 0) input.removeAttribute("aria-activedescendant");
    else {
      input.setAttribute("aria-activedescendant", buttons[active].id);
      if (scroll) buttons[active].scrollIntoView({ block: "nearest" });
    }
  }

  function render() {
    const words = normalize(input.value).trim().split(/\s+/).filter(Boolean);
    visible = [];
    for (const entry of entries) {
      if (words.every(word => entry.search.includes(word))) visible.push(entry.item);
      if (visible.length === 50) break;
    }
    buttons = visible.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "qs-result";
      button.id = `${prefix}-result-${index}`;
      button.tabIndex = -1;
      button.setAttribute("role", "option");
      const content = document.createElement("span");
      content.className = "qs-result-content";
      const label = document.createElement("span");
      label.className = "qs-result-label";
      label.textContent = item.label;
      content.append(label);
      if (item.detail) {
        const detail = document.createElement("span");
        detail.className = "qs-result-detail";
        detail.textContent = item.detail;
        content.append(detail);
      }
      button.append(content);
      if (item.group) {
        const group = document.createElement("span");
        group.className = "qs-result-group";
        group.textContent = item.group;
        button.append(group);
      }
      button.addEventListener("click", () => finish(item));
      return button;
    });
    results.replaceChildren(...buttons);
    results.scrollTop = 0;
    empty.hidden = visible.length !== 0;
    results.hidden = visible.length === 0;
    count.textContent = t("search.resultCount", { n: visible.length });
    select(visible.length ? 0 : -1);
  }

  function build() {
    dialog = document.createElement("dialog");
    dialog.className = "qs-dialog";
    dialog.setAttribute("aria-labelledby", `${prefix}-title`);
    dialog.setAttribute("aria-describedby", `${prefix}-hint`);
    const header = document.createElement("div");
    header.className = "qs-header";
    title = document.createElement("h2");
    title.className = "qs-title";
    title.id = `${prefix}-title`;
    closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "qs-close";
    closeButton.addEventListener("click", () => finish());
    header.append(title, closeButton);
    input = document.createElement("input");
    input.className = "qs-input";
    input.type = "search";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-labelledby", title.id);
    input.setAttribute("aria-controls", `${prefix}-results`);
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-haspopup", "listbox");
    input.addEventListener("input", render);
    results = document.createElement("div");
    results.className = "qs-results";
    results.id = `${prefix}-results`;
    results.setAttribute("role", "listbox");
    results.setAttribute("aria-labelledby", `${prefix}-count`);
    empty = document.createElement("p");
    empty.className = "qs-empty";
    const footer = document.createElement("div");
    footer.className = "qs-footer";
    hint = document.createElement("span");
    hint.className = "qs-hint";
    hint.id = `${prefix}-hint`;
    count = document.createElement("span");
    count.className = "qs-count";
    count.id = `${prefix}-count`;
    count.setAttribute("role", "status");
    count.setAttribute("aria-live", "polite");
    count.setAttribute("aria-atomic", "true");
    footer.append(hint, count);
    dialog.append(header, input, results, empty, footer);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish();
    });
    dialog.addEventListener("close", () => {
      // A queued close event from the previous opening must not dismiss a new one.
      if (!dialog.open) finish();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) finish();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.isComposing || event.target !== input || !visible.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        select((active + step + visible.length) % visible.length, true);
      } else if (event.key === "Enter") {
        event.preventDefault();
        finish(visible[active]);
      }
    });
    document.body.append(dialog);
  }

  function open() {
    if (pending) { input.focus(); return pending.promise; }
    if (!dialog) build();
    try {
      entries = getItems().map(item => ({
        item,
        search: normalize([item.id, item.label, item.detail, item.group,
          Array.isArray(item.keywords) ? item.keywords.join(" ") : item.keywords].filter(Boolean).join(" ")),
      }));
      title.textContent = t("search.title");
      input.placeholder = t("search.placeholder");
      closeButton.textContent = t("search.close");
      empty.textContent = t("search.empty");
      hint.textContent = t("search.hint");
      input.value = "";
      render();
      opener = document.activeElement;
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      pending = { promise, resolve, reject };
      dialog.showModal();
      input.setAttribute("aria-expanded", "true");
      input.focus();
      return promise;
    } catch (error) {
      pending = null;
      restoreFocus();
      return Promise.reject(error);
    }
  }

  return { open };
}
