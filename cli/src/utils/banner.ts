import pc from "picocolors";

const ALICE_ART = [
  " █████╗ ██╗     ██╗ ██████╗███████╗",
  "██╔══██╗██║     ██║██╔════╝██╔════╝",
  "███████║██║     ██║██║     █████╗  ",
  "██╔══██║██║     ██║██║     ██╔══╝  ",
  "██║  ██║███████╗██║╚██████╗███████╗",
  "╚═╝  ╚═╝╚══════╝╚═╝ ╚═════╝╚══════╝",
] as const;

const TAGLINE = "面向人机协作团队的项目管理系统";

export function printPaperclipCliBanner(): void {
  const lines = [
    "",
    ...ALICE_ART.map((line) => pc.cyan(line)),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
