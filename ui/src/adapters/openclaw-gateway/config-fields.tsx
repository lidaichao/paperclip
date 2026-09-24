import { l10n } from "../../i18n";
import { configFieldsForSection } from "../config-sections";
import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";
import {
  PayloadTemplateJsonField,
  RuntimeServicesJsonField,
} from "../runtime-json-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function HeadersJsonTextarea({
  isCreate,
  createDraft,
  onCreateDraftChange,
  editStringified,
  onEditCommit,
  inputClass,
}: {
  isCreate: boolean;
  createDraft: string;
  onCreateDraftChange: (next: string) => void;
  editStringified: string;
  onEditCommit: (next: string) => void;
  inputClass: string;
}) {
  const [editDraft, setEditDraft] = useState<string>(editStringified);
  const [lastSyncedFromConfig, setLastSyncedFromConfig] = useState<string>(editStringified);
  useEffect(() => {
    if (isCreate) return;
    if (editStringified !== lastSyncedFromConfig) {
      setEditDraft(editStringified);
      setLastSyncedFromConfig(editStringified);
    }
  }, [editStringified, isCreate, lastSyncedFromConfig]);
  const value = isCreate ? createDraft : editDraft;
  return (
    <textarea
      value={value}
      onChange={(e) => {
        const next = e.target.value;
        if (isCreate) {
          onCreateDraftChange(next);
        } else {
          setEditDraft(next);
          onEditCommit(next);
        }
      }}
      rows={3}
      className={inputClass}
      placeholder='{"x-custom-header": "value"}'
    />
  );
}

function SecretField({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <DraftInput
          value={value}
          onCommit={onCommit}
          immediate
          type={visible ? "text" : "password"}
          className={inputClass + " pl-8"}
          placeholder={placeholder}
        />
      </div>
    </Field>
  );
}

function parseScopes(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").join(", ");
  }
  return typeof value === "string" ? value : "";
}

