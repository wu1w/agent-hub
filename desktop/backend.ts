import fs from "node:fs/promises";
import path from "node:path";
import { startServer } from "../src/server.ts";
import { ensureSessionToken, hubPaths } from "../src/core/config.ts";
import { writeText } from "../src/core/fsx.ts";

declare const __HUB_VERSION__: string;

// The native shell owns this process. Neither credentials nor user files are bundled.
// A stable origin preserves WebKit preferences between launches. Never reuse or
// stop an unknown listener; if occupied, get a fresh OS-assigned local port.
const server = await startServer(3951).catch(error => {
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return startServer(0);
  throw error;
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("No local listener");
const root = hubPaths().root;
const descriptor = path.join(root, "desktop-runtime.json");
const runtime = { pid: process.pid, port: address.port, version: __HUB_VERSION__, root };
await writeText(descriptor, JSON.stringify(runtime));
await fs.chmod(descriptor, 0o600);
let closing = false;
function stop(): void {
  if (closing) return;
  closing = true;
  server.close(() => {
    void (async () => {
      const recorded = JSON.parse(await fs.readFile(descriptor, "utf8").catch(() => "{}"));
      if (recorded.pid === process.pid) await fs.rm(descriptor, { force: true });
    })().finally(() => process.exit(0));
  });
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
// A pipe EOF also cleans up after a native app crash; no detached server is left behind.
process.stdin.resume();
process.stdin.once("end", stop);
process.stdin.once("error", stop);
const logPath = path.join(process.env.HOME || root, "Library", "Logs", "Agent Hub", "app.log");
// This private parent pipe is the only place this handshake is emitted. The shell
// consumes it in memory and never logs stdout or puts the token into a URL.
process.stdout.write(JSON.stringify({ type: "ready", ...runtime, token: await ensureSessionToken(), logPath }) + "\n");
