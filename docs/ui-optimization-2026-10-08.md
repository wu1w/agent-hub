# Frontend workflow update (0.3.0)

The previous navigation separated related content across eight entries, exposed technical file names before their purpose, and changed connection modes by cycling through values. This update groups related work and makes pending edits explicit.

## Navigation and workflows

- Six primary destinations: Overview, Skills, Rules & memory, Sessions, Agents, and Vault. Shared memory and preferences/project rules are adjacent views; agent cards and the connection table are adjacent views. Existing deep links remain valid, and browser Back restores navigation.
- Overview leads with background synchronization and its last successful checks. Conflicts, broken links, and delivery warnings appear as actionable issues. Optional skill imports are separate from failures; zero-count issue cards disappear.
- Skills have one guided import entry and a secondary actions menu. Distribution scope is an explicit draft saved together with the content. Users choose default or custom scope; changing a target no longer writes immediately.
- Agent connection settings use explicit choices. Paths and previews are under expandable details. The installed-agent filter is shared across the cards and table, and the optional adapter catalog is collapsed.
- Project memory scope has named global/project choices and a project selector. The chosen project folder is reused within the session. Shared preferences and project conventions have plain-language labels with filenames shown as secondary information.
- A local quick switcher searches pages, skills, and agents with Cmd/Ctrl+K. It supports keyboard selection, cancellation, and focus restoration without a network search.
- Sessions have a readable two-pane layout. Changing filters clears a selection that is no longer present. Vault access and permissions retain their existing semantics.

## Reliability, accessibility, and cost

The current page is the only page rendered during polling. Agent identity files are read when their editor is expanded; unchanged agent cards retain their DOM and drafts. Explicit refresh bypasses the snapshot metadata cache. No frontend framework or additional runtime dependency was introduced.

Asynchronous reads cannot replace newer skill, memory, project, identity, or subagent drafts. Cancel and Escape cannot repeat a previous dialog confirmation. Native buttons, links, selects, current-location states, focus restoration, and visible search controls support keyboard use. Both existing locales remain supported, including localized number/date formatting and narrow-window navigation.

## Validation

Automated coverage includes delayed responses, draft/revision handling, atomic skill scope saves, stale session responses, explicit refresh, source navigation, and quick search. Interactive checks used an isolated temporary Hub and covered import/scope navigation, content plus scope saving, project rules, agent previews, cancellation, empty session results, English/Chinese, and a 390 px viewport. The packaged application is separately smoke-tested with a temporary home and system-only PATH; all frontend modules must be present in the bundle.

The final source suite passes 352 tests, along with TypeScript and frontend checks. Interactive regression also confirmed that a memory draft survives a delivered-content preview and that freshly loaded preferences can be edited and saved.
