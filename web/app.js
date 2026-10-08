import { createQuickSwitcher } from "./quick-switcher.js";
import { mergeVaultDraft } from "./vault-draft.js";
import { t, setLang, getLang, detectLang, applyDom, apiErrorText } from "./i18n.js";
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let snap = null;
let selectedSkill = null;
let skillDirty = false;
// undefined keeps the loaded file's targets; null explicitly inherits defaults.
let skillTargetsDraft;
let skillRevision;
let skillBusy = false;
let skillPending = false;
let skillLoadEpoch = 0;
let skillEditEpoch = 0;
let skillFilter = "";
let skillQuery = "";
let loadedAgentsCwd = null;
let agentsRevision;
const agentDrafts = new Map();
const agentIdentityReaders = new WeakMap();
const selectedSubagents = new Map();
let userDirty = false;
let userRevision;
let userLoaded = false;
let userPending = false;
let userLoadEpoch = 0;
let memoryDirty = false;
let memoryRevision;
let memoryLoaded = false;
let memoryLoadEpoch = 0;
let memoryEditEpoch = 0;
let memoryBusy = false;
let memoryPending = false;
let memoryConflict = null;
let userBusy = false;
let vaultLoaded = false;
let vaultQuery = "";
let selectedMemory = "global";
let sessionState = { sessions: [], handoffs: [], selected: null };
let sessionLoadEpoch = 0;
let sessionTab = "content";
let sessContentKey = "";
let ctxView = "user";
let ctxAgentSel = null;
let memView = "source";
let memAgentSel = null;
let vaultBusy = false;
let vaultRevealEpoch = 0;
let vaultLoadEpoch = 0;
let vaultState = { markdown: "", masked: "", entries: [], reveal: false, dirty: false };
let currentPage = "overview";
let langLoadEpoch = 0;
let bannerState = null;
let quickSwitcher;
let lastProjectCwd = "";
let projectLoadEpoch = 0;
let projectFileBusy = false;

const LAYER_META = {
  skills: { label: "Skills", labelKey: "layer.skills", options: [["hub", "opt.hub"], ["own", "opt.own"]] },
  ctx: { label: "Ctx", labelKey: "layer.ctx", options: [["hub", "opt.hub"], ["own", "opt.own"]] },
  memory: { label: "Memory", labelKey: "layer.memory", options: [["hub", "opt.hub"], ["own", "opt.own"]] },
  sessions: { label: "Sessions", labelKey: "layer.sessions", options: [["index", "opt.index"], ["own", "opt.own"]] },
  vault: { label: "Vault", labelKey: "layer.vault", options: [["off", "opt.off"], ["own", "opt.own"], ["hub", "opt.hub"]] },
};
function pillTxt(v) {
  return t(`pill.${v}`);
}
const PAGES = ["overview", "skills", "ctx", "memory", "sessions", "vault", "matrix", "agents"];

function allowsCtxHub(agent) {
  const targets = snap?.config?.layers?.ctx?.global_targets ?? [];
  return Boolean(agent?.userMdProjection) && targets.includes(agent.id);
}

function ctxHubBlockReason(agent) {
  return agent?.userMdProjection ? t("ctx.notInAllowlist") : t("ctx.noUserMd");
}

// One disabled reason per (agent, layer, value), mirroring the old <option disabled> rules.
function layerOptionBlock(agent, layer, value) {
  if (agent.memoryOnly && layer !== "memory") return t("block.memoryOnly");
  if (layer === "vault" && agent.supportsVault === false) return t("block.noVault");
  if (layer === "sessions" && !agent.supportsSessions) return t("block.noScanner");
  if ((layer === "memory" || layer === "ctx" || layer === "vault") && value === "hub" && !agent.present) return t("block.notInstalled");
  if (layer === "ctx" && value === "hub" && !allowsCtxHub(agent)) return ctxHubBlockReason(agent);
  return null;
}

async function applyLanguage(lang) {
  setLang(lang);
  applyDom(document);
  $$(".lang-btn").forEach((btn) => btn.classList.toggle("on", btn.dataset.lang === getLang()));
  const epoch = ++langLoadEpoch;
  if (snap) {
    try {
      const next = await api("/api/snapshot");
      if (epoch === langLoadEpoch && next && Array.isArray(next.agents)) snap = next;
    } catch {
      /* keep last snapshot; chrome strings already switched */
    }
  }
  if (epoch !== langLoadEpoch) return;
  if (snap) renderAll();
  if (!selectedSkill) {
    const meta = $("#skill-meta");
    if (meta) meta.textContent = t("skills.pick");
  }
  if (!sessionState.selected) {
    const sess = $("#session-meta");
    if (sess) sess.textContent = sessionState.unavailable ? t("sessions.unavailable") : t("sessions.meta");
  }
  const saved = $("#skill-saved");
  if (saved && selectedSkill) saved.textContent = skillDirty ? t("skills.dirty") : t("skills.clean");
  if (currentPage === "sessions") renderSessions();
  if (currentPage === "vault") {
    const revealBtn = $("#btn-vault-reveal");
    if (revealBtn) revealBtn.textContent = vaultState.reveal ? t("vault.hide") : t("vault.show");
    renderVaultEntries();
  }
  refreshBanner();
}

function paintBanner(text) {
  const el = $("#banner");
  if (!el) return;
  const dismiss = $("#dismiss-banner");
  if (dismiss) dismiss.hidden = !text;
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

function banner(text) {
  bannerState = text ? { text: String(text) } : null;
  paintBanner(text);
}

function bannerParams(key, params) {
  if ((key !== "banner.bound" && key !== "banner.binding") || !params) return params;
  const layerKey = LAYER_META[params.layer]?.labelKey ?? `layer.${params.layer}`;
  return { label: params.label, layer: t(layerKey), value: t(`pill.${params.value}`) };
}

function notice(key, params) {
  const text = t(key, bannerParams(key, params));
  banner(text);
  bannerState = { key, params };
}

function refreshBanner() {
  const el = $("#banner");
  if (!el || el.hidden || !bannerState?.key) return;
  el.textContent = t(bannerState.key, bannerParams(bannerState.key, bannerState.params));
}

function keepDiskChangedQuiet() {
  const el = $("#banner");
  return Boolean(el && !el.hidden && bannerState && bannerState.key !== "banner.diskChanged");
}

function bootToken() {
  return sessionStorage.getItem("hub_token") || "";
}

async function api(path, opts = {}) {
  const token = bootToken();
  const res = await fetch(path, {
    credentials: "same-origin",
    ...opts,
    headers: {
      "content-type": "application/json",
      "accept-language": getLang() === "en" ? "en" : "zh-CN",
      ...(token ? { "x-hub-token": token } : {}),
      ...(opts.headers ?? {}),
    },
  });
  let data = {};
  if (typeof res.text === "function") {
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); }
      catch {
        const message = apiErrorText(t("err.badJson"));
        banner(message);
        const error = new Error(message);
        error.status = res.status;
        throw error;
      }
    }
  } else {
    data = await res.json();
  }
  if (res.status === 401) {
    notice("err.session");
    if (!location.pathname.endsWith("/login.html")) location.replace("/login.html");
  }
  if (res.status === 503 && /^\/api\/(?:index|handoff|reveal)(?:[/?]|$)/.test(path)) clearSessionView();
  if (!res.ok) {
    const message = apiErrorText(data.error ?? res.statusText);
    banner(message);
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return data;
}

function openQuickSearch() {
  quickSwitcher ??= createQuickSwitcher({
    t,
    getItems: () => [
      ...["overview", "skills", "memory", "ctx", "sessions", "agents", "matrix", "vault"].map(page => ({ id: `page:${page}`, label: t(page === "memory" ? "knowledge.memory" : page === "ctx" ? "knowledge.ctx" : page === "matrix" ? "agents.tableView" : `nav.${page}`), group: t("search.pageGroup"), keywords: page })),
      ...(snap?.skills || []).map(skill => ({ id: `skill:${skill.name}`, label: skill.name, detail: t("search.skillDetail"), group: t("search.skillGroup") })),
      ...(snap?.agents || []).map(agent => ({ id: `agent:${agent.id}`, label: agent.label, detail: agent.id, group: t("search.agentGroup") })),
    ],
    onSelect: async item => {
      const colon = item.id.indexOf(":"); const kind = item.id.slice(0, colon), value = item.id.slice(colon + 1);
      if (kind === "page") go(value);
      else if (kind === "skill") {
        skillFilter = ""; skillQuery = ""; $("#skill-q").value = "";
        go("skills"); await openSkill(value); $("#skill-editor").focus();
      } else if (kind === "agent") focusAgent(value);
    },
  });
  return quickSwitcher.open();
}

function focusAgent(id) {
  $("#agent-filter").value = id;
  const agent = snap?.agents.find(row => row.id === id);
  if (agent && !agent.present) $("#agent-installed").checked = false;
  go("agents");
  filterAgentCards();
  const card = $$("#agent-cards .card").find(row => row.dataset.agent === id);
  if (card) {
    card.tabIndex = -1; card.focus({ preventScroll: true }); card.scrollIntoView({ block: "nearest" });
  }
}

function rememberProject(cwd) {
  lastProjectCwd = cwd;
  for (const id of ["#project-cwd", "#agents-cwd"]) if (!$(id).value.trim()) $(id).value = cwd;
}

/* ================= routing ================= */

