import { l10n } from "../../i18n";
import type { UIAdapterModule } from "../types";
import { parseHttpStdoutLine } from "./parse-stdout";
import { HttpConfigFields } from "./config-fields";
import { buildHttpConfig } from "./build-config";

export const httpUIAdapter: UIAdapterModule = {
  type: "http",
  label: l10n("local.http_webhook_676845ee"),
  parseStdoutLine: parseHttpStdoutLine,
  ConfigFields: HttpConfigFields,
  buildAdapterConfig: buildHttpConfig,
};
