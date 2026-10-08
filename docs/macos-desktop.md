# macOS desktop app

Version 0.2.0 introduces an Apple Silicon desktop application. It targets macOS 13 or later; local interactive acceptance was performed on macOS 26.6.1 arm64.

## Install and run

Download the DMG or ZIP from [GitHub Releases](https://github.com/wu1w/agent-hub/releases). Drag **Agent Hub.app** to Applications and open it. No separate Node installation, repository checkout, package manager or terminal is needed.

This release is **ad-hoc signed and not notarized by Apple**. Signature integrity validation is distinct from Gatekeeper trust. For a downloaded application you trust, use Apple's documented per-application [Open Anyway procedure](https://support.apple.com/en-gb/102445) if macOS blocks it. Do not disable Gatekeeper globally. Local acceptance used the locally built artifact; it does not certify the downloaded quarantine flow.

The app reads the existing `~/.agent-hub` data and honors the config root pointer. It also preserves an explicitly supplied `AGENT_HUB_ROOT` and native agent path overrides. Closing the window keeps the backend running; reopen from the Dock. **Quit Agent Hub** stops it. No login daemon is installed. Uninstalling the app leaves Hub data intact.

The package contains the program and public runtime resources only. It does not include any user's Hub configuration, memories, skills, transcripts, vault, authentication token or private source checkout.

## Implementation

- Native Swift/AppKit shell and system `WKWebView`.
- Official Node **22.23.3** runtime, downloaded from nodejs.org and verified against the official SHA256 manifest. Node's license and upstream signature are retained.
- Bundled JavaScript backend and three pure-JavaScript runtime dependencies. There is no runtime TypeScript compiler or dependency installation.
- Only loopback HTTP. Desktop prefers port 3951 for stable web preferences; if occupied, it chooses a fresh OS port rather than reusing an unknown listener.
- A private parent pipe passes the login handshake to the shell, which installs an HttpOnly session cookie. Tokens are not written to URLs or stdout logs. Navigation stays on the child server's origin; user-activated external links open in the system browser. No arbitrary JavaScript-to-native command bridge is exposed.
- Single application instance. Closing the parent pipe also stops the backend after a shell crash. Normal Quit drains active synchronization before termination.
- Existing user PATH precedes bundled runtime fallback, so launching other agents does not force them onto Hub's Node version.
- Native menus and frontend text have English and Simplified Chinese resources. Dates follow the selected locale.

App stderr is stored at `~/Library/Logs/Agent Hub/app.log` with mode 0600 and bounded rotation on launch. `desktop-runtime.json` in the Hub data directory records the owning PID and port, without a token; normal shutdown removes it.

## Performance verification

Measurements below use this Mac's 24 catalog entries, 56 Hub skills, 53 vendor skills and 1,178 session index entries. They are observations for this dataset, not universal latency or memory guarantees.

| Measurement | Before | After |
|---|---:|---:|
| Snapshot metadata scan / warm cached snapshot | 122–129 ms | 8–10 ms |
| File/path operations per snapshot | 7,496 | 784 |
| Installed desktop warm HTTP snapshot median | — | 12.7 ms |

In a 10-second idle sample, the backend consumed 0.06 CPU seconds (about 0.6% of one core) and used approximately 91 MiB RSS. The native shell used approximately 92 MiB RSS with no measurable CPU-time increase in that interval. These figures **exclude system WebKit helper processes** and should not be described as total application memory.

Metadata caching expires after 60 seconds and invalidates on disk events, current configuration changes and API writes. Concurrent reads share the expensive scan. Vault material, authorization, memory and user context are reread; an unavailable vault still fails closed. Cache errors are not treated as an empty library. Unwatched changes discovered at expiry carry a metadata revision so the UI updates.

The frontend suspends polling while hidden and prevents overlapping polls. Asset delivery checks source content every 10 seconds with an approximately one-second event path. Unchanged projections and manifests are not rewritten. Session indexing responds after about 20 seconds, with a five-minute fallback. Sleep and Quit pause synchronization.

## Build and verify

```sh
npm ci
npm run typecheck
npm run check:web
npm test
npm run package:mac -- --arch arm64
node scripts/smoke-macos.mjs
```

Artifacts are in `dist/`: DMG, ZIP and their SHA256 manifest. `--skip-dmg` builds just the app and ZIP. `build-info.json` records the source commit, dirty-tree flag, app version, Node version, architecture and verified runtime hash. Release artifacts should be built from a clean committed tree.

The package smoke test starts the bundled runtime from a temporary home using only the system PATH. It verifies unauthenticated rejection, authenticated HTTP/static assets, the 24-agent catalog, and cleanup after the parent pipe closes. macOS CI builds and smoke-tests the package; Linux CI checks the shared backend.

Local validation included DMG checksum/mount integrity, bundle signature integrity, installation from the DMG, successful native launch, English/Chinese switching and the DeepSeek card. The final shared-source suite contains 316 passing tests. A separate clean Debian arm64/Node 22 run passed the earlier 308-test suite before the eight cache tests were added; GitHub CI provides the final commit's platform checks.
