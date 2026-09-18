import { setHubTargets } from "./core/frontmatter.ts";
import { requireSecretMaterial } from "./core/secrets.ts";
import { transaction, withHubLock } from "./core/transaction.ts";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { applyBind } from "./core/bind.ts";
import { ensureSessionToken, hubPaths, loadConfig, setAgentEnabled } from "./core/config.ts";
import { selectMemoryProject, syncCtxInjects, syncMemoryReport, syncVaultCatalogs } from "./core/deliver.ts";
import { HubError } from "./core/errors.ts";
import { createSubagent, createMemoryProject, listIdentityBackups, readAgentLayer, readAllowed, restoreIdentity, writeAllowed, type FileKind, type BackupKind } from "./core/files.ts";
import { launchHandoff, createHandoff, listHandoffs, openEditorArgv, revealArgv } from "./core/handoff.ts";
import { importNativeMemory, remember } from "./core/memory.ts";
import { getSession, listSessionsForDisplay, readSessionContent, rebuildIndex, visibleHubSessions } from "./core/sessions.ts";
import {
  adoptSkills,
  promoteProjectSkill,
  relinkHubSkills,
  removeHubSkill,
  repairLinks,
  resolveSkillConflict,
  scanProjectSkills,
  setSkillTargets,
} from "./core/skills.ts";
import { buildSnapshot } from "./core/snapshot.ts";
import { saveVaultFromMarkdown, setVaultGrants, vaultCatalogFor, renderVaultGetMeta, vaultGet, vaultUiPayload, vaultExecArgv } from "./core/vault.ts";
import { startHubWatch } from "./core/watch.ts";
import { isAgentId, type AgentId, type ConflictKeep, type Layer } from "./core/types.ts";
import { langFromHeader, localizeResponse, t, type Lang } from "./core/locale.ts";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > 2_000_000) throw new HubError("request body too large", 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: http.ServerResponse, status: number, body: unknown, cookie?: string, lang: Lang | null = null): void {
  const data = JSON.stringify(lang ? localizeResponse(body, lang) : body);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (cookie) headers["set-cookie"] = cookie;
  res.writeHead(status, headers);
  res.end(data);
}

function send(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown, cookie?: string): void {
  json(res, status, body, cookie, langFromHeader(String(req.headers["accept-language"] ?? "")));
}

function parseCookie(req: http.IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === "hub_session") return rest.join("=");
  }
  return null;
}

