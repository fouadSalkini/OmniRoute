"use client";

import { useCallback, useEffect, useState } from "react";
import { parseTokenLimits, type TokenLimitRow } from "../apiKeyDetailsData";
import { TokenLimitsEditor } from "../components/TokenLimitsEditor";

/** Token limits save independently from the key's access-policy PATCH. */
export default function AccessTokenLimitsEditor({
  keyId,
  providers,
}: {
  keyId: string;
  providers: string[];
}) {
  const [limits, setLimits] = useState<TokenLimitRow[] | null>(null);
  const [saved, setSaved] = useState(false);
  const loadLimits = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(
          `/api/usage/token-limits?apiKeyId=${encodeURIComponent(keyId)}`,
          {
            cache: "no-store",
            signal,
          }
        );
        const body: unknown = await response.json();
        if (!signal?.aborted) setLimits(response.ok ? parseTokenLimits(body) : null);
      } catch {
        if (!signal?.aborted) setLimits(null);
      }
    },
    [keyId]
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadLimits(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadLimits]);

  return (
    <TokenLimitsEditor
      keyId={keyId}
      limits={limits}
      providers={providers}
      saved={saved}
      onSaved={async () => {
        await loadLimits();
        setSaved(true);
      }}
    />
  );
}
