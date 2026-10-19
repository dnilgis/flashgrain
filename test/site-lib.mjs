// Loads assets/js/site.js the way tools/feed.mjs does (vm, no board), so tests call the page's own helpers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "test/fixtures", name), "utf8"));

// cal: the parsed calendar to set as FG_CBOT (as feed.mjs does), or undefined for "no calendar".
export function loadFG(cal) {
  const window = cal ? { FG_CBOT: cal } : {};
  const document = { getElementById: () => null };
  vm.runInNewContext(readFileSync(join(ROOT, "assets/js/site.js"), "utf8"), { window, document, Intl, Date, Math });
  return window.FG;
}
