import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractFrontmatter,
  parseHubTargets,
  repairLegacyHubWildcard,
  setHubTargets,
  skillAllowedFor,
  targetsAllow,
} from "./frontmatter.ts";

test("extractFrontmatter requires a closed YAML fence", () => {
  assert.equal(extractFrontmatter("# no fence\n"), null);
  assert.equal(extractFrontmatter("---\nname: demo\n"), null);
  const crlf = extractFrontmatter("---\r\nname: demo\r\n---\r\n\r\nBody\r\n");
  assert.equal(crlf?.yaml, "name: demo");
  assert.equal(crlf?.body, "Body\r\n");
});

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

test("setHubTargets unique-sorts agents and can clear hub.targets", () => {
  const md = `---\nname: demo\nhub:\n  targets: [grok]\n---\n\nBody\n`;
  assert.deepEqual(parseHubTargets(setHubTargets(md, ["grok", "grok", "cursor"])), ["grok", "cursor"]);
  assert.equal(parseHubTargets(setHubTargets(md, null)), null);
});

test("repairLegacyHubWildcard quotes the bare * alias", () => {
  const broken = "---\nname: demo\nhub:\n  targets: [*]\n---\n\nBody\n";
  assert.throws(() => parseHubTargets(broken), /有效 YAML/);
  const repaired = repairLegacyHubWildcard(broken);
  assert.deepEqual(parseHubTargets(repaired), ["*"]);
  assert.equal(repairLegacyHubWildcard("# not yaml\n"), "# not yaml\n");
});
