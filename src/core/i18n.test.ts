import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { STRINGS, t, setLang, getLang } from "../../web/i18n.js";
import { translateError } from "../../web/errors.js";
import { consumeLangFlag, t as cliT, getLang as cliLang } from "./locale.ts";

const exec = promisify(execFile);

test("UI catalogs expose the same keys in zh and en", () => {
  assert.deepEqual(Object.keys(STRINGS.zh).sort(), Object.keys(STRINGS.en).sort());
});

test("UI t() switches zh/en and interpolates", () => {
  setLang("zh");
  assert.equal(getLang(), "zh");
  assert.equal(t("nav.overview"), "概览");
  assert.equal(t("overview.subN", { n: 3 }), "一份资产，投递到 3 个 Agent");
  setLang("en");
  assert.equal(t("nav.overview"), "Overview");
  assert.equal(t("overview.subN", { n: 3 }), "One store, delivered to 3 agents");
  setLang("zh");
});

test("translateError maps protocol and Hub errors both ways", () => {
  assert.equal(translateError("session required", "zh"), "需要本机会话");
  assert.equal(translateError("需要本机会话", "en"), "session required");
  assert.equal(translateError("保险库暂不可用，已暂停索引和交接访问；原文件保持不变，请恢复保险库后重试", "en"), "Vault unavailable; indexing and handoff are paused. Source files are unchanged. Restore the vault and retry.");
  assert.equal(translateError("Hub 中没有 skill: demo", "en"), "No such Hub skill: demo");
  assert.equal(translateError("No such Hub skill: demo", "zh"), "Hub 中没有 skill: demo");
  assert.equal(translateError("session required", null), "session required");
});

test("CLI --lang and HUB_LANG select help language", async () => {
  consumeLangFlag(["--lang", "en"]);
  assert.equal(cliLang(), "en");
  assert.match(cliT("help"), /Scan local adapters/);
  consumeLangFlag([], { HUB_LANG: "zh" } as NodeJS.ProcessEnv);
  assert.equal(cliLang(), "zh");
  assert.match(cliT("help"), /扫描本机适配器/);
  const cli = new URL("../cli.ts", import.meta.url).pathname;
  const en = await exec(process.execPath, ["--import", "tsx", cli, "--lang", "en", "help"], { env: { ...process.env, HUB_LANG: "zh" } });
  assert.match(en.stdout, /Scan local adapters/);
  const zh = await exec(process.execPath, ["--import", "tsx", cli, "help"], { env: { ...process.env, HUB_LANG: "zh" } });
  assert.match(zh.stdout, /扫描本机适配器/);
  assert.deepEqual(consumeLangFlag(["vault", "get", "x", "--exec", "--", "--lang", "en"]), ["vault", "get", "x", "--exec", "--", "--lang", "en"]);
});
