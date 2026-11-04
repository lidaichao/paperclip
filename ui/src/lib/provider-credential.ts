import { secretsApi } from "../api/secrets";
import { l10n } from "../i18n";

export const PROVIDER_ENV_KEYS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  groq: "GROQ_API_KEY",
  opencode: "OPENCODE_API_KEY",
};

/** New organization credentials get a distinct key; never rotate another agent's secret. */
export async function storeOrganizationApiKey(
  companyId: string,
  envKey: string,
  value: string,
) {
  const secret = await secretsApi.create(companyId, {
    name: `${envKey} · agent setup`,
    key: `${envKey}.setup.${crypto.randomUUID()}`,
    value: value.trim(),
    description: l10n("local.adapter_credential_supplied_during_agent_setup_10300707"),
  });
  return {
    binding: {
      type: "secret_ref" as const,
      secretId: secret.id,
      version: "latest" as const,
    },
    remove: () => secretsApi.remove(secret.id),
  };
}

/** Store a validated key during agent creation without rotating other agents’
 * credentials. The caller removes this definition if creation fails. */
export async function storeProviderApiKey(
  companyId: string,
  envKey: string,
  value: string,
) {
  const key = `${envKey}.setup.${crypto.randomUUID()}`;
  const definition = await secretsApi.createUserSecretDefinition(companyId, {
    key,
    name: `${envKey} · agent setup`,
    description: l10n("local.model_provider_credential_for_new_agent_setup_10300708"),
  });
  const remove = () =>
    secretsApi.removeUserSecretDefinition(companyId, definition.id);
  try {
    await secretsApi.createMyUserSecret(companyId, {
      definitionId: definition.id,
      definitionKey: key,
      value: value.trim(),
    });
  } catch (error) {
    await remove();
    throw error;
  }
  return {
    binding: {
      type: "user_secret_ref" as const,
      key,
      version: "latest" as const,
    },
    remove,
  };
}
