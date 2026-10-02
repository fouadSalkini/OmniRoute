import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";
import { splitCodexReasoningSuffix } from "../../open-sse/executors/codex/reasoningSuffix.ts";
import { withReasoningRuleContext } from "../../open-sse/utils/reasoningRuleContext.ts";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses/toResponses.ts";
import {
  normalizeCodexModelsResponse,
  buildCodexModelsUrl,
} from "../../src/app/api/providers/[id]/models/discovery/codex.ts";
import {
  getCodexClientVersion,
  getCodexDefaultHeaders,
} from "../../open-sse/config/codexClient.ts";
import { getPricingForModel } from "../../src/shared/constants/pricing.ts";
import { applyCodexGlobalFastServiceTier } from "../../src/lib/providers/codexFastTier.ts";
import { extendCodexGpt56EffortValues } from "../../src/shared/reasoning/effortStandardization.ts";
import {
  getReasoningEffortValues,
  getReasoningVariantBaseModelId,
  inferSelectedReasoningEffort,
  getDefaultReasoningEffort,
} from "../../src/lib/vscode/reasoningMetadata.ts";

const MODEL = "gpt-6.1-sol";
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

// Live catalog fields confirmed by openai/codex rust-v0.160.0 models.json.
// Neither catalog reports an output limit; do not borrow one from GPT-6 Sol.
const LIVE_MODEL = {
  slug: MODEL,
  visibility: "list",
  supported_in_api: true,
  max_context_window: 872000,
  supported_reasoning_levels: EFFORTS.map((effort) => ({ effort })),
};

test.after(async () => {
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDbInstance();
});

test("omitted GPT-6.1 Sol effort uses low on translated and native paths without changing other models", () => {
  const executor = new CodexExecutor();
  for (const native of [false, true]) {
    for (const model of [MODEL, "gpt-6-sol", "gpt-6-astra", "gpt-5.5"]) {
      const transformed = executor.transformRequest(
        model,
        { model, input: [], _nativeCodexPassthrough: native },
        true,
        { requestEndpointPath: "/responses", providerSpecificData: {} }
      );
      assert.equal(transformed.reasoning.effort, model === MODEL ? "low" : "medium");
    }
  }
});

test("GPT-6.1 Sol fallback preserves connection, request, suffix and force-rule precedence", () => {
  const executor = new CodexExecutor();
  const cases = [
    { model: MODEL, body: {}, expected: "high" },
    { model: MODEL, body: { reasoning_effort: "xhigh" }, expected: "xhigh" },
    {
      model: MODEL,
      body: { reasoning: { effort: "max" }, reasoning_effort: "xhigh" },
      expected: "max",
    },
    { model: `${MODEL}-low`, body: { reasoning: { effort: "max" } }, expected: "low" },
    {
      model: `${MODEL}-low`,
      body: { reasoning: { effort: "max" } },
      force: true,
      expected: "medium",
    },
  ];
  for (const native of [false, true]) {
    for (const scenario of cases) {
      const credentials = {
        requestEndpointPath: "/responses",
        providerSpecificData: { requestDefaults: { reasoningEffort: "high" } },
      };
      const transformed = executor.transformRequest(
        scenario.model,
        { model: scenario.model, input: [], _nativeCodexPassthrough: native, ...scenario.body },
        true,
        scenario.force
          ? withReasoningRuleContext(credentials, {
              id: "force-sol",
              effortMode: "force",
              targetEffort: "medium",
            })
          : credentials
      );
      assert.equal(transformed.reasoning.effort, scenario.expected);
    }
  }
});

test("GPT-6.1 Sol registry exposes only verified limits and effort aliases", () => {
  for (const provider of ["codex", "codex-app-server"]) {
    const models = getModelsByProviderId(provider);
    for (const id of [MODEL, ...EFFORTS.map((effort) => `${MODEL}-${effort}`)]) {
      const model = models.find((entry) => entry.id === id);
      assert.ok(model, `${provider}/${id}`);
      assert.equal(model.contextLength, 872000);
      assert.equal(model.maxOutputTokens, undefined);
      assert.equal(model.supportsReasoning, true);
      assert.equal(model.supportsVision, true);
      assert.equal(model.toolCalling, true);
      assert.equal(model.targetFormat, "openai-responses");
      assert.deepEqual(model.supportedThinkingEfforts, EFFORTS);
      assert.equal(getPricingForModel("cx", id), null);
      const credentials = { providerSpecificData: {} };
      const body: Record<string, unknown> = {};
      const resolved = applyCodexGlobalFastServiceTier(
        "codex",
        credentials,
        { codexServiceTier: true },
        { model: id, body }
      );
      assert.deepEqual(resolved.providerSpecificData, {
        requestDefaults: { serviceTier: "priority" },
      });
      assert.equal(body.service_tier, "priority");
    }
  }
});

