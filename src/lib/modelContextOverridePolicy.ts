import { getModelContextOverrideRecord } from "@/lib/db/modelContextOverrides";
import type { ModelCapabilityResolutionSnapshot } from "@/lib/modelCapabilityResolutionSnapshot";
import { getAuthoritativeContextWindow } from "@/shared/constants/modelSpecs";

// Windows an `auto:discovery` override may not undercut: model-id entries only (native
// Claude/GLM). Hosted-provider entries stay overridable because hosts can cap lower.
export function getDiscoveryProtectedContextWindow(
  modelId: string | null,
  rawModel: string | null
): number | null {
  for (const candidate of [modelId, rawModel]) {
    const contextWindow = getAuthoritativeContextWindow(candidate);
    if (typeof contextWindow === "number") return contextWindow;
  }
  return null;
}

export function getContextOverrideSource(
  resolved: {
    provider: string | null;
    model: string | null;
    rawModel: string | null;
  },
  snapshot?: ModelCapabilityResolutionSnapshot | null
): "manual" | "auto:discovery" | null {
  if (snapshot?.contextOverrideSources && resolved.provider && resolved.model) {
    const src = snapshot.contextOverrideSources.get(resolved.provider)?.get(resolved.model);
    if (src) return src;
    if (resolved.rawModel && resolved.rawModel !== resolved.model) {
      const rawSrc = snapshot.contextOverrideSources.get(resolved.provider)?.get(resolved.rawModel);
      if (rawSrc) return rawSrc;
    }
  }
  const rec = getModelContextOverrideRecord(resolved.provider, resolved.model);
  if (rec) return rec.source;
  if (resolved.rawModel && resolved.rawModel !== resolved.model) {
    const rawRec = getModelContextOverrideRecord(resolved.provider, resolved.rawModel);
    if (rawRec) return rawRec.source;
  }
  return null;
}