export function OpenClawGatewayConfigFields({
  section,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const configuredHeaders =
    config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
      ? (config.headers as Record<string, unknown>)
      : {};
  const effectiveHeaders =
    (eff("adapterConfig", "headers", configuredHeaders) as Record<string, unknown>) ?? {};

  const effectiveGatewayToken = typeof effectiveHeaders["x-openclaw-token"] === "string"
    ? String(effectiveHeaders["x-openclaw-token"])
    : typeof effectiveHeaders["x-openclaw-auth"] === "string"
      ? String(effectiveHeaders["x-openclaw-auth"])
      : "";

  const commitGatewayToken = (rawValue: string) => {
    const nextValue = rawValue.trim();
    const nextHeaders: Record<string, unknown> = { ...effectiveHeaders };
    if (nextValue) {
      nextHeaders["x-openclaw-token"] = nextValue;
      delete nextHeaders["x-openclaw-auth"];
    } else {
      delete nextHeaders["x-openclaw-token"];
      delete nextHeaders["x-openclaw-auth"];
    }
    mark("adapterConfig", "headers", Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined);
  };

  const sessionStrategy = eff(
    "adapterConfig",
    "sessionKeyStrategy",
    String(config.sessionKeyStrategy ?? "fixed"),
  );

  return configFieldsForSection(section, (
    <>
      <Field label={l10n("local.gateway_url_3d069508")} hint={help.webhookUrl}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="ws://127.0.0.1:18789"
        />
      </Field>

      <PayloadTemplateJsonField
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
      />

      {/* Auth and Identity - available in both create and edit modes */}
      <SecretField
        label={l10n("local.gateway_auth_token_a31b5be3")}
        value={
          isCreate
            ? values!.authToken ?? ""
            : effectiveGatewayToken
        }
        onCommit={(v) =>
          isCreate
            ? set!({ authToken: v })
            : commitGatewayToken(v)
        }
        placeholder={l10n("local.openclaw_gateway_token_dbcf48fe")}
      />

      <Field label={l10n("local.agent_id_510bce73")}>
        <DraftInput
          value={
            isCreate
              ? values!.agentId ?? ""
              : eff("adapterConfig", "agentId", String(config.agentId ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ agentId: v })
              : mark("adapterConfig", "agentId", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="agent-123"
        />
      </Field>

      <Field label={l10n("local.session_strategy_1747233a")}>
        <select
          value={
            isCreate
              ? values!.sessionKeyStrategy ?? "fixed"
              : sessionStrategy
          }
          onChange={(e) =>
            isCreate
              ? set!({ sessionKeyStrategy: e.target.value })
              : mark("adapterConfig", "sessionKeyStrategy", e.target.value)
          }
          className={inputClass}
        >
          <option value="fixed">{l10n("local.fixed_1246fc93")}</option>
          <option value="issue">{l10n("local.per_issue_a1ce76ec")}</option>
          <option value="run">{l10n("local.per_run_97bc74ee")}</option>
        </select>
      </Field>

      {(isCreate ? values!.sessionKeyStrategy ?? "fixed" : sessionStrategy) === "fixed" && (
        <Field label={l10n("local.session_key_2319ec27")}>
          <DraftInput
            value={
              isCreate
                ? values!.sessionKey ?? ""
                : eff("adapterConfig", "sessionKey", String(config.sessionKey ?? "paperclip"))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ sessionKey: v })
                : mark("adapterConfig", "sessionKey", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="paperclip"
          />
        </Field>
      )}

      <SecretField
        label={l10n("local.password_alternative_auth_a0623db1")}
        value={
          isCreate
            ? values!.password ?? ""
            : eff("adapterConfig", "password", String(config.password ?? ""))
        }
        onCommit={(v) =>
          isCreate
            ? set!({ password: v })
            : mark("adapterConfig", "password", v || undefined)
        }
        placeholder={l10n("local.gateway_shared_password_6a063dc2")}
      />

      <Field label={l10n("local.role_14736a2e")}>
        <DraftInput
          value={
            isCreate
              ? values!.role ?? ""
              : eff("adapterConfig", "role", String(config.role ?? "operator"))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ role: v })
              : mark("adapterConfig", "role", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder={l10n("local.operator_06e55b63")}
        />
      </Field>

      <Field label={l10n("local.scopes_comma_separated_79d74bdb")}>
        <DraftInput
          value={
            isCreate
              ? values!.scopes ?? ""
              : eff("adapterConfig", "scopes", parseScopes(config.scopes ?? ["operator.admin"]))
          }
          onCommit={(v) => {
            const parsed = v
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean);
            if (isCreate) {
              set!({ scopes: v });
            } else {
              mark("adapterConfig", "scopes", parsed.length > 0 ? parsed : undefined);
            }
          }}
          immediate
          className={inputClass}
          placeholder="operator.admin"
        />
      </Field>

      <RuntimeServicesJsonField
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
      />

      <Field label={l10n("local.paperclip_api_url_override_5462f769")}>
        <DraftInput
          value={
            isCreate
              ? values!.paperclipApiUrl ?? ""
              : eff("adapterConfig", "paperclipApiUrl", String(config.paperclipApiUrl ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ paperclipApiUrl: v })
              : mark("adapterConfig", "paperclipApiUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://paperclip.example"
        />
      </Field>

      <Field configSection="runPolicy" label={l10n("local.timeout_seconds_1f966032")}>
        <DraftInput
          value={
            isCreate
              ? values!.timeoutSec != null ? String(values!.timeoutSec) : ""
              : eff("adapterConfig", "timeoutSec", String(config.timeoutSec ?? ""))
          }
          onCommit={(v) => {
            const parsed = Number.parseInt(v.trim(), 10);
            const val = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
            if (isCreate) {
              set!({ timeoutSec: val });
            } else {
              mark("adapterConfig", "timeoutSec", val);
            }
          }}
          immediate
          className={inputClass}
          placeholder="120"
        />
      </Field>

      <Field label={l10n("local.headers_json_2899a831")}>
        <HeadersJsonTextarea
          isCreate={isCreate}
          createDraft={isCreate ? values!.headersJson ?? "" : ""}
          onCreateDraftChange={(next) => set!({ headersJson: next })}
          editStringified={JSON.stringify(eff("adapterConfig", "headers", config.headers ?? {}), null, 2)}
          onEditCommit={(next) => {
            const trimmed = next.trim();
            if (!trimmed) {
              mark("adapterConfig", "headers", undefined);
              return;
            }
            try {
              const parsed = JSON.parse(trimmed);
              if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                mark("adapterConfig", "headers", parsed);
              }
            } catch {
              // Keep local draft until JSON is valid
            }
          }}
          inputClass={inputClass}
        />
      </Field>

      {!isCreate && (
        <Field label={l10n("local.claimed_api_key_path_be223b29")}>
          <DraftInput
            value={eff("adapterConfig", "claimedApiKeyPath", String(config.claimedApiKeyPath ?? ""))}
            onCommit={(v) => mark("adapterConfig", "claimedApiKeyPath", v || undefined)}
            immediate
            className={inputClass}
            placeholder="~/.openclaw/workspace/paperclip-claimed-api-key.json"
          />
        </Field>
      )}

      <Field configSection="runPolicy" label={l10n("local.wait_timeout_ms_9e659817")}>
        <DraftInput
          value={
            isCreate
              ? values!.waitTimeoutMs != null
                ? String(values!.waitTimeoutMs)
                : ""
              : eff("adapterConfig", "waitTimeoutMs", String(config.waitTimeoutMs ?? "120000"))
          }
          onCommit={(v) => {
            const parsed = Number.parseInt(v.trim(), 10);
            const next = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
            if (isCreate) {
              set!({ waitTimeoutMs: next });
            } else {
              mark("adapterConfig", "waitTimeoutMs", next);
            }
          }}
          immediate
          className={inputClass}
          placeholder="120000"
        />
      </Field>

      <Field label={l10n("local.disable_device_auth_9ce19772")}>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={
              isCreate
                ? values!.disableDeviceAuth ?? false
                : eff("adapterConfig", "disableDeviceAuth", Boolean(config.disableDeviceAuth ?? false))
            }
            onChange={(e) =>
              isCreate
                ? set!({ disableDeviceAuth: e.target.checked })
                : mark("adapterConfig", "disableDeviceAuth", e.target.checked || undefined)
            }
          />
          {l10n("local.skip_device_key_authentication_4ca95215")}</label>
      </Field>

      <Field label={l10n("local.auto_pair_on_first_connect_7d491d76")}>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={
              isCreate
                ? values!.autoPairOnFirstConnect ?? true
                : eff("adapterConfig", "autoPairOnFirstConnect", config.autoPairOnFirstConnect !== false)
            }
            onChange={(e) =>
              isCreate
                ? set!({ autoPairOnFirstConnect: e.target.checked })
                : mark("adapterConfig", "autoPairOnFirstConnect", e.target.checked)
            }
          />
          {l10n("local.automatically_approve_device_pairing_55fd685a")}</label>
      </Field>

      <Field label={l10n("local.device_auth_6fc25a19")}>
        <div className="text-xs text-muted-foreground leading-relaxed">
          {l10n("local.when_enabled_paperclip_persists_a_device_key_cf3f004a")}</div>
      </Field>
    </>
  ));
}
