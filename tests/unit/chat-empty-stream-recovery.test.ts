import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const artifacts = path.resolve("_artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(artifacts, "empty-stream-recovery-"));
process.env.DATA_DIR = dataDir;
process.env.REQUIRE_API_KEY = "false";
process.env.INITIAL_PASSWORD = "";
process.env.DASHBOARD_PASSWORD = "";
process.env.API_KEY_SECRET = "test-empty-stream-recovery";
process.env.STREAM_READINESS_TIMEOUT_MS = "1000";
process.env.FLUSH_EMPTY_RETRY_ENABLED = "false";
process.env.STREAM_READINESS_STALL_RETRY_ENABLED = "false";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { handleChat } = await import("../../src/sse/handlers/chat.ts");
const { initTranslators } = await import("../../open-sse/translator/index.ts");
const { clearInflight } = await import("../../open-sse/services/requestDedup.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");
const originalFetch = globalThis.fetch;

function claudeStream(text = ""): Response {
  const frames: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: {
        id: "msg-test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    },
  ];
  if (text) {
    frames.push(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 }
    );
  }
  frames.push(
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: text ? 3 : 0 },
    },
    { type: "message_stop" }
  );
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

function streamRequest(
  extraHeaders: Record<string, string> = {},
  model = "claude/claude-opus-5-5-xhigh"
): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: `Reply OK. ${crypto.randomUUID()}` }],
      stream: true,
      max_tokens: 1024,
    }),
  });
}

async function seedConnection(
  name: string,
  provider: "claude" | "codex" = "claude"
): Promise<{ id: string; token: string }> {
  const token = `test-${name}`;
  const row = await providersDb.createProviderConnection({
    provider,
    authType: "oauth",
    name,
    accessToken: token,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    isActive: true,
    testStatus: "active",
    providerSpecificData: provider === "codex" ? { workspaceId: `workspace-${name}` } : undefined,
  });
  return { id: row.id, token };
}