function sessionCookie(token: string): string {
  return `hub_session=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

function presentedSecret(req: http.IncomingMessage): string {
  return parseCookie(req) ?? String(req.headers["x-hub-token"] ?? "");
}

async function isAuthed(req: http.IncomingMessage): Promise<boolean> {
  const token = await ensureSessionToken();
  return presentedSecret(req) === token;
}

async function guard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: { requireSession?: boolean },
): Promise<boolean> {
  const host = String(req.headers.host ?? "").split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") {
    send(req, res, 403, { error: "host not allowed" });
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(String(origin));
      if (parsed.origin !== `http://${req.headers.host}`) {
        send(req, res, 403, { error: "origin not allowed" });
        return false;
      }
    } catch {
      send(req, res, 403, { error: "origin not allowed" });
      return false;
    }
  }
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    const ct = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!ct.startsWith("application/json")) {
      send(req, res, 415, { error: "content-type must be application/json" });
      return false;
    }
  }
  if (opts.requireSession && !(await isAuthed(req))) {
    send(req, res, 401, { error: "session required" });
    return false;
  }
  return true;
}

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  const isLogin = method === "POST" && url.pathname === "/api/login";
  if (!(await guard(req, res, { requireSession: !isLogin }))) return;
  const token = await ensureSessionToken();
  const cookie = !isLogin && (await isAuthed(req)) && !parseCookie(req) ? sessionCookie(token) : undefined;

  if (isLogin) {
    const body = JSON.parse((await readBody(req)) || "{}") as { token?: string };
    if (body.token !== token) {
      send(req, res, 401, { error: "session required" });
      return;
    }
    send(req, res, 200, { ok: true }, sessionCookie(token));
    return;
  }

  if (method === "GET" && url.pathname === "/api/snapshot") {
    send(req, res, 200, await buildSnapshot(), cookie);
    return;
  }
  if (method === "POST" && url.pathname === "/api/adopt") {
    const body = JSON.parse((await readBody(req)) || "{}") as { mode?: string; names?: unknown };
    const mode = body.mode === "link-existing" ? "link-existing" : "adopt";
    if (body.names !== undefined && (!Array.isArray(body.names) || !body.names.every(n => typeof n === "string"))) throw new HubError("names 必须是技能名数组", 400);
    send(req, res, 200, await adoptSkills(mode, { names: body.names as string[] | undefined }));
    return;
  }
  if (method === "POST" && url.pathname === "/api/relink") {
    send(req, res, 200, { linked: await relinkHubSkills() });
    return;
  }
  if (method === "POST" && url.pathname === "/api/bind") {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      agent: AgentId;
      layer: string;
      value: string;
      skillsMode?: string;
    };
    const result = await applyBind({
      agent: body.agent,
      layer: body.layer as Layer,
      value: body.value,
      skillsMode: body.skillsMode,
    });
    send(req, res, 200, { snapshot: await buildSnapshot(), extra: result.extra });
    return;
  }
  if (method === "POST" && url.pathname === "/api/skill-targets") {
    const body = JSON.parse((await readBody(req)) || "{}") as { name: string; targets: string[] | null; content?: string; revision?: string };
    if (typeof body.content === "string") {
      if (typeof body.revision !== "string") throw new HubError("skill revision required", 428);
      const file = await transaction(async () => {
        await writeAllowed("skill", setHubTargets(body.content!, body.targets), undefined, body.name, body.revision);
        return readAllowed("skill", undefined, body.name);
      });
      send(req, res, 200, { snapshot: await buildSnapshot(), file });
    } else {
      await setSkillTargets(body.name, body.targets);
      send(req, res, 200, await buildSnapshot());
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/skill-delete") {
    const body = JSON.parse((await readBody(req)) || "{}") as { name?: string };
    if (!body.name) {
      send(req, res, 400, { error: "name required" });
      return;
    }
    await removeHubSkill(body.name);
    send(req, res, 200, await buildSnapshot());
    return;
  }
  if (url.pathname === "/api/file") {
    const kind = url.searchParams.get("kind") as FileKind | null;
    const agent = (url.searchParams.get("agent") ?? undefined) as AgentId | undefined;
    const name = url.searchParams.get("name") ?? undefined;
    if (!kind) {
      send(req, res, 400, { error: "kind required" });
      return;
    }
    if (method === "GET") {
      send(req, res, 200, await readAllowed(kind, agent, name), cookie);
      return;
    }
    if (method === "POST" && kind === "memory" && name) {
      const body = JSON.parse((await readBody(req)) || "{}") as { content?: string };
      send(req, res, 201, await createMemoryProject(name, body.content ?? ""));
      return;
    }
    if (method === "POST" && kind === "subagent") {
      if (!isAgentId(agent) || !name) throw new HubError("agent and name required", 400);
      const body = JSON.parse((await readBody(req)) || "{}") as { content?: string };
      send(req, res, 201, await createSubagent(agent, name, body.content ?? ""));
      return;
    }
    if (method === "PUT") {
      const body = JSON.parse((await readBody(req)) || "{}") as { content?: string; revision?: string };
      if (kind === "skill" && typeof body.revision !== "string") throw new HubError("skill revision required; reload before saving", 428);
      if (kind === "subagent" && typeof body.revision !== "string") throw new HubError("subagent revision required; reload before saving", 428);
      const written = await withHubLock(async () => {
        const saved = await transaction(async () => {
          const result = await writeAllowed(kind, body.content ?? "", agent, name, body.revision);
          if (kind === "user-md") await syncCtxInjects();
          return { ...result, ...(await readAllowed(kind, agent, name)) };
        });
        return kind === "memory"
          ? { ...saved, delivery: await syncMemoryReport(name && name !== "global" ? name : undefined) }
          : saved;
      });
      send(req, res, 200, written);
      return;
    }
  }
  if (method === "POST" && url.pathname === "/api/open") {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      kind?: FileKind;
      agent?: AgentId;
      name?: string;
    };
    if (!body.kind) {
      send(req, res, 400, { error: "kind required" });
      return;
    }
    const file = await readAllowed(body.kind, body.agent, body.name);
    const argv = openEditorArgv(file.path);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    send(req, res, 200, { ok: true, path: file.path });
    return;
  }
  if (method === "GET" && url.pathname === "/api/identity/backups") {
    const agent = url.searchParams.get("agent");
    if (!isAgentId(agent)) {
      send(req, res, 400, { error: "agent required" }, cookie);
      return;
    }
    send(req, res, 200, { backups: await listIdentityBackups(agent) }, cookie);
    return;
  }
  if (method === "POST" && url.pathname === "/api/identity/restore") {
    const body = JSON.parse((await readBody(req)) || "{}") as { agent?: AgentId; backupName?: string; legacy?: { kind: BackupKind; subagent?: string } };
    if (!isAgentId(body.agent)) {
      send(req, res, 400, { error: "agent required" });
      return;
    }
    send(req, res, 200, await restoreIdentity(body.agent, body.backupName, body.legacy));
    return;
  }
  if (method === "POST" && url.pathname === "/api/import-memory") {
    const body = JSON.parse((await readBody(req)) || "{}") as { agent?: AgentId };
    const result = await importNativeMemory(isAgentId(body.agent) ? body.agent : undefined);
    send(req, res, 200, { ...result, snapshot: await buildSnapshot() });
    return;
  }
  if (method === "POST" && url.pathname === "/api/remember") {
    const body = JSON.parse((await readBody(req)) || "{}") as { text?: string; project?: string };
    const result = await withHubLock(async () => {
      const result = await remember(body.text ?? "", body.project);
      return { ...result, delivery: await syncMemoryReport(body.project) };
    });
    send(req, res, 200, { ...result, snapshot: await buildSnapshot() });
    return;
  }
  if (method === "POST" && url.pathname === "/api/index") {
    const body = JSON.parse((await readBody(req)) || "{}") as { agent?: AgentId };
    const report = await rebuildIndex(body.agent);
    send(req, res, 200, { ...report, snapshot: await buildSnapshot() });
    return;
  }
  if (method === "POST" && url.pathname === "/api/memory/sync") {
    const delivery = await syncMemoryReport();
    send(req, res, 200, { written: delivery.written, delivery, snapshot: await buildSnapshot() });
    return;
  }
  if (method === "POST" && url.pathname === "/api/memory/scope") {
    const body = JSON.parse((await readBody(req)) || "{}") as { agent: AgentId; cwd: string; project?: string; globalOnly?: boolean };
    send(req, res, 200, { path: await selectMemoryProject(body.agent, body.project, body.cwd, body.globalOnly === true) });
    return;
  }
  if (method === "GET" && url.pathname === "/api/sessions") {
    const agent = url.searchParams.get("agent") as AgentId | null;
    const q = url.searchParams.get("q") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "80");
    const includeOwn = url.searchParams.get("own") === "1";
    const config = await loadConfig();
    const rows = visibleHubSessions(
      await listSessionsForDisplay({
        allowedAgents: config.agents.enabled.filter((id) => includeOwn || config.bind[id].sessions === "index"),
        agent: agent ?? undefined,
        q,
        limit: Number.isFinite(limit) ? limit : 80,
      }),
      config,
      includeOwn,
    );
    send(req, res, 200, { sessions: rows, handoffs: await listHandoffs(20) }, cookie);
    return;
  }
  if (method === "GET" && url.pathname === "/api/session/content") {
    const agent = url.searchParams.get("agent") ?? "";
    const id = url.searchParams.get("id") ?? "";
    if (!agent || !id) throw new HubError("agent and id required", 400);
    if (!isAgentId(agent)) throw new HubError("invalid agent", 400);
    send(req, res, 200, await readSessionContent(agent, id), cookie);
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent-layer") {
    const agent = url.searchParams.get("agent") ?? "";
    const layer = url.searchParams.get("layer") ?? "";
    if (!isAgentId(agent)) throw new HubError("invalid agent", 400);
    if (layer !== "ctx" && layer !== "memory") throw new HubError("layer must be ctx or memory", 400);
    send(req, res, 200, await readAgentLayer(agent, layer), cookie);
    return;
  }
  if (method === "POST" && url.pathname === "/api/handoff") {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      from: AgentId;
      to: AgentId;
      sessionId: string;
      cwd?: string;
      forceOwn?: boolean;
    };
    send(req, res, 200, await createHandoff({ ...body, forceOwn: body.forceOwn === true }));
    return;
  }
  if (method === "POST" && url.pathname === "/api/handoff/launch") {
    const body = JSON.parse((await readBody(req)) || "{}") as { id: string; forceOwn?: boolean };
    send(req, res, 200, await launchHandoff(body.id, body.forceOwn === true));
    return;
  }
  if (method === "POST" && url.pathname === "/api/reveal") {
    const body = JSON.parse((await readBody(req)) || "{}") as { agent?: AgentId; sessionId?: string };
    if (!body.agent || !body.sessionId) {
      send(req, res, 400, { error: "agent and sessionId required" });
      return;
    }
    await requireSecretMaterial();
    const row = getSession(body.agent, body.sessionId);
    if (!row) {
      send(req, res, 404, { error: "session not in index" });
      return;
    }
    const argv = revealArgv(row.source_path);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    send(req, res, 200, { ok: true, path: row.source_path });
    return;
  }
  if (method === "GET" && url.pathname === "/api/vault") {
    send(req, res, 200, await vaultUiPayload(url.searchParams.get("reveal") === "1"), cookie);
    return;
  }
  if (method === "PUT" && url.pathname === "/api/vault") {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      markdown?: string;
      grants?: Record<string, AgentId[]>;
      secretFields?: Record<string, string[]>;
      revision?: string;
    };
    if (typeof body.revision !== "string") throw new HubError("vault revision required; reload before saving", 428);
    const result = await transaction(async () => {
      await saveVaultFromMarkdown(body.markdown ?? "", body.grants, body.secretFields, body.revision);
      await syncVaultCatalogs();
      return vaultUiPayload();
    });
    send(req, res, 200, result);
    return;
  }
  if (method === "POST" && url.pathname === "/api/vault/grant") {
    const body = JSON.parse((await readBody(req)) || "{}") as { id: string; agents: AgentId[]; revision?: string };
    if (typeof body.revision !== "string") throw new HubError("vault revision required; reload before granting", 428);
    const result = await transaction(async () => {
      await setVaultGrants(body.id, body.agents ?? [], body.revision);
      await syncVaultCatalogs();
      return vaultUiPayload();
    });
    send(req, res, 200, result);
    return;
  }
  if (method === "POST" && url.pathname === "/api/vault/get") {
    const body = JSON.parse((await readBody(req)) || "{}") as { agent: AgentId; id: string; reveal?: boolean };
    if (!isAgentId(body.agent) || !body.id) {
      send(req, res, 400, { error: "agent and id required" });
      return;
    }
    const entry = await vaultGet(body.agent, body.id);
    send(req, res, 200, body.reveal === true ? entry : { id: entry.id, metadata: renderVaultGetMeta(entry) });
    return;
  }
  if (method === "GET" && url.pathname === "/api/vault/catalog") {
    const agent = url.searchParams.get("agent") as AgentId | null;
    if (!agent) {
      send(req, res, 400, { error: "agent required" });
      return;
    }
    send(req, res, 200, { items: await vaultCatalogFor(agent) }, cookie);
    return;
  }
  if (method === "GET" && url.pathname === "/api/vault/exec-plan") {
    const agent = url.searchParams.get("agent") as AgentId | null;
    const command = url.searchParams.get("command") || agent || "grok";
    if (!agent || !isAgentId(agent)) {
      send(req, res, 400, { error: "agent required" });
      return;
    }
    const items = await vaultCatalogFor(agent);
    send(req, res, 200, {
      argv: vaultExecArgv(agent, [command]),
      note: "Run this in a local terminal. HTTP never receives secret values.",
      entries: items.map((item) => item.id),
    }, cookie);
    return;
  }
  if (method === "POST" && url.pathname === "/api/catalog") {
    const body = JSON.parse((await readBody(req)) || "{}") as { agent?: AgentId; enabled?: boolean };
    if (!isAgentId(body.agent) || typeof body.enabled !== "boolean") throw new HubError("agent required", 400);
    await setAgentEnabled(body.agent, body.enabled);
    send(req, res, 200, await buildSnapshot());
    return;
  }
  if (method === "POST" && url.pathname === "/api/repair") {
    send(req, res, 200, { ...(await repairLinks()), snapshot: await buildSnapshot() });
    return;
  }
  if (method === "GET" && url.pathname === "/api/project-skills") {
    const cwd = url.searchParams.get("cwd");
    if (!cwd) {
      send(req, res, 400, { error: "cwd required" });
      return;
    }
    send(req, res, 200, { skills: await scanProjectSkills(cwd) }, cookie);
    return;
  }
  if (method === "POST" && url.pathname === "/api/promote") {
    const body = JSON.parse((await readBody(req)) || "{}") as { cwd?: string; name?: string };
    if (!body.cwd || !body.name) {
      send(req, res, 400, { error: "cwd and name required" });
      return;
    }
    const result = await promoteProjectSkill(body.cwd, body.name);
    send(req, res, 200, { ...result, snapshot: await buildSnapshot() });
    return;
  }
  if (method === "POST" && url.pathname === "/api/conflict") {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      name: string;
      keep: ConflictKeep;
      fromPath?: string;
      agent?: AgentId;
    };
    if (!body.name || (body.keep !== "hub" && body.keep !== "agent")) {
      send(req, res, 400, { error: "name and keep=hub|agent required" });
      return;
    }
    const result = await resolveSkillConflict(body.name, body.keep, body.fromPath, body.agent);
    send(req, res, 200, { ...result, snapshot: await buildSnapshot() });
    return;
  }
  send(req, res, 404, { error: "not found" }, cookie);
}