function go(page, { replace = false, loadSource = true } = {}) {
  if (!PAGES.includes(page)) page = "overview";
  const changed = currentPage !== page;
  currentPage = page;
  const parent = page === "ctx" ? "memory" : page === "matrix" ? "agents" : page;
  $$(".navb").forEach((x) => {
    const active = x.dataset.page === parent;
    x.classList.toggle("on", active);
    if (active) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current");
  });
  PAGES.forEach((p) => $("#page-" + p).classList.toggle("hidden", p !== page));
  $("#knowledge-head")?.classList.toggle("hidden", !["memory", "ctx"].includes(page));
  $("#agent-head")?.classList.toggle("hidden", !["agents", "matrix"].includes(page));
  $$(".workspace-tabs [data-route]").forEach((link) => {
    link.classList.toggle("on", link.dataset.route === page);
    if (link.dataset.route === page) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  if (location.hash !== "#/" + page) history[replace ? "replaceState" : "pushState"](null, "", "#/" + page);
  if (changed) window.scrollTo?.({ top: 0 });
  if (snap) renderAll();
  if (page === "ctx" && snap) loadUserMd().catch((err) => banner(String(err.message ?? err)));
  if (page === "memory" && snap && !memoryLoaded && memView === "source" && loadSource) openMemory(selectedMemory).catch((err) => banner(String(err.message ?? err)));
  if (page === "sessions") loadSessions().catch((err) => banner(String(err.message ?? err)));
  if (page === "vault" && !vaultLoaded) loadVault().catch((err) => banner(String(err.message ?? err)));
  renderAgentDraftStatus();
}

async function refresh({ fresh = false } = {}) {
  snap = await api(fresh ? "/api/snapshot?fresh=1" : "/api/snapshot");
  $("#hub-root").textContent = snap.hubRoot;
  renderAll();
  if (fresh && currentPage === "agents") await refreshOpenAgentEditors();
  if (currentPage === "ctx") await loadUserMd().catch((err) => banner(String(err.message ?? err)));
  if (currentPage === "memory" && !memoryLoaded && memView === "source") await openMemory(selectedMemory).catch((err) => banner(String(err.message ?? err)));
  if (currentPage === "vault") await loadVault().catch((err) => banner(String(err.message ?? err)));
}

function renderAll() {
  if (!snap) return;
  renderNav();
  renderSnapshotWarnings();
  fillHandoffTargets();
  const render = { overview: renderOverview, skills: renderSkills, ctx: renderCtx, memory: renderMemory, agents: renderAgents, matrix: renderMatrix }[currentPage];
  if (render) render();
  if (currentPage === "skills") renderSkillTargets();
}

function renderAssets() {
  renderAll();
}

function fmtCount(n) {
  return new Intl.NumberFormat(getLang() === "en" ? "en-US" : "zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(n ?? 0));
}

function renderNav() {
  const pending = (snap.conflicts?.length ?? 0) + (snap.broken?.length ?? 0);
  const badge = $("#nav-n-overview");
  badge.textContent = pending ? fmtCount(pending) : "";
  badge.classList.toggle("warn", pending > 0);
  $("#nav-n-skills").textContent = fmtCount(snap.skills?.length);
  $("#nav-n-memory").textContent = fmtCount(1 + (snap.memory?.projects?.length ?? 0));
  const ownOn = $("#session-own")?.checked;
  const sessionCount = ownOn && snap.sessions?.all != null ? snap.sessions.all : snap.sessions?.count;
  $("#nav-n-sessions").textContent = fmtCount(sessionCount);
  $("#nav-n-vault").textContent = snap.vault?.status === "unavailable" ? "!" : fmtCount(snap.vault?.count);
  $("#nav-n-agents").textContent = fmtCount(snap.agents?.filter(a => a.present).length);
}

function renderOverview() {
  const c = snap.conflicts.length, b = snap.broken.length, u = snap.unadopted.length;
  $("#ov-sub").textContent = t("overview.intro");
  const todos = [
    { n: c, card: "#ov-card-conflicts", v: "#ov-n-conflicts", p: "#ov-p-conflicts", act: "#ov-act-conflicts", text: t("overview.conflictsTodo", { n: c }) },
    { n: b, card: "#ov-card-broken", v: "#ov-n-broken", p: "#ov-p-broken", act: "#ov-act-broken", text: t("overview.brokenTodo", { n: b }) },
    { n: u, card: "#ov-card-unadopted", v: "#ov-n-unadopted", p: "#ov-p-unadopted", act: "#ov-act-unadopted", text: t("overview.unadoptedTodo", { n: u }) },
  ];
  for (const row of todos) {
    $(row.v).textContent = fmtCount(row.n);
    $(row.p).textContent = row.text;
    $(row.act).disabled = !row.n;
    $(row.card).hidden = !row.n;
  }
  $("#ov-stat-skills").textContent = fmtCount(snap.skills.length);
  $("#ov-stat-skills-s").textContent = t("overview.vendorCount", { n: snap.vendorSkills.length });
  $("#ov-stat-agents").textContent = fmtCount(snap.agents.filter(a => a.present).length);
  $("#ov-stat-agents-s").textContent = t("overview.adapterCount", { n: snap.catalog?.length ?? snap.agents.length });
  $("#ov-stat-sessions").textContent = fmtCount(snap.sessions.count);
  $("#ov-stat-vault").textContent = snap.vault.status === "unavailable" ? "—" : fmtCount(snap.vault.count);
  $("#ov-stat-vault-s").textContent = snap.vault.status === "unavailable" ? t("overview.statVaultFail") : t("overview.statVaultHint");
  const bars = $("#ov-bars");
  bars.replaceChildren();
  for (const [layer, meta] of Object.entries(LAYER_META)) {
    const eligible = snap.agents.filter(a => a.present && !(a.memoryOnly && layer !== "memory") && !(layer === "sessions" && !a.supportsSessions) && !(layer === "vault" && a.supportsVault === false) && !(layer === "ctx" && !allowsCtxHub(a)));
    const on = eligible.filter(a => a.bind[layer] === "hub" || (layer === "sessions" && a.bind.sessions === "index")).length;
    const row = document.createElement("a");
    row.href = "#/matrix";
    row.className = "bar-row";
    row.innerHTML = `<span>${esc(t(meta.labelKey))}</span><div class="bar-track"><div class="bar-fill" style="width:${eligible.length ? Math.round(on / eligible.length * 100) : 0}%"></div></div><span class="n">${fmtCount(on)} / ${fmtCount(eligible.length)}</span>`;
    row.addEventListener("click", event => { event.preventDefault(); go("matrix"); });
    bars.append(row);
  }
  renderSyncStatus();
  renderOverviewWarnings();
}

function renderOverviewWarnings() {
  const warnings = snapshotWarnings();
  const panel = $("#ov-warnings-panel");
  panel.hidden = warnings.length === 0;
  const list = $("#ov-warnings-list");
  list.replaceChildren(...warnings.map((message) => item(apiErrorText(message))));
  const count = warnings.length + (snap.conflicts?.length || 0) + (snap.broken?.length || 0);
  $("#ov-no-issues").hidden = count > 0;
  $("#ov-attention-count").textContent = count ? t("overview.issueCount", { n: count }) : "";
}

async function startOnboarding() {
  const data = await api("/api/snapshot");
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<h2>${t("onboard.title")}</h2><p>${t("onboard.body")}</p><form method="dialog"><div class="onboard-skills"></div><p class="onboard-status" role="status"></p><menu><button value="cancel" class="btn">${t("onboard.later")}</button><button type="button" class="btn pri onboard-apply">${t("onboard.apply")}</button></menu></form>`;
  const list = dialog.querySelector(".onboard-skills");
  const eligible = new Set(data.agents.filter(a => !a.memoryOnly && a.bind.skills === "hub").map(a => a.id));
  const names = [...new Set(data.unadopted.filter(r => eligible.has(r.agent)).map(r => r.name))];
  for (const name of names) {
    const label = document.createElement("label");
    const box = document.createElement("input"); box.type = "checkbox"; box.checked = true; box.value = name;
    label.append(box, name); list.append(label);
  }
  for (const row of data.vendorSkills) {
    const label = document.createElement("label");
    const box = document.createElement("input"); box.type = "checkbox"; box.disabled = true;
    label.append(box, t("onboard.vendor", { name: row.name, agent: row.agent })); list.append(label);
  }
  for (const row of data.unadopted.filter(r => !eligible.has(r.agent))) list.append(item(t("onboard.ownKeep", { name: row.name, agent: row.agent })));
  if (!names.length) list.prepend(item(t("onboard.empty")));
  dialog.querySelector(".onboard-apply").addEventListener("click", async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try {
      const selected = [...list.querySelectorAll("input:checked")].map(box => box.value);
      const report = selected.length ? await api("/api/adopt", { method: "POST", body: JSON.stringify({mode: "adopt", names: selected}) }) : { conflicts: [] };
      if (report.conflicts.length) { dialog.querySelector(".onboard-status").textContent = t("onboard.conflict"); return; }
      localStorage.setItem(`hub-onboard:${data.hubRoot}`, "done");
      dialog.close(); await refresh(); notice("onboard.done");
    } catch (error) { dialog.querySelector(".onboard-status").textContent = error.message; }
    finally { button.disabled = false; }
  });
  dialog.addEventListener("close", () => { localStorage.setItem(`hub-onboard:${data.hubRoot}`, "seen"); dialog.remove(); }, {once: true});
  document.body.append(dialog); dialog.showModal();
}

/* ================= skills ================= */

function skillState(name) {
  if (snap.conflicts.some((row) => row.name === name)) return "r";
  if (snap.broken.some((row) => row.name === name)) return "y";
  return "";
}

function renderSkillChips() {
  const defs = [
    ["", t("skills.chipAll"), snap.skills.length + snap.vendorSkills.length, ""],
    ["conflict", t("skills.chipConflict"), snap.conflicts.length, "bad "],
    ["broken", t("skills.chipBroken"), snap.broken.length, "warn "],
    ["unadopted", t("skills.chipUnadopted"), snap.unadopted.length, ""],
  ];
  $("#skill-chips").innerHTML = defs
    .map(([f, label, n, cls]) => `<button type="button" class="chip ${cls}${skillFilter === f ? "on" : ""}" data-f="${f}">${label}<span class="c">${n}</span></button>`)
    .join("");
}

function skillRowEl({ name, src, time, state, readonly, title, mounts, onClick }) {
  const row = document.createElement(onClick ? "button" : "div");
  if (onClick) row.type = "button";
  row.className = "skill-row" + (readonly ? " ro" : "") + (selectedSkill === name && !readonly ? " sel" : "");
  if (title) row.title = title;
  const dotCls = state ? ` ${state}` : "";
  const mountHtml = mounts ?? "";
  row.innerHTML = `<span class="dot${dotCls}"></span><span class="name">${esc(name)}<span class="src">${esc(src)}</span></span><span class="time">${esc(time)}</span><div class="mounts">${mountHtml}</div>`;
  if (onClick) row.addEventListener("click", onClick);
  return row;
}

function renderSkills() {
  renderSnapshotWarnings();
  renderSkillChips();
  $("#d-n-conflicts").textContent = snap.conflicts.length || "";
  $("#d-n-broken").textContent = snap.broken.length || "";
  $("#btn-repair").disabled = !snap.broken.length;
  $("#d-conflicts").hidden = !snap.conflicts.length;
  $("#d-broken").hidden = !snap.broken.length;
  const body = $("#skill-rows");
  body.replaceChildren();
  const q = skillQuery.toLowerCase();
  if (skillFilter === "unadopted") {
    const rows = snap.unadopted.filter((row) => row.name.toLowerCase().includes(q));
    for (const row of rows) {
      body.append(skillRowEl({
        name: row.name, src: row.agent, time: "", state: "y", readonly: true,
        title: t("skills.unadoptedTitle"),
        mounts: `<span class="mount">${t("skills.mountUnadopted")}</span>`,
      }));
    }
    if (!rows.length) body.append(emptyRow(snap.skillsStatus === "unavailable" ? t("skills.scanFailUnadopted") : t("skills.emptyUnadopted")));
  } else {
    let shown = 0;
    for (const rec of snap.skills) {
      const state = skillState(rec.name);
      if (skillFilter === "conflict" && state !== "r") continue;
      if (skillFilter === "broken" && state !== "y") continue;
      if (!rec.name.toLowerCase().includes(q)) continue;
      shown++;
      const mounts = rec.targets == null
        ? `<span class="mount hub">${t("skills.mountDefault")}</span>`
        : rec.targets.map((id) => `<span class="mount hub">${esc(id)}</span>`).join("") || `<span class="mount">${t("skills.mountNone")}</span>`;
      body.append(skillRowEl({
        name: rec.name, src: t("skills.srcUser"),
        time: rec.updatedAt ? new Date(rec.updatedAt).toLocaleString(getLang() === "en" ? "en-US" : "zh-CN") : "—",
        state, mounts,
        onClick: () => openSkill(rec.name),
      }));
    }
    for (const rec of snap.vendorSkills) {
      if (skillFilter === "broken") continue;
      if (skillFilter === "conflict" && skillState(rec.name) !== "r") continue;
      if (!rec.name.toLowerCase().includes(q)) continue;
      shown++;
      body.append(skillRowEl({
        name: rec.name, src: t("skills.srcVendor", { agent: rec.agent }),
        time: new Date(rec.updatedAt).toLocaleString(getLang() === "en" ? "en-US" : "zh-CN"),
        state: skillState(rec.name), readonly: true,
        title: t("skills.vendorTitle"),
        mounts: `<span class="mount">${t("skills.vendorRo")}</span>`,
      }));
    }
    if (!shown) body.append(emptyRow(skillFilter || skillQuery ? t("skills.emptyFilter") : t("skills.emptyHub")));
  }

  const conflicts = $("#skill-conflicts");
  conflicts.replaceChildren();
  if (!snap.conflicts.length) conflicts.append(item(snap.skillsStatus === "unavailable" ? t("skills.conflictsUnknown") : t("skills.noConflicts")));
  for (const row of snap.conflicts) {
    const li = document.createElement("li");
    li.className = "conflict-row";
    li.append(`${row.agent}  ${row.name}`);
    const keepHub = document.createElement("button");
    keepHub.className = "btn sm";
    keepHub.textContent = t("skills.keepHub");
    keepHub.disabled = !snap.skills.some((skill) => skill.name === row.name);
    keepHub.addEventListener("click", () => resolveConflict(row.name, "hub"));
    const keepAgent = document.createElement("button");
    keepAgent.className = "btn sm";
    keepAgent.textContent = t("skills.keepAgent");
    keepAgent.addEventListener("click", () => resolveConflict(row.name, "agent", row.path));
    li.append(keepHub, keepAgent);
    conflicts.append(li);
  }
  const broken = $("#skill-broken");
  broken.replaceChildren();
  if (!snap.broken.length) broken.append(item(snap.skillsStatus === "unavailable" ? t("skills.brokenUnknown") : t("skills.noBroken")));
  for (const row of snap.broken) broken.append(item(`${row.agent}  ${row.name}`));
}

function emptyRow(text) {
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = text;
  return div;
}

async function resolveConflict(name, keep, fromPath) {
  const result = await api("/api/conflict", {
    method: "POST",
    body: JSON.stringify({ name, keep, fromPath }),
  });
  snap = result.snapshot;
  renderAssets();
  banner(result.resolved);
}

async function repairBroken() {
  const report = await api("/api/repair", { method: "POST", body: "{}" });
  snap = report.snapshot;
  renderAssets();
  notice("banner.repaired", { repaired: report.repaired.length, leftover: report.leftover.length });
}

function item(text) {
  const li = document.createElement("li");
  li.textContent = text;
  return li;
}

function esc(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function renderMarkdown(raw) {
  const chunks = String(raw ?? "").split(/```/);
  return chunks.map((chunk, i) => {
    if (i % 2 === 1) {
      const body = chunk.replace(/^[^\n]*\n/, "");
      return `<pre><code>${esc(body)}</code></pre>`;
    }
    let html = esc(chunk);
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(?:<li>.*<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`);
    html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
    html = html.split(/\n{2,}/).map((para) => {
      if (/^\s*<(h[1-3]|ul|pre)/.test(para)) return para;
      return para.trim() ? `<p>${para.replace(/\n/g, "<br>")}</p>` : "";
    }).join("");
    return html;
  }).join("");
}

function wirePreview(textarea, toggleBtn) {
  if (!textarea || !toggleBtn || textarea.dataset.previewWired === "1") return;
  textarea.dataset.previewWired = "1";
  const preview = document.createElement("div");
  preview.className = "md-preview hidden";
  textarea.insertAdjacentElement("afterend", preview);
  const sync = () => {
    preview.innerHTML = renderMarkdown(textarea.value);
  };
  toggleBtn.addEventListener("click", () => {
    preview.classList.toggle("hidden");
    const on = !preview.classList.contains("hidden");
    toggleBtn.textContent = on ? t("skills.previewOff") : t("skills.preview");
    toggleBtn.classList.toggle("is-on", on);
    if (on) sync();
  });
  textarea.addEventListener("input", () => {
    if (!preview.classList.contains("hidden")) sync();
  });
}

function effectiveTargetIds(targets) {
  const defaults = snap?.config?.layers?.skills?.default_targets ?? ["*"];
  const source = targets == null ? defaults : targets;
  if (source.includes("*")) return snap.agents.filter(a => !a.memoryOnly).map((agent) => agent.id);
  return source.filter((id) => snap.agents.some((agent) => !agent.memoryOnly && agent.id === id));
}

async function saveSkillTargets(targets) {
  if (!selectedSkill) return;
  if (skillBusy || skillPending) return;
  skillBusy = true;
  const editor = $("#skill-editor");
  editor.disabled = true;
  $("#btn-save-skill").disabled = true;
  renderSkillTargets();
  try {
    // Leave frontmatter edited in the text area intact unless a target change
    // was explicitly staged. Both paths save the same visible document draft.
    const result = targets === undefined
      ? { file: await api(`/api/file?kind=skill&name=${encodeURIComponent(selectedSkill)}`, {
        method: "PUT",
        body: JSON.stringify({ content: editor.value, revision: skillRevision }),
      }) }
      : await api("/api/skill-targets", {
        method: "POST",
        body: JSON.stringify({ name: selectedSkill, targets, content: editor.value, revision: skillRevision }),
      });
    if (result.snapshot) snap = result.snapshot;
    editor.value = result.file.content;
    skillRevision = result.file.revision;
    skillTargetsDraft = undefined;
    skillDirty = false;
    $("#skill-saved").textContent = t("skills.saved");
  } finally {
    skillBusy = false;
    editor.disabled = false;
    $("#btn-save-skill").disabled = false;
    renderSkillTargets();
  }
  // Guarded: unit tests extract this function alone, without the nav/overview renderers.
  if (typeof renderNav === "function") renderNav();
  if (typeof renderOverview === "function") renderOverview();
  renderSkills();
  renderSkillTargets();
  if (targets === undefined) notice("banner.savedSkill", { name: selectedSkill });
  else {
    const label = targets == null ? t("skills.inherit") : targets.join(",") || t("banner.nobody");
    notice("banner.targetsSaved", { name: selectedSkill, label });
  }
}

function renderSkillTargets() {
  const wrap = $("#skill-targets");
  const active = document.activeElement;
  const focusKey = active?.parentElement === wrap ? active.dataset.skillTarget : undefined;
  wrap.replaceChildren();
  if (!selectedSkill || !snap) {
    wrap.hidden = true;
    $("#skill-targets-hint").hidden = true;
    return;
  }
  const rec = snap.skills.find((item) => item.name === selectedSkill);
  if (!rec) {
    wrap.hidden = true;
    $("#skill-targets-hint").hidden = true;
    return;
  }
  wrap.hidden = false;
  $("#skill-targets-hint").hidden = false;
  const targets = skillTargetsDraft === undefined ? rec.targets : skillTargetsDraft;
  const inherit = targets == null;
  const onIds = new Set(effectiveTargetIds(targets));
  const stageTargets = (next) => {
    if (skillBusy || skillPending) return;
    skillTargetsDraft = next == null ? null : [...next];
    skillEditEpoch++;
    skillDirty = true;
    $("#skill-saved").textContent = t("skills.dirty");
    renderSkillTargets();
  };
  const inheritBtn = document.createElement("button");
  inheritBtn.type = "button";
  inheritBtn.className = "grant" + (inherit ? " is-on" : "");
  inheritBtn.dataset.skillTarget = "mode:inherit";
  inheritBtn.setAttribute("aria-pressed", String(inherit));
  inheritBtn.textContent = t("skills.inherit");
  inheritBtn.disabled = skillBusy || skillPending;
  inheritBtn.title = t("skills.inheritTitle", { targets: (snap.config?.layers?.skills?.default_targets ?? ["*"]).join(",") });
  inheritBtn.addEventListener("click", () => {
    if (!inherit) stageTargets(null);
  });
  const customBtn = document.createElement("button");
  customBtn.type = "button";
  customBtn.className = "grant" + (!inherit ? " is-on" : "");
  customBtn.dataset.skillTarget = "mode:custom";
  customBtn.setAttribute("aria-pressed", String(!inherit));
  customBtn.textContent = t("skills.custom");
  customBtn.disabled = skillBusy || skillPending;
  customBtn.title = t("skills.targetDraftTitle");
  customBtn.addEventListener("click", () => {
    if (inherit) stageTargets(snap.config?.layers?.skills?.default_targets ?? ["*"]);
  });
  wrap.append(inheritBtn, customBtn);
  for (const agent of snap.agents) {
    const btn = document.createElement("button");
    btn.type = "button";
    const connected = !agent.memoryOnly && agent.bind.skills === "hub";
    btn.className = "grant" + (connected && onIds.has(agent.id) ? " is-on" : "");
    btn.dataset.skillTarget = `agent:${agent.id}`;
    btn.setAttribute("aria-pressed", String(connected && onIds.has(agent.id)));
    btn.textContent = agent.label || agent.id;
    btn.disabled = skillBusy || skillPending || inherit || !connected;
    btn.title = t("skills.targetDraftTitle");
    if (agent.memoryOnly) {
      btn.textContent += ` · ${t("skills.targetUnsupported")}`;
      btn.title = t("skills.memoryOnlyTitle");
    } else if (!connected) {
      btn.textContent += ` · ${t("skills.targetOwn")}`;
      btn.title = t("skills.targetOwnTitle");
    }
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      // Preserve targets outside the current catalog while changing one visible
      // recipient. Own agents remain untouched and cannot be enabled here.
      const next = new Set(targets?.includes("*") ? [...targets.filter(id => id !== "*"), ...onIds] : targets || []);
      if (next.has(agent.id)) next.delete(agent.id);
      else next.add(agent.id);
      stageTargets([...next]);
    });
    wrap.append(btn);
  }
  if (focusKey) {
    const replacement = [...wrap.children].find((btn) => btn.dataset.skillTarget === focusKey);
    if (replacement && !replacement.disabled) replacement.focus();
  }
}

async function openSkill(name) {
  if (skillBusy) return;
  if (skillDirty && !confirm(t("skills.discard"))) return;
  const loadEpoch = ++skillLoadEpoch;
  const editEpoch = skillEditEpoch;
  skillPending = true;
  updateSkillControls();
  try {
    const file = await api(`/api/file?kind=skill&name=${encodeURIComponent(name)}`);
    if (loadEpoch !== skillLoadEpoch) return;
    if (editEpoch !== skillEditEpoch) { notice("memory.newerDraft"); return; }
    // Commit document identity, revision and contents together. Until then the
    // old document remains visible and writable drafts cannot target this name.
    selectedSkill = name;
    $("#skill-title").textContent = name;
    $("#skill-meta").textContent = file.path;
    const ed = $("#skill-editor");
    ed.value = file.content;
    skillRevision = file.revision;
    skillEditEpoch++;
    skillDirty = false;
    skillTargetsDraft = undefined;
    $("#skill-saved").textContent = t("skills.clean");
    const preview = ed.nextElementSibling;
    if (preview && preview.classList.contains("md-preview") && !preview.classList.contains("hidden")) {
      preview.innerHTML = renderMarkdown(ed.value);
    }
    renderSkills();
  } finally {
    if (loadEpoch === skillLoadEpoch) { skillPending = false; updateSkillControls(); }
  }
}

function updateSkillControls() {
  const blocked = !selectedSkill || skillPending || skillBusy;
  for (const id of ["#btn-save-skill", "#btn-open-skill", "#btn-preview-skill", "#btn-delete-skill"]) $(id).disabled = blocked;
  $("#skill-editor").disabled = !selectedSkill || skillBusy;
  renderSkillTargets();
}

/* ================= ctx ================= */

function setSourceCurrent(button, current) {
  if (!button) return;
  button.classList.toggle("is-sel", current);
  if (current) button.setAttribute("aria-current", "true");
  else button.removeAttribute("aria-current");
}

function replaceSourceRows(list, rows) {
  const focused = document.activeElement;
  const focusedId = list.contains(focused) && focused.classList.contains("source-item") ? focused.dataset.id : null;
  list.replaceChildren(...rows);
  // Only restore a button that this replacement removed, never an editor or another list.
  if (focusedId != null) {
    [...list.querySelectorAll(".source-item")].find(button => button.dataset.id === focusedId)?.focus({ preventScroll: true });
  }
}

// Revision is captured at load; PUT carries it so a concurrent edit fails with 409 instead of being silently overwritten.
async function loadUserMd() {
  if (userDirty || userBusy) return;
  const epoch = ++userLoadEpoch;
  userPending = true;
  updateUserControls();
  try {
    const file = await api("/api/file?kind=user-md");
    if (epoch !== userLoadEpoch || userDirty || userBusy) return;
    // The visible content and revision always come from the same file read.
    userRevision = file.revision;
    $("#user-path").textContent = file.path;
    $("#user-editor").value = file.content;
    userLoaded = true;
  } finally {
    if (epoch === userLoadEpoch) { userPending = false; updateUserControls(); }
  }
}

function updateUserControls() {
  $("#user-editor").disabled = !userLoaded || userPending;
  $("#btn-save-user").disabled = !userLoaded || userPending || userBusy;
}

function renderCtx() {
  if (!userLoaded) $("#user-path").textContent = snap.userMd.path;
  if (userLoaded && !userDirty && !userBusy && !userPending && $("#user-editor").value !== snap.userMd.content) {
    loadUserMd().catch(error => banner(error.message));
  }
  updateUserControls();
  renderCtxAgentList();
}

function showCtxView(name) {
  ctxView = name;
  for (const [view, id] of [["user", "#ctx-view-user"], ["project", "#ctx-view-project"], ["agent", "#ctx-view-agent"]]) {
    const el = $(id);
    if (!el) continue;
    el.classList.toggle("hidden", view !== name);
    el.style.display = view === name ? "flex" : "";
  }
  setSourceCurrent($("#ctx-src-user"), name === "user");
  setSourceCurrent($("#ctx-src-project"), name === "project");
  for (const button of $("#ctx-agent-list")?.querySelectorAll(".source-item") ?? []) {
    setSourceCurrent(button, name === "agent" && button.dataset.id === ctxAgentSel);
  }
}

function renderCtxAgentList() {
  const list = $("#ctx-agent-list");
  if (!list) return;
  showCtxView(ctxView);
  const rows = [];
  for (const agent of snap?.agents ?? []) {
    if (agent.memoryOnly) continue;
    const li = document.createElement("button");
    li.type = "button"; li.className = "source-item";
    li.dataset.id = agent.id;
    const b = document.createElement("b");
    b.textContent = agent.label;
    const badge = document.createElement("span");
    const state = !agent.userMdProjection ? "none" : agent.bind.ctx === "hub" ? "hub" : "own";
    badge.className = "bind-badge " + state;
    badge.textContent = state === "none" ? t("ctx.noProjection") : state === "hub" ? t("pill.hub") : t("pill.own");
    setSourceCurrent(li, ctxView === "agent" && ctxAgentSel === agent.id);
    li.append(b, badge);
    li.addEventListener("click", () => openCtxAgent(agent).catch((err) => banner(String(err.message ?? err))));
    const row = document.createElement("li"); row.append(li); rows.push(row);
  }
  replaceSourceRows(list, rows);
}

async function openCtxAgent(agent) {
  ctxAgentSel = agent.id;
  showCtxView("agent");
  renderCtxAgentList();
  $("#ctx-a-name").textContent = agent.label;
  const badge = $("#ctx-a-bind");
  const state = !agent.userMdProjection ? "none" : agent.bind.ctx === "hub" ? "hub" : "own";
  badge.className = "bind-badge " + state;
  badge.textContent = state === "none" ? t("ctx.noProjection") : state === "hub" ? t("pill.hub") : t("pill.own");
  const editor = $("#ctx-a-content");
  editor.value = "";
  if (!agent.userMdProjection) {
    $("#ctx-a-path").textContent = "";
    $("#ctx-a-note").textContent = ctxHubBlockReason(agent);
    return;
  }
  $("#ctx-a-path").textContent = agent.userMdProjection;
  $("#ctx-a-note").textContent = t("sessions.loading");
  const data = await api(`/api/agent-layer?agent=${encodeURIComponent(agent.id)}&layer=ctx`);
  if (ctxAgentSel !== agent.id) return;
  editor.value = data.content;
  $("#ctx-a-path").textContent = data.path;
  $("#ctx-a-note").textContent = agent.bind.ctx !== "hub"
    ? t("ctx.ownNote")
    : data.exists ? t("ctx.readOnly") : t("ctx.hubMissing");
  if (data.exists && !data.content) $("#ctx-a-note").textContent = `${t("ctx.readOnly")} ${t("ctx.emptyFile")}`;
}

/* ================= memory ================= */

function renderMemory() {
  $("#memory-title").textContent = selectedMemory === "global" ? t("knowledge.globalMemory") : selectedMemory;
  const list = $("#memory-list");
  const items = [];
  const rows = [{ id: "global", label: t("knowledge.globalMemory"), sub: "global.md" }, ...snap.memory.projects.map((p) => ({ id: p.id, label: p.id, sub: t("memory.project") }))];
  for (const row of rows) {
    const li = document.createElement("button");
    li.type = "button"; li.className = "source-item";
    li.dataset.id = row.id;
    const b = document.createElement("b");
    b.textContent = row.label;
    const s = document.createElement("span");
    s.className = "s";
    s.textContent = row.sub;
    li.append(b, s);
    setSourceCurrent(li, memView === "source" && selectedMemory === row.id);
    li.addEventListener("click", () => openMemory(row.id).catch(error => banner(error.message)));
    const entry = document.createElement("li"); entry.append(li); items.push(entry);
  }
  replaceSourceRows(list, items);
  fillHandoffTargets();
  renderMemoryAgentList();
}

function showMemView(name) {
  memView = name;
  for (const [view, id] of [["source", "#mem-view-source"], ["agent", "#mem-view-agent"]]) {
    const el = $(id);
    if (!el) continue;
    el.classList.toggle("hidden", view !== name);
    el.style.display = view === name ? "flex" : "";
  }
  for (const [id, current] of [["#memory-list", name === "source" ? selectedMemory : null], ["#memory-agent-list", name === "agent" ? memAgentSel : null]]) {
    for (const button of $(id)?.querySelectorAll(".source-item") ?? []) setSourceCurrent(button, button.dataset.id === current);
  }
}

function renderMemoryAgentList() {
  const list = $("#memory-agent-list");
  if (!list) return;
  const rows = [];
  for (const agent of snap?.agents ?? []) {
    const li = document.createElement("button");
    li.type = "button"; li.className = "source-item";
    li.dataset.id = agent.id;
    const b = document.createElement("b");
    b.textContent = agent.label;
    const badge = document.createElement("span");
    const hub = agent.bind.memory === "hub";
    badge.className = "bind-badge " + (hub ? "hub" : "own");
    badge.textContent = hub ? t("pill.hub") : t("pill.own");
    setSourceCurrent(li, memView === "agent" && memAgentSel === agent.id);
    li.append(b, badge);
    li.addEventListener("click", () => openMemAgent(agent).catch((err) => banner(String(err.message ?? err))));
    const row = document.createElement("li"); row.append(li); rows.push(row);
  }
  replaceSourceRows(list, rows);
}

async function openMemAgent(agent) {
  memoryLoadEpoch++;
  memoryPending = false;
  updateMemoryControls();
  memAgentSel = agent.id;
  showMemView("agent");
  renderMemoryAgentList();
  $("#mem-a-name").textContent = agent.label;
  const badge = $("#mem-a-bind");
  const hub = agent.bind.memory === "hub";
  badge.className = "bind-badge " + (hub ? "hub" : "own");
  badge.textContent = hub ? t("pill.hub") : t("pill.own");
  $("#mem-a-path").textContent = agent.memoryInjectPath || "";
  const loading = $("#mem-a-loading");
  loading.replaceChildren();
  const mode = agent.memoryLoading?.mode;
  const modeKey = mode === "workspace" ? "memory.modeWorkspace" : mode === "manual" ? "memory.modeManual" : "memory.modeGlobal";
  loading.append(item(`${t("memory.mode")}: ${t(modeKey)}`));
  for (const p of agent.memoryLoading?.paths ?? []) loading.append(item(`${t("memory.paths")}: ${p}`));
  const note = apiErrorText(agent.memoryLoading?.note || "");
  if (note) loading.append(item(note));
  const editor = $("#mem-a-content");
  editor.value = "";
  $("#mem-a-note").textContent = t("sessions.loading");
  const data = await api(`/api/agent-layer?agent=${encodeURIComponent(agent.id)}&layer=memory`);
  if (memAgentSel !== agent.id) return;
  editor.value = data.content;
  $("#mem-a-path").textContent = data.path;
  $("#mem-a-note").textContent = !hub
    ? t("memory.ownNote")
    : data.exists ? t("memory.readOnly") : t("memory.notInjected");
}

async function syncMemoryEntries() {
  const result = await api("/api/memory/sync", { method: "POST", body: "{}" });
  snap = result.snapshot;
  renderAll();
  banner(memoryDeliveryMessage(result, "banner.syncMem"));
}

async function openMemory(id) {
  if (memoryBusy) { notice("memory.busy"); return false; }
  // Delivery previews do not replace the source editor. Return to that draft
  // without turning a view change into an implicit reload or discard.
  if (memoryLoaded && id === selectedMemory && memView === "agent") {
    memoryLoadEpoch++;
    memoryPending = false;
    showMemView("source");
    renderMemory();
    updateMemoryControls();
    return true;
  }
  if (memoryDirty && !confirm(t("memory.discard"))) return false;
  const loadEpoch = ++memoryLoadEpoch;
  const editEpoch = memoryEditEpoch;
  memoryPending = true;
  updateMemoryControls();
  try {
    const file = await api(`/api/file?kind=memory&name=${encodeURIComponent(id)}`);
    if (loadEpoch !== memoryLoadEpoch) return false;
    // Typing while the read was in flight cancels replacement of that draft.
    if (editEpoch !== memoryEditEpoch) { notice("memory.newerDraft"); return false; }
    applyMemoryFile(id, file);
    showMemView("source");
    renderMemory();
    return true;
  } finally {
    if (loadEpoch === memoryLoadEpoch) { memoryPending = false; updateMemoryControls(); }
  }
}

function applyMemoryFile(id, file) {
  // Commit identity, revision, title and contents together, only for an accepted response.
  selectedMemory = id;
  memoryRevision = file.revision;
  $("#memory-title").textContent = id === "global" ? t("knowledge.globalMemory") : id;
  $("#memory-path").textContent = file.path;
  $("#memory-editor").value = file.content;
  memoryEditEpoch++;
  memoryDirty = false;
  memoryLoaded = true;
  memoryConflict = null;
  renderMemoryConflict();
}

function updateMemoryControls() {
  for (const id of ["#btn-save-memory", "#btn-remember"]) $(id).disabled = memoryBusy || memoryPending || !memoryLoaded;
  $("#btn-new-project").disabled = memoryBusy || memoryPending;
  $("#btn-memory-merge").disabled = memoryBusy || memoryPending || !memoryConflict;
  $("#btn-memory-reload").disabled = memoryBusy || memoryPending;
}

function renderMemoryConflict() {
  const active = memoryConflict?.id === selectedMemory;
  $("#memory-conflict").hidden = !active;
  $("#memory-remote").value = active ? memoryConflict.content : "";
  updateMemoryControls();
}

async function loadMemoryConflict(id) {
  // The local editor and its base revision stay unchanged until the user resolves it.
  notice("memory.conflictKept");
  try {
    const file = await api(`/api/file?kind=memory&name=${encodeURIComponent(id)}`);
    if (id !== selectedMemory) return;
    memoryConflict = { id, content: file.content, revision: file.revision };
    renderMemoryConflict();
    notice("memory.conflictKept");
  } catch (error) {
    banner(`${t("memory.conflictKept")} ${error.message}`);
  }
}

function memoryDeliveryMessage(result, successKey) {
  const failures = result?.delivery?.failures ?? [];
  if (!failures.length) return t(successKey);
  const details = failures.map(f => [f.agent, f.cwd, apiErrorText(f.error)].filter(Boolean).join(" · ")).join("; ");
  return `${t("memory.deliveryPartial", { count: failures.length })} ${details}`;
}

async function saveMemoryDraft(mergeRevision) {
  if (memoryBusy || memoryPending || !memoryLoaded) return null;
  const id = selectedMemory;
  const editor = $("#memory-editor");
  const content = editor.value;
  const revision = mergeRevision ?? memoryRevision;
  memoryBusy = true;
  updateMemoryControls();
  try {
    const saved = await api(`/api/file?kind=memory&name=${encodeURIComponent(id)}`, {
      method: "PUT", body: JSON.stringify({ content, revision }),
    });
    // Navigation is blocked during writes; typing is not. Only the submitted version is saved.
    if (selectedMemory === id) {
      memoryRevision = saved.revision;
      memoryDirty = editor.value !== content;
      memoryConflict = null;
      renderMemoryConflict();
    }
    return saved;
  } catch (error) {
    if (error.status === 409) { await loadMemoryConflict(id); return null; }
    throw error;
  } finally { memoryBusy = false; updateMemoryControls(); }
}

async function finishMemorySave(saved) {
  if (!saved) return;
  let message = memoryDeliveryMessage(saved, "banner.savedMemory");
  try { await refresh(); } catch (error) { message += ` ${t("memory.savedReloadFailed")} ${error.message}`; }
  if (memoryDirty) message += ` ${t("memory.newerDraft")}`;
  banner(message);
}

function fillHandoffTargets() {
  const sel = $("#handoff-to");
  const prev = sel.value;
  sel.replaceChildren();
  for (const agent of snap.agents.filter(a => a.supportsHandoff)) {
    const opt = document.createElement("option");
    opt.value = agent.id;
    opt.textContent = agent.label;
    sel.append(opt);
  }
  if (prev) sel.value = prev;
}

function renderSyncStatus(offline = false) {
  const assetNode = $("#ov-asset-sync"), sessionNode = $("#ov-session-sync");
  if (!assetNode || !sessionNode) return;
  const panel = $("#ov-sync-panel"), title = $("#ov-health-title"), detail = $("#ov-health-detail");
  if (offline) {
    assetNode.textContent = t("overview.syncOffline");
    sessionNode.textContent = "";
    if (title) title.textContent = t("overview.offlineTitle");
    if (detail) detail.textContent = t("overview.offlineHint");
    if (panel) panel.dataset.state = "error";
    return;
  }
  const label = (running, error, success) => error ? t("overview.syncError", { error: apiErrorText(error) })
    : running ? t("overview.syncRunning") : success ? t("overview.syncOk", {
      time: new Date(success).toLocaleTimeString(getLang() === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    }) : t("overview.syncPending");
  const assets = snap.sync?.assets, sessions = snap.sync?.sessions;
  const errors = Object.values(assets?.layers || {}).flatMap(layer => layer.errors || []);
  const failed = errors.length > 0 || Boolean(sessions?.error);
  const running = assets?.running || sessions?.running;
  const ready = assets?.lastSyncedAt && sessions?.lastSuccessAt;
  if (panel) panel.dataset.state = failed ? "error" : ready ? "ok" : "pending";
  if (title) title.textContent = t(failed ? "overview.needsAttention" : running ? "overview.syncRunning" : ready ? "overview.healthy" : "overview.syncPending");
  if (detail) detail.textContent = t(failed ? "overview.syncFixHint" : "overview.backgroundHint");
  assetNode.textContent = label(assets?.running, errors.map(row => row.error).join("; "), assets?.lastSyncedAt);
  sessionNode.textContent = label(sessions?.running, sessions?.error, sessions?.lastSuccessAt);
}

function snapshotWarnings() {
  const warnings = [...(snap.warnings || [])];
  if (snap.memoryCapacity?.nearLimit) warnings.push(t("warning.memoryCapacity", {
    used: snap.memoryCapacity.usedChars, limit: snap.memoryCapacity.effectiveLimit,
    remaining: snap.memoryCapacity.remainingChars,
  }));
  for (const layer of Object.values(snap.sync?.assets?.layers || {})) {
    for (const failure of layer.errors || []) warnings.push(t("overview.syncError", { error: `${failure.agent || failure.layer}: ${apiErrorText(failure.error)}` }));
  }
  if (snap.sync?.sessions?.error) warnings.push(t("overview.syncError", { error: apiErrorText(snap.sync.sessions.error) }));
  if (snap.vault.status === "unavailable") warnings.push(snap.vault.error);
  return warnings;
}

function renderSnapshotWarnings() {
  const warnings = snapshotWarnings();
  const box = $("#snapshot-warnings");
  box.replaceChildren();
  box.hidden = warnings.length === 0 || currentPage === "overview";
  if (!box.hidden) {
    const label = document.createElement("span");
    label.textContent = t("overview.warningSummary", { n: warnings.length });
    const link = document.createElement("a");
    link.href = "#/overview";
    link.textContent = t("overview.reviewWarnings");
    link.addEventListener("click", event => { event.preventDefault(); go("overview"); });
    box.append(label, link);
  }
  $("#nav-vault-label").textContent = snap.vault.status === "unavailable" ? t("nav.vaultFail") : t("nav.vault");
}

function pillCtl(pill) {
  return {
    get value() { return pill.dataset.v ?? ""; },
    set value(v) { pill.dataset.v = v; pill.className = "pill " + v; pill.textContent = pillTxt(v); },
    get disabled() { return pill.classList.contains("busy"); },
    set disabled(b) { pill.classList.toggle("busy", b); },
  };
}

function renderMatrix() {
  const tbl = $("#matrix");
  const signature = JSON.stringify([getLang(), snap.agents, snap.config?.layers?.ctx]);
  if (tbl.dataset.signature === signature) { filterAgentCards(); return; }
  tbl.dataset.signature = signature;
  const layers = Object.keys(LAYER_META);
  tbl.innerHTML = `<thead><tr><th>${esc(t("nav.agents"))}</th>` + layers.map(l => `<th>${esc(t(LAYER_META[l].labelKey))}</th>`).join("") + "</tr></thead><tbody></tbody>";
  const tbody = tbl.querySelector("tbody");
  for (const agent of snap.agents) {
    const tr = document.createElement("tr");
    tr.dataset.agent = agent.id; tr.dataset.label = agent.label; tr.dataset.present = String(agent.present);
    const head = document.createElement("th"); head.scope = "row"; head.className = "agent";
    const link = document.createElement("button"); link.type = "button"; link.className = "agent-detail-link";
    link.textContent = agent.label;
    link.addEventListener("click", () => focusAgent(agent.id));
    head.append(link); tr.append(head);
    for (const layer of layers) {
      const cell = document.createElement("td");
      const unavailable = agent.memoryOnly && layer !== "memory" ? t("block.memoryOnly") : layer === "sessions" && !agent.supportsSessions ? t("block.noScanner") : layer === "vault" && agent.supportsVault === false ? t("block.noVault") : null;
      if (unavailable) {
        const label = document.createElement("span"); label.className = "matrix-na"; label.textContent = t("agents.unsupported"); label.title = unavailable; cell.append(label);
      } else {
        const select = document.createElement("select"); select.className = "binding-select " + agent.bind[layer];
        select.setAttribute("aria-label", `${agent.label} · ${t(LAYER_META[layer].labelKey)}`);
        for (const [value, key] of LAYER_META[layer].options) {
          const option = document.createElement("option"); option.value = value; option.textContent = t(key);
          const reason = layerOptionBlock(agent, layer, value);
          option.disabled = Boolean(reason); if (reason) option.title = reason;
          select.append(option);
        }
        select.value = agent.bind[layer];
        select.addEventListener("change", () => onBind(agent, layer, select.value, select).catch(err => banner(err.message)));
        cell.append(select);
      }
      tr.append(cell);
    }
    tbody.append(tr);
  }
  filterAgentCards();
}

function segCtl(seg) {
  return {
    get value() { return seg.querySelector("button.on")?.dataset.v ?? ""; },
    set value(v) { seg.querySelectorAll("button").forEach((b) => { b.classList.toggle("on", b.dataset.v === v); b.setAttribute("aria-pressed", String(b.dataset.v === v)); }); },
    get disabled() { return seg.classList.contains("busy"); },
    set disabled(b) { seg.classList.toggle("busy", b); },
  };
}

function renderAgents() {
  renderSnapshotWarnings();
  const root = $("#agent-cards");
  const signature = JSON.stringify([getLang(), snap.agents, snap.vault.entries, snap.config?.layers?.ctx, snap.catalog]);
  if (root.dataset.signature === signature) { filterAgentCards(); return; }
  const openFrom = (selector) => {
    if (!root || typeof root.querySelectorAll !== "function") return new Set();
    return new Set([...root.querySelectorAll(selector)].map((el) => el.closest?.("[data-agent]")?.dataset.agent).filter(Boolean));
  };
  const openIdentity = openFrom("details.id-block[open]");
  const openFolds = openFrom("details.memo-fold[open]");
  root.replaceChildren();
  for (const agent of snap.agents) {
    const card = document.createElement("article");
    card.className = "card" + (agent.present ? "" : " off");
    card.dataset.agent = agent.id;
    card.dataset.label = agent.label;
    card.dataset.present = String(agent.present);
    card.innerHTML = `
      <div class="card-top">
        <b>${esc(agent.label)}</b>
        <span class="badge ${agent.present ? "inst" : "miss"}">${agent.present ? t("agents.present") : t("agents.missing")}</span>
        ${agent.memoryOnly ? `<span class="badge memo">${t(agent.manualMemory ? "agents.manualMemory" : "agents.memoryOnly")}</span>` : ""}
        <span class="path" style="margin-left:auto">${esc(agent.id)}</span>
        <button type="button" class="btn sm catalog-off">${t("agents.catalogOff")}</button>
      </div>
      <div class="bind"></div>
      <details class="d connection-details"><summary>${t("agents.connectionDetails")}</summary><p class="path">${esc(agent.manualMemory ? t("agents.manualNote") : ["zcode", "kimi"].includes(agent.id) ? t("agents.nativeNote") : agent.memoryOnly ? agent.compatibilityNote : agent.skillDir)}</p><ul class="resolved"></ul><div class="row-actions agent-content-links"></div></details>
      <details class="id-block d">
        <summary>${t("agents.identity")}</summary>
        <p class="path id-path"></p>
        <textarea class="id-editor" spellcheck="false" data-kind="identity"></textarea>
        <div class="row-actions" style="margin-top:8px">
          <button type="button" class="btn sm draft-id">${t("agents.draftFromUser")}</button>
          <button type="button" class="btn sm pri save-id">${t("agents.saveId")}</button>
          <button type="button" class="btn sm open-id">${t("skills.openExt")}</button>
          <button type="button" class="btn sm preview-id">${t("skills.preview")}</button>
          <button type="button" class="btn sm restore-id">${t("agents.restore")}</button>
        </div>
        <div class="soul-wrap"></div>
        <div class="sub-wrap"></div>
      </details>
    `;
    card.querySelector(".catalog-off").addEventListener("click", async () => {
      try {
        snap = await api("/api/catalog", { method: "POST", body: JSON.stringify({ agent: agent.id, enabled: false }) });
        renderAll();
        notice("banner.catalogOff", { id: agent.id });
      } catch (error) { banner(error.message); }
    });
    const shortcuts = card.querySelector(".agent-content-links");
    for (const [page, key, open] of [["memory", "agents.viewMemory", openMemAgent], ["ctx", "agents.viewPreferences", openCtxAgent]]) {
      if (page === "ctx" && !agent.userMdProjection) continue;
      const link = document.createElement("button"); link.type = "button"; link.className = "btn sm"; link.textContent = t(key);
      link.addEventListener("click", () => { go(page, { loadSource: false }); open(agent).catch(error => banner(error.message)); });
      shortcuts.append(link);
    }
    const bind = card.querySelector(".bind");
    for (const [layer, meta] of Object.entries(LAYER_META)) {
      const lab = document.createElement("label");
      lab.textContent = t(meta.labelKey || "layer." + layer);
      const seg = document.createElement("div");
      seg.dataset.layer = layer;
      const groupBlock = (agent.memoryOnly && layer !== "memory") ? t("block.memoryOnly")
        : (layer === "sessions" && !agent.supportsSessions) ? t("block.noScanner")
        : (layer === "vault" && agent.supportsVault === false) ? t("block.noVault") : null;
      seg.className = "seg" + (groupBlock ? " dis" : "");
      if (groupBlock) seg.title = groupBlock;
      for (const [value, label] of meta.options) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.v = value;
        btn.textContent = t(label);
        // className (not classList) so the extracted-function UI tests can run against plain mock nodes.
        btn.className = agent.bind[layer] === value ? "on" : "";
        btn.setAttribute?.("aria-pressed", String(agent.bind[layer] === value));
        btn.setAttribute?.("aria-label", `${agent.label} · ${t(meta.labelKey)} · ${t(label)}`);
        // Inlined layerOptionBlock: the ctx-ui test extracts renderAgents without that helper.
        const reason = groupBlock
          ?? ((layer === "memory" || layer === "ctx" || layer === "vault") && value === "hub" && !agent.present ? t("block.notInstalled")
            : layer === "ctx" && value === "hub" && !allowsCtxHub(agent) ? ctxHubBlockReason(agent)
            : null);
        if (reason) {
          btn.disabled = true;
          btn.title = reason;
          if (!seg.title) seg.title = reason;
        }
        btn.addEventListener("click", () => {
          if (btn.disabled || btn.className === "on") return;
          onBind(agent, layer, value, segCtl(seg)).catch((err) => banner(String(err.message ?? err)));
        });
        seg.append(btn);
      }
      bind.append(lab, seg);
    }
    const resolved = card.querySelector(".resolved");
    const ctxPath = agent.bind.ctx === "hub" && agent.userMdProjection ? agent.userMdProjection : t("resolved.ownNoProj");
    const memPath = agent.bind.memory === "hub" ? agent.memoryInjectPath : t("resolved.ownNoMem");
    const sessPath = agent.sessionRoot ?? "—";
    const vaultLabel = agent.bind.vault === "hub"
      ? t("resolved.vaultHub", { path: agent.vaultCatalogPath })
      : agent.bind.vault === "off"
        ? t("resolved.vaultOff")
        : t("resolved.vaultOwn");
    const granted = (snap.vault.entries || []).filter((entry) => entry.agents.includes(agent.id)).map((entry) => entry.id);
    const found = t("resolved.found");
    const missing = t("resolved.missing");
    resolved.innerHTML = `
      ${agent.memoryOnly ? "" : `<li>${t("resolved.identity", { path: esc(agent.identityPath), load: esc(agent.identityNative ? t("agents.identityNative") : t("agents.identityProjected", { path: agent.identityNativePath || agent.identityPath })) })}</li>`}
      <li>${t("resolved.ctx", { path: esc(ctxPath) })}</li>
      <li>${t("ctx.sub")}</li>
      <li>${t("resolved.memory", { path: esc(memPath) })}</li>
      <li>${t("resolved.install", { config: agent.installation?.configDirectory ? found : missing, bin: agent.installation?.executable ? found : missing })}</li>
      <li>${esc(agent.manualMemory ? t("agents.manualNote") : apiErrorText(agent.memoryLoading?.note || ""))}</li>
      ${(agent.memoryLoading?.paths || []).map(p => `<li>${t(agent.manualMemory ? "resolved.export" : "resolved.autoload", { path: esc(p) })}</li>`).join("")}
      <li>${t("resolved.sessions", { path: esc(sessPath), mode: agent.bind.sessions === "index" ? t("resolved.sessIndex") : t("resolved.sessOwn") })}</li>
      <li>${t("resolved.vaultLine", { label: esc(vaultLabel) })}${granted.length ? ` · ${granted.join(", ")}` : ""}</li>
    `;
    if (agent.bind.vault === "hub") {
      const claim = document.createElement("button");
      claim.type = "button";
      claim.className = "btn sm";
      claim.textContent = t("agents.vaultExec");
      const cmd = `hub vault exec --for ${agent.id} -- ${agent.command || agent.id}`;
      claim.title = t("agents.vaultExecHint", { cmd });
      claim.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(cmd);
          notice("banner.copiedCmd");
        } catch { banner(cmd); }
      });
      card.append(claim);
    }
    if (agent.manualMemory) {
      const download = document.createElement("button");
      download.type = "button";
      download.className = "btn sm";
      download.textContent = t("agents.copyMemory");
      download.addEventListener("click", async () => {
        download.disabled = true;
        try {
          const file = await api("/api/file?kind=memory&name=global");
          await navigator.clipboard.writeText(file.content);
          notice("agents.memoryCopied");
        } catch (error) { banner(error.message); }
        finally { download.disabled = false; }
      });
      card.append(download);
    }
    if (agent.memoryOnly) {
      card.querySelector(".id-block").remove();
      // Memory-only / manual-export cards stay folded: card-top summary only until expanded.
      const fold = document.createElement("details");
      fold.className = "memo-fold";
      const summary = document.createElement("summary");
      summary.textContent = t("agents.foldDetail");
      fold.append(summary);
      for (const child of [...card.children].slice(1)) fold.append(child);
      card.append(fold);
      root.append(card);
      if (openFolds.has(agent.id)) fold.setAttribute("open", "");
      continue;
    }
    setupAgentIdentity(card, agent);
    card.querySelector(".draft-id").addEventListener("click", () => draftIdentityFromUser(card));
    wirePreview(card.querySelector(".id-editor"), card.querySelector(".preview-id"));
    card.querySelector(".save-id").addEventListener("click", () => saveIdentity(card, agent).catch(error => banner(error.message)));
    card.querySelector(".open-id").addEventListener("click", () => openFile("identity", agent.id));
    card.querySelector(".restore-id").addEventListener("click", () => restoreIdentity(agent));
    root.append(card);
    if (openIdentity.has(agent.id)) card.querySelector("details.id-block")?.setAttribute("open", "");
  }
  root.dataset.signature = signature;
  renderCatalog();
  filterAgentCards();
}

function renderCatalog() {
  const box = $("#agent-catalog");
  if (!box) return;
  const rows = (snap.catalog || []).filter((row) => !row.enabled);
  box.replaceChildren();
  if (!rows.length) return;
  const title = document.createElement("h2");
  title.textContent = t("agents.catalog");
  const hint = document.createElement("p");
  hint.className = "sub";
  hint.textContent = t("agents.catalogHint");
  box.append(title, hint);
  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "row-actions";
    const label = document.createElement("span");
    label.textContent = `${row.label} (${row.id})${row.present ? "" : " · " + t("agents.missing")}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn sm";
    btn.textContent = t("agents.catalogOn");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        snap = await api("/api/catalog", { method: "POST", body: JSON.stringify({ agent: row.id, enabled: true }) });
        renderAll();
        notice("banner.catalogOn", { id: row.id });
      } catch (error) { banner(error.message); }
      finally { btn.disabled = false; }
    });
    line.append(label, btn);
    box.append(line);
  }
}

function filterAgentCards() {
  const q = $("#agent-filter").value.trim().toLowerCase();
  const installed = $("#agent-installed").checked;
  const matches = agent => (agent.id + " " + agent.label).toLowerCase().includes(q) && (!installed || agent.present);
  for (const node of $$("#agent-cards .card, #matrix tbody tr[data-agent]")) {
    node.hidden = !matches({ id: node.dataset.agent, label: node.dataset.label, present: node.dataset.present === "true" });
  }
  const shown = (snap?.agents || []).filter(matches).length;
  $("#agent-filter-count").textContent = t("agents.shownCount", { n: shown, total: snap?.agents.length ?? 0 });
  const empty = $("#agent-empty"); if (empty) empty.hidden = shown > 0;
}

function renderAgentDraftStatus() {
  const pending = [...agentDrafts.entries()].filter(([, draft]) => draft.dirty).map(([key]) => key);
  const status = $("#agent-draft-status");
  status.hidden = !pending.length;
  status.textContent = pending.length ? t("draft.pending", { names: pending.join(getLang() === "en" ? ", " : "、") }) : "";
}

// Save the focused editor only; never save a hidden page's draft.
function handleSaveShortcut(event) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "s") return;
  event.preventDefault();
  if (event.repeat || event.isComposing) return;
  const editor = document.activeElement;
  if (!editor || editor.disabled || editor.readOnly || editor.closest?.(".hidden, [hidden]")) return;
  const buttons = { "skill-editor": "#btn-save-skill", "user-editor": "#btn-save-user", "memory-editor": "#btn-save-memory", "agents-editor": "#btn-save-agents", "vault-editor": "#btn-save-vault" };
  let button = buttons[editor.id] ? $(buttons[editor.id]) : null;
  for (const [field, save] of [["id-editor", ".save-id"], ["soul-editor", ".save-soul"], ["sub-editor", ".save-sub"]]) {
    if (editor.classList?.contains(field)) button = editor.closest(".card")?.querySelector(save);
  }
  if (button && !button.disabled) button.click();
}
window.addEventListener("keydown", handleSaveShortcut);