test("live discovery retains GPT-6.1 Sol efforts and leaves output unknown", () => {
  const [model] = normalizeCodexModelsResponse({ models: [LIVE_MODEL] });
  assert.equal(model.id, MODEL);
  assert.equal(model.visibility, "list");
  assert.equal(model.supportedInApi, true);
  assert.equal(model.inputTokenLimit, 872000);
  assert.equal(model.outputTokenLimit, undefined);
  assert.deepEqual(model.supportedThinkingEfforts, EFFORTS);
  assert.deepEqual(
    normalizeCodexModelsResponse({ models: [{ ...LIVE_MODEL, visibility: "hide" }] }),
    []
  );
  assert.deepEqual(
    normalizeCodexModelsResponse({ models: [{ ...LIVE_MODEL, supported_in_api: false }] }),
    []
  );
});

test("GPT-6.1 Sol aliases and explicit reasoning survive chat and native translation", () => {
  const executor = new CodexExecutor();
  for (const effort of EFFORTS) {
    const alias = `${MODEL}-${effort}`;
    assert.deepEqual(splitCodexReasoningSuffix(alias), { baseModel: MODEL, effort });
    const aliasRequest = executor.transformRequest(alias, { model: alias, input: [] }, true, {
      requestEndpointPath: "/responses",
    });
    assert.equal(aliasRequest.model, MODEL);
    assert.equal(aliasRequest.reasoning.effort, effort === "ultra" ? "max" : effort);
    for (const inputModel of [
      MODEL,
      alias,
      ...(["max", "ultra"].includes(effort) ? [`${MODEL}(${effort})`] : []),
    ]) {
      const body = { model: inputModel, input: [], reasoning: { effort, summary: "detailed" } };
      const result = executor.transformRequest(inputModel, body, true, {
        requestEndpointPath: "/responses",
      });
      assert.equal(result.model, MODEL, inputModel);
      assert.equal(result.reasoning.effort, effort === "ultra" ? "max" : effort);
      assert.equal(result.reasoning.summary, "detailed");
    }
    const translated = openaiToOpenAIResponsesRequest(
      MODEL,
      {
        model: MODEL,
        messages: [{ role: "user", content: "test" }],
        reasoning_effort: effort,
      },
      true,
      {}
    );
    const result = executor.transformRequest(MODEL, translated, true, {
      requestEndpointPath: "/chat/completions",
    });
    assert.equal(result.model, MODEL);
    assert.equal(result.reasoning.effort, effort === "ultra" ? "max" : effort);
  }
  assert.equal(splitCodexReasoningSuffix("gpt-6.1-solstice-max").baseModel, "gpt-6.1-solstice-max");
});

test("catalog and VS Code normalize all GPT-6.1 Sol effort variants", () => {
  for (const prefix of ["cx", "codex"]) {
    assert.equal(getDefaultReasoningEffort({ id: `${prefix}/${MODEL}`, owned_by: "codex" }), "low");
    for (const effort of EFFORTS) {
      const id = `${prefix}/${MODEL}-${effort}`;
      const model = { id, owned_by: "codex", capabilities: { reasoning: true } };
      assert.deepEqual(extendCodexGpt56EffortValues(prefix, id, ["none", "low"]), EFFORTS);
      assert.deepEqual(getReasoningEffortValues(model), EFFORTS);
      assert.equal(inferSelectedReasoningEffort(model, EFFORTS), effort);
      assert.equal(getReasoningVariantBaseModelId(id), `${prefix}/${MODEL}`);
    }
  }
  assert.deepEqual(extendCodexGpt56EffortValues("kiro", MODEL, ["low"]), ["low"]);
});

test("default discovery and inference identity use the verified Codex 0.160.0 release", () => {
  const previousVersion = process.env.CODEX_CLIENT_VERSION;
  const previousAgent = process.env.CODEX_USER_AGENT;
  delete process.env.CODEX_CLIENT_VERSION;
  delete process.env.CODEX_USER_AGENT;
  try {
    assert.equal(getCodexClientVersion(), "0.160.0");
    assert.equal(new URL(buildCodexModelsUrl()).searchParams.get("client_version"), "0.160.0");
    assert.equal(getCodexDefaultHeaders().Version, "0.160.0");
    assert.match(getCodexDefaultHeaders()["User-Agent"], /codex-cli\/0\.160\.0 /);
  } finally {
    if (previousVersion === undefined) delete process.env.CODEX_CLIENT_VERSION;
    else process.env.CODEX_CLIENT_VERSION = previousVersion;
    if (previousAgent === undefined) delete process.env.CODEX_USER_AGENT;
    else process.env.CODEX_USER_AGENT = previousAgent;
  }
});
