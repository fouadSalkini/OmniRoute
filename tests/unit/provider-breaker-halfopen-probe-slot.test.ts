/**
 * The HALF_OPEN probe that a combo dispatch consumes must still be credited.
 *
 * Live failure: chat.ts runs the combo probe inside `breaker.execute()`, which
 * takes the only HALF_OPEN slot and records nothing (combo results are
 * "ignore"). combo.ts then credits the outcome through
 * recordProviderSuccess(provider, connectionId) / recordProviderFailure(), but
 * recordProviderSuccess gated the provider breaker on `canExecute()` — false
 * while that slot is taken. Successful probes were never counted, so the provider
 * breaker stayed HALF_OPEN for hours, admitting one request per resetTimeout.
 * Failures keep that gate: while the probe is in flight, the failures reported
 * include the gate's own rejections of concurrent requests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCircuitBreaker,
  resetAllCircuitBreakers,
} from "../../src/shared/utils/circuitBreaker.ts";
import {
  recordProviderFailure,
  recordProviderSuccess,
} from "../../open-sse/services/accountFallback.ts";

const RESET_MS = 80;
const profile = { failureThreshold: 1, resetTimeoutMs: RESET_MS };

const uniqueProvider = (suffix: string) =>
  `probe-slot-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Open the provider breaker, let it reach HALF_OPEN, then run a combo probe through it. */
async function consumeHalfOpenProbe(provider: string) {
  recordProviderFailure(provider, undefined, undefined, profile);
  const breaker = getCircuitBreaker(provider);
  assert.equal(breaker.state, "OPEN");

  await new Promise((r) => setTimeout(r, RESET_MS + 40));
  assert.equal(breaker.canExecute(), true);
  assert.equal(breaker.state, "HALF_OPEN");

  await breaker.execute(async () => ({ success: true, status: 200 }), {
    classifyResult: () => "ignore",
  });
  assert.equal(breaker.canExecute(), false, "the probe holds the only HALF_OPEN slot");
  return breaker;
}

test("a successful combo probe holding the HALF_OPEN slot closes the provider breaker", async () => {
  const provider = uniqueProvider("success");
  const breaker = await consumeHalfOpenProbe(provider);

  recordProviderSuccess(provider, "conn-1");

  assert.equal(breaker.state, "CLOSED", "probe success must close the provider breaker");
  assert.equal(breaker.canExecute(), true);
  resetAllCircuitBreakers();
});

test("gate rejections while the probe is in flight do not reopen the provider breaker", async () => {
  const provider = uniqueProvider("gate-rejection");
  const breaker = await consumeHalfOpenProbe(provider);

  // A concurrent combo request is refused by the gate (canExecute() is false) and the
  // combo target loop reports that 503 like any provider failure.
  recordProviderFailure(provider, undefined, undefined, profile);
  assert.equal(breaker.state, "HALF_OPEN", "a gate rejection is not a probe failure");

  recordProviderSuccess(provider, "conn-1");
  assert.equal(breaker.state, "CLOSED", "the probe's success still closes the breaker");
  resetAllCircuitBreakers();
});
