# Agent Hub

A local control plane for assets shared by multiple agents. One set of user assets, bound by capability across 23 agents. Extra adapters are Memory-first. The software does not run a model.

Source and docs live in this repository. Runtime data lives in `~/.agent-hub/`.

- [Product requirements (PRD)](docs/PRD.md)
- [Technical specification (SPEC)](docs/SPEC.md)
- [2026-09-17 audit fixes and upgrade notes](docs/audit-fixes-2026-09-17.md)
- [Round 6 fixes and overall audit](docs/audit-round6-2026-09-17.md)
- [Round 7 fixes and regression audit](docs/audit-round7-2026-09-17.md)
- [Computer Use browser acceptance](docs/computer-use-acceptance-2026-09-17.md)

## What it is

Skills, identity, memory, sessions, and secrets end up in a different directory for each agent. Agent Hub does three things:

1. **Hub.** User-editable content is stored once: skills, user and project conventions, memory, an encrypted vault, and a session index.
2. **Agents.** Each layer of each agent is set to follow Hub or to keep its own files. Identity is always that agent's own file.
3. **Delivery.** A Hub layer is attached with a symlink, a projection, or an inject by name. An Own layer is left untouched.

The screen follows [CC Switch](https://github.com/farion1231/cc-switch): one place to see every tool. It does not take CC Switch's provider switching or local API routing. Storage follows the "one authority, adapters deliver it" idea from Luzi, without a capability marketplace, invite codes, or a cloud catalog.

## What it is not

- Another agent or chat window
- A community capability network like Luzi (luzi.ai)
- A provider, relay, or usage panel like CC Switch
- One writable history merged from every session jsonl
- One identity file collected and then redistributed

## Six layers

| Layer | Authority | How an agent binds |
|---|---|---|
| Identity | That agent's own identity file | No dropdown. Markdown editor in the app |
| Skills | `~/.agent-hub/skills/` (user skills) | Hub = symlink. Own = leave it alone |
| Ctx | Hub `USER.md`; repo `AGENTS.md` | Hub = project the short user file. Project conventions stay in the repo |
| Memory | `~/.agent-hub/memory/` | Hub = read-only inject. Own = that agent's private memory |
| Sessions | Original files stay put. Hub only indexes them | This agent only, or listed in the catalog |
| Vault | Encrypted store at `~/.agent-hub/vault/` | Off / Own / Hub (called by name, not symlinked) |

Vendor skills, such as `~/.cursor/skills-cursor` and `~/.grok/bundled/skills`, are not adopted.

## Target runtimes

There are 23 entries. The original five start enabled (Grok CLI, Cursor, Codex, grok-hyper, WorkBuddy), plus any client already detected on the machine. The rest are turned on by hand from the catalog on the Agents page. Hermes and Claude Code have session scanners and still default to Own. The sixteen newer entries support Memory only. The list and native entry points are in [Popular agent notes](docs/popular-agents-2026-09-16.md). Skill paths for the original five:

| id | Runtime | User skill directory (illustrative) |
|---|---|---|
| `grok` | Grok CLI | `~/.grok/skills` |
| `cursor` | Cursor Agent | `~/.cursor/skills` |
| `codex` | Codex | `~/.codex/skills` |
| `hyper` | grok-hyper | skill directory under `~/.grok-hyper` |
| `workbuddy` | WorkBuddy | `~/.workbuddy/skills` |

Existing handoff paths stay in place: `cursor-grok-bridge` (Cursor → Grok), and Codex's Cursor session import.

## Data directory

User assets default to `~/.agent-hub/`, separate from this repository. Vault ciphertext must not enter git, skill symlinks, or iCloud sync.

## Status

P0–P3 are in place: skill adopt and symlink, project skill promotion, Memory inject, session index with a short summary, handoff notes, Vault, and Grok subagent editing.

```bash
cd ~/agent-hub
npm install
npm run hub -- scan
npm run hub -- status
npm run hub -- remember "a long-term note" --project world
npm run hub -- index
npm run hub -- vault
npm run hub -- vault get xai-api --for grok
npm run hub -- repair
npm run hub -- project-skills --cwd ~/world
npm run hub -- promote --cwd ~/world local-hook
npm run hub -- subagents
npm run hub -- catalog
npm run hub -- catalog on gemini
npm run hub -- vault exec --for grok -- grok
npm run web
# open http://127.0.0.1:3950
```

`hub adopt` moves each agent's **user** skill directory into `~/.agent-hub/skills` and symlinks it according to the bind. Vendor directories such as `~/.cursor/skills-cursor` are not touched. Run `scan`, or look at "not yet adopted" in the UI, before adopting.

CI on GitHub Actions (Node 22) runs `npm run typecheck`, `npm run check:web`, and `npm test`.

Implementation order is in the [PRD](docs/PRD.md) and the [SPEC](docs/SPEC.md).

## Native memory autoload (2026-09-16)

Memory covers Grok CLI, Cursor, Codex, grok-hyper, WorkBuddy, and Hermes / Claude Code. New adapters default to Own. A client that is not installed does not get a fake config directory.

After global Memory is set to Hub, it takes effect in a new session. Cursor and grok-hyper use native workspace rules, so register the workspace on the Memory page first (project id `*` loads global memory only). After upgrading an existing bind, use "resync load entries".

Entry points, limits, CLI usage, and live verification are in the [autoload notes](docs/memory-autoload-2026-09-16.md).

## Popular agent expansion (2026-09-16)

There are 23 adapters. OpenCode, Gemini CLI, Cline, Roo Code (archived), Kilo Code, Windsurf, GitHub Copilot CLI, Goose, Qwen Code, Pi, OpenClaw, Aider, ZCode, Grok Bot, Doubao, and Kimi Code expose native Memory autoload. Other layers are disabled. Grok Bot and Doubao have no native entry point, so they use manual import and export only. The default is Own. Config schema 5 does not silently expand an old list to 23 entries. A new install enables the original five and any client already detected. Scope, native docs, and verification limits are in the [adapter notes](docs/popular-agents-2026-09-16.md).

### Round 4 boundary fixes

`bind.<agent>.memory` is the only Memory bind authority. The unused `layers.memory.targets` field is removed. Old copies of that field are ignored on read and dropped on the next save. Private memory is not written into Git-tracked files. Untracked delivery files and config are listed in `.git/info/exclude`. Turning a bind off leaves that exclude in place so a later commit does not pick the file up (`git add -f` can still force it). Paths that look like sync directories are rejected. Cline uses only a registered workspace. Cross-client fallbacks such as `CLAUDE.md` and `.cursorrules` are not written and are not silently hidden; clean up that client's own entry first. The Agents page can filter cards, append a one-shot identity draft from `USER.md`, show skill source and mtime, and skip the first-run guide. Filtering does not change binds. A draft is saved only when asked. The guide leaves Own binds, vendor skills, and Vault state as they are.

## Desktop agents added (2026-09-17)

ZCode, Grok Bot, Doubao, and Kimi Code are included. ZCode and Kimi Code support a native `AGENTS.md`. Grok Bot and Doubao get a clearly labeled manual memory export. New entries default to Own. Scope and limits are in the [adapter notes](docs/desktop-agents-2026-09-17.md).

## Control-plane completion (2026-09-18)

- Default enablement is the original five plus clients already detected. `hub catalog on|off` changes the enabled list only, not binds.
- Saving identity for Cursor, Grok, or Codex projects it onto a path that runtime can load. Cursor global Memory is written to `~/.cursor/rules/hub-generated.mdc`.
- Hermes and Claude can use `Sessions=index`. A handoff includes an argv that can be executed. With Vault set to Hub, `hub vault exec --for <agent> -- <cmd>` injects granted environment variables into a child process. HTTP returns the command plan only, not secrets.
- The web UI polls `diskEpoch` and refreshes status. It does not remount symlinks on its own.
