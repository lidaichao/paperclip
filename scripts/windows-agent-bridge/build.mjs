import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(bridgeDir, "..", "..");
const workspace = {
  "adapter-utils": path.join(root, "packages", "adapter-utils", "src"),
  shared: path.join(root, "packages", "shared", "src"),
};
const workspacePackages = {
  name: "bridge-workspace-packages",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^@paperclipai\/(adapter-utils|shared)(\/.*)?$/ }, (args) => {
      const [, packageName, , subpath] = args.path.match(/^@paperclipai\/(adapter-utils|shared)(\/(.*))?$/);
      return { path: path.join(workspace[packageName], subpath ? `${subpath}.ts` : "index.ts") };
    });
  },
};
for (const [entry, output] of [["main.ts", "bridge.bundle.mjs"], ["launcher.ts", "launcher.bundle.mjs"]]) {
  await build({
    entryPoints: [path.join(bridgeDir, entry)],
    outfile: path.join(bridgeDir, "dist", output),
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [workspacePackages],
  });
}
