// Runs tools/feed.mjs --selftest under node:test so `node --test test/` covers it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("feed.mjs --selftest passes", () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../tools/feed.mjs", import.meta.url)), "--selftest"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!/FAIL/.test(r.stdout + r.stderr), r.stdout + r.stderr);
  assert.ok(/expired @S6X row leaves the feed/.test(r.stdout));
});
