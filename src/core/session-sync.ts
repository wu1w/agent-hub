import { syncChangedSessions } from "./sessions.ts";

/** Delay after the first session-file event. Later events do not push this back. */
export const SESSION_SYNC_QUIET_MS = 20_000;
/** Ceiling for the first event, and the stat backstop when filesystem events are dropped. */
export const SESSION_SYNC_CAP_MS = 5 * 60_000;

export type SessionSyncHandle = {
  notify: () => void;
  stop: () => Promise<void>;
  status: () => SessionSyncStatus;
};

export type SessionSyncStatus = {
  running: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  error: string | null;
  skipped: boolean;
};
let currentStatus: SessionSyncStatus = { running: false, lastAttemptAt: null, lastSuccessAt: null, error: null, skipped: false };
export function sessionSyncStatus(): SessionSyncStatus { return { ...currentStatus }; }

export function startSessionSync(options?: {
  quietMs?: number;
  capMs?: number;
  run?: () => Promise<unknown>;
  initial?: boolean;
}): SessionSyncHandle {
  const quietMs = options?.quietMs ?? SESSION_SYNC_QUIET_MS;
  const capMs = options?.capMs ?? SESSION_SYNC_CAP_MS;
  const run = options?.run ?? (() => syncChangedSessions());
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let cap: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let active: Promise<void> | null = null;
  const state: SessionSyncStatus = { running: false, lastAttemptAt: null, lastSuccessAt: null, error: null, skipped: false };
  currentStatus = state;
  const runOnce = (): Promise<void> => {
    if (stopped || active) return active ?? Promise.resolve();
    state.running = true;
    state.lastAttemptAt = Date.now();
    active = (async () => { try {
      const result = await run();
      state.skipped = Boolean(result && typeof result === "object" && "skipped" in result && result.skipped);
      if (!state.skipped) { state.lastSuccessAt = Date.now(); state.error = null; }
      else notify(); // An asset transaction may hold the writer lock during startup.
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.skipped = false;
    } finally { state.running = false; } })().finally(() => { active = null; });
    return active;
  };

  const fire = () => {
    if (quiet) clearTimeout(quiet);
    quiet = null;
    if (cap) clearTimeout(cap);
    cap = null;
    if (stopped) return;
    void runOnce();
  };

  const notify = () => {
    if (stopped) return;
    // A running transcript keeps changing. Keep the first deadline so those appends are not postponed to the cap.
    if (!quiet) quiet = setTimeout(fire, quietMs);
    if (!cap) cap = setTimeout(fire, capMs);
  };

  const interval = setInterval(() => {
    void runOnce();
  }, capMs);
  interval.unref();
  if (options?.initial) void runOnce();

  return {
    notify,
    status: () => ({ ...state }),
    async stop() {
      stopped = true;
      if (quiet) clearTimeout(quiet);
      if (cap) clearTimeout(cap);
      quiet = null;
      cap = null;
      clearInterval(interval);
      await active;
    },
  };
}
