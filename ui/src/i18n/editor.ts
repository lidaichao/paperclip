import type { Translation } from "@mdxeditor/editor";
import { i18n } from "./index";
import rows from "./editor-messages.json";

const messages = new Map(rows.map((row) => [row.key, row]));

/** Supported editor extension point; document content never passes through it. */
export const translateEditor: Translation = (key, defaultValue, interpolations = {}) => {
  const row = messages.get(key);
  const template = i18n.language === "zh-CN" && row?.english === defaultValue
    ? row.translation
    : defaultValue;
  return template.replace(/\{\{([^{}]+)\}\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(interpolations, name)
      ? String(interpolations[name])
      : token,
  );
};