function attachAgentDraft(editor, key, file) {
  let draft = agentDrafts.get(key);
  if (!draft?.dirty) { draft = { content: file.content, revision: file.revision, dirty: false }; agentDrafts.set(key, draft); }
  editor.value = draft.content;
  editor.oninput = () => { draft.content = editor.value; draft.dirty = true; renderAgentDraftStatus(); };
}

function agentHasDirtyDrafts(agentId) {
  return [...agentDrafts].some(([key, draft]) => key.split(":")[1] === agentId && draft.dirty);
}

function draftIdentityFromUser(card) {
  const editor = card.querySelector(".id-editor");
  const body = (userDirty ? $("#user-editor").value : snap?.userMd?.content ?? "").trim();
  editor.value = `${editor.value.trimEnd()}\n\n${body}\n`;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  notice("banner.draftUser");
}

function setupAgentIdentity(card, agent) {
  const identity = card.querySelector(".id-block");
  const editor = card.querySelector(".id-editor"), save = card.querySelector(".save-id");
  const draft = card.querySelector(".draft-id");
  draft.disabled = true;
  let loaded = false, active = null;
  const ensure = async (fresh = false) => {
    if (card.isConnected === false || !identity.open || (fresh && agentHasDirtyDrafts(agent.id))) return;
    if (active) {
      if (fresh) { await active; return ensure(true); }
      return active;
    }
    if (loaded && !fresh) return;
    editor.disabled = true; save.disabled = true; draft.disabled = true;
    active = (async () => {
      try {
        if (!(await loadIdentity(card, agent))) return;
        renderSubagents(card, agent);
        loaded = true;
      } catch (error) {
        if (card.isConnected !== false) banner(error.message);
      } finally {
        editor.disabled = !loaded; save.disabled = !loaded; draft.disabled = !loaded;
      }
    })().finally(() => { active = null; });
    return active;
  };
  identity.addEventListener("toggle", () => ensure());
  agentIdentityReaders.set(card, () => ensure(true));
}

