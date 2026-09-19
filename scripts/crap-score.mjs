#!/usr/bin/env node
/** CRAP = C^2 * (1 - coverage)^3 + C  (Crap4j; coverage is 0–1). */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "scripts", "crap-report.json");

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, acc);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, "''");
}

function complexity(src) {
  const text = strip(src);
  let c = 1;
  const re = /\b(if|for|while|case|catch)\b|&&|\|\||\?(?![?.])/g;
  while (re.exec(text)) c += 1;
  return c;
}

function crap(c, cov) {
  const p = Math.min(1, Math.max(0, cov));
  return Number((c * c * (1 - p) ** 3 + c).toFixed(2));
}

function parseCoverage(text) {
  const cov = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:#\s*)?(\S+\.ts)\s+\|\s+([\d.]+)/);
    if (!m) continue;
    const file = m[1].replace(/^\.\//, "");
    cov.set(file.replaceAll("\\", "/"), Number(m[2]) / 100);
  }
  return cov;
}

const files = walk(path.join(root, "src"));
const run = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    "--test-coverage-exclude=**/*.test.ts",
    "src/core/*.test.ts",
    "src/server.test.ts",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 40_000_000, env: process.env },
);

const coverageText = `${run.stdout}\n${run.stderr}`;
if (run.status !== 0 && !coverageText.includes("# tests")) {
  console.error(coverageText.slice(-4000));
  process.exit(run.status || 1);
}

const cov = parseCoverage(coverageText);
const rows = files.map((full) => {
  const rel = path.relative(root, full).replaceAll("\\", "/");
  const c = complexity(fs.readFileSync(full, "utf8"));
  const coverage = cov.has(rel) ? cov.get(rel) : cov.has(path.basename(rel)) ? cov.get(path.basename(rel)) : 0;
  return { file: rel, complexity: c, coverage: Number((coverage * 100).toFixed(2)), crap: crap(c, coverage) };
}).sort((a, b) => b.crap - a.crap);

const report = {
  generatedAt: new Date().toISOString(),
  formula: "CRAP = C² × (1 − coverage)³ + C",
  testsExit: run.status,
  files: rows.length,
  high: rows.filter((r) => r.crap >= 30).length,
  medium: rows.filter((r) => r.crap >= 15 && r.crap < 30).length,
  low: rows.filter((r) => r.crap < 15).length,
  rows,
};

fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`CRAP report → ${path.relative(root, outFile)}`);
console.log(`high(≥30)=${report.high}  medium(15–29)=${report.medium}  low(<15)=${report.low}`);
for (const row of rows.slice(0, 15)) {
  console.log(`${String(row.crap).padStart(8)}  C=${String(row.complexity).padStart(4)}  cov=${String(row.coverage).padStart(6)}%  ${row.file}`);
}
if (run.status !== 0) process.exit(run.status);
