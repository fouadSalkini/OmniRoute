/**
 * Production regression (node A, 2026-11-03): ~1-2 s event-loop stalls on every large agentic
 * chat request. CPU profiles attributed most of each stall to the conversation-tracker reconnect
 * walk (one HMAC per step, up to DEFAULT_RECONNECT_MAX_STEPS steps) running synchronously
 * inside resolveConversationId, so health checks and other requests waited behind it.
 *
 * The walk now yields to the event loop every RECONNECT_YIELD_EVERY_STEPS steps, and
 * resolutions sharing a fingerprint bucket are serialized so the read-walk-write sequence stays
 * atomic per conversation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-conv-cooperative-"));
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "conversation-cooperative-test-secret";

const tracker = await import("../../open-sse/services/conversationTracker.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

test.after(() => {
  try {
    resetDbInstance();
  } catch {
    /* already closed */
  }
});

type Turn = { role: string; content: string };

/** A duplicate-heavy agentic history: a polling tool loop repeats the same two turns. */
function pollingHistory(length: number): Turn[] {
  const turns: Turn[] = [{ role: "user", content: "start the build and watch it" }];
  for (let i = 1; i < length; i++) {
    turns.push(
      i % 2 === 1
        ? { role: "assistant", content: "Checking build status." }
        : { role: "user", content: "Process still running." }
    );
  }
  return turns;
}

/** An index whose every node shares the two duplicated content hashes, so walks are long. */
function duplicateHeavyIndex(turns: Turn[]) {
  const canonical = tracker.extractCanonicalTurns({ messages: turns });
  const hashes = canonical.map(tracker.hashTurnContent);
  const nodeIds = new Set<string>();
  const byContentHash = new Map<string, string[]>();
  const parentsWithChildren = new Set<string>();
  for (let i = 0; i < hashes.length; i++) {
    const id = `node-${i}`;
    nodeIds.add(id);
    const bucket = byContentHash.get(hashes[i]) ?? [];
    bucket.push(id);
    byContentHash.set(hashes[i], bucket);
    if (i > 0) parentsWithChildren.add(`node-${i - 1}`);
  }
  return { canonical, hashes, index: { nodeIds, byContentHash, parentsWithChildren } };
}

test("cooperative walk returns the same match and step count as the synchronous walk", async () => {
  const { canonical, hashes, index } = duplicateHeavyIndex(pollingHistory(400));
  const options = { turnHashes: hashes, maxSteps: 30_000 };
  const sync = tracker.findReconnectMatch(canonical, index, options);
  const cooperative = await tracker.findReconnectMatchCooperative(canonical, index, options);
  assert.deepEqual(cooperative, sync);
  assert.ok(sync.stepsUsed > tracker.RECONNECT_YIELD_EVERY_STEPS * 5, "walk must span many slices");
});

test("cooperative walk lets other event-loop work run before it finishes", async () => {
  const { canonical, hashes, index } = duplicateHeavyIndex(pollingHistory(400));
  let interleaved = 0;
  const ticker = setInterval(() => interleaved++, 0);
  try {
    const result = await tracker.findReconnectMatchCooperative(canonical, index, {
      turnHashes: hashes,
      maxSteps: 30_000,
    });
    assert.ok(result.stepsUsed > tracker.RECONNECT_YIELD_EVERY_STEPS * 5);
  } finally {
    clearInterval(ticker);
  }
  assert.ok(interleaved > 0, "timers must fire while the walk is in progress");
});

test("concurrent resolutions of one conversation stay serialized and continue the same id", async () => {
  const apiKeyId = "key-cooperative";
  const base = pollingHistory(60);
  const request = (messages: Turn[]) =>
    tracker.resolveConversationId({
      body: { model: "m", messages },
      model: "m",
      apiKeyId,
      clientSessionIdHeader: null,
      correlationId: `corr-${Math.random()}`,
    });
  const first = await request(base);
  assert.equal(first.isNewConversation, true);

  const continued = [...base, { role: "assistant", content: "Build finished." }];
  const [a, b] = await Promise.all([request(continued), request(continued)]);
  assert.equal(a.conversationId, first.conversationId);
  assert.equal(b.conversationId, first.conversationId);
  assert.equal(a.isNewConversation, false);
  assert.equal(b.isNewConversation, false);
});

test("a session's walk does not queue another session of the same API key", async () => {
  const apiKeyId = "key-cross-session";
  const request = (messages: Turn[], clientSessionId: string) =>
    tracker.resolveConversationId({
      body: { model: "m", messages },
      model: "m",
      apiKeyId,
      clientSessionIdHeader: null,
      clientSessionId,
      correlationId: `corr-${Math.random()}`,
    });
  // reconnectWalk stops once no later start can beat the best run, so the history has to be
  // long enough that even the shortened walk spans several RECONNECT_YIELD_EVERY_STEPS slices.
  const longHistory = pollingHistory(4000);
  await request(longHistory, "sess-long");

  // Continuing the duplicate-heavy history makes the reconnect walk span many yield slices.
  const continued = [...longHistory, { role: "assistant", content: "Checking build status." }];
  const finished: string[] = [];
  const long = request(continued, "sess-long").then(() => finished.push("long"));
  await new Promise((resolve) => setImmediate(resolve));
  const other = request([{ role: "user", content: "unrelated question" }], "sess-other").then(() =>
    finished.push("other")
  );
  await Promise.all([long, other]);
  assert.deepEqual(finished, ["other", "long"]);
});