async function refreshOpenAgentEditors(agentId) {
  const cards = $$("#agent-cards .card").filter(card => !agentId || card.dataset.agent === agentId);
  await Promise.all(cards.map(card => agentIdentityReaders.get(card)?.()));
}

async function saveAgentDraft(editor, key, url) {
  const draft = agentDrafts.get(key);
  if (!draft) throw new Error(t("banner.waitFile"));
  const content = editor.value;
  const saved = await api(url, { method: "PUT", body: JSON.stringify({ content, revision: draft.revision }) });
  draft.revision = saved.revision;
  draft.dirty = draft.content !== content;
  renderAgentDraftStatus();
}

window.addEventListener("beforeunload", event => {
  if ((loadedAgentsCwd && $("#agents-editor").value !== $("#agents-editor").dataset.loadedContent) || skillDirty || userDirty || memoryDirty || vaultState.dirty || [...agentDrafts.values()].some(d => d.dirty)) {
    event.preventDefault(); event.returnValue = "";
  }
});

async function loadIdentity(card, agent) {
  const epoch = String(Number(card.dataset.identityLoadEpoch ?? 0) + 1);
  card.dataset.identityLoadEpoch = epoch;
  const current = () => card.isConnected !== false && card.dataset.identityLoadEpoch === epoch;
  const file = await api(`/api/file?kind=identity&agent=${agent.id}`);
  if (!current()) return false;
  card.querySelector(".id-path").textContent = file.path;
  attachAgentDraft(card.querySelector(".id-editor"), `identity:${agent.id}`, file);
  if (agent.soulPath) {
    const soul = await api(`/api/file?kind=soul&agent=${agent.id}`);
    if (!current()) return false;
    const wrap = card.querySelector(".soul-wrap");
    wrap.innerHTML = `
      <h3 class="subhead">${t("agents.soul")}</h3>
      <p class="path">${esc(soul.path)}</p>
      <textarea class="soul-editor" spellcheck="false"></textarea>
      <div class="row-actions" style="margin-top:8px">
        <button type="button" class="btn sm save-soul">${t("agents.saveSoul")}</button>
        <button type="button" class="btn sm preview-soul">${t("skills.preview")}</button>
      </div>
    `;
    attachAgentDraft(wrap.querySelector(".soul-editor"), `soul:${agent.id}`, soul);
    wirePreview(wrap.querySelector(".soul-editor"), wrap.querySelector(".preview-soul"));
    wrap.querySelector(".save-soul").addEventListener("click", async () => {
      await saveAgentDraft(wrap.querySelector(".soul-editor"), `soul:${agent.id}`, `/api/file?kind=soul&agent=${agent.id}`);
      notice("banner.savedSoul", { label: agent.label });
    });
  }
  return true;
}