function responsesEvent(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

type CodexStreamOptions = {
  text?: string;
  functionCall?: boolean;
};

function codexResponsesStream({ text, functionCall }: CodexStreamOptions = {}): Response {
  const functionItem = {
    id: "fc-test",
    type: "function_call",
    call_id: "call-test",
    name: "lookup",
    arguments: "",
  };
  const messageItem = {
    id: "msg-test",
    type: "message",
    role: "assistant",
    content: text ? [{ type: "output_text", text }] : [],
  };
  const output = functionCall ? [functionItem] : text ? [messageItem] : [];
  const frames = [responsesEvent("response.created", { response: { status: "in_progress" } })];
  if (functionCall) {
    frames.push(
      responsesEvent("response.output_item.added", { output_index: 0, item: functionItem })
    );
  }
  if (text) {
    frames.push(
      responsesEvent("response.output_item.added", { output_index: 0, item: messageItem }),
      responsesEvent("response.output_text.delta", {
        item_id: "msg-test",
        output_index: 0,
        content_index: 0,
        delta: text,
      })
    );
  }
  frames.push(
    responsesEvent("response.completed", {
      response: {
        id: "resp-test",
        status: "completed",
        output,
        usage: { input_tokens: 1, output_tokens: text || functionCall ? 1 : 0, total_tokens: 2 },
      },
    })
  );
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

function delayedEncryptedReasoningCodexStream(delayMs: number): Response {
  const reasoning = {
    id: "rs-encrypted",
    type: "reasoning",
    encrypted_content: "opaque-upstream-reasoning",
    summary: [],
  };
  const frames = [
    responsesEvent("response.created", {
      response: { id: "resp-reasoning", status: "in_progress" },
    }),
    responsesEvent("response.output_item.added", { output_index: 0, item: reasoning }),
    responsesEvent("response.completed", {
      response: { id: "resp-reasoning", status: "completed", output: [reasoning] },
    }),
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const streamEncoder = new TextEncoder();
        controller.enqueue(streamEncoder.encode(frames[0]));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        for (const frame of frames.slice(1)) controller.enqueue(streamEncoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

function stubCodexDispatches(reply: (token: string, attempt: number) => Response): string[] {
  const dispatches: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("/backend-api/codex/responses")) {
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    }
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    dispatches.push(token);
    return reply(token, dispatches.length);
  };
  return dispatches;
}

function delayedEmptyClaudeStream(delayMs: number): Response {
  const frames = [
    {
      type: "message_start",
      message: {
        id: "msg-delayed-empty",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(`event: ${frames[0].type}\ndata: ${JSON.stringify(frames[0])}\n\n`)
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        for (const frame of frames.slice(1)) {
          controller.enqueue(
            encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
          );
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

test.beforeEach(async () => {
  clearInflight();
  resetAllCircuitBreakers();
  initTranslators();
  await settingsDb.updateSettings({ fallbackStrategy: "fill-first", autoDbBackup: false });
});

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  await callLogs.waitForCallLogSaves(2000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  flushProxyLogsSync();
  clearInflight();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function stubClaudeDispatches(reply: (token: string, attempt: number) => Response): string[] {
  const dispatches: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/v1/messages")) {
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    }
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    dispatches.push(token);
    return reply(token, dispatches.length);
  };
  return dispatches;
}

test("empty Claude lifecycle recovers on an eligible sibling before exposing a 502", async () => {
  const first = await seedConnection("empty");
  const sibling = await seedConnection("healthy");
  const dispatches = stubClaudeDispatches((token) =>
    token === first.token ? claudeStream() : claudeStream("RECOVERED")
  );

  const response = await handleChat(streamRequest());
  const body = await response.text();

  assert.match(
    body,
    /RECOVERED/,
    "client must receive the healthy sibling, not an empty-content 502"
  );
  assert.doesNotMatch(body, /Provider returned empty content/);
  assert.deepEqual(dispatches, [first.token, sibling.token], "recovery must spend only one retry");
  assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), sibling.id);
});

test("empty Codex Responses lifecycle recovers on an eligible sibling", async () => {
  const first = await seedConnection("codex-empty", "codex");
  const sibling = await seedConnection("codex-healthy", "codex");
  const dispatches = stubCodexDispatches((token) =>
    token === first.token
      ? codexResponsesStream()
      : codexResponsesStream({ text: "CODEX_RECOVERED" })
  );

  const response = await handleChat(streamRequest({}, "codex/gpt-6.1-sol-xhigh"));
  const body = await response.text();

  assert.match(body, /CODEX_RECOVERED/);
  assert.doesNotMatch(body, /Provider returned empty content/);
  assert.deepEqual(dispatches, [first.token, sibling.token]);
  assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), sibling.id);
});

test("a delayed encrypted-only Codex reasoning response recovers instead of committing empty output", async () => {
  const first = await seedConnection("codex-reasoning-empty", "codex");
  const sibling = await seedConnection("codex-reasoning-healthy", "codex");
  const combo = await combosDb.createCombo({
    name: "codex-reasoning-empty-recovery",
    strategy: "priority",
    models: ["codex/gpt-6.1-sol-xhigh"],
    config: { maxRetries: 1, retryDelayMs: 0, maxGlobalAttempts: 2 },
  });
  const dispatches = stubCodexDispatches((token) =>
    token === first.token
      ? delayedEncryptedReasoningCodexStream(1_100)
      : codexResponsesStream({ text: "CODEX_REASONING_RECOVERED" })
  );

  const response = await handleChat(streamRequest({}, combo.name));
  const body = await response.text();

  assert.match(body, /CODEX_REASONING_RECOVERED/);
  assert.doesNotMatch(body, /Provider returned empty content/);
  assert.deepEqual(dispatches, [first.token, sibling.token]);
});

test("Codex text output commits the stream without retrying another account", async () => {
  const first = await seedConnection("codex-text", "codex");
  await seedConnection("codex-text-sibling", "codex");
  const dispatches = stubCodexDispatches(() => codexResponsesStream({ text: "TEXT_COMMITTED" }));

  const response = await handleChat(streamRequest({}, "codex/gpt-6.1-sol-xhigh"));
  const body = await response.text();

  assert.match(body, /TEXT_COMMITTED/);
  assert.deepEqual(dispatches, [first.token]);
});

test("Codex function_call start commits the stream before arguments complete", async () => {
  const first = await seedConnection("codex-tool", "codex");
  await seedConnection("codex-tool-sibling", "codex");
  const dispatches = stubCodexDispatches(() => codexResponsesStream({ functionCall: true }));

  const response = await handleChat(streamRequest({}, "codex/gpt-6.1-sol-xhigh"));
  const body = await response.text();

  assert.equal(response.status, 200, body);
  assert.match(body, /lookup/);
  assert.deepEqual(dispatches, [first.token]);
});

test("a Codex request pinned to one connection never rotates an empty response", async () => {
  const pinned = await seedConnection("codex-pinned", "codex");
  await seedConnection("codex-pinned-sibling", "codex");
  const dispatches = stubCodexDispatches(() => codexResponsesStream());

  const response = await handleChat(
    streamRequest({ "X-OmniRoute-Connection": pinned.id }, "codex/gpt-6.1-sol-xhigh")
  );

  assert.equal(response.status, 502);
  assert.deepEqual(dispatches, [pinned.token]);
});

test("combo rotates after a delayed empty Claude lifecycle beyond the content probe", async () => {
  const first = await seedConnection("combo-delayed-empty");
  const sibling = await seedConnection("combo-delayed-healthy");
  const combo = await combosDb.createCombo({
    name: "delayed-empty-recovery",
    strategy: "priority",
    models: ["claude/claude-opus-5-5-xhigh"],
    config: { maxRetries: 1, retryDelayMs: 0, maxGlobalAttempts: 2 },
  });
  const dispatches = stubClaudeDispatches((token) =>
    token === first.token ? delayedEmptyClaudeStream(1_100) : claudeStream("DELAYED_RECOVERED")
  );

  const response = await handleChat(streamRequest({}, combo.name));
  const body = await response.text();

  assert.match(body, /DELAYED_RECOVERED/);
  assert.doesNotMatch(body, /Provider returned empty content/);
  assert.deepEqual(dispatches, [first.token, sibling.token]);
});

test("singleton replays once; a still-empty upstream surfaces 502 with no account cooldown", async () => {
  const single = await seedConnection("single");
  const dispatches = stubClaudeDispatches(() => claudeStream());

  const response = await handleChat(streamRequest());

  assert.equal(response.status, 502);
  assert.deepEqual(dispatches, [single.token, single.token]);
  const body = await response.json();
  assert.equal(body.error.code, "empty_content");
  const row = await providersDb.getProviderConnectionById(single.id);
  assert.equal(row?.testStatus, "active");
  assert.ok(!row?.rateLimitedUntil, "an empty turn must not disable the account");
});

test("API-key allowlist forbids healthy out-of-scope siblings during empty recovery", async () => {
  const allowed = await seedConnection("allowed");
  await seedConnection("forbidden");
  const key = await apiKeysDb.createApiKey("restricted", "test", [], {
    allowedConnections: [allowed.id],
  });
  const dispatches = stubClaudeDispatches((token) =>
    token === allowed.token ? claudeStream() : claudeStream("FORBIDDEN")
  );

  const response = await handleChat(streamRequest({ Authorization: `Bearer ${key.key}` }));

  assert.equal(response.status, 502);
  assert.deepEqual(dispatches, [allowed.token, allowed.token]);
  assert.doesNotMatch(await response.text(), /FORBIDDEN/);
});

test("explicit connection pin never rotates or retries an empty turn", async () => {
  const pinned = await seedConnection("pinned");
  await seedConnection("healthy");
  const dispatches = stubClaudeDispatches(() => claudeStream());

  const response = await handleChat(streamRequest({ "X-OmniRoute-Connection": pinned.id }));

  assert.equal(response.status, 502);
  assert.deepEqual(dispatches, [pinned.token]);
});

test("combo uses its two-attempt budget to recover without nested empty retries", async () => {
  const first = await seedConnection("combo-empty");
  const healthy = await seedConnection("combo-healthy");
  const combo = await combosDb.createCombo({
    name: "empty-recovery",
    strategy: "priority",
    models: ["claude/claude-opus-5-5-xhigh"],
    config: { maxRetries: 1, retryDelayMs: 0, maxGlobalAttempts: 2 },
  });
  const dispatches = stubClaudeDispatches((token) =>
    token === first.token ? claudeStream() : claudeStream("COMBO_RECOVERED")
  );

  const response = await handleChat(streamRequest({}, combo.name));
  const body = await response.text();

  assert.match(body, /COMBO_RECOVERED/);
  assert.doesNotMatch(body, /Provider returned empty content/);
  assert.deepEqual(dispatches, [first.token, healthy.token]);
});
