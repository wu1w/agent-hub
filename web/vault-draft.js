const MASK = "••••••••";

// Parse with the same heading/field/continuation boundaries as the backend.
function fields(markdown) {
  let id = "", current;
  const out = [];
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { id = heading[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); current = undefined; continue; }
    const field = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (field && id) { current = { id, name: field[1].trim(), value: field[2] }; out.push(current); }
    else if (current && line.trim() && !line.startsWith("#")) current.value += (current.value ? "\n" : "") + line;
  }
  return out;
}

export function mergeVaultDraft(edited, previous) {
  const old = new Map(fields(previous).map((f) => [JSON.stringify([f.id, f.name]), f.value]));
  let id = "", restored = false;
  return edited.split("\n").flatMap((line) => {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { restored = false; id = heading[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
    const field = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (field) restored = false;
    if (field && field[2] === MASK) {
      const value = old.get(JSON.stringify([id, field[1].trim()]));
      if (value !== undefined) { restored = true; return [`${field[1]}: ${value}`]; }
    }
    if (restored && line.trim() === MASK) return [];
    return [line];
  }).join("\n");
}