async function saveIdentity(card, agent) {
  await saveAgentDraft(card.querySelector(".id-editor"), `identity:${agent.id}`, `/api/file?kind=identity&agent=${agent.id}`);
  notice("banner.savedId", { label: agent.label });
}

async function openFile(kind, agent, name) {
  const result = await api("/api/open", {
    method: "POST",
    body: JSON.stringify({ kind, agent, name }),
  });
  notice("banner.opened", { path: result.path });
}

function backupKindLabel(item) {
  if (item.kind === "unknown") return t("backup.unknown");
  if (item.kind === "soul") return t("backup.soul");
  if (item.kind === "subagent") return t("backup.subagent", { name: item.subagent || "" }).trim();
  return t("backup.identity");
}

async function pickBackup(agent) {
  const listed = await api(`/api/identity/backups?agent=${agent.id}`);
  if (!listed.backups.length) {
    notice("banner.noBackup");
    return null;
  }
  const dlg = $("#backup-picker");
  const list = $("#backup-picker-list");
  list.replaceChildren();
  const newest = listed.backups[listed.backups.length - 1];
  $("#backup-picker-text").textContent = t("backup.pickNamed", { label: agent.label });
  for (const item of listed.backups.slice().reverse()) {
    const li = document.createElement("li");
    const lab = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "backup-pick";
    radio.value = item.name;
    radio.checked = item.name === newest.name;
    lab.append(radio, document.createTextNode(` ${backupKindLabel(item)} · ${item.name}`));
    li.append(lab);
    list.append(li);
  }
  dlg.returnValue = "cancel";
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener(
      "close",
      () => {
        if (dlg.returnValue !== "ok") {
          resolve(null);
          return;
        }
        const picked = list.querySelector("input[name='backup-pick']:checked");
        resolve(picked ? picked.value : newest.name);
      },
      { once: true },
    );
  });
}

async function restoreIdentity(agent) {
  const backupName = await pickBackup(agent);
  if (!backupName) return;
  const listed = await api(`/api/identity/backups?agent=${agent.id}`);
  const selected = listed.backups.find((b) => b.name === backupName);
  let legacy;
  if (selected?.kind === "unknown") {
    const kind = await Promise.resolve(askText({ title: t("backup.legacyKind") }));
    if (!["identity", "soul", "subagent"].includes(kind)) return;
    const subagent = kind === "subagent" ? await Promise.resolve(askText({ title: t("backup.legacySub") })) : undefined;
    if (kind === "subagent" && !subagent) return;
    legacy = { kind, subagent };
  }
  const result = await api("/api/identity/restore", {
    method: "POST",
    body: JSON.stringify({ agent: agent.id, backupName, legacy }),
  });
  await refresh();
  await refreshOpenAgentEditors(agent.id);
  if (agentHasDirtyDrafts(agent.id)) {
    banner(`${t("banner.restored", { kind: result.kind, path: result.path })} ${t("memory.newerDraft")}`);
  } else notice("banner.restored", { kind: result.kind, path: result.path });
}

function renderSubagents(card, agent) {
  const wrap = card.querySelector(".sub-wrap");
  if (!wrap) return;
  if (agent.id !== "grok" && (!agent.subagents || agent.subagents.length === 0)) return;
  const canEdit = agent.id === "grok";
  wrap.innerHTML = `
    <h3 class="subhead">${canEdit ? t("agents.subGrok") : t("agents.subagents")}</h3>
    <div class="subagent-list"></div>
    <p class="path sub-path"></p>
    <textarea class="sub-editor" spellcheck="false" ${canEdit ? "" : "disabled"}></textarea>
    <div class="row-actions" style="margin-top:8px">
      <button type="button" class="btn sm pri save-sub" ${canEdit ? "" : "disabled"}>${t("agents.saveSub")}</button>
      <button type="button" class="btn sm preview-sub">${t("skills.preview")}</button>
      <button type="button" class="btn sm new-sub" ${canEdit ? "" : "hidden"}>${t("agents.newSub")}</button>
    </div>
  `;
  const list = wrap.querySelector(".subagent-list");
  if (agent.subagents.length === 0) {
    list.append(item(t("agents.noSub")));
  }
  for (const sub of agent.subagents) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = sub.title && sub.title !== sub.name ? `${sub.name} · ${sub.title}` : sub.name;
    btn.addEventListener("click", () => openSubagent(wrap, agent, sub.name).catch(err => banner(err.message)));
    list.append(btn);
  }
  if (selectedSubagents.has(agent.id)) openSubagent(wrap, agent, selectedSubagents.get(agent.id)).catch(err => banner(err.message));
  wirePreview(wrap.querySelector(".sub-editor"), wrap.querySelector(".preview-sub"));
  wrap.querySelector(".save-sub").addEventListener("click", async () => {
    const name = wrap.dataset.sub;
    if (!name || wrap.dataset.subPending === "1" || wrap.dataset.subBusy === "1") return;
    wrap.dataset.subBusy = "1";
    const save = wrap.querySelector(".save-sub");
    save.disabled = true;
    try {
      await saveAgentDraft(wrap.querySelector(".sub-editor"), `subagent:${agent.id}:${name}`, `/api/file?kind=subagent&agent=${agent.id}&name=${encodeURIComponent(name)}`);
      notice("banner.wroteSub", { name });
    } catch (error) { banner(error.message); }
    finally { wrap.dataset.subBusy = "0"; save.disabled = false; }
  });
  wrap.querySelector(".new-sub").addEventListener("click", async () => {
    const name = await Promise.resolve(askText({
      title: t("prompt.subName"),
      validate: (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? null : t("dialog.invalidId")),
    }));
    if (!name) return;
    const button = wrap.querySelector(".new-sub");
    button.disabled = true;
    try {
      const seed = `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\n${t("draft.subSeed", { label: agent.label })}\n`;
      await api(`/api/file?kind=subagent&agent=${agent.id}&name=${encodeURIComponent(name)}`, {
        method: "POST",
        body: JSON.stringify({ content: seed }),
      });
      await refresh();
      notice("banner.createdSub", { name });
    } catch (error) { banner(error.message); }
    finally { button.disabled = false; }
  });
}