async function staticFile(url: URL, res: http.ServerResponse, cookie?: string): Promise<void> {
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  rel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file);
    const headers: Record<string, string> = { "content-type": TYPES[ext] ?? "application/octet-stream" };
    if (cookie) headers["set-cookie"] = cookie;
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

/**
 * Token is printed only on an interactive terminal; on redirected stdout
 * (e.g. ~/.agent-hub/logs/web-3950.log) we print a pointer to the 0600 file
 * instead, so the live passphrase never lands in a log.
 */
export function tokenLogLines(token: string, isTTY: boolean): string[] {
  if (isTTY) return [t("web.token"), token];
  return [t("web.token_file", { path: hubPaths().token })];
}

export async function startServer(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const run = (async () => {
      let url: URL;
      try { url = new URL(req.url ?? "/", "http://127.0.0.1"); }
      catch { throw new HubError("invalid request URL", 400); }
      if (url.pathname.startsWith("/api/")) {
        await api(req, res, url);
        return;
      }
      if (!(await guard(req, res, { requireSession: false }))) return;
      const method = req.method ?? "GET";
      const authed = await isAuthed(req);
      const publicFile =
        url.pathname === "/login.html" ||
        url.pathname === "/app.css" ||
        url.pathname === "/i18n.js" ||
        url.pathname === "/errors.js" ||
        url.pathname === "/logo.png" ||
        url.pathname === "/logo.jpg" ||
        url.pathname === "/favicon-16.png" ||
        url.pathname === "/favicon-32.png" ||
        url.pathname === "/apple-touch-icon.png";
      if (url.pathname === "/login.html" && authed && method === "GET") {
        res.writeHead(302, { location: "/", "cache-control": "no-store" });
        res.end();
        return;
      }
      if (!authed && !publicFile) {
        const wantsPage = method === "GET" && (url.pathname === "/" || url.pathname.endsWith(".html"));
        if (wantsPage) {
          res.writeHead(302, { location: "/login.html", "cache-control": "no-store" });
          res.end();
          return;
        }
        send(req, res, 401, { error: "session required" });
        return;
      }
      await staticFile(url, res);
    })();
    run.catch((err) => {
      const status = err instanceof HubError ? err.status : err instanceof SyntaxError ? 400 : 500;
      send(req, res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const stopWatch = await startHubWatch();
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    stopWatch();
    return originalClose(callback);
  }) as typeof server.close;
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  const token = await ensureSessionToken();
  console.log(t("web.listen", { url: `http://127.0.0.1:${actual}/` }));
  for (const line of tokenLogLines(token, Boolean(process.stdout.isTTY))) console.log(line);
  return server;
}
