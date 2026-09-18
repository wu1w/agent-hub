import fs from "node:fs/promises";

export async function i18nPrelude(): Promise<string> {
  const errors = await fs.readFile(new URL("../../web/errors.js", import.meta.url), "utf8");
  const i18n = await fs.readFile(new URL("../../web/i18n.js", import.meta.url), "utf8");
  const strip = (src: string) =>
    src
      .replace(/^import[^\n]+\n/gm, "")
      .replace(/\bexport default \w+;\n?/g, "")
      .replace(/\bexport /g, "");
  return `${strip(errors)}\n${strip(i18n)}\ncurrent = "zh";\n`;
}

export function i18nSandbox(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    localStorage: { getItem: () => "zh", setItem() {}, removeItem() {} },
    navigator: { language: "zh-CN" },
    ...extra,
  };
}
