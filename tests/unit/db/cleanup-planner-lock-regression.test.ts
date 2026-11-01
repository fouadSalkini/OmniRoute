import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cleanup-planner-lock-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;
const core = await import("../../../src/lib/db/core");
const cleanup = await import("../../../src/lib/db/cleanup");
const settings = await import("../../../src/lib/db/databaseSettings");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

test("scheduled cleanup does not force planner analysis or replace existing statistics", async () => {
  settings.updateDatabaseSettings({ retention: { autoCleanupEnabled: false } });
  const db = core.getDbInstance();
  const hasStats = () =>
    !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'").get();
  assert.equal(hasStats(), false);

  // 2026-11-01: forced analysis blocked the event loop for 3.6s and contended with writes.
  for (const phase of ["startup", "periodic"] as const) {
    await cleanup.runScheduledCleanupPass(phase);
    assert.equal(hasStats(), false, `${phase} cleanup must not start planner analysis`);
  }

  db.exec("ANALYZE");
  const before = db.prepare("SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx").all();
  assert.ok(before.length > 0);
  for (const phase of ["startup", "periodic"] as const) {
    await cleanup.runScheduledCleanupPass(phase);
    assert.deepEqual(
      db.prepare("SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx").all(),
      before,
      "statistics left by an earlier deployment must not be deleted or rewritten"
    );
  }
});