async function openSubagent(wrap, agent, name) {
  if (wrap.dataset.subBusy === "1") return;
  const epoch = String(Number(wrap.dataset.loadEpoch ?? 0) + 1);
  wrap.dataset.loadEpoch = epoch;
  wrap.dataset.subPending = "1";
  const editor = wrap.querySelector(".sub-editor");
  const save = wrap.querySelector(".save-sub");
  const previousContent = editor.value;
  save.disabled = true;
  try {
    const file = await api(`/api/file?kind=subagent&agent=${agent.id}&name=${encodeURIComponent(name)}`);
    if (wrap.dataset.loadEpoch !== epoch || wrap.isConnected === false) return;
    if (editor.value !== previousContent) { notice("memory.newerDraft"); return; }
    wrap.dataset.sub = name;
    wrap.querySelector(".sub-path").textContent = file.path;
    selectedSubagents.set(agent.id, name);
    attachAgentDraft(editor, `subagent:${agent.id}:${name}`, file);
  } finally {
    if (wrap.dataset.loadEpoch === epoch) {
      wrap.dataset.subPending = "0";
      save.disabled = agent.id !== "grok" || !wrap.dataset.sub;
    }
  }
}

async function confirmBox(text, okLabel, altLabel) {
  const dlg = $("#confirm");
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = okLabel;
  const alt = $("#confirm-alt");
  if (altLabel) {
    alt.hidden = false;
    alt.textContent = altLabel;
  } else {
    alt.hidden = true;
  }
  dlg.returnValue = "cancel";
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener(
      "close",
      () => resolve(dlg.returnValue),
      { once: true },
    );
  });
}

/* Text/scope dialogs replace window.prompt. vm test sandboxes have no <dialog> (no showModal),
   so askText falls back to a synchronous prompt() there — extracted handlers stay testable. */
function askText(opts) {
  const dlg = $("#text-prompt");
  if (!dlg || typeof dlg.showModal !== "function") {
    const value = prompt(opts.title);
    return value == null || !value.trim() ? null : value.trim();
  }
  $("#text-prompt-title").textContent = opts.title;
  const input = $("#text-prompt-input");
  input.value = opts.value ?? "";
  input.placeholder = opts.placeholder ?? "";
  const err = $("#text-prompt-err");
  err.hidden = true;
  err.textContent = "";
  $("#text-prompt-cancel").onclick = () => dlg.close("cancel");
  return new Promise((resolve) => {
    $("#text-prompt-form").onsubmit = (ev) => {
      ev.preventDefault();
      const value = input.value.trim();
      const invalid = !value ? t("dialog.required") : opts.validate ? opts.validate(value) : null;
      if (invalid) {
        err.hidden = false;
        err.textContent = invalid;
        return;
      }
      dlg.close("ok");
    };
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" ? input.value.trim() : null), { once: true });
    dlg.returnValue = "cancel";
    dlg.showModal();
    input.focus();
    input.select?.();
  });
}

// apply() runs synchronously on the prompt fallback, asynchronously on the dialog path.
function whenText(out, apply) {
  if (out && typeof out.then === "function") out.then((value) => { if (value != null) apply(value); });
  else if (out != null) apply(out);
}

async function submitMemoryScope(agent, cwd, project) {
  const result = await api("/api/memory/scope", {
    method: "POST",
    body: JSON.stringify({ agent, cwd, project: project === "*" ? undefined : project || undefined, globalOnly: project === "*" }),
  });
  await refresh();
  return result;
}

async function askScope() {
  const dlg = $("#scope-dialog");
  if (!dlg || typeof dlg.showModal !== "function") {
    const agent = prompt(t("banner.scopeAskAgent", { ids: snap.agents.map(a => a.id).join(" / ") }));
    if (!agent) return null;
    const cwd = prompt(t("banner.scopeAskCwd"));
    if (!cwd) return null;
    const project = prompt(t("banner.scopeAskProject"));
    if (project === null) return null;
    return submitMemoryScope(agent, cwd, project);
  }
  const sel = $("#scope-agent");
  sel.replaceChildren();
  for (const agent of snap.agents.filter(a => a.present && a.bind.memory === "hub" && a.memoryLoading?.mode !== "manual")) {
    const option = document.createElement("option"); option.value = agent.id; option.textContent = agent.label; sel.append(option);
  }
  if (memAgentSel && [...sel.options].some(option => option.value === memAgentSel)) sel.value = memAgentSel;
  const cwdInput = $("#scope-cwd"), projectInput = $("#scope-project"), mode = $("#scope-mode"), err = $("#scope-err");
  const save = $("#scope-ok"), cancel = $("#scope-cancel");
  cwdInput.value = lastProjectCwd || $("#agents-cwd").value.trim() || $("#project-cwd").value.trim();
  projectInput.replaceChildren();
  for (const project of snap.memory?.projects || []) {
    const option = document.createElement("option"); option.value = project.id; option.textContent = project.id; projectInput.append(option);
  }
  mode.value = selectedMemory !== "global" ? "project" : "global";
  if (selectedMemory !== "global") projectInput.value = selectedMemory;
  let saving = false;
  const update = () => {
    $("#scope-project-field").hidden = mode.value !== "project";
    $("#scope-remove-hint").hidden = mode.value !== "remove";
    save.disabled = saving || !sel.value || (mode.value === "project" && !projectInput.value);
    err.hidden = Boolean(sel.value);
    err.textContent = sel.value ? "" : t("memory.scopeConnectedOnly");
  };
  mode.onchange = update; sel.onchange = update; projectInput.onchange = update;
  update();
  cancel.onclick = () => { if (!saving) dlg.close("cancel"); };
  dlg.oncancel = event => { if (saving) event.preventDefault(); };
  return new Promise((resolve) => {
    $("#scope-form").onsubmit = async event => {
      event.preventDefault();
      if (saving) return;
      err.hidden = true;
      const cwd = cwdInput.value.trim();
      if (!cwd) { err.hidden = false; err.textContent = t("memory.scopeNeedCwd"); return; }
      if (!sel.value) { err.hidden = false; err.textContent = t("memory.scopeConnectedOnly"); return; }
      if (mode.value === "project" && !projectInput.value) { err.hidden = false; err.textContent = t("memory.scopePickProject"); return; }
      const project = mode.value === "global" ? "*" : mode.value === "remove" ? "" : projectInput.value;
      if (mode.value === "remove" && !confirm(t("memory.scopeRemoveHint"))) return;
      saving = true;
      for (const field of [sel, cwdInput, projectInput, mode, save, cancel]) field.disabled = true;
      try {
        const result = await submitMemoryScope(sel.value, cwd, project);
        rememberProject(cwd); dlg.close("ok"); resolve(result);
      } catch (error) { err.hidden = false; err.textContent = error.message; }
      finally {
        saving = false;
        for (const field of [sel, cwdInput, projectInput, mode, cancel]) field.disabled = false;
        save.disabled = !sel.value;
      }
    };
    dlg.addEventListener("close", () => { if (dlg.returnValue !== "ok") resolve(null); }, { once: true });
    dlg.returnValue = "cancel"; dlg.showModal(); cwdInput.focus();
  });
}

async function onBind(agent, layer, value, sel) {
  const prev = agent.bind[layer];
  if (prev === value) return;
  if (layer === "ctx" && value === "hub" && !allowsCtxHub(agent)) {
    sel.value = prev;
    notice("banner.blocked", { label: agent.label, reason: ctxHubBlockReason(agent) });
    return;
  }
  let skillsMode;
  if (layer === "skills" && prev === "own" && value === "hub") {
    const choice = await confirmBox(
      t("bind.skillsToHub", { label: agent.label }),
      t("bind.skillsToHubOk"),
      t("bind.skillsToHubAlt"),
    );
    if (choice === "cancel" || choice === "") {
      sel.value = prev;
      return;
    }
    skillsMode = choice === "alt" ? "link-existing" : "adopt";
  }
  if (layer === "skills" && prev === "hub" && value === "own") {
    const choice = await confirmBox(
      t("bind.skillsToOwn", { label: agent.label }),
      t("bind.skillsToOwnOk"),
      t("bind.skillsToOwnAlt"),
    );
    if (choice === "cancel" || choice === "") {
      sel.value = prev;
      return;
    }
    skillsMode = choice === "alt" ? "unlink" : "detach-copy";
  }
  if (layer === "ctx" && value === "hub") {
    const choice = await confirmBox(t("bind.ctxHub", { label: agent.label }), t("bind.ctxHubOk"), null);
    if (choice === "cancel" || choice === "") {
      sel.value = prev;
      return;
    }
  }
  if (layer === "memory" && value === "hub") {
    const choice = await confirmBox(t(agent.manualMemory ? "bind.memExport" : "bind.memHub", { label: agent.label }), t(agent.manualMemory ? "bind.memExportOk" : "bind.memHubOk"), null);
    if (choice === "cancel" || choice === "") {
      sel.value = prev;
      return;
    }
  }
  if (layer === "vault" && value === "hub") {
    const choice = await confirmBox(t("bind.vaultHub", { label: agent.label }), t("bind.vaultHubOk"), null);
    if (choice === "cancel" || choice === "") {
      sel.value = prev;
      return;
    }
  }
  if (layer === "vault" && value !== "hub" && prev === "hub") {
    const choice = await confirmBox(t("bind.vaultOff", { label: agent.label }), t("bind.vaultOffOk"), null);
    if (choice === "cancel" || choice === "") {
      sel.value = prev;
      return;
    }
  }
  sel.disabled = true;
  sel.setAttribute?.("aria-busy", "true");
  if (typeof document !== "undefined" && document.body) document.body.dataset.busy = "1";
  try {
  notice("banner.binding", { label: agent.label, layer, value });
  const result = await api("/api/bind", {
    method: "POST",
    body: JSON.stringify({ agent: agent.id, layer, value, skillsMode }),
  });
  snap = result.snapshot;
  if (result.extra?.conflicts?.length) notice("banner.bindConflict");
  else notice("banner.bound", { label: agent.label, layer, value });
  renderAll();
  refreshBanner();
  } catch (error) {
    sel.value = prev;
    banner(error.message);
  } finally {
    sel.disabled = false;
    sel.removeAttribute?.("aria-busy");
    if (typeof document !== "undefined" && document.body) delete document.body.dataset.busy;
  }
}

/* ================= chrome wiring ================= */

