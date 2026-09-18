import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHubTargets, setHubTargets, skillAllowedFor, targetsAllow } from "./frontmatter.ts";

test("parse bracket targets", () => {
  const md = `---\nname: panlong-xiaoshuo\nhub:\n  targets: [grok, hyper]\n---\n\n# x\n`;
  assert.deepEqual(parseHubTargets(md), ["grok", "hyper"]);
  assert.equal(targetsAllow(["grok", "hyper"], "cursor", true), false);
  assert.equal(targetsAllow(null, "cursor", true), true);
});

test("null targets fall back to config default_targets", () => {
  assert.equal(skillAllowedFor(null, "grok", ["grok"]), true);
  assert.equal(skillAllowedFor(null, "cursor", ["grok"]), false);
  assert.equal(skillAllowedFor(["*"], "cursor", ["grok"]), true);
  assert.equal(skillAllowedFor([], "grok", ["*"]), false);
});

test("setHubTargets roundtrip", () => {
  const md = `---\nname: frontend-design\ndescription: ui\n---\n\nBody.\n`;
  const next = setHubTargets(md, ["cursor"]);
  assert.deepEqual(parseHubTargets(next), ["cursor"]);
  assert.match(next, /Body\./);
});

test("explicit wildcard is preserved and not collapsed to defaults", () => {
  const md = `---\nname: demo\n---\n\n# demo\n`;
  const next = setHubTargets(md, ["*"]);
  assert.deepEqual(parseHubTargets(next), ["*"]);
  assert.equal(skillAllowedFor(parseHubTargets(next), "cursor", ["grok"]), true);
});
