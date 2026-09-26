"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { getProviderDisplayName } from "@/lib/display/names";
import {
  ANTHROPIC_RATE_LIMIT_HEADER_MODES,
  isAnthropicRateLimitHeaderMode,
  toggleSharedQuotaProvider,
} from "../selfServiceQuota";
import type {
  AnthropicRateLimitHeaderMode,
  QuotaProviderOption,
  SelfServiceQuota,
} from "../selfServiceQuota";

const HEADER_MODE_COPY: Record<AnthropicRateLimitHeaderMode, { label: string; desc: string }> = {
  auto: { label: "anthropicRateLimitHeadersAuto", desc: "anthropicRateLimitHeadersAutoDesc" },
  forward: {
    label: "anthropicRateLimitHeadersForward",
    desc: "anthropicRateLimitHeadersForwardDesc",
  },
  strip: { label: "anthropicRateLimitHeadersStrip", desc: "anthropicRateLimitHeadersStripDesc" },
};

/**
 * Controlled editor for the per-key self-service quota settings: which reachable
 * providers' shared account quota the key holder can see (`null` = all, `[]` = none,
 * otherwise an explicit subset) and the upstream `anthropic-ratelimit-*` header mode.
 * Used by the API key permissions modal and the per-key details page.
 */
export function SelfServiceQuotaSettings({
  value,
  onChange,
  providerOptions,
  disabled = false,
  showProviderPicker = true,
}: {
  value: SelfServiceQuota;
  onChange: (next: SelfServiceQuota) => void;
  providerOptions: readonly QuotaProviderOption[];
  disabled?: boolean;
  /** The provider picker only matters while the key shares account quota. */
  showProviderPicker?: boolean;
}) {
  const t = useTranslations("apiManager");
  const baseId = useId();
  const headerSelectId = `${baseId}-headers`;
  const shareAll = value.sharedQuotaProviders === null;
  const selected = value.sharedQuotaProviders ?? [];
  const reachable = new Set(providerOptions.map((option) => option.provider));
  // Keep a saved provider visible after it stops being reachable so it can be unchecked.
  const rows: QuotaProviderOption[] = [
    ...providerOptions,
    ...selected
      .filter((provider) => !reachable.has(provider))
      .map((provider) => ({ provider, connectionCount: 0 })),
  ];

  const setProviders = (sharedQuotaProviders: string[] | null) =>
    onChange({ ...value, sharedQuotaProviders });

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
      {showProviderPicker && (
        <fieldset className="flex flex-col gap-2" disabled={disabled}>
          <legend className="text-sm font-medium text-text-main">
            {t("sharedQuotaProvidersTitle")}
          </legend>
          <p className="text-xs text-text-muted">{t("sharedQuotaProvidersDesc")}</p>
          <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-4">
            <label className="inline-flex items-center gap-2 text-xs text-text-main">
              <input
                type="radio"
                name={`${baseId}-mode`}
                checked={shareAll}
                onChange={() => setProviders(null)}
              />
              {t("sharedQuotaProvidersAll")}
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-text-main">
              <input
                type="radio"
                name={`${baseId}-mode`}
                checked={!shareAll}
                onChange={() => setProviders(providerOptions.map((option) => option.provider))}
              />
              {t("sharedQuotaProvidersSelected")}
            </label>
          </div>
          {!shareAll && rows.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-md border border-border bg-surface/40 p-2">
              {rows.map((option) => (
                <li key={option.provider}>
                  <label className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-main">
                    <input
                      type="checkbox"
                      checked={selected.includes(option.provider)}
                      onChange={() =>
                        setProviders(toggleSharedQuotaProvider(selected, option.provider))
                      }
                    />
                    <span className="font-medium">{getProviderDisplayName(option.provider)}</span>
                    <span className="text-text-muted">
                      {reachable.has(option.provider)
                        ? t("sharedQuotaProviderConnections", { count: option.connectionCount })
                        : t("sharedQuotaProviderUnreachable")}
                    </span>
                    {option.quotaSupported === false && (
                      <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] text-text-muted dark:bg-white/5">
                        {t("sharedQuotaProviderNoQuotaData")}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {providerOptions.length === 0 && (
            <p className="text-xs text-text-muted">{t("sharedQuotaProvidersNoneReachable")}</p>
          )}
          {!shareAll && selected.length === 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
              {t("sharedQuotaProvidersNoneSelected")}
            </p>
          )}
        </fieldset>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={headerSelectId} className="text-sm font-medium text-text-main">
          {t("anthropicRateLimitHeadersLabel")}
        </label>
        <p className="text-xs text-text-muted">{t("anthropicRateLimitHeadersDesc")}</p>
        <select
          id={headerSelectId}
          value={value.anthropicRateLimitHeaders}
          disabled={disabled}
          onChange={(event) => {
            const mode = event.target.value;
            if (isAnthropicRateLimitHeaderMode(mode)) {
              onChange({ ...value, anthropicRateLimitHeaders: mode });
            }
          }}
          className="w-full rounded-control border border-black/10 bg-surface px-3 py-2 text-[16px] text-text-main focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-50 sm:w-auto sm:text-sm dark:border-white/10"
        >
          {ANTHROPIC_RATE_LIMIT_HEADER_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(HEADER_MODE_COPY[mode].label)}
            </option>
          ))}
        </select>
        <ul className="flex flex-col gap-0.5 text-[11px] text-text-muted">
          {ANTHROPIC_RATE_LIMIT_HEADER_MODES.map((mode) => (
            <li
              key={mode}
              className={value.anthropicRateLimitHeaders === mode ? "text-text-main" : undefined}
            >
              <span className="font-semibold">{t(HEADER_MODE_COPY[mode].label)}:</span>{" "}
              {t(HEADER_MODE_COPY[mode].desc)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
