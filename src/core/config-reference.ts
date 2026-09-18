import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { hubPaths } from "./config.ts";
import { parse, modify, applyEdits, type ParseError } from "jsonc-parser";
import { parseDocument, isMap } from "yaml";
import { readText, removeFile, writeText } from "./fsx.ts";

export type ConfigReference = { path: string; key: "instructions" | "read"; format: "jsonc" | "yaml" };
export type ReferenceState = ConfigReference & { value: string; added: boolean; originalPath: string | null; writtenHash: string };

export function parseJsonConfig(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || Array.isArray(value) || typeof value !== "object") throw new Error("invalid JSON/JSONC configuration; no changes made");
  return value;
}

function edit(text: string, ref: ConfigReference, transform: (values: string[], present: boolean) => string[] | undefined): string {
  if (ref.format === "jsonc") {
    const data = parseJsonConfig(text || "{}");
    const v = data[ref.key];
    if (v !== undefined && (!Array.isArray(v) || !v.every(x => typeof x === "string"))) throw new Error(`${ref.key} must be an array of strings`);
    const next = transform(v as string[] || [], v !== undefined);
    return applyEdits(text || "{}", modify(text || "{}", [ref.key], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  const doc = parseDocument(text || "{}", { uniqueKeys: true });
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) throw new Error("invalid YAML mapping; no changes made");
  const v: unknown = ((doc.toJS({ maxAliasCount: 100 }) || {}) as Record<string, unknown>)[ref.key];
  const values = v === undefined ? [] : typeof v === "string" ? [v] : v;
  if (!Array.isArray(values) || !values.every(x => typeof x === "string")) throw new Error(`${ref.key} must be a string or list of strings`);
  const next = transform(values, v !== undefined);
  if (next === undefined) doc.delete(ref.key); else doc.set(ref.key, next);
  return doc.toString();
}

export async function attachReference(ref: ConfigReference, value: string, previous?: ReferenceState): Promise<ReferenceState> {
  const current = await readText(ref.path);
  let added = previous?.added ?? false;
  const next = edit(current || "{}", ref, values => {
    if (values.includes(value)) return values;
    added = true;
    return [...values, value];
  });
  // Do not reformat a file that already contained the requested reference.
  const written = added ? next : current!;
  let originalPath = previous?.originalPath ?? null;
  if (!previous || current === null || hash(current) !== previous.writtenHash) {
    const clean = current === null ? null : previous?.added
      ? edit(current, ref, values => { const rest = values.filter(v => v !== value); return rest.length ? rest : undefined; })
      : current;
    originalPath = clean === null ? null : path.join(hubPaths().backups, "autoload-config", `${randomUUID()}.${ref.format}`);
    if (originalPath !== null) await writeText(originalPath, clean!);
  }
  if (written !== current) await writeText(ref.path, written);
  return { ...ref, value, added, originalPath, writtenHash: hash(written) };
}

export async function detachReference(ref: ReferenceState): Promise<void> {
  if (!ref.added) return;
  const current = await readText(ref.path);
  if (current === null) return;
  if (hash(current) === ref.writtenHash) {
    if (ref.originalPath === null) await removeFile(ref.path);
    else {
      const original = await readText(ref.originalPath);
      if (original === null) throw new Error("autoload configuration backup missing");
      await writeText(ref.path, original);
    }
    return;
  }
  let found = false;
  const next = edit(current, ref, values => {
    found = values.includes(ref.value);
    const remaining = values.filter(v => v !== ref.value);
    return remaining.length ? remaining : undefined;
  });
  if (found) await writeText(ref.path, next);
}

function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
