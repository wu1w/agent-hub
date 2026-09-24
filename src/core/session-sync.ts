import { syncChangedSessions } from "./sessions.ts";

/** Delay after the first session-file event. Later events do not push this back. */
export const SESSION_SYNC_QUIET_MS = 20_000;
/** Ceiling for the first event, and the stat backstop when filesystem events are dropped. */
export const SESSION_SYNC_CAP_MS = 5 * 60_000;

export type SessionSyncHandle = {
  notify: () => void;
  stop: () => void;
};

export function startSessionSync(options?: {
  quietMs?: number;
  capMs?: number;
  run?: () => Promise<unknown>;
}): SessionSyncHandle {
  const quietMs = options?.quietMs ?? SESSION_SYNC_QUIET_MS;
  const capMs = options?.capMs ?? SESSION_SYNC_CAP_MS;
  const run = options?.run ?? (() => syncChangedSessions());
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let cap: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const fire = () => {
    if (quiet) clearTimeout(quiet);
    quiet = null;
    if (cap) clearTimeout(cap);
    cap = null;
    if (stopped) return;
    void Promise.resolve(run()).catch(() => {});
  };

  const notify = () => {
    if (stopped) return;
    // A running transcript keeps changing. Keep the first deadline so those appends are not postponed to the cap.
    if (!quiet) quiet = setTimeout(fire, quietMs);
    if (!cap) cap = setTimeout(fire, capMs);
  };

  const interval = setInterval(() => {
    if (!stopped) void Promise.resolve(run()).catch(() => {});
  }, capMs);
  interval.unref();

  return {
    notify,
    stop() {
      stopped = true;
      if (quiet) clearTimeout(quiet);
      if (cap) clearTimeout(cap);
      quiet = null;
      cap = null;
      clearInterval(interval);
    },
  };
}
