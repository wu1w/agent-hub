import { HubError } from "./errors.ts";
import { loadVault } from "./vault.ts";

export type SecretMaterial = {
  ok: boolean;
  secrets: string[];
};

export async function loadSecretMaterial(): Promise<SecretMaterial> {
  try {
    const store = await loadVault();
    const out: string[] = [];
    for (const entry of store.entries) {
      for (const field of entry.fields) {
        if (!field.secret) continue;
        const value = field.value.trim();
        if (value) out.push(value);
      }
    }
    return { ok: true, secrets: out.sort((a, b) => b.length - a.length) };
  } catch {
    return { ok: false, secrets: [] };
  }
}

export async function requireSecretMaterial(): Promise<SecretMaterial> {
  const material = await loadSecretMaterial();
  if (!material.ok) throw new HubError("保险库暂不可用，已暂停索引和交接访问；原文件保持不变，请恢复保险库后重试", 503);
  return material;
}

export async function knownSecrets(): Promise<string[]> {
  const loaded = await loadSecretMaterial();
  return loaded.ok ? loaded.secrets : [];
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    // Also scrub legacy derived forms and JSON-escaped transcripts.
    const variants = [secret, secret.replace(/\s+/g, " ").trim(), JSON.stringify(secret).slice(1, -1)];
    for (const value of variants.sort((a, b) => b.length - a.length)) if (value) out = out.split(value).join("***");
  }
  return out;
}

export function redactOrOmit(text: string, material: SecretMaterial): string {
  if (!material.ok) return "";
  return redactSecrets(text, material.secrets);
}

export async function redactDerived(text: string): Promise<string> {
  const material = await loadSecretMaterial();
  return redactOrOmit(text, material);
}
