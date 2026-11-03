export interface AdapterModelEntry {
  id: string;
  label?: string;
}

/**
 * Per-adapter model list supplied by the operator via env, so the agent model
 * picker can offer models the server cannot CLI-discover (e.g. gateway models).
 * JSON object: adapterType -> [{ id, label? }]. Returns null when unset; throws
 * loudly on malformed input.
 */
export function parseAdapterModelsEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, AdapterModelEntry[]> | null {
  const raw = env.PAPERCLIP_ADAPTER_MODELS?.trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`PAPERCLIP_ADAPTER_MODELS 必须是有效的 JSON：${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PAPERCLIP_ADAPTER_MODELS 必须是将 adapterType 映射到 {id,label} 数组的 JSON 对象");
  }
  const out: Record<string, AdapterModelEntry[]> = {};
  for (const [type, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      throw new Error(`PAPERCLIP_ADAPTER_MODELS[${type}] 必须是数组`);
    }
    out[type] = list.map((m) => {
      const o = m as Record<string, unknown>;
      if (typeof o.id !== "string" || !o.id) {
        throw new Error(`PAPERCLIP_ADAPTER_MODELS[${type}] 的条目必须提供非空字符串 id`);
      }
      return { id: o.id, label: typeof o.label === "string" ? o.label : o.id };
    });
  }
  return out;
}
