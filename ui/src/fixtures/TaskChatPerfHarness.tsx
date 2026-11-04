import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import type { TaskChatItem } from "@/components/task-chat/task-chat-model";
import { l10n } from "@/i18n";
import "@/index.css";

const paragraphs = Array.from({ length: 8 }, (_, i) =>
  `### ${l10n("local.investigation_10300814", { number: i + 1 })}\n\n${l10n("local.agent_inspected_implementation_10300815")}\n\n- ${l10n("local.preserve_existing_behavior_10300816")}\n- ${l10n("local.verify_next_update_10300817")}\n\n\`\`\`ts\nconst result = await inspect({ attempt: ${i} });\n\`\`\``,
).join("\n\n");
const history: TaskChatItem[] = Array.from({ length: 200 }, (_, index) => ({
  id: `history-${index}`,
  kind: "message",
  author: "agent",
  authorName: l10n("local.engineer_10300818"),
  text: `${l10n("local.historical_response_10300819", { number: index })}\n\n${paragraphs}`,
  timestamp: "12:00 PM",
  attachedTurn: {
    id: `turn-${index}`,
    kind: "turn",
    settled: true,
    summary: { toolCount: 20, added: 0, removed: 0, durationLabel: "38s" },
    items: Array.from({ length: 20 }, (_, tool) => ({
      id: `tool-${index}-${tool}`, kind: "tool", name: "Read", status: "completed", target: `src/file-${tool}.ts`, detail: l10n("local.file_inspected_successfully_10300820"),
    })),
  },
}));
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Harness() {
  const [streaming, setStreaming] = useState(false);
  const [reproject, setReproject] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 100);
    return () => window.clearInterval(timer);
  }, [streaming]);
  return (
    <div className="flex h-dvh flex-col px-6">
      <header className="flex shrink-0 items-center gap-4 py-3">
        <h1>{l10n("local.task_chat_perf_title_10300813", { responses: 200, tools: "4,000" })}</h1>
        <button onClick={() => setStreaming((value) => !value)}>{streaming ? l10n("local.stop_streaming_10300821") : l10n("local.start_streaming_10300822")}</button>
        <label><input type="checkbox" checked={reproject} onChange={(event) => setReproject(event.target.checked)} /> {l10n("local.recreate_history_objects_10300823")}</label>
        <output data-testid="stream-tick">{tick}</output>
      </header>
      <TaskChatThreadView items={reproject ? history.map((item) => ({ ...item })) : history} contentKey={tick} tail={<p>{l10n("local.live_response_10300824", { number: tick })}</p>} />
      <textarea className="shrink-0 border p-3" aria-label={l10n("local.reply_10300825")} placeholder={l10n("local.reply_to_task_10300826")} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}><MemoryRouter><ThemeProvider><Harness /></ThemeProvider></MemoryRouter></QueryClientProvider>,
);
