"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button, Input, Select } from "@/shared/components";
import { safeApiErrorMessage } from "../apiKeyDetailsData";
import type { TokenLimitRow } from "../apiKeyDetailsData";
import { sendJson } from "../useApiKeyDetails";
import {
  DetailsSection,
  EmptyNote,
  SaveFeedback,
  StatusBadge,
  UtilizationBar,
  formatCount,
  formatDateTime,
} from "./DetailsPrimitives";

type ScopeType = TokenLimitRow["scopeType"];
type ResetInterval = TokenLimitRow["resetInterval"];

interface Draft {
  id?: string;
  scopeType: ScopeType;
  scopeValue: string;
  tokenLimit: string;
  resetInterval: ResetInterval;
  resetTime: string;
  enabled: boolean;
}

const NEW_DRAFT: Draft = {
  scopeType: "global",
  scopeValue: "",
  tokenLimit: "",
  resetInterval: "monthly",
  resetTime: "00:00",
  enabled: true,
};

const SCOPE_TYPES: ScopeType[] = ["global", "provider", "model"];
const RESET_INTERVALS: ResetInterval[] = ["daily", "weekly", "monthly"];
const SCOPE_TYPE_KEYS: Record<ScopeType, string> = {
  global: "scopeGlobal",
  provider: "scopeProvider",
  model: "scopeModel",
};
const INTERVAL_KEYS: Record<ResetInterval, string> = {
  daily: "windowDaily",
  weekly: "windowWeekly",
  monthly: "windowMonthly",
};

function toDraft(row: TokenLimitRow): Draft {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeValue: row.scopeValue,
    tokenLimit: String(row.tokenLimit),
    resetInterval: row.resetInterval,
    resetTime: row.resetTime,
    enabled: row.enabled,
  };
}

