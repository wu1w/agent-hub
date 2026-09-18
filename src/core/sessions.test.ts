import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { loadConfig, setBind } from "./config.ts";
import { createHandoff, listHandoffs, resumePlan } from "./handoff.ts";
import { closeSessionIndex, cursorFolderToCwd, getSession, listSessions, rebuildIndex, visibleHubSessions } from "./sessions.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-sess-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;

before(async () => {
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  await fs.mkdir(path.join(home, ".grok", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".cursor", "projects"), { recursive: true });
  await fs.mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".grok-hyper", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".workbuddy", "sessions"), { recursive: true });

  const grokSid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const grokDir = path.join(home, ".grok", "sessions", encodeURIComponent("/Users/demo/world"), grokSid);
  await fs.mkdir(grokDir, { recursive: true });
  // Grok stores non-session files beside its session directories.
  await fs.writeFile(path.join(path.dirname(grokDir), "prompt_history.jsonl"), "{}\n");
  await fs.writeFile(path.join(path.dirname(grokDir), ".cwd"), "/Users/demo/world\n");
  await fs.writeFile(
    path.join(grokDir, "summary.json"),
    JSON.stringify({
      info: { id: grokSid, cwd: "/Users/demo/world" },
      generated_title: "WorldRules lock",
      session_summary: "Locked the world object and dropped legacy tools.",
      updated_at: "2026-09-12T23:43:55.401460Z",
    }),
  );

  const cursorSid = "11111111-2222-4333-8444-555555555555";
  const proj = path.join(home, "world");
  await fs.mkdir(proj, { recursive: true });
  const cursorDir = path.join(home, ".cursor", "projects", "world", "agent-transcripts", cursorSid);
  await fs.mkdir(cursorDir, { recursive: true });
  await fs.writeFile(
    path.join(cursorDir, `${cursorSid}.jsonl`),
    `${JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "<user_query>\nImplement steward only\n</user_query>" }] },
    })}\n`,
  );

  const codexSid = "01a0a442-0e4d-7261-bf30-856695a12308";
  const codexDir = path.join(home, ".codex", "sessions", "2026", "09", "15");
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(
    path.join(codexDir, `rollout-2026-09-15T16-49-47-${codexSid}.jsonl`),
    [
      JSON.stringify({
        type: "session_meta",
        payload: { session_id: codexSid, cwd: "/Users/demo/medical-harness" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the audit report" }],
        },
      }),
    ].join("\n") + "\n",
  );

  const hyperSid = "26083339f905494b965355811864cacf";
  const hyperDir = path.join(home, ".grok-hyper", "sessions");
  await fs.mkdir(hyperDir, { recursive: true });
  await fs.writeFile(
    path.join(hyperDir, `${hyperSid}.jsonl`),
    [
      JSON.stringify({ type: "session/start", id: hyperSid, workspace: "/Users/demo/grok-hyper" }),
      JSON.stringify({ type: "user", text: "接入本地 ChatGPT" }),
    ].join("\n") + "\n",
  );
  await fs.writeFile(path.join(hyperDir, `${hyperSid}.meta.json`), JSON.stringify({ title: "本地 ChatGPT 接入" }));
});

after(async () => {
  closeSessionIndex();
  process.env.HOME = prevHome;
  if (prevRoot) process.env.AGENT_HUB_ROOT = prevRoot;
  else delete process.env.AGENT_HUB_ROOT;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("index scans grok cursor codex hyper without copying jsonl", async () => {
  const report = await rebuildIndex();
  assert.equal(report.byAgent.grok, 1);
  assert.equal(report.byAgent.cursor, 1);
  assert.equal(report.byAgent.codex, 1);
  assert.equal(report.byAgent.hyper, 1);
  const grok = getSession("grok", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(grok?.title, "WorldRules lock");
  assert.equal(grok?.cwd, "/Users/demo/world");
  assert.match(grok?.summary ?? "", /legacy tools/);
  const cursor = getSession("cursor", "11111111-2222-4333-8444-555555555555");
  assert.match(cursor?.title ?? "", /Implement steward only/);
  const codex = getSession("codex", "01a0a442-0e4d-7261-bf30-856695a12308");
  assert.equal(codex?.cwd, "/Users/demo/medical-harness");
  assert.match(codex?.title ?? "", /Fix the audit report/);
  const hyper = getSession("hyper", "26083339f905494b965355811864cacf");
  assert.equal(hyper?.cwd, "/Users/demo/grok-hyper");
  assert.match(hyper?.title ?? "", /本地 ChatGPT/);
  const hubSessions = path.join(home, ".agent-hub", "sessions");
  const copied = await fs.readdir(hubSessions);
  assert.equal(copied.some((name) => name.endsWith(".jsonl")), false);
});

test("handoff writes markdown and grok_resume plan", async () => {
  await rebuildIndex();
  const result = await createHandoff({
    from: "grok",
    to: "grok",
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  assert.match(result.markdown, /source_session: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
  assert.equal(result.resume.kind, "grok-resume");
  assert.equal(result.resume.mcp?.tool, "grok_resume");
  assert.ok(result.resume.argv.includes("--prompt-file"));
  const cross = resumePlan({
    from: "cursor",
    to: "grok",
    sessionId: "11111111-2222-4333-8444-555555555555",
    cwd: "/Users/demo/world",
    handoffPath: result.record.path,
  });
  assert.equal(cross.kind, "grok-start");
  assert.equal(cross.mcp?.tool, "grok_start");
  assert.ok(cross.argv.includes("--prompt-file"));
  assert.ok(cross.argv.includes(result.record.path));
  const listed = listSessions({ agent: "grok" });
  assert.equal(listed.length, 1);
  assert.match(result.markdown, /legacy tools/);
  const handoffs = await listHandoffs();
  assert.ok(handoffs.some((item) => item.from === "grok" && item.to === "grok"));
  const found = listSessions({ q: "legacy tools" });
  assert.equal(found.length, 1);
});

test("sessions=own are hidden from hub list and block handoff without forceOwn", async () => {
  await rebuildIndex();
  await setBind("grok", "sessions", "own");
  const config = await loadConfig();
  const hidden = visibleHubSessions(listSessions({ agent: "grok" }), config, false);
  assert.equal(hidden.length, 0);
  const shown = visibleHubSessions(listSessions({ agent: "grok" }), config, true);
  assert.equal(shown.length, 1);
  await assert.rejects(
    () => createHandoff({
      from: "grok",
      to: "codex",
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    }),
    /own|揭隐/,
  );
  const forced = await createHandoff({
    from: "grok",
    to: "codex",
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    forceOwn: true,
  });
  assert.ok(forced.record.path);
  await setBind("grok", "sessions", "index");
});

test("sessions=own agent is not scanned on index refresh (bind is sole authority)", async () => {
  await setBind("codex", "sessions", "own");
  try {
    const sid = "99999999-8888-7777-6666-555555555555";
    const dir = path.join(home, ".codex", "sessions", "2026", "09", "16");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `rollout-2026-09-16T00-00-00-${sid}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { session_id: sid, cwd: "/Users/demo/own-only" } })}\n`,
    );
    const report = await rebuildIndex();
    assert.equal(report.byAgent.codex, undefined);
    assert.equal(report.byAgent.grok, 1);
    assert.equal(getSession("codex", sid), null);
  } finally {
    await setBind("codex", "sessions", "index");
  }
});

test("cursorFolderToCwd maps existing home-relative folder", async () => {
  const cwd = await cursorFolderToCwd("world", home);
  assert.equal(cwd, path.join(home, "world"));
});