function bindChrome() {
  updateUserControls();
  $("#dismiss-banner")?.addEventListener("click", () => banner(null));
  document.addEventListener?.("click", event => {
    for (const menu of $$(".more-menu[open]")) if (!menu.contains(event.target) || event.target.closest("button")) menu.open = false;
  });
  document.addEventListener?.("keydown", event => {
    if (event.key !== "Escape") return;
    for (const menu of $$(".more-menu[open]")) { menu.open = false; menu.querySelector("summary").focus(); }
  });
  const focusSearch = () => openQuickSearch().catch(error => banner(error.message));
  $$(".lang-btn").forEach((btn) => btn.addEventListener("click", () => applyLanguage(btn.dataset.lang).catch((err) => banner(String(err.message ?? err)))));
  $$(".navb").forEach((btn) => btn.addEventListener("click", event => { event.preventDefault(); go(btn.dataset.page); }));
  $$("[data-route]").forEach(link => link.addEventListener("click", event => { event.preventDefault(); go(link.dataset.route); }));
  window.addEventListener("hashchange", () => go(location.hash.replace("#/", "")));
  $("#side-search").addEventListener("click", focusSearch);
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      focusSearch();
    }
  });
  $("#btn-reset-agent-filter").addEventListener("click", () => { $("#agent-filter").value = ""; $("#agent-installed").checked = false; localStorage.setItem("hub-agent-installed", "0"); filterAgentCards(); });

  $("#ov-act-conflicts").addEventListener("click", () => {
    skillFilter = "conflict";
    go("skills");
    if (snap) renderSkills();
  });
  $("#ov-act-broken").addEventListener("click", () => repairBroken().catch((err) => banner(String(err.message ?? err))));
  $("#ov-act-unadopted").addEventListener("click", () => startOnboarding().catch((err) => banner(String(err.message ?? err))));
  $("#btn-scan-all").addEventListener("click", () => refresh({ fresh: true }).then(() => notice("banner.scanned")).catch(error => banner(error.message)));

  $("#agent-filter").addEventListener("input", filterAgentCards);
  // Default on: show only agents with detected client evidence until the user opts out (persisted).
  const installedPref = localStorage.getItem("hub-agent-installed");
  $("#agent-installed").checked = installedPref === null ? true : installedPref === "1";
  $("#agent-installed").addEventListener("change", () => {
    localStorage.setItem("hub-agent-installed", $("#agent-installed").checked ? "1" : "0");
    filterAgentCards();
  });
  $("#search-kbd").textContent = /mac/i.test(navigator.platform || "") ? "⌘K" : "Ctrl+K";
  $("#vault-q").addEventListener("input", () => {
    vaultQuery = $("#vault-q").value.trim().toLowerCase();
    renderVaultEntries();
  });
  $("#btn-onboard").addEventListener("click", () => startOnboarding().catch(err => banner(err.message)));
  $("#btn-sync-memory").addEventListener("click", async () => {
    try {
      await syncMemoryEntries();
    } catch (err) { banner(String(err.message ?? err)); }
  });
  $("#btn-mem-a-sync").addEventListener("click", async () => {
    try {
      await syncMemoryEntries();
      const agent = snap.agents.find((item) => item.id === memAgentSel);
      if (agent) await openMemAgent(agent);
    } catch (err) { banner(String(err.message ?? err)); }
  });
  $("#tab-sess-content").addEventListener("click", () => sessTab("content"));
  $("#tab-sess-handoff").addEventListener("click", () => sessTab("handoff"));
  $("#ctx-src-user").addEventListener("click", () => { showCtxView("user"); renderCtxAgentList(); });
  $("#ctx-src-project").addEventListener("click", () => { showCtxView("project"); renderCtxAgentList(); });
  $("#btn-memory-scope").addEventListener("click", async () => {
    try {
      const result = await askScope();
      if (result) notice("banner.scopeDone", { path: result.path });
    } catch (err) { banner(String(err.message ?? err)); }
  });
  $("#btn-scan").addEventListener("click", () => refresh({ fresh: true }).then(() => notice("banner.scanned")).catch(error => banner(error.message)));
  $("#btn-scan-project").addEventListener("click", () => scanProjectSkills());
  $("#btn-open-agents").addEventListener("click", () => openAgentsMd());
  $("#btn-save-agents").addEventListener("click", async () => {
    const cwd = loadedAgentsCwd;
    if (projectFileBusy) return;
    if (!cwd) { notice("banner.loadFileFirst"); return; }
    projectFileBusy = true; $("#btn-save-agents").disabled = true;
    const editor = $("#agents-editor"), content = editor.value;
    try {
      const saved = await api(`/api/file?kind=agents-md&name=${encodeURIComponent(cwd)}`, { method: "PUT", body: JSON.stringify({ content, revision: agentsRevision }) });
      agentsRevision = saved.revision; editor.dataset.loadedContent = saved.content;
      notice("banner.savedAgents", { cwd });
    } catch (error) { banner(error.message); }
    finally { projectFileBusy = false; $("#btn-save-agents").disabled = false; }
  });
  $("#btn-repair").addEventListener("click", () => repairBroken().catch((err) => banner(String(err.message ?? err))));
  $("#btn-adopt").addEventListener("click", async () => {
    const choice = await confirmBox(t("banner.adoptAsk"), t("banner.adoptOk"), t("banner.adoptAlt"));
    if (choice === "cancel" || choice === "") return;
    const report = await api("/api/adopt", {
      method: "POST",
      body: JSON.stringify({ mode: choice === "alt" ? "link-existing" : "adopt" }),
    });
    await refresh();
    notice("banner.adopted", { moved: report.moved.length, linked: report.linked.length, conflicts: report.conflicts.length });
  });
  $("#skill-q").addEventListener("input", () => {
    skillQuery = $("#skill-q").value.trim();
    renderSkills();
  });
  $("#skill-chips").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    skillFilter = chip.dataset.f;
    renderSkills();
  });
  $("#skill-editor").addEventListener("input", () => {
    skillEditEpoch++;
    skillDirty = true;
    $("#skill-saved").textContent = t("skills.dirty");
  });
  $("#btn-save-skill").addEventListener("click", async () => {
    if (!selectedSkill || skillBusy || skillPending) return;
    try {
      await saveSkillTargets(skillTargetsDraft);
    } catch (error) { banner(error.message); }
  });
  $("#btn-open-skill").addEventListener("click", () => {
    if (!selectedSkill) return;
    openFile("skill", undefined, selectedSkill);
  });
  $("#btn-delete-skill").addEventListener("click", async () => {
    if (!selectedSkill || skillBusy || skillPending) return;
    if (!confirm(t("banner.deleteAsk", { name: selectedSkill }))) return;
    snap = await api("/api/skill-delete", {
      method: "POST",
      body: JSON.stringify({ name: selectedSkill }),
    });
    selectedSkill = null;
    skillTargetsDraft = undefined;
    skillDirty = false;
    $("#skill-title").textContent = "SKILL.md";
    $("#skill-meta").textContent = t("skills.pick");
    $("#skill-editor").value = "";
    $("#skill-editor").disabled = true;
    $("#skill-saved").textContent = "";
    $("#btn-save-skill").disabled = true;
    $("#btn-open-skill").disabled = true;
    $("#btn-preview-skill").disabled = true;
    $("#btn-delete-skill").disabled = true;
    renderSkillTargets();
    renderNav();
    renderOverview();
    renderSkills();
    notice("banner.deleted");
  });
  $("#btn-open-user").addEventListener("click", () => openFile("user-md"));
  $("#btn-open-memory").addEventListener("click", () => openFile("memory", undefined, selectedMemory));
  $("#btn-import-memory").addEventListener("click", async () => {
    const report = await api("/api/import-memory", { method: "POST", body: "{}" });
    snap = report.snapshot;
    renderAssets();
    notice("banner.imported", { imported: report.imported.length, skipped: report.skipped.length });
  });
  $("#user-editor").addEventListener("input", () => {
    userDirty = true;
  });
  $("#btn-save-user").addEventListener("click", async () => {
    if (userBusy || userPending || !userLoaded) return;
    userBusy = true;
    updateUserControls();
    const content = $("#user-editor").value;
    try {
      const saved = await api("/api/file?kind=user-md", {
        method: "PUT", body: JSON.stringify({ content, revision: userRevision }),
      });
      userRevision = saved.revision;
      userDirty = $("#user-editor").value !== content;
      if (snap?.userMd) snap.userMd = { path: saved.path, content: saved.content };
      if (userDirty) banner(`${t("banner.savedUser")} ${t("memory.newerDraft")}`);
      else notice("banner.savedUser");
    } catch (error) {
      banner(error.status === 409 ? t("banner.fileConflictKept") : error.message);
    } finally { userBusy = false; updateUserControls(); }
  });
  $("#memory-editor").addEventListener("input", () => {
    memoryDirty = true;
    memoryEditEpoch++;
  });
  $("#btn-save-memory").addEventListener("click", async () => {
    try { await finishMemorySave(await saveMemoryDraft()); }
    catch (error) { banner(error.message); }
  });
  $("#btn-memory-reload").addEventListener("click", () => openMemory(selectedMemory).catch(error => banner(error.message)));
  $("#btn-memory-merge").addEventListener("click", async () => {
    const conflict = memoryConflict;
    if (!conflict || conflict.id !== selectedMemory || memoryBusy || memoryPending) return;
    if (!confirm(t("memory.mergeConfirm"))) return;
    try { await finishMemorySave(await saveMemoryDraft(conflict.revision)); }
    catch (error) { banner(error.message); }
  });
  $("#btn-remember").addEventListener("click", async () => {
    if (memoryBusy || memoryPending || !memoryLoaded) return;
    const text = $("#remember-text").value.trim();
    if (!text) return;
    const id = selectedMemory;
    let committed = null;
    try {
      if (memoryDirty) {
        const saved = await saveMemoryDraft();
        if (!saved) return;
        if (memoryDirty) { notice("memory.newerDraft"); return; }
      }
      if (selectedMemory !== id) return;
      memoryBusy = true;
      updateMemoryControls();
      const editEpoch = memoryEditEpoch;
      committed = await api("/api/remember", {
        method: "POST", body: JSON.stringify({ text, project: id === "global" ? undefined : id }),
      });
      // Clear only the submitted text; do not erase another note typed while waiting.
      if ($("#remember-text").value.trim() === text) $("#remember-text").value = "";
      const file = await api(`/api/file?kind=memory&name=${encodeURIComponent(id)}`);
      if (memoryEditEpoch === editEpoch) applyMemoryFile(id, file);
      else {
        memoryConflict = { id, content: file.content, revision: file.revision };
        memoryDirty = true;
        renderMemoryConflict();
      }
      await refresh();
      banner(memoryDeliveryMessage(committed, "banner.remembered") + (memoryDirty ? ` ${t("memory.conflictKept")}` : ""));
    } catch (error) {
      if (committed) {
        memoryDirty = true;
        banner(`${t("memory.savedReloadFailed")} ${error.message}`);
      } else if (error.status === 409) await loadMemoryConflict(id);
      else banner(error.message);
    } finally { memoryBusy = false; updateMemoryControls(); }
  });
  $("#btn-new-project").addEventListener("click", async () => {
    if (memoryBusy || memoryPending) return;
    const ask = typeof askText === "function"
      ? askText
      : (opts) => { const v = prompt(opts.title); return v == null || !v.trim() ? null : v.trim(); };
    const id = await Promise.resolve(ask({
      title: t("banner.newProject"),
      validate: (v) => (/^[A-Za-z0-9._-]+$/.test(v) && !["global", "global.md", ".", ".."].includes(v.toLowerCase()) ? null : t("dialog.invalidId")),
    }));
    if (!id || memoryBusy || memoryPending) return;
    const epoch = ++memoryLoadEpoch;
    memoryBusy = true;
    updateMemoryControls();
    try {
      await api(`/api/file?kind=memory&name=${encodeURIComponent(id)}`, {
        method: "POST", body: JSON.stringify({ content: `# ${id}\n\n${t("memory.projectSeed")}\n` }),
      });
    } catch (error) { banner(error.message); return; }
    finally { memoryBusy = false; updateMemoryControls(); }
    try {
      await refresh();
      // Selection only changes after openMemory accepts the discard decision and its response.
      if (epoch === memoryLoadEpoch) await openMemory(id);
    } catch (error) { banner(error.message); }
  });
  $("#btn-index").addEventListener("click", async () => {
    notice("banner.indexing");
    const report = await api("/api/index", { method: "POST", body: "{}" });
    snap = report.snapshot;
    renderNav();
    renderOverview();
    await loadSessions();
    notice("banner.indexed", { count: report.count ?? report.upserted, pruned: report.pruned });
  });
  $("#session-q").addEventListener("input", () => {
    clearTimeout(window.__sessTimer);
    window.__sessTimer = setTimeout(() => loadSessions().catch((err) => banner(String(err.message ?? err))), 200);
  });
  $("#session-own").addEventListener("change", () => {
    updateHandoffButton();
    loadSessions();
  });
  $("#btn-reveal").addEventListener("click", async () => {
    const row = sessionState.selected;
    if (!row) return;
    await api("/api/reveal", {
      method: "POST",
      body: JSON.stringify({ agent: row.agent_id, sessionId: row.session_id }),
    });
    notice("banner.finder");
  });
  $("#btn-handoff").addEventListener("click", async () => {
    const row = sessionState.selected;
    if (!row) return;
    const ownOnly = sessionIsOwn(row);
    if (ownOnly && !$("#session-own").checked) {
      notice("banner.ownHandoff");
      return;
    }
    const result = await api("/api/handoff", {
      method: "POST",
      body: JSON.stringify({
        from: row.agent_id,
        to: $("#handoff-to").value,
        sessionId: row.session_id,
        cwd: row.cwd,
        forceOwn: ownOnly,
      }),
    });
    const lines = [
      result.record.path,
      result.resume.note,
      result.resume.argv.join(" "),
      result.resume.mcp ? `${result.resume.mcp.tool} ${JSON.stringify(result.resume.mcp.args)}` : "",
    ].filter(Boolean);
    $("#handoff-out").textContent = lines.join("\n");
    if (result.resume.argv.length) {
      const launch = document.createElement("button");
      launch.type = "button";
      launch.className = "btn sm";
      launch.textContent = result.resume.kind === "cursor-open" ? t("banner.launchFinder") : t("banner.launchTerm");
      launch.addEventListener("click", async () => {
        try {
          await api("/api/handoff/launch", { method: "POST", body: JSON.stringify({ id: result.record.id, forceOwn: ownOnly }) });
          banner(result.resume.kind === "cursor-open" ? t("banner.handoffShow") : t("banner.handoffTerm"));
        } catch (err) { banner(String(err.message ?? err)); }
      });
      $("#handoff-out").append(document.createElement("br"), launch);
    }
    notice("banner.handoffWrote");
    try { await loadSessions(); }
    catch (err) { banner(String(err.message ?? err)); }
  });
  $("#vault-editor").addEventListener("input", () => {
    vaultState.dirty = true;
    vaultState.markdown = vaultState.reveal ? $("#vault-editor").value : mergeVaultDraft($("#vault-editor").value, vaultState.markdown);
  });
  window.addEventListener("blur", () => {
    vaultRevealEpoch++;
    vaultState.reveal = false;
    $("#vault-editor").value = maskNow(vaultState.markdown);
    $("#btn-vault-reveal").textContent = t("vault.show");
  });
  $("#vault-editor").addEventListener("blur", () => {
    vaultRevealEpoch++;
    vaultState.reveal = false;
    $("#vault-editor").value = maskNow(vaultState.markdown);
    $("#btn-vault-reveal").textContent = t("vault.show");
  });
  $("#btn-vault-reveal").addEventListener("mousedown", (ev) => ev.preventDefault());
  $("#btn-vault-reveal").addEventListener("click", () => {
    toggleVaultReveal().catch((err) => banner(String(err.message ?? err)));
  });
  $("#btn-save-vault").addEventListener("click", async () => {
    if (vaultBusy) return;
    setVaultBusy(true);
    try {
      const saved = await api("/api/vault", {
        method: "PUT",
        body: JSON.stringify({ markdown: vaultState.markdown, revision: vaultState.revision, secretFields: vaultState.secretFields }),
      });
      applyVaultPayload(saved);
      await refreshAfterVault("banner.vaultSaved");
    } catch (err) { banner(String(err.message ?? err)); }
    finally { setVaultBusy(false); }
  });
  $("#btn-vault-restore").addEventListener("click", async () => {
    if (vaultBusy) return;
    const choice = await confirmBox(t("vault.restoreConfirm"), t("vault.restorePrevious"));
    if (choice !== "ok") return;
    setVaultBusy(true);
    try {
      const restored = await api("/api/vault/restore-previous", { method: "POST", body: "{}" });
      applyVaultPayload(restored);
      await refreshAfterVault("banner.vaultRestored");
    } catch (err) { banner(String(err.message ?? err)); }
    finally { setVaultBusy(false); }
  });
}

/* ================= vault ================= */

function setVaultBusy(busy) {
  vaultBusy = busy;
  if (busy) vaultLoadEpoch++;
  $("#vault-editor").readOnly = busy;
  $("#btn-save-vault").disabled = busy;
  $("#btn-vault-reveal").disabled = busy;
  const restore = $("#btn-vault-restore");
  if (restore) restore.disabled = busy;
}

async function loadVault() {
  if (vaultBusy) return;
  if (vaultState.dirty && !confirm(t("banner.vaultDiscard"))) return;
  const epoch = ++vaultLoadEpoch;
  const draft = JSON.stringify(vaultState);
  const data = await api("/api/vault");
  if (epoch !== vaultLoadEpoch || draft !== JSON.stringify(vaultState)) return;
  applyVaultPayload(data);
}

async function refreshAfterVault(key, params) {
  try {
    const updated = await api("/api/snapshot");
    snap = updated;
    renderAll();
    notice(key, params);
  } catch (error) {
    notice("banner.refreshFail", { message: t(key, params), error: error.message });
  }
}

function applyVaultPayload(data) {
  if (snap?.vault) snap.vault = { ...snap.vault, status: "ready", entries: data.entries, count: data.entries.length, error: null };
  vaultState.markdown = data.markdown ?? data.masked;
  vaultState.revision = data.revision;
  vaultState.secretFields = data.secretFields ?? {};
  vaultState.masked = data.masked;
  vaultState.entries = data.entries;
  vaultState.reveal = false;
  vaultState.dirty = false;
  vaultLoaded = true;
  $("#vault-path").textContent = data.path;
  $("#btn-vault-reveal").textContent = t("vault.show");
  $("#vault-editor").value = data.masked;
  // Direct #/vault load races refresh(): snap can still be null here; refresh() re-loads the vault afterwards.
  if (snap) {
    renderNav();
    renderVaultEntries();
  }
}

function renderVaultEntries() {
  const list = $("#vault-entries");
  list.replaceChildren();
  const entries = vaultQuery
    ? vaultState.entries.filter((entry) => entry.id.toLowerCase().includes(vaultQuery) || (entry.note || "").toLowerCase().includes(vaultQuery))
    : vaultState.entries;
  if (!entries.length) {
    list.append(item(vaultState.entries.length ? t("vault.noMatch") : t("vault.empty")));
    return;
  }
  for (const entry of entries) {
    const wrap = document.createElement("li");
    wrap.className = "vault-entry";
    const title = document.createElement("div");
    title.className = "id";
    title.textContent = entry.id;
    if (entry.note) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = "  " + entry.note;
      title.append(note);
    }
    const grants = document.createElement("div");
    grants.className = "grants";
    for (const agent of snap.agents.filter(a => a.supportsVault)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "grant" + (entry.agents.includes(agent.id) ? " is-on" : "");
      btn.textContent = agent.id;
      btn.addEventListener("click", async () => {
        if (vaultBusy) return;
        if (vaultState.dirty) { notice("banner.vaultDraftFirst"); return; }
        const set = new Set(entry.agents);
        if (set.has(agent.id)) set.delete(agent.id);
        else set.add(agent.id);
        setVaultBusy(true);
        try {
          const saved = await api("/api/vault/grant", {
            method: "POST",
            body: JSON.stringify({ id: entry.id, agents: [...set], revision: vaultState.revision }),
          });
          applyVaultPayload(saved);
          await refreshAfterVault("banner.vaultGrant", { id: entry.id, who: [...set].join(", ") || t("banner.nobody") });
        } catch (err) { banner(String(err.message ?? err)); }
        finally { setVaultBusy(false); }
      });
      grants.append(btn);
    }
    // Children order is contractual: tests reach markSecret at children[2] and unmarkSecret at children[3].
    const markSecret = document.createElement("button");
    markSecret.type = "button";
    markSecret.className = "btn sm";
    markSecret.textContent = t("vault.markSecret");
    markSecret.addEventListener("click", () => {
      if (vaultBusy) return;
      whenText(askText({ title: t("banner.vaultPromptMark", { id: entry.id }) }), (name) => {
        vaultState.secretFields[entry.id] = [...new Set([...(vaultState.secretFields[entry.id] || []), name])];
        vaultState.dirty = true;
        if (!vaultState.reveal) $("#vault-editor").value = maskNow(vaultState.markdown);
        notice("banner.vaultSecretAdded");
      });
    });
    const unmarkSecret = document.createElement("button");
    unmarkSecret.type = "button";
    unmarkSecret.className = "btn sm";
    unmarkSecret.textContent = t("vault.unmarkSecret");
    unmarkSecret.addEventListener("mousedown", (ev) => ev.preventDefault());
    unmarkSecret.addEventListener("click", () => {
      if (vaultBusy) return;
      if (!vaultState.reveal) { notice("banner.vaultNeedReveal"); return; }
      whenText(askText({ title: t("banner.vaultPromptUnmark", { id: entry.id }) }), (name) => {
        if (/密钥|密码|token|key|secret/i.test(name)) { notice("banner.vaultKeepSecret"); return; }
        vaultState.secretFields[entry.id] = (vaultState.secretFields[entry.id] || []).filter(field => field !== name);
        vaultState.dirty = true;
        notice("banner.vaultUnmarked");
      });
    });
    wrap.append(title, grants, markSecret, unmarkSecret);
    list.append(wrap);
  }
}

