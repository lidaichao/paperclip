import { l10n } from "../../../i18n";

export const GITHUB_PRIVATE_KEY_FILE_MAX_BYTES = 64 * 1024;

export function createGitHubPrivateKeyReadGuard() {
  let revision = 0;
  return {
    start() {
      revision += 1;
      return revision;
    },
    invalidate() {
      revision += 1;
    },
    isCurrent(candidate: number) {
      return candidate === revision;
    },
  };
}

export async function readGitHubPrivateKeyFile(
  file: Pick<File, "size" | "text">,
): Promise<string> {
  if (file.size === 0) {
    throw new Error(
      l10n("local.github_private_key_file_empty_10300046"),
    );
  }
  if (file.size > GITHUB_PRIVATE_KEY_FILE_MAX_BYTES) {
    throw new Error(
      l10n("local.github_private_key_file_too_large_10300047"),
    );
  }

  let value: string;
  try {
    value = await file.text();
  } catch {
    throw new Error(
      l10n("local.alice_could_not_read_pem_file_0c950005"),
    );
  }
  if (!value.trim()) {
    throw new Error(
      l10n("local.github_private_key_file_empty_10300046"),
    );
  }
  return value;
}
