import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { after, before, test } from "node:test";
import { adapterCommand } from "./adapters.ts";
import { applyBind } from "./bind.ts";
import { ensureHub, hubPaths, loadConfig, saveConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { writeText } from "./fsx.ts";
import { localizeResponse } from "./locale.ts";
import { redactSecrets, MIN_REDACT_SECRET_LENGTH } from "./secrets.ts";
import { buildSnapshot } from "./snapshot.ts";
import { i18nPrelude, i18nSandbox } from "./ui-vm.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-audit-0918-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;
const prevKey = process.env.AGENT_HUB_VAULT_KEY;

before(async () => {
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = "c3".repeat(32);
  await fs.mkdir(path.join(home, ".grok", "sessions"), { recursive: true });
  await ensureHub();
});

after(async () => {
  process.env.HOME = prevHome;
  if (prevRoot) process.env.AGENT_HUB_ROOT = prevRoot;
  else delete process.env.AGENT_HUB_ROOT;
  if (prevKey) process.env.AGENT_HUB_VAULT_KEY = prevKey;
  else delete process.env.AGENT_HUB_VAULT_KEY;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("short secrets are not used for redaction", () => {
  const pin = "1234";
  assert.ok(pin.length < MIN_REDACT_SECRET_LENGTH);
  const text = "Session 2026-09-18 id=abc1234 title=lunch at 1234";
  assert.equal(redactSecrets(text, [pin, "sk-live-secret-value"]), text.replaceAll("sk-live-secret-value", "***"));
  assert.equal(redactSecrets(text, [pin]), text);
});

test("corrupt inject-state and autoload JSON do not take down snapshot", async () => {
  await writeText(path.join(hubPaths().memory, "inject-state.json"), "{not-json");
  await writeText(path.join(hubPaths().memory, "autoload.json"), "]oops");
  const snap = await buildSnapshot();
  assert.equal(typeof snap.hubRoot, "string");
  const grok = snap.agents.find((row) => row.id === "grok");
  assert.equal(grok?.command, "grok");
});

test("uninstalled Ctx=Hub and Vault=Hub are 409, not inject-failed 500", async () => {
  await assert.rejects(
    () => applyBind({ agent: "workbuddy", layer: "ctx", value: "hub" }),
    (err: unknown) => err instanceof HubError && err.status === 409 && /未检测到安装/.test(err.message),
  );
  await assert.rejects(
    () => applyBind({ agent: "workbuddy", layer: "vault", value: "hub" }),
    (err: unknown) => err instanceof HubError && err.status === 409 && /未检测到安装/.test(err.message),
  );
});

test("localizeResponse translates catalog labels", () => {
  const body = { catalog: [{ id: "roo", label: "Roo Code（已归档）", present: false, enabled: false, memoryOnly: true }] };
  const en = localizeResponse(body, "en");
  assert.equal(en.catalog[0]!.label, "Roo Code (archived)");
});

test("adapterCommand uses grok-hyper for hyper vault exec", () => {
  assert.equal(adapterCommand("hyper"), "grok-hyper");
  assert.equal(adapterCommand("cursor"), "cursor");
});

test("mergeLayers keeps layers.vault.default", async () => {
  const config = await loadConfig();
  config.layers.vault.default = "hub";
  await saveConfig(config);
  assert.equal((await loadConfig()).layers.vault.default, "hub");
  config.layers.vault.default = "off";
  await saveConfig(config);
});

test("openSkill drops a stale response after a newer click", async () => {
  const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function openSkill(");
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  const fn = source.slice(start, next < 0 ? undefined : start + 1 + next);
  let resolveA!: (value: { path: string; content: string; revision: string }) => void;
  const a = new Promise<{ path: string; content: string; revision: string }>((resolve) => { resolveA = resolve; });
  const calls: string[] = [];
  const els: Record<string, { textContent: string; value: string; disabled: boolean; nextElementSibling: null }> = {};
  const get = (key: string) => {
    if (!els[key]) els[key] = { textContent: "", value: "", disabled: false, nextElementSibling: null };
    return els[key];
  };
  const context = vm.createContext(i18nSandbox({
    skillBusy: false,
    skillDirty: false,
    skillLoadEpoch: 0,
    selectedSkill: null,
    confirm: () => true,
    $: get,
    api: async (url: string) => {
      calls.push(url);
      if (url.includes("skill-a")) return a;
      return { path: "/b", content: "B", revision: "rb" };
    },
    renderSkills() {},
    renderSkillTargets() {},
    renderMarkdown: () => "",
  }));
  vm.runInContext(await i18nPrelude() + "\n" + fn, context);
  const first = context.openSkill("skill-a");
  await context.openSkill("skill-b");
  resolveA({ path: "/a", content: "A-STALE", revision: "ra" });
  await first;
  assert.equal(context.selectedSkill, "skill-b");
  assert.equal(get("#skill-editor").value, "B");
  assert.deepEqual(calls.length, 2);
});

test("unmark secret button ignores mousedown so Chrome blur cannot steal reveal", async () => {
  const app = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  const block = app.slice(app.indexOf("const unmarkSecret = document.createElement"), app.indexOf("wrap.append(title, grants, markSecret, unmarkSecret)"));
  assert.match(block, /unmarkSecret\.addEventListener\("mousedown"/);
  assert.match(block, /preventDefault/);
});
