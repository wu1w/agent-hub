import { withHubLock } from "./transaction.ts";
import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HubError } from "./errors.ts";
import { supportsSessions, adapter, homedir } from "./adapters.ts";
import { ensureHub, hubPaths, loadConfig } from "./config.ts";
import { exists, isDir, mtimeMs, readHead, readText } from "./fsx.ts";
import { requireSecretMaterial, redactOrOmit, type SecretMaterial } from "./secrets.ts";
import { AGENT_IDS, type AgentId, type HubConfig, type SessionRecord } from "./types.ts";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let cached: { path: string; db: DatabaseSync } | null = null;

export function closeSessionIndex(): void {
  if (!cached) return;
  cached.db.close();
  cached = null;
}

function openIndex(): DatabaseSync {
  const file = hubPaths().sessionIndex;
  if (cached && cached.path === file) return cached.db;
  closeSessionIndex();
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.chmodSync(path.dirname(file), 0o700);
  const db = new DatabaseSync(file);
  fsSync.chmodSync(file, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      cwd TEXT,
      title TEXT,
      summary TEXT,
      mtime INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS sessions_mtime ON sessions(mtime DESC);
  `);
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!cols.some((col) => col.name === "summary")) {
    db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
  }
  cached = { path: file, db };
  return db;
}

const INDEX_TITLE_MAX = 80;
const INDEX_SUMMARY_MAX = 240;

function collapse(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function jsonlRecords(head: string, max = 40): unknown[] {
  const lines = head.split("\n");
  // A complete final JSON record is valid even without a trailing newline.
  // A bounded or partially written final record is rejected by JSON.parse below.
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      break;
    }
    if (out.length >= max) break;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (typeof rec.text === "string") parts.push(rec.text);
    else if (typeof rec.input_text === "string") parts.push(rec.input_text);
  }
  return parts.join("\n");
}

function skipUserWrapper(text: string): boolean {
  const t = text.trim();
  return t.startsWith("<") && !t.includes("<user_query>");
}

async function readTail(file: string, max = 512_000): Promise<{ text: string; size: number; truncated: boolean }> {
  const handle = await fs.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - max);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start) text = text.slice(text.indexOf("\n") + 1);
    return { text, size, truncated: start > 0 };
  } finally { await handle.close(); }
}

async function recentSummary(file: string): Promise<string> {
  const { text } = await readTail(file);
  let user = "", result = "";
  for (const item of jsonlRecords(text, 10000)) {
    const rec = asRecord(item);
    const msg = asRecord(rec?.payload) ?? asRecord(rec?.message) ?? rec;
    const role = msg?.role ?? rec?.role ?? (msg?.type === "agent_message" ? "assistant" : msg?.type === "user_message" ? "user" : msg?.type);
    const content = contentText(msg?.content ?? msg?.text ?? msg?.message);
    if (!content) continue;
    if (role === "assistant" && (!msg?.channel || msg.channel === "final")) result = content;
    if (role === "user" && !skipUserWrapper(content)) { user = content; result = ""; }
  }
  return result ? `最近回复（有界尾部，非整场总结）：${result}`
    : user ? `未找到最新最终回复；最近请求：${user}` : "摘要不可用：有界尾部未找到请求或最终回复，请检查原会话。";
}

async function greedyExisting(root: string, parts: string[]): Promise<string> {
  let current = root;
  let i = 0;
  while (i < parts.length) {
    let hit: string | null = null;
    for (let j = parts.length; j > i; j--) {
      const candidate = path.join(current, parts.slice(i, j).join("-"));
      if (await exists(candidate)) {
        hit = candidate;
        i = j;
        break;
      }
    }
    if (!hit) return path.join(current, parts.slice(i).join("-"));
    current = hit;
  }
  return current;
}

export async function cursorFolderToCwd(folder: string, home: string): Promise<string> {
  if (!folder || folder === "empty-window") return "";
  const parts = folder.split("-").filter(Boolean);
  if (parts[0] === "Users") {
    const abs = await greedyExisting(path.parse(home).root, parts);
    if (await exists(abs)) return abs;
  }
  const underHome = path.join(home, folder);
  if (await exists(underHome)) return underHome;
  const dashed = await greedyExisting(home, parts);
  if (dashed !== home && (await exists(dashed))) return dashed;
  return underHome;
}

async function scanGrok(home: string, now: number): Promise<SessionRecord[]> {
  const root = adapter("grok").sessionRoot?.(home);
  if (!root) return [];
  let groups: string[] = [];
  try {
    groups = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: SessionRecord[] = [];
  for (const group of groups) {
    const groupPath = path.join(root, group);
    if (!(await isDir(groupPath))) continue;
    let cwd = group;
    try {
      cwd = decodeURIComponent(group);
    } catch {
      cwd = group;
    }
    const cwdFile = await readText(path.join(groupPath, ".cwd"));
    if (cwdFile?.trim()) cwd = cwdFile.trim();
    let children: string[] = [];
    try {
      children = await fs.readdir(groupPath);
    } catch {
      continue;
    }
    for (const sid of children) {
      if (!(await isDir(path.join(groupPath, sid)))) continue;
      const summaryPath = path.join(groupPath, sid, "summary.json");
      const raw = await readText(summaryPath);
      if (raw == null) continue;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const info = asRecord(parsed.info);
      const sessionId = String(info?.id ?? sid);
      const title = String(parsed.generated_title || parsed.session_summary || parsed.title || sessionId);
      const summary = String(parsed.session_summary || parsed.generated_title || parsed.title || "");
      const updated = String(parsed.updated_at || parsed.last_active_at || parsed.created_at || "");
      const parsedMs = Date.parse(updated);
      out.push({
        agent_id: "grok",
        session_id: sessionId,
        cwd: String(info?.cwd || cwd),
        title,
        summary,
        mtime: Number.isFinite(parsedMs) ? parsedMs : await mtimeMs(summaryPath),
        source_path: summaryPath,
        indexed_at: now,
      });
    }
  }
  return out;
}

async function scanCursor(home: string, now: number): Promise<SessionRecord[]> {
  const root = adapter("cursor").sessionRoot?.(home);
  if (!root) return [];
  let projects: string[] = [];
  try {
    projects = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: SessionRecord[] = [];
  for (const folder of projects) {
    const transcripts = path.join(root, folder, "agent-transcripts");
    if (!(await isDir(transcripts))) continue;
    const cwd = await cursorFolderToCwd(folder, home);
    let sessions: string[] = [];
    try {
      sessions = await fs.readdir(transcripts);
    } catch {
      continue;
    }
    for (const sid of sessions) {
      const jsonl = path.join(transcripts, sid, `${sid}.jsonl`);
      const source = (await exists(jsonl)) ? jsonl : path.join(transcripts, sid);
      const file = (await exists(jsonl))
        ? jsonl
        : (await isDir(source))
          ? null
          : source;
      if (!file || !file.endsWith(".jsonl")) {
        if (!(await isDir(path.join(transcripts, sid)))) continue;
        let nested: string[] = [];
        try {
          nested = await fs.readdir(path.join(transcripts, sid));
        } catch {
          continue;
        }
        for (const name of nested) {
          if (!name.endsWith(".jsonl")) continue;
          const nestedFile = path.join(transcripts, sid, name);
          const rec = await cursorRecord(nestedFile, name.replace(/\.jsonl$/, ""), cwd, now);
          if (rec) out.push(rec);
        }
        continue;
      }
      const rec = await cursorRecord(file, sid, cwd, now);
      if (rec) out.push(rec);
    }
  }
  return out;
}

async function cursorRecord(
  file: string,
  sessionId: string,
  cwd: string,
  now: number,
): Promise<SessionRecord | null> {
  const head = await readHead(file, 32_000);
  if (head == null) return null;
  const records = jsonlRecords(head, 10000);
  const decoded = records.map(item => {
    const rec = asRecord(item);
    const message = asRecord(rec?.message);
    return contentText(message?.content ?? rec?.content ?? rec?.text);
  }).join("\n");
  const query = decoded.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  const raw = query?.[1] || "";
  return {
    agent_id: "cursor",
    session_id: sessionId,
    cwd,
    title: raw || sessionId,
    summary: await recentSummary(file),
    mtime: await mtimeMs(file),
    source_path: file,
    indexed_at: now,
  };
}

async function scanCodex(home: string, now: number): Promise<SessionRecord[]> {
  const root = adapter("codex").sessionRoot?.(home);
  if (!root) return [];
  const files = await walkJsonl(root, "rollout-");
  const out: SessionRecord[] = [];
  for (const file of files) {
    const head = await readHead(file, 256_000);
    if (head == null) continue;
    const records = jsonlRecords(head, 60);
    let sessionId = "";
    let cwd = "";
    let rawUser = "";
    for (const item of records) {
      const rec = asRecord(item);
      if (!rec) continue;
      const payload = asRecord(rec.payload);
      if (rec.type === "session_meta" && payload) {
        sessionId = String(payload.session_id || payload.id || "");
        cwd = String(payload.cwd || "");
      }
      const role = payload?.role;
      const text = contentText(payload?.content);
      if (role === "user" && text && !skipUserWrapper(text) && !rawUser) {
        rawUser = text;
      }
    }
    if (!sessionId) {
      const hit = file.match(UUID);
      sessionId = hit?.[0] ?? path.basename(file, ".jsonl");
    }
    out.push({
      agent_id: "codex",
      session_id: sessionId,
      cwd,
      title: rawUser || path.basename(file, ".jsonl"),
      summary: await recentSummary(file),
      mtime: await mtimeMs(file),
      source_path: file,
      indexed_at: now,
    });
  }
  return out;
}

async function scanHyper(home: string, now: number): Promise<SessionRecord[]> {
  const root = adapter("hyper").sessionRoot?.(home);
  if (!root) return [];
  let names: string[] = [];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: SessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(root, name);
    const head = await readHead(file, 32_000);
    if (head == null) continue;
    const records = jsonlRecords(head, 8);
    let sessionId = name.replace(/\.jsonl$/, "");
    let cwd = "";
    let rawUser = "";
    let title = "";
    for (const item of records) {
      const rec = asRecord(item);
      if (!rec) continue;
      if (rec.type === "session/start") {
        if (typeof rec.id === "string") sessionId = rec.id;
        if (typeof rec.workspace === "string") cwd = rec.workspace;
      }
      if (rec.type === "user" && typeof rec.text === "string" && !rawUser) {
        rawUser = rec.text;
      }
    }
    const meta = await readText(path.join(root, `${sessionId}.meta.json`));
    if (meta) {
      try {
        const parsed = JSON.parse(meta) as { title?: string };
        if (parsed.title) title = parsed.title;
      } catch {
        // keep jsonl title
      }
    }
    out.push({
      agent_id: "hyper",
      session_id: sessionId,
      cwd,
      title: title || rawUser || sessionId,
      summary: await recentSummary(file),
      mtime: await mtimeMs(file),
      source_path: file,
      indexed_at: now,
    });
  }
  return out;
}

async function walkJsonl(dir: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  await walk(dir, 0);
  return out;
}

function claudeFolderToCwd(folder: string, home: string): string {
  const trimmed = folder.replace(/^-+/, "").replace(/-/g, "/");
  if (trimmed.startsWith("Users/") || trimmed.startsWith("home/")) {
    const abs = path.parse(home).root + trimmed;
    return abs;
  }
  const underHome = path.join(home, folder);
  return underHome;
}

async function scanJsonlSessions(
  agent: AgentId,
  root: string,
  now: number,
  cwdFrom: (folder: string, file: string) => string,
): Promise<SessionRecord[]> {
  const files = await walkJsonl(root, "");
  const out: SessionRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const head = await readHead(file, 64_000);
    if (head == null) continue;
    const records = jsonlRecords(head, 40);
    let rawUser = "";
    for (const item of records) {
      const rec = asRecord(item);
      if (!rec) continue;
      const msg = asRecord(rec.message) ?? rec;
      const role = msg?.role ?? rec.role ?? rec.type;
      const text = contentText(msg?.content ?? rec.content ?? rec.text ?? rec.message);
      if ((role === "user" || rec.type === "user" || rec.type === "user_message") && text && !rawUser && !skipUserWrapper(text)) {
        rawUser = text;
      }
    }
    const sessionId = path.basename(file, ".jsonl");
    const folder = path.basename(path.dirname(file));
    out.push({
      agent_id: agent,
      session_id: sessionId,
      cwd: cwdFrom(folder, file),
      title: rawUser || sessionId,
      summary: await recentSummary(file),
      mtime: await mtimeMs(file),
      source_path: file,
      indexed_at: now,
    });
  }
  return out;
}

async function scanHermes(home: string, now: number): Promise<SessionRecord[]> {
  const root = adapter("hermes").sessionRoot?.(home);
  if (!root) return [];
  return scanJsonlSessions("hermes", root, now, () => "");
}

async function scanClaude(home: string, now: number): Promise<SessionRecord[]> {
  const root = adapter("claude").sessionRoot?.(home);
  if (!root) return [];
  return scanJsonlSessions("claude", root, now, (folder) => claudeFolderToCwd(folder, home));
}

const SCANNERS: Partial<Record<AgentId, (home: string, now: number) => Promise<SessionRecord[]>>> = {
  grok: scanGrok,
  cursor: scanCursor,
  codex: scanCodex,
  hyper: scanHyper,
  hermes: scanHermes,
  claude: scanClaude,
};

export type IndexReport = {
  upserted: number;
  pruned: number;
  count: number;
  byAgent: Record<string, number>;
  redaction: "ok" | "unavailable";
};

export async function rebuildIndex(only?: AgentId): Promise<IndexReport> {
  return withHubLock(() => rebuildIndexLocked(only));
}

async function rebuildIndexLocked(only?: AgentId): Promise<IndexReport> {
  if (only && !supportsSessions(only)) throw new HubError(`${only} 尚无会话扫描器`, 400);
  await ensureHub();
  const config = await loadConfig();
  const home = homedir();
  const now = Date.now();
  const material = await requireSecretMaterial();
  const db = openIndex();
  // bind.<agent>.sessions === "index" 是扫描名单的唯一权威；layers.sessions.index 仅为旧配置兼容保留。
  const agents = (only ? [only] : AGENT_IDS.filter((id) => config.bind[id].sessions === "index")).filter((id) =>
    config.agents.enabled.includes(id),
  );
  const seen = new Set<string>();
  const byAgent: Record<string, number> = {};
  let upserted = 0;
  const upsert = db.prepare(`
    INSERT INTO sessions (agent_id, session_id, cwd, title, summary, mtime, source_path, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, session_id) DO UPDATE SET
      cwd = excluded.cwd,
      title = excluded.title,
      summary = excluded.summary,
      mtime = excluded.mtime,
      source_path = excluded.source_path,
      indexed_at = excluded.indexed_at
  `);
  // Read every source before modifying SQLite, so a failed scanner leaves the prior index intact.
  const scanned: SessionRecord[] = [];
  for (const id of agents) {
    const ad = adapter(id);
    if (!(await exists(ad.presentMarker(home)))) continue;
    const scan = SCANNERS[id];
    if (!scan) continue;
    const rows = await scan(home, now);
    byAgent[id] = rows.length;
    scanned.push(...rows);
  }
  let pruned = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of scanned) {
      upsert.run(row.agent_id, row.session_id, row.cwd,
        collapse(redactOrOmit(row.title, material), INDEX_TITLE_MAX),
        collapse(redactOrOmit(row.summary, material), INDEX_SUMMARY_MAX),
        row.mtime, row.source_path, row.indexed_at);
      seen.add(`${row.agent_id}\t${row.session_id}`);
      upserted++;
    }
    const existing = db.prepare("SELECT agent_id, session_id, source_path FROM sessions").all() as {
      agent_id: string;
      session_id: string;
      source_path: string;
    }[];
    const del = db.prepare("DELETE FROM sessions WHERE agent_id = ? AND session_id = ?");
    for (const row of existing) {
      if (only && row.agent_id !== only) continue;
      const key = `${row.agent_id}\t${row.session_id}`;
      if (seen.has(key)) continue;
      if (await exists(row.source_path)) continue;
      del.run(row.agent_id, row.session_id);
      pruned += 1;
    }
    const stale = db.prepare("SELECT agent_id, session_id, title, summary FROM sessions").all() as SessionRecord[];
    const scrub = db.prepare("UPDATE sessions SET title = ?, summary = ? WHERE agent_id = ? AND session_id = ?");
    for (const row of stale) scrub.run(redactOrOmit(row.title, material), redactOrOmit(row.summary, material), row.agent_id, row.session_id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
  for (const suffix of ["", "-wal", "-shm"]) {
    try { await fs.chmod(hubPaths().sessionIndex + suffix, 0o600); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
  return {
    upserted,
    pruned,
    count: Number(countRow.count),
    byAgent,
    redaction: material.ok ? "ok" : "unavailable",
  };
}

export function listSessions(opts: {
  agent?: AgentId;
  allowedAgents?: AgentId[];
  q?: string;
  limit?: number;
}): SessionRecord[] {
  const db = openIndex();
  const limit = Math.min(Math.max(opts.limit ?? 80, 1), 500);
  const params: (string | number)[] = [];
  const where: string[] = [];
  if (opts.allowedAgents) {
    if (!opts.allowedAgents.length) return [];
    where.push(`agent_id IN (${opts.allowedAgents.map(() => "?").join(",")})`);
    params.push(...opts.allowedAgents);
  }
  if (opts.agent) {
    where.push("agent_id = ?");
    params.push(opts.agent);
  }
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim()}%`;
    where.push("(title LIKE ? OR summary LIKE ? OR cwd LIKE ? OR session_id LIKE ?)");
    params.push(like, like, like, like);
  }
  const sql = `SELECT agent_id, session_id, cwd, title, summary, mtime, source_path, indexed_at
    FROM sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY mtime DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as SessionRecord[];
}

export function visibleHubSessions(
  rows: SessionRecord[],
  config: HubConfig,
  includeOwn: boolean,
): SessionRecord[] {
  return rows.filter((row) => config.agents.enabled.includes(row.agent_id) && (includeOwn || config.bind[row.agent_id]?.sessions === "index"));
}

export function getSession(agent: AgentId, sessionId: string): SessionRecord | null {
  const db = openIndex();
  const row = db.prepare(
    "SELECT agent_id, session_id, cwd, title, summary, mtime, source_path, indexed_at FROM sessions WHERE agent_id = ? AND session_id = ?",
  ).get(agent, sessionId) as SessionRecord | undefined;
  return row ?? null;
}

export function sessionStats(allowedAgents?: AgentId[]): { count: number; indexedAt: number | null } {
  const db = openIndex();
  if (allowedAgents?.length === 0) return { count: 0, indexedAt: null };
  const where = allowedAgents ? ` WHERE agent_id IN (${allowedAgents.map(() => "?").join(",")})` : "";
  const row = db.prepare("SELECT COUNT(*) AS count, MAX(indexed_at) AS indexedAt FROM sessions" + where).get(...(allowedAgents ?? [])) as {
    count: number;
    indexedAt: number | null;
  };
  return { count: Number(row.count), indexedAt: row.indexedAt == null ? null : Number(row.indexedAt) };
}

/** UI/CLI reads fail closed without mutating the persisted index. */
export async function listSessionsForDisplay(opts: Parameters<typeof listSessions>[0]): Promise<SessionRecord[]> {
  const material = await requireSecretMaterial();
  return listSessions(opts).map(row => ({ ...row, title: redactOrOmit(row.title, material), summary: redactOrOmit(row.summary, material) }));
}

export type SessionMessage = { role: "user" | "assistant" | "tool" | "system" | "other"; text: string };
export type SessionContent = {
  path: string;
  size: number;
  truncated: boolean;
  messages: SessionMessage[];
  raw?: string;
};

const SESSION_MSG_MAX = 200;
const SESSION_MSG_TEXT_MAX = 4000;
const SESSION_RAW_MAX = 64_000;

function normalizeRole(value: unknown): SessionMessage["role"] {
  const role = String(value ?? "").toLowerCase();
  if (role === "user" || role === "user_message" || role === "human") return "user";
  if (role === "assistant" || role === "agent_message" || role === "agent") return "assistant";
  if (role === "tool" || role === "tool_call" || role === "tool_result" || role === "function") return "tool";
  if (role === "system" || role === "developer") return "system";
  return "other";
}

function extractMessages(text: string, material: SecretMaterial): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const item of jsonlRecords(text, 10000)) {
    const rec = asRecord(item);
    const msg = asRecord(rec?.payload) ?? asRecord(rec?.message) ?? rec;
    const role = normalizeRole(msg?.role ?? rec?.role ?? msg?.type);
    let content = contentText(msg?.content ?? msg?.text ?? msg?.message);
    const query = content.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
    if (query?.[1]) content = query[1];
    if (!content.trim()) continue;
    content = redactOrOmit(content, material); // Redact before truncation, including secrets crossing the display limit.
    out.push({ role, text: content.length > SESSION_MSG_TEXT_MAX ? `${content.slice(0, SESSION_MSG_TEXT_MAX)}…` : content });
  }
  return out.slice(-SESSION_MSG_MAX);
}

export async function readSessionContent(agent: AgentId, sessionId: string): Promise<SessionContent> {
  const material = await requireSecretMaterial(); // Core callers must fail closed too.
  const row = getSession(agent, sessionId);
  if (!row) throw new HubError("session not in index: " + sessionId, 404);
  // Some agents (e.g. grok) index a metadata file; the real transcript is its sibling chat_history.jsonl.
  let file = row.source_path;
  if (!file.endsWith(".jsonl")) {
    const sibling = path.join(path.dirname(file), "chat_history.jsonl");
    if (await exists(sibling)) file = sibling;
  }
  if (!(await exists(file))) throw new HubError("session source file is gone", 404);
  const { text, size, truncated } = await readTail(file);
  const messages = extractMessages(text, material);
  const result: SessionContent = { path: file, size, truncated, messages };
  if (messages.length < 3) {
    const safeRaw = redactOrOmit(text, material);
    result.raw = safeRaw.length > SESSION_RAW_MAX ? safeRaw.slice(-SESSION_RAW_MAX) : safeRaw;
  }
  return result;
}
