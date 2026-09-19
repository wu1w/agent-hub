import { HubError } from "./errors.ts";
import { loadVault } from "./vault.ts";

export type SecretMaterial = {
  ok: boolean;
  secrets: string[];
};

/** Values shorter than this are skipped during redaction. A PIN like "1234"
 *  would otherwise rewrite session titles, dates, and IDs that happen to contain it. */
export const MIN_REDACT_SECRET_LENGTH = 8;

export async function loadSecretMaterial(): Promise<SecretMaterial> {
  try {
    const store = await loadVault();
    const out: string[] = [];
    for (const entry of store.entries) {
      for (const field of entry.fields) {
        if (!field.secret) continue;
        const value = field.value.trim();
        if (value.length >= MIN_REDACT_SECRET_LENGTH) out.push(value);
      }
    }
    return { ok: true, secrets: out.sort((a, b) => b.length - a.length) };
  } catch {
    return { ok: false, secrets: [] };
  }
}

export async function requireSecretMaterial(): Promise<SecretMaterial> {
  const material = await loadSecretMaterial();
  if (!material.ok) {
    throw new HubError(
      "Vault unavailable; indexing and handoff are paused. Source files are unchanged. Restore the vault and retry.",
      503,
    );
  }
  return material;
}

export async function knownSecrets(): Promise<string[]> {
  const loaded = await loadSecretMaterial();
  return loaded.ok ? loaded.secrets : [];
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_REDACT_SECRET_LENGTH) continue;
    // Also scrub legacy derived forms and JSON-escaped transcripts.
    const variants = [secret, secret.replace(/\s+/g, " ").trim(), JSON.stringify(secret).slice(1, -1)];
    for (const value of variants.sort((a, b) => b.length - a.length)) {
      if (value.length >= MIN_REDACT_SECRET_LENGTH) out = out.split(value).join("***");
    }
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