function maskNow(md) {
  let entry = "";
  let secret = false;
  const TOP_FIELD = /^([^ \t#:：][^:：]*)[:：]\s*(.*)$/;
  return md.split("\n").flatMap((line) => {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { entry = heading[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); secret = false; return [line]; }
    if (line.startsWith("  ")) return [secret && line.trim() ? "  ••••••••" : line];
    const field = line.match(TOP_FIELD);
    if (field) {
      const name = field[1].trim();
      secret = !/^(说明|desc|description)$/i.test(name) && (/密钥|密码|token|key|secret/i.test(name) || (vaultState.secretFields?.[entry] ?? []).includes(name));
      return [secret ? `${name}: ••••••••` : line];
    }
    return secret && line.trim() && !line.startsWith("#") ? ["••••••••"] : [line];
  }).join("\n");
}

async function toggleVaultReveal() {
  if (vaultBusy) return;
  const epoch = ++vaultRevealEpoch;
  if (vaultState.reveal) {
    vaultState.reveal = false;
    $("#vault-editor").value = maskNow(vaultState.markdown);
    $("#btn-vault-reveal").textContent = t("vault.show");
    return;
  }
  setVaultBusy(true);
  try {
  if (!vaultState.dirty || vaultState.markdown.includes("••••••••")) {
    const data = await api("/api/vault?reveal=1");
    if (epoch !== vaultRevealEpoch) return;
    if (vaultState.dirty && data.revision !== vaultState.revision) throw new Error(t("banner.vaultStale"));
    vaultState.markdown = vaultState.dirty ? mergeVaultDraft(vaultState.markdown, data.markdown ?? data.masked) : (data.markdown ?? data.masked);
    vaultState.revision = data.revision;
    if (!vaultState.dirty) vaultState.secretFields = data.secretFields ?? {};
  }
  vaultState.reveal = true;
  $("#vault-editor").value = vaultState.markdown;
  $("#btn-vault-reveal").textContent = t("vault.hide");
  } finally { setVaultBusy(false); }
}

/* ================= project skills / agents.md ================= */

async function scanProjectSkills() {
  const cwd = $("#project-cwd").value.trim();
  if (!cwd) {
    notice("banner.needCwd");
    return;
  }
  const data = await api(`/api/project-skills?cwd=${encodeURIComponent(cwd)}`);
  rememberProject(cwd);
  const list = $("#project-skills");
  list.replaceChildren();
  if (!data.skills.length) {
    list.append(item(t("banner.noProjectSkills")));
    return;
  }
  for (const row of data.skills) {
    const li = document.createElement("li");
    li.className = "conflict-row";
    li.append(`${row.inHub ? t("banner.inHub") : ""}${row.name}  ${row.rel}`);
    if (!row.inHub) {
      const btn = document.createElement("button");
      btn.className = "btn sm";
      btn.textContent = t("banner.promote");
      btn.addEventListener("click", async () => {
        const result = await api("/api/promote", {
          method: "POST",
          body: JSON.stringify({ cwd, name: row.name }),
        });
        snap = result.snapshot;
        renderAssets();
        await scanProjectSkills();
        notice("banner.promoted", { name: row.name });
      });
      li.append(btn);
    }
    list.append(li);
  }
}

async function openAgentsMd() {
  if (projectFileBusy) return;
  const editor = $("#agents-editor");
  if (loadedAgentsCwd && editor.value !== editor.dataset.loadedContent && !confirm(t("banner.discardAgents"))) return;
  const cwd = $("#agents-cwd").value.trim();
  if (!cwd) { notice("banner.needCwd"); return; }
  const epoch = ++projectLoadEpoch, previous = editor.value;
  $("#btn-save-agents").disabled = true;
  try {
    const file = await api(`/api/file?kind=agents-md&name=${encodeURIComponent(cwd)}`);
    if (epoch !== projectLoadEpoch) return;
    if (editor.value !== previous) { notice("memory.newerDraft"); return; }
    loadedAgentsCwd = cwd; agentsRevision = file.revision;
    $("#agents-path").textContent = file.path;
    editor.value = file.content; editor.dataset.loadedContent = file.content;
    rememberProject(cwd);
    if (!file.exists) notice("banner.noAgentsMd");
  } catch (error) { banner(error.message); }
  finally { if (epoch === projectLoadEpoch) $("#btn-save-agents").disabled = !loadedAgentsCwd; }
}

function sessionIsOwn(row) {
  const agent = snap?.agents.find((item) => item.id === row.agent_id);
  return agent?.bind.sessions === "own";
}

function sessTab(name) {
  sessionTab = name;
  $("#tab-sess-content").classList.toggle("on", name === "content");
  $("#tab-sess-handoff").classList.toggle("on", name === "handoff");
  $("#sess-pane-content").classList.toggle("hidden", name !== "content");
  const handoff = $("#sess-pane-handoff");
  handoff.classList.toggle("hidden", name !== "handoff");
  handoff.style.display = name === "handoff" ? "block" : "";
}

function renderSessionMessages(data) {
  const flow = $("#sess-c-flow");
  flow.replaceChildren();
  if (!data.messages.length && !data.raw) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = t("sessions.emptyMessages");
    flow.append(empty);
    return;
  }
  for (const msg of data.messages) {
    const div = document.createElement("div");
    div.className = "msg " + msg.role;
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = msg.role;
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = msg.text;
    div.append(role, text);
    flow.append(div);
  }
  const spoken = data.messages.some((msg) => msg.role === "user" || msg.role === "assistant");
  if (!spoken && data.raw) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = t("sessions.noMessages");
    flow.append(hint);
    const pre = document.createElement("pre");
    pre.className = "handoff-out";
    pre.textContent = data.raw;
    flow.append(pre);
  }
}

async function openSessionContent(row) {
  const key = `${row.agent_id}/${row.session_id}`;
  sessContentKey = key;
  $("#sess-c-flow").replaceChildren();
  $("#sess-c-path").textContent = row.source_path;
  $("#sess-c-hint").textContent = t("sessions.loading");
  try {
    const data = await api(`/api/session/content?agent=${encodeURIComponent(row.agent_id)}&id=${encodeURIComponent(row.session_id)}`);
    if (sessContentKey !== key) return;
    $("#sess-c-path").textContent = data.path;
    const when = new Date(row.mtime).toLocaleString(getLang() === "en" ? "en-US" : "zh-CN");
    $("#sess-c-hint").textContent = `${row.agent_id} · ${row.session_id} · ${when}` + (data.truncated ? ` · ${t("sessions.truncated")}` : "");
    renderSessionMessages(data);
  } catch (err) {
    if (sessContentKey !== key) return;
    $("#sess-c-hint").textContent = t("sessions.loadFail", { error: err.message });
  }
}

function updateHandoffButton() {
  const row = sessionState.selected;
  const blocked = row && sessionIsOwn(row) && !$("#session-own").checked;
  $("#btn-handoff").disabled = !row || blocked;
}

function clearSessionView() {
  sessionState = { sessions: [], handoffs: [], selected: null, unavailable: true };
  sessContentKey = "";
  $("#handoff-out").textContent = "";
  $("#session-meta").textContent = t("sessions.unavailable");
  $("#session-path").textContent = "";
  $("#sess-c-hint").textContent = t("sessions.unavailable");
  $("#sess-c-path").textContent = "";
  $("#sess-c-flow").replaceChildren();
  updateHandoffButton(); renderSessions();
}

async function loadSessions() {
  const epoch = ++sessionLoadEpoch;
  const q = encodeURIComponent($("#session-q").value.trim());
  const own = $("#session-own").checked ? "1" : "0";
  let data;
  try { data = await api(`/api/sessions?q=${q}&own=${own}&limit=120`); }
  catch (error) {
    if (epoch !== sessionLoadEpoch) return;
    if (error.status === 503) clearSessionView();
    throw error;
  }
  if (epoch !== sessionLoadEpoch) return;
  sessionState.unavailable = false;
  if (!sessionState.selected) $("#session-meta").textContent = t("sessions.metaPick");
  sessionState.sessions = data.sessions;
  sessionState.handoffs = data.handoffs;
  if (sessionState.selected && !sessionState.sessions.some((row) => row.agent_id === sessionState.selected.agent_id && row.session_id === sessionState.selected.session_id)) {
    sessionState.selected = null;
    sessContentKey = "";
    $("#sess-c-flow").replaceChildren();
    $("#sess-c-path").textContent = "";
    $("#sess-c-hint").textContent = t("sessions.contentHint");
    $("#session-path").textContent = "";
    $("#session-meta").textContent = t("sessions.metaPick");
    $("#handoff-out").textContent = "";
  }
  updateHandoffButton();
  renderSessions();
  renderNav();
}

function renderSessions() {
  const body = $("#session-rows");
  body.replaceChildren();
  if (!sessionState.sessions.length) {
    body.innerHTML = `<tr><td colspan="2"><div class="empty">${sessionState.unavailable ? t("sessions.indexUnavailable") : t("sessions.empty")}</div></td></tr>`;
  }
  for (const row of sessionState.sessions) {
    const tr = document.createElement("tr");
    tr.className = "session-row" + (sessionState.selected && sessionState.selected.agent_id === row.agent_id && sessionState.selected.session_id === row.session_id ? " is-sel" : "");
    const when = new Date(row.mtime).toLocaleString(getLang() === "en" ? "en-US" : "zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const oneLine = (s) => String(s ?? "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
    const title = oneLine(row.title);
    const summary = oneLine(row.summary);
    const extra = summary && summary !== title ? `<span class="summary">${esc(summary)}</span>` : "";
    tr.innerHTML = `<td><strong class="session-title">${esc(title || t("sessions.untitled"))}</strong>${extra}<span class="session-context">${esc(row.agent_id)} · ${esc(row.cwd?.split(/[\\/]/).filter(Boolean).pop() || t("sessions.noProject"))}</span></td><td class="mono session-time">${esc(when)}</td>`;
    tr.title = [title, row.cwd].filter(Boolean).join("\n");
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    const openRow = () => {
      sessionState.selected = row;
      $("#session-meta").textContent = `${row.agent_id} · ${row.session_id}`;
      $("#session-path").textContent = row.source_path;
      updateHandoffButton();
      if (![...$("#handoff-to").options].some((opt) => opt.selected && opt.value !== row.agent_id)) {
        const grok = [...$("#handoff-to").options].find((opt) => opt.value === "grok");
        if (row.agent_id !== "grok" && grok) $("#handoff-to").value = "grok";
      }
      renderSessions();
      sessTab("content");
      openSessionContent(row);
    };
    tr.addEventListener("click", openRow);
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openRow();
      }
    });
    body.append(tr);
  }
  const hl = $("#handoff-list");
  hl.replaceChildren();
  if (!sessionState.handoffs.length) hl.append(item(sessionState.unavailable ? t("sessions.handoffsUnavailable") : t("sessions.noHandoffs")));
  for (const itemRow of sessionState.handoffs) {
    const li = document.createElement("li");
    li.className = "handoff-item";
    const text = document.createElement("span");
    text.textContent = `${itemRow.from} → ${itemRow.to}  ${itemRow.sessionId}`;
    const acts = document.createElement("span");
    acts.className = "handoff-acts";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn sm";
    openBtn.textContent = t("handoff.openSession");
    openBtn.addEventListener("click", () => openHandoffSession(itemRow).catch((err) => banner(String(err.message ?? err))));
    const launchBtn = document.createElement("button");
    launchBtn.type = "button";
    launchBtn.className = "btn sm";
    launchBtn.textContent = t("handoff.launch");
    launchBtn.addEventListener("click", async () => {
      launchBtn.disabled = true;
      try {
        await api("/api/handoff/launch", { method: "POST", body: JSON.stringify({ id: itemRow.id }) });
        notice("banner.handoffLaunched");
      } catch (err) { banner(String(err.message ?? err)); }
      finally { launchBtn.disabled = false; }
    });
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn sm";
    copyBtn.textContent = t("handoff.copyPath");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(itemRow.path);
        notice("banner.pathCopied");
      } catch { banner(itemRow.path); }
    });
    acts.append(openBtn, launchBtn, copyBtn);
    li.append(text, acts);
    hl.append(li);
  }
}

function acceptSnapshot(next) {
  const prevIndexed = snap && snap.sessions ? snap.sessions.indexedAt : undefined;
  const nextIndexed = next && next.sessions ? next.sessions.indexedAt : undefined;
  const diskChanged = Boolean(snap) && (next.diskEpoch !== snap.diskEpoch || next.metadataRevision !== snap.metadataRevision);
  const sessionsChanged = Boolean(snap) && nextIndexed !== prevIndexed;
  snap = next;
  if (next.sync) {
    renderSyncStatus();
    renderSnapshotWarnings();
    renderOverviewWarnings();
  }
  if (diskChanged) {
    renderAll();
    if (!keepDiskChangedQuiet()) notice("banner.diskChanged");
  }
  if (sessionsChanged && currentPage === "sessions") {
    loadSessions().catch((err) => banner(String(err.message ?? err)));
  }
}

async function openHandoffSession(rec) {
  go("sessions");
  await loadSessions();
  const row = sessionState.sessions.find((s) => s.agent_id === rec.from && s.session_id === rec.sessionId);
  if (!row) {
    notice("sessions.notInList");
    return;
  }
  sessionState.selected = row;
  $("#session-meta").textContent = `${row.agent_id} · ${row.session_id}`;
  $("#session-path").textContent = row.source_path;
  updateHandoffButton();
  renderSessions();
  sessTab("content");
  openSessionContent(row);
}

/* ================= boot ================= */

applyLanguage(detectLang());
bindChrome();
$$("[data-preview]").forEach((btn) => {
  const textarea = document.getElementById(btn.dataset.preview);
  wirePreview(textarea, btn);
});
$("#side-host").textContent = location.host;
go(location.hash.replace("#/", ""), { replace: true });
refresh().catch((err) => banner(String(err.message ?? err)));
let snapshotPollRunning = false;
async function pollSnapshot() {
  if (!snap || document.hidden || snapshotPollRunning) return;
  snapshotPollRunning = true;
  try { acceptSnapshot(await api("/api/snapshot")); }
  catch { renderSyncStatus(true); }
  finally { snapshotPollRunning = false; }
}
setInterval(pollSnapshot, 8000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void pollSnapshot(); });
