// handleChatCore wiring of agent-session turn capture. The extractor, DB module and route are
// covered in agent-session-messages.test.ts; this file proves handleChatCore's ACTUAL usage call
// sites hand a sessionTurn to the usage write, for both the streaming and the non-streaming
// success paths, via the observable side effect (rows in agent_session_messages). Mock fetch,
// call the real handleChatCore, assert real behaviour.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-session-turn-wiring-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const FLAG = "AGENT_SESSION_MESSAGES_ENABLED";
const originalFlag = process.env[FLAG];
process.env[FLAG] = "true";

const core = await import("../../src/lib/db/core.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { listAgentSessionMessages } = await import("../../src/lib/db/agentSessionMessages.ts");

const originalFetch = globalThis.fetch;
const MODEL = "gpt-4o-mini";

type TurnRow = {
  user: string | null;
  assistant: string | null;
  tools: string[];
};

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function streamingUpstream(text: string): Response {
  const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
  const base = { id: "chatcmpl-turn-wiring", object: "chat.completion.chunk", model: MODEL };
  const sse =
    chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text } }] }) +
    chunk({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }) +
    "data: [DONE]\n\n";
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonUpstream(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-turn-wiring-json",
      object: "chat.completion",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function invoke(options: {
  stream: boolean;
  prompt: string;
  reply: string;
  sessionId: string;
  apiKeyInfo: Record<string, unknown>;
}): Promise<void> {
  globalThis.fetch = (async () =>
    options.stream
      ? streamingUpstream(options.reply)
      : jsonUpstream(options.reply)) as typeof fetch;
  const body = {
    model: MODEL,
    stream: options.stream,
    messages: [{ role: "user", content: options.prompt }],
  };
  const result = await handleChatCore({
    body,
    modelInfo: { provider: "openai", model: MODEL, extendedContext: false },
    credentials: { apiKey: "sk-test-turn-wiring", providerSpecificData: {} },
    log: noopLog(),
    apiKeyInfo: options.apiKeyInfo,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: new Headers({
        accept: options.stream ? "text/event-stream" : "application/json",
        "x-omniroute-project": "demo-project",
        "x-omniroute-session-id": options.sessionId,
      }),
    },
    userAgent: "unit-test",
    isCombo: false,
  } as unknown as Parameters<typeof handleChatCore>[0]);
  const response = (result as { response?: Response }).response;
  assert.ok(response, "handleChatCore returned no response");
  assert.equal(response.status, 200);
  // Drain the body so the streaming path reaches onStreamComplete.
  await response.text();
}

function sessionRowId(clientSessionId: string): string | null {
  const row = core
    .getDbInstance()
    .prepare("SELECT id FROM agent_sessions WHERE client_session_id = ?")
    .get(clientSessionId) as { id: string } | undefined;
  return row?.id ?? null;
}

async function waitForSession(clientSessionId: string, timeoutMs = 4000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = sessionRowId(clientSessionId);
    if (id) return id;
    await new Promise((r) => setTimeout(r, 25));
  }
  return sessionRowId(clientSessionId);
}

function turnsFor(sessionRow: string): TurnRow[] {
  return listAgentSessionMessages(core.getDbInstance(), sessionRow).messages as TurnRow[];
}

before(async () => {
  core.resetDbInstance();
  await core.ensureDbInitialized();
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a streaming request with an agent identity stores its turn", async () => {
  await invoke({
    stream: true,
    prompt: "stream prompt",
    reply: "Streamed reply",
    sessionId: "sess-stream-1",
    apiKeyInfo: { id: "key-alice", name: "key-alice" },
  });
  const sessionRow = await waitForSession("sess-stream-1");
  assert.ok(sessionRow, "expected an agent session row for the streaming request");
  const turns = turnsFor(sessionRow);
  assert.equal(turns.length, 1, "expected exactly one stored turn for the streaming request");
  assert.equal(turns[0].user, "stream prompt");
  assert.equal(turns[0].assistant, "Streamed reply");
});

test("a non-streaming request with an agent identity stores its turn", async () => {
  await invoke({
    stream: false,
    prompt: "plain prompt",
    reply: "Plain reply",
    sessionId: "sess-json-1",
    apiKeyInfo: { id: "key-alice", name: "key-alice" },
  });
  const sessionRow = await waitForSession("sess-json-1");
  assert.ok(sessionRow, "expected an agent session row for the non-streaming request");
  const turns = turnsFor(sessionRow);
  assert.equal(turns.length, 1, "expected exactly one stored turn for the non-streaming request");
  assert.equal(turns[0].user, "plain prompt");
  assert.equal(turns[0].assistant, "Plain reply");
});

test("a noLog key still records the session but never stores a turn", async () => {
  await invoke({
    stream: true,
    prompt: "private prompt",
    reply: "Private reply",
    sessionId: "sess-nolog-1",
    apiKeyInfo: { id: "key-bob", name: "key-bob", noLog: true },
  });
  const sessionRow = await waitForSession("sess-nolog-1");
  assert.ok(sessionRow, "expected an agent session row for the noLog request");
  // Give any (erroneous) turn write the same window the positive cases get.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(turnsFor(sessionRow).length, 0);
});
