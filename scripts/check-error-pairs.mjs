#!/usr/bin/env node
/** Fail if thrown Hub/Error literals are missing from errors.js, or if ERROR_PAIRS are not reversible. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_PAIRS, translateError } from "../web/errors.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

for (const [en, zh] of ERROR_PAIRS) {
  if (translateError(en, "en") !== en) problems.push(`pair en→en drifted: ${en}`);
  if (translateError(en, "zh") !== zh) problems.push(`pair en→zh drifted: ${en}`);
  if (translateError(zh, "en") !== en) problems.push(`pair zh→en drifted: ${zh}`);
  if (translateError(zh, "zh") !== zh) problems.push(`pair zh→zh drifted: ${zh}`);
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const throwRe = /throw new (?:HubError|Error)\(\s*(["'`])([\s\S]*?)\1/g;
const skip = /^(usage: |invalid config|invalid names|abort)/;

for (const file of walk(path.join(root, "src"))) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(throwRe)) {
    const message = match[2];
    if (message.includes("${") || message.endsWith(": ") || skip.test(message)) continue;
    const en = translateError(message, "en");
    const zh = translateError(message, "zh");
    const hasHan = /[\u4e00-\u9fff]/.test(message);
    if (hasHan && en === message) problems.push(`${path.relative(root, file)}: unmapped zh throw: ${message}`);
    if (!hasHan && zh === message) problems.push(`${path.relative(root, file)}: unmapped en throw: ${message}`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`ok ${ERROR_PAIRS.length} error pairs; throw literals mapped`);
