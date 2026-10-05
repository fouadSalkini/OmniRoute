/**
 * A request that never reaches the provider must not count against its breaker.
 *
 * Live failure: one upstream 503 put the only usable account into a short
 * cooldown. Every request during that window got a locally synthesized
 * "No <provider> accounts currently available ... after upstream 503", and each
 * refusal was recorded as a provider failure by the chat.ts no-credentials
 * path. Ten refusals in ~18s opened the whole-provider breaker although the
 * provider itself had failed once.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("provider-breaker-unreached");
const { getCircuitBreaker } = await import("../../src/shared/utils/circuitBreaker.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { buildRequest, handleChat, resetStorage, seedConnection, settingsDb } = harness;

/** The only connection is cooling down after an upstream 503. */
async function seedCoolingConnection(provider: string) {
  const connection = await seedConnection(provider);
  await providersDb.updateProviderConnection(connection.id, {
    testStatus: "unavailable",
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    lastError: "upstream connect error or disconnect/reset before headers",
    errorCode: 503,
  });
}

let fetchCalls = 0;

test.beforeEach(async () => {
  await resetStorage();
  await settingsDb.updateSettings({ requestRetry: 0 });
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("the provider must not be contacted");
  };
});

test.afterEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

test("single-model refusals while every account cools down leave the provider breaker untouched", async () => {
  await seedCoolingConnection("openai");

  for (let i = 0; i < 3; i++) {
    const response = await handleChat(
      buildRequest({
        body: { model: "openai/gpt-4.1", messages: [{ role: "user", content: "hi" }] },
      })
    );
    assert.equal(response.status, 503);
  }

  const breaker = getCircuitBreaker("openai");
  assert.equal(fetchCalls, 0);
  assert.equal(breaker.failureCount, 0, "no upstream call, no provider failure");
  assert.equal(breaker.state, "CLOSED");
});

test("a request that reaches the provider and gets a 503 still counts", async () => {
  await seedConnection("openai");
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };

  const response = await handleChat(
    buildRequest({
      body: { model: "openai/gpt-4.1", messages: [{ role: "user", content: "hi" }] },
    })
  );

  assert.equal(response.status, 503);
  assert.ok(fetchCalls >= 1, "the provider was contacted");
  assert.ok(getCircuitBreaker("openai").failureCount >= 1, "a real upstream 503 is a failure");
});
