"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Button, CardSkeleton } from "@/shared/components";
import { useApiKeyDetails } from "./useApiKeyDetails";
import { AccountQuotasSection } from "./components/AccountQuotasSection";
import { formatDateTime, StatusBadge } from "./components/DetailsPrimitives";
import { LimitsSection } from "./components/LimitsSection";
import { SelfServiceSettingsCard } from "./components/SelfServiceSettingsCard";
import { TokenLimitsEditor } from "./components/TokenLimitsEditor";
import { UsageLimitCard } from "./components/UsageLimitCard";
import { UsageSummarySection } from "./components/UsageSummarySection";
import { VisibilityControls } from "./components/VisibilityControls";

type SavedSection = "visibility" | "selfService" | "usageLimit" | "keyQuota" | "tokenLimits";

const LOAD_ERROR_KEYS = {
  not_found: "loadNotFound",
  forbidden: "loadForbidden",
  failed: "loadFailed",
} as const;

/**
 * Per-key information and statistics page: UTC day/week usage, every enforced limit,
 * the shared account quota preview, and the controls that shape them. Each control
 * saves on its own and then refetches the whole page.
 */
export default function ApiKeyDetailsPageClient({ keyId }: { keyId: string }) {
  const t = useTranslations("apiKeyDetails");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { data, error, loading, refreshing, reload } = useApiKeyDetails(keyId);
  const [savedSection, setSavedSection] = useState<SavedSection | null>(null);

  const savedHandler = useCallback(
    (section: SavedSection) => async () => {
      await reload();
      setSavedSection(section);
    },
    [reload]
  );

  const view = data?.view;
  const keyConfig = data?.keyConfig ?? null;
  const name = view?.apiKey.name || keyConfig?.name || "";
  const generatedAt = formatDateTime(view?.generatedAt ?? null, locale);

  return (
    <div className="w-full min-w-0 space-y-6 pb-10">
      <header className="space-y-3">
        <Link href="/dashboard/api-manager" className="text-sm text-primary hover:underline">
          ← {t("backToKeys")}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="break-words text-2xl font-semibold tracking-tight text-text-main">
              {name || t("pageTitle")}
            </h1>
            <p className="break-all font-mono text-xs text-text-muted">
              {t("keyIdLabel", { id: keyId })}
            </p>
            {generatedAt && (
              <p className="text-[11px] text-text-muted">
                {t("generatedAt", { date: generatedAt })}
              </p>
            )}
          </div>
          {data && (
            <Button
              variant="secondary"
              size="sm"
              icon="refresh"
              loading={refreshing}
              onClick={() => void reload()}
            >
              {tc("refresh")}
            </Button>
          )}
        </div>
        {view && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("visibilityTitle")}>
            <StatusBadge
              tone={view.visibility.selfUsage ? "good" : "neutral"}
              icon={view.visibility.selfUsage ? "visibility" : "visibility_off"}
            >
              {view.visibility.selfUsage ? t("badgeUsageVisible") : t("badgeUsageHidden")}
            </StatusBadge>
            <StatusBadge
              tone={view.visibility.accountQuota ? "warn" : "neutral"}
              icon={view.visibility.accountQuota ? "visibility" : "visibility_off"}
            >
              {view.visibility.accountQuota ? t("badgeQuotaVisible") : t("badgeQuotaHidden")}
            </StatusBadge>
          </div>
        )}
      </header>

      {loading ? (
        <div role="status" aria-live="polite" aria-busy="true" className="space-y-4">
          <span className="sr-only">{tc("loading")}</span>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <CardSkeleton />
            <CardSkeleton />
          </div>
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : !data || !view ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-card border border-red-500/30 bg-red-500/5 p-4"
        >
          <p className="text-sm text-red-700 dark:text-red-300">
            {t(LOAD_ERROR_KEYS[error ?? "failed"])}
          </p>
          <Button size="sm" variant="secondary" icon="refresh" onClick={() => void reload()}>
            {tc("retry")}
          </Button>
        </div>
      ) : (
        <>
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              {t("refreshFailed")}
            </p>
          )}
          <UsageSummarySection daily={view.usage.daily} weekly={view.usage.weekly} />
          <LimitsSection limits={view.limits} />
          <AccountQuotasSection
            quotas={view.accountQuotas}
            visibleToKeyHolder={view.visibility.accountQuota}
          />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <VisibilityControls
              keyId={keyId}
              keyConfig={keyConfig}
              visibility={view.visibility}
              saved={savedSection === "visibility"}
              onSaved={savedHandler("visibility")}
            />
            <SelfServiceSettingsCard
              keyId={keyId}
              settings={view.settings}
              availableProviders={view.availableProviders}
              saved={savedSection === "selfService"}
              onSaved={savedHandler("selfService")}
            />
            <UsageLimitCard
              key={`usage:${keyConfig?.usageLimitEnabled}:${keyConfig?.dailyUsageLimitUsd}:${keyConfig?.weeklyUsageLimitUsd}`}
              keyId={keyId}
              keyConfig={keyConfig}
              saved={savedSection === "usageLimit"}
              onSaved={savedHandler("usageLimit")}
            />
          </div>
          <TokenLimitsEditor
            keyId={keyId}
            limits={data.tokenLimits}
            providers={view.availableProviders.map((option) => option.provider)}
            saved={savedSection === "tokenLimits"}
            onSaved={savedHandler("tokenLimits")}
          />
        </>
      )}
    </div>
  );
}