/** Per-key token budgets (`/api/usage/token-limits`), scoped globally, per provider or per model. */
export function TokenLimitsEditor({
  keyId,
  limits,
  providers,
  saved,
  onSaved,
}: {
  keyId: string;
  limits: TokenLimitRow[] | null;
  providers: string[];
  saved: boolean;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations("apiKeyDetails");
  const tc = useTranslations("common");
  const locale = useLocale();
  const providerListId = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeText = (scopeType: ScopeType, scopeValue: string) =>
    scopeType === "global"
      ? t("scopeGlobal")
      : t(scopeType === "provider" ? "scopeProviderValue" : "scopeModelValue", {
          value: scopeValue,
        });

  const run = async (request: () => ReturnType<typeof sendJson>): Promise<boolean> => {
    setSaving(true);
    setError(null);
    const res = await request();
    if (res.ok) await onSaved();
    else setError(safeApiErrorMessage(res.body, t("saveFailed")));
    setSaving(false);
    return res.ok;
  };

  const submit = async () => {
    if (!draft) return;
    const tokenLimit = Number(draft.tokenLimit);
    const scopeValue = draft.scopeType === "global" ? "" : draft.scopeValue.trim();
    if (!Number.isInteger(tokenLimit) || tokenLimit <= 0) {
      setError(t("tokenLimitInvalid"));
      return;
    }
    if (draft.scopeType !== "global" && !scopeValue) {
      setError(t("tokenLimitScopeRequired"));
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(draft.resetTime)) {
      setError(t("tokenLimitResetTimeInvalid"));
      return;
    }
    const ok = await run(() =>
      sendJson("/api/usage/token-limits", "POST", {
        ...(draft.id && { id: draft.id }),
        apiKeyId: keyId,
        scopeType: draft.scopeType,
        scopeValue,
        tokenLimit,
        resetInterval: draft.resetInterval,
        resetTime: draft.resetTime,
        enabled: draft.enabled,
      })
    );
    if (ok) setDraft(null);
  };

  const remove = (row: TokenLimitRow) => {
    if (!window.confirm(t("tokenLimitDeleteConfirm"))) return;
    void run(() => sendJson(`/api/usage/token-limits?id=${encodeURIComponent(row.id)}`, "DELETE"));
  };

  const update = (patch: Partial<Draft>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const editing = Boolean(draft?.id);

  return (
    <DetailsSection
      title={t("tokenLimitsTitle")}
      description={t("tokenLimitsDesc")}
      icon="data_usage"
      action={
        limits && !draft ? (
          <Button size="sm" icon="add" onClick={() => setDraft({ ...NEW_DRAFT })}>
            {t("tokenLimitAdd")}
          </Button>
        ) : null
      }
    >
      {limits === null ? (
        <EmptyNote>{t("tokenLimitsUnavailable")}</EmptyNote>
      ) : (
        <div className="flex flex-col gap-3">
          {limits.length === 0 && !draft && <EmptyNote>{t("tokenLimitsEmpty")}</EmptyNote>}
          {limits.length > 0 && (
            <ul className="flex flex-col gap-2">
              {limits.map((row) => {
                const scope = scopeText(row.scopeType, row.scopeValue);
                const utilization = row.tokenLimit > 0 ? row.tokensUsed / row.tokenLimit : 0;
                const percent = Math.round(Math.min(utilization, 1) * 100);
                const nextReset = formatDateTime(row.nextResetAt, locale);
                return (
                  <li
                    key={row.id}
                    className="flex flex-col gap-2 rounded-lg border border-border bg-surface/40 p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="break-all text-sm font-medium text-text-main">
                          {scope}
                        </span>
                        <StatusBadge>{t(INTERVAL_KEYS[row.resetInterval])}</StatusBadge>
                        {!row.enabled && <StatusBadge tone="warn">{tc("disabled")}</StatusBadge>}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="edit"
                          disabled={saving}
                          aria-label={t("tokenLimitEditAria", { scope })}
                          onClick={() => setDraft(toDraft(row))}
                        >
                          {tc("edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="delete"
                          disabled={saving}
                          aria-label={t("tokenLimitDeleteAria", { scope })}
                          onClick={() => remove(row)}
                        >
                          {tc("delete")}
                        </Button>
                      </div>
                    </div>
                    <UtilizationBar
                      value={utilization}
                      label={t("utilizationAria", { name: scope, percent })}
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="tabular-nums text-text-main">
                        {t("usedOfLimit", {
                          used: formatCount(row.tokensUsed, locale),
                          limit: formatCount(row.tokenLimit, locale),
                        })}
                      </span>
                      <span className="text-text-muted" title={row.nextResetAt ?? undefined}>
                        {nextReset ? t("resetsAt", { date: nextReset }) : t("noReset")}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {draft && (
            <form
              className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3"
              aria-label={editing ? t("tokenLimitEditTitle") : t("tokenLimitAddTitle")}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <p className="text-sm font-medium text-text-main">
                {editing ? t("tokenLimitEditTitle") : t("tokenLimitAddTitle")}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Select
                  label={t("tokenLimitScope")}
                  value={draft.scopeType}
                  placeholder=""
                  disabled={editing}
                  hint={editing ? t("tokenLimitScopeLocked") : undefined}
                  options={SCOPE_TYPES.map((value) => ({
                    value,
                    label: t(SCOPE_TYPE_KEYS[value]),
                  }))}
                  onChange={(event) => update({ scopeType: event.target.value as ScopeType })}
                />
                {draft.scopeType !== "global" && (
                  <Input
                    label={draft.scopeType === "provider" ? t("scopeProvider") : t("scopeModel")}
                    value={draft.scopeValue}
                    disabled={editing}
                    list={draft.scopeType === "provider" ? providerListId : undefined}
                    placeholder={
                      draft.scopeType === "provider"
                        ? t("tokenLimitProviderPlaceholder")
                        : t("tokenLimitModelPlaceholder")
                    }
                    onChange={(event) => update({ scopeValue: event.target.value })}
                  />
                )}
                <Input
                  label={t("tokenLimitAmount")}
                  type="number"
                  min={1}
                  step="1"
                  inputMode="numeric"
                  required
                  value={draft.tokenLimit}
                  onChange={(event) => update({ tokenLimit: event.target.value })}
                />
                <Select
                  label={t("tokenLimitInterval")}
                  value={draft.resetInterval}
                  placeholder=""
                  options={RESET_INTERVALS.map((value) => ({
                    value,
                    label: t(INTERVAL_KEYS[value]),
                  }))}
                  onChange={(event) =>
                    update({ resetInterval: event.target.value as ResetInterval })
                  }
                />
                <Input
                  label={t("tokenLimitResetTime")}
                  type="time"
                  value={draft.resetTime}
                  onChange={(event) => update({ resetTime: event.target.value })}
                />
                <label className="flex items-center gap-2 self-end pb-2 text-sm text-text-main">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => update({ enabled: event.target.checked })}
                  />
                  {tc("enabled")}
                </label>
              </div>
              <datalist id={providerListId}>
                {providers.map((provider) => (
                  <option key={provider} value={provider} />
                ))}
              </datalist>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" icon="save" loading={saving}>
                  {tc("save")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    setDraft(null);
                    setError(null);
                  }}
                >
                  {tc("cancel")}
                </Button>
              </div>
            </form>
          )}
          <SaveFeedback error={error} saved={saved && !error && !draft ? t("saved") : null} />
        </div>
      )}
    </DetailsSection>
  );
}
