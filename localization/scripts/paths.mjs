import path from "node:path";

export const kitRoot = path.resolve(import.meta.dirname, "..");
export const projectRoot = path.resolve(kitRoot, "..");
export const uiRoot = path.join(projectRoot, "ui");
export const currentSourceBackupRoot = path.join(
  kitRoot,
  "integration",
  "source-before-current",
);
