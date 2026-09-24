import { l10n, englishPluralSuffix } from "../i18n";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  HeartbeatRunEvent,
  ProviderTraceFieldMapping,
  ProviderTraceFrame,
} from "@paperclipai/shared";
import {
  ArrowRight,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleOff,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileJson2,
  Layers3,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { heartbeatsApi, type ProviderTraceInspection } from "@/api/heartbeats";
import { accessApi } from "@/api/access";
import { parsePaperclipRunnerStdoutLine } from "@/adapters/paperclip-runner";
import { TaskChatProtocolCard } from "@/components/task-chat/TaskChatProtocolCard";
import type { TaskChatProtocolItem } from "@/components/task-chat/task-chat-model";
import { transcriptToTaskChatItems } from "@/components/task-chat/transcript-adapter";
import { TASK_PROTOCOL_EVENT_SURFACE_REGISTRY } from "@/components/task-chat/task-protocol-surfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useCopyAction } from "@/lib/use-copy-action";

type TraceEntry = Record<string, unknown>;
type InspectorView = "overview" | "pipeline" | "trace";

type RawTraceAccess = {
  runId: string;
  allowed: boolean;
  epoch: number;
  phase: "granted" | "denied" | "deleting";
};

type TraceOperation = {
  key: string;
  frames: TraceEntry[];
  interpretations: TraceEntry[];
  events: HeartbeatRunEvent[];
  title: string;
  subtitle: string;
  itemType: string;
  nativeMethods: string[];
  directions: string[];
  dispositions: string[];
  prpTypes: string[];
  visible: boolean;
  timestamp: number;
};

const VIEW_OPTIONS: Array<{
  value: InspectorView;
  label: string;
  icon: typeof Layers3;
}> = [
  { value: "overview", label: l10n("local.overview_d4b1ea57"), icon: Layers3 },
  { value: "pipeline", label: l10n("local.pipeline_37e1c775"), icon: ArrowRight },
  { value: "trace", label: l10n("local.exact_trace_64c8a985"), icon: FileJson2 },
];

const RAW_TRACE_ACCESS_REVALIDATION_MS = 1_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function revealedFrameKey(runId: string, frameId: number): string {
  return `${runId}:${frameId}`;
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function downloadBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}

function decodeExactFrame(rawBase64: string): unknown {
  const decoded = atob(rawBase64);
  try {
    return JSON.parse(decoded);
  } catch {
    return decoded;
  }
}

function statusVariant(status: string | undefined) {
  if (status === "complete") return "secondary" as const;
  if (status === "incomplete" || status === "truncated")
    return "destructive" as const;
  return "outline" as const;
}

function traceBadgeLabel(status: string, expiresAt: string | Date) {
  if (status === "capturing") return l10n("local.raw_trace_enabled_258f625d");
  if (status === "incomplete") return l10n("local.incomplete_75f33cdf");
  if (status === "truncated") return l10n("local.truncated_d9d9fcf3");
  if (status === "deleted") return l10n("local.deleted_b48ff39c");
  if (status === "expired") return l10n("local.expired_424a2551");
  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return l10n("local.expired_424a2551");
  const hours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1_000)));
  return l10n("local.expires_in_valueh_a0f26414", {v0: (hours)});
}

function frameParsed(entry: TraceEntry) {
  return record(entry.parsed);
}

function frameMethod(entry: TraceEntry) {
  const parsed = frameParsed(entry);
  return text(parsed.method) || text(record(parsed.params).method);
}

function frameItem(entry: TraceEntry) {
  const parsed = frameParsed(entry);
  const params = record(parsed.params);
  return record(params.item ?? parsed.item);
}

function frameItemType(entry: TraceEntry) {
  const parsed = frameParsed(entry);
  const params = record(parsed.params);
  return text(frameItem(entry).type) || text(params.itemType) || text(parsed.type);
}

function eventPrp(event: HeartbeatRunEvent) {
  const payload = record(event.payload);
  const prpEvent = record(payload.prpEvent);
  return Object.keys(prpEvent).length > 0 ? prpEvent : payload;
}

function eventSourceId(event: HeartbeatRunEvent) {
  return text(eventPrp(event).sourceEventId);
}

function eventTimestamp(event: HeartbeatRunEvent) {
  const value = new Date(event.createdAt).getTime();
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function frameTimestamp(frame: TraceEntry) {
  const raw = scalar(frame.timestamp);
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function visibilityDecision(event: HeartbeatRunEvent) {
  const registration = TASK_PROTOCOL_EVENT_SURFACE_REGISTRY[event.eventType];
  if (!registration) {
    return {
      visible: false,
      surface: "run_debug",
      container: "Runner Inspector",
      state: "hidden",
      action: "none",
      reasonCode: "presentation_surface_unregistered",
      reason: "No production surface registration exists for this event type.",
    };
  }
  return {
    visible: registration.disposition !== "debug-only",
    surface: registration.surface,
    container:
      registration.disposition === "inline"
        ? "primary run turn"
        : "collapsed activity",
    state: registration.disposition,
    action:
      registration.disposition === "inline"
        ? "render"
        : registration.disposition === "folded"
          ? "fold"
          : "operator only",
    reasonCode: `presentation_${registration.disposition}`,
    reason: registration.rationale,
  };
}

function interpretationEventIds(entry: TraceEntry) {
  return Array.isArray(entry.emittedEventIds)
    ? entry.emittedEventIds.map(String)
    : [];
}

function frameCorrelationTokens(frame: TraceEntry, interpretations: TraceEntry[]) {
  const parsed = frameParsed(frame);
  const params = record(parsed.params);
  const item = frameItem(frame);
  const tokens = interpretations.flatMap(interpretationEventIds).map((id) => `event:${id}`);
  const rpcId = scalar(parsed.id);
  if (rpcId) {
    const direction = text(frame.direction);
    const isRequest = Boolean(frameMethod(frame));
    const requestOrigin = isRequest
      ? direction === "client_to_provider" ? "client" : "provider"
      : direction === "client_to_provider" ? "provider" : "client";
    tokens.push(`rpc:${requestOrigin}:${rpcId}`);
  }
  for (const id of [item.id, params.itemId, params.callId, parsed.itemId]) {
    const value = scalar(id);
    if (value) tokens.push(`item:${value}`);
  }
  return unique(tokens);
}

function buildOperations(
  frames: TraceEntry[],
  interpretations: TraceEntry[],
  events: HeartbeatRunEvent[],
): TraceOperation[] {
  const sortedFrames = [...frames].sort(
    (left, right) => Number(left.frameId) - Number(right.frameId),
  );
  const frameById = new Map(sortedFrames.map((frame) => [Number(frame.frameId), frame]));
  const parent = new Map([...frameById.keys()].map((id) => [id, id]));
  const find = (id: number): number => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const tokenOwner = new Map<string, number>();
  for (const frame of sortedFrames) {
    const frameId = Number(frame.frameId);
    const stages = interpretations.filter((entry) => Number(entry.frameId) === frameId);
    for (const token of frameCorrelationTokens(frame, stages)) {
      const owner = tokenOwner.get(token);
      if (owner === undefined) tokenOwner.set(token, frameId);
      else union(owner, frameId);
    }
  }

  const groupedFrames = new Map<number, TraceEntry[]>();
  for (const frame of sortedFrames) {
    const root = find(Number(frame.frameId));
    groupedFrames.set(root, [...(groupedFrames.get(root) ?? []), frame]);
  }
  const claimedEvents = new Set<number>();
  const operations: TraceOperation[] = [];
  for (const groupFrames of groupedFrames.values()) {
    const frameIds = new Set(groupFrames.map((frame) => Number(frame.frameId)));
    const stages = interpretations.filter((entry) => frameIds.has(Number(entry.frameId)));
    const emittedIds = new Set(stages.flatMap(interpretationEventIds));
    const groupEvents = events.filter((event) => emittedIds.has(eventSourceId(event)));
    groupEvents.forEach((event) => claimedEvents.add(event.id));
    const methods = unique(groupFrames.map(frameMethod));
    const itemTypes = unique(groupFrames.map(frameItemType));
    const title = itemTypes.at(-1) || methods.at(-1) || text(groupFrames[0]?.direction) || l10n("local.provider_frame_abe6ad0d");
    const firstFrame = groupFrames[0];
    const lastFrame = groupFrames.at(-1);
    const range = firstFrame === lastFrame
      ? `frame ${firstFrame?.frameId}`
      : `frames ${firstFrame?.frameId}–${lastFrame?.frameId}`;
    operations.push({
      key: `frames:${firstFrame?.frameId}`,
      frames: groupFrames,
      interpretations: stages,
      events: groupEvents,
      title,
      subtitle: `${range} · ${groupEvents.length} PRP event${groupEvents.length === 1 ? "" : "s"}`,
      itemType: itemTypes.at(-1) ?? "",
      nativeMethods: methods,
      directions: unique(groupFrames.map((frame) => text(frame.direction))),
      dispositions: unique(stages.map((entry) => text(entry.disposition))),
      prpTypes: unique(groupEvents.map((event) => event.eventType)),
      visible: groupEvents.some((event) => visibilityDecision(event).visible),
      timestamp: Math.min(...groupFrames.map(frameTimestamp)),
    });
  }
  for (const event of events) {
    if (claimedEvents.has(event.id)) continue;
    const decision = visibilityDecision(event);
    operations.push({
      key: `event:${event.id}`,
      frames: [],
      interpretations: [],
      events: [event],
      title: event.eventType,
      subtitle: `PRP ${eventSourceId(event) || `event ${event.seq}`} · no raw correlation`,
      itemType: "",
      nativeMethods: [],
      directions: [],
      dispositions: [],
      prpTypes: [event.eventType],
      visible: decision.visible,
      timestamp: eventTimestamp(event),
    });
  }
  return operations.sort((left, right) => left.timestamp - right.timestamp);
}

async function loadAllRunEvents(runId: string) {
  const events: HeartbeatRunEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await heartbeatsApi.events(runId, afterSeq, 1_000);
    events.push(...page);
    if (page.length < 1_000) return events;
    const nextSeq = page.at(-1)?.seq ?? afterSeq;
    if (nextSeq <= afterSeq) return events;
    afterSeq = nextSeq;
  }
}

function jsonMatches(value: unknown, query: string): boolean {
  if (!query) return true;
  try {
    return JSON.stringify(value).toLowerCase().includes(query.toLowerCase());
  } catch {
    return String(value).toLowerCase().includes(query.toLowerCase());
  }
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="text-primary">{l10n("local._quot_49755823")}{value}{l10n("local._quot_49755823")}</span>;
  if (typeof value === "number") return <span className="text-muted-foreground">{value}</span>;
  if (typeof value === "boolean") return <span className="text-secondary-foreground">{String(value)}</span>;
  if (value === null) return <span className="text-muted-foreground">{l10n("local.null_74234e98")}</span>;
  return <span>{String(value)}</span>;
}

function JsonNode({
  label,
  value,
  path,
  depth,
  query,
}: {
  label?: string;
  value: unknown;
  path: string;
  depth: number;
  query: string;
}) {
  const expandable = value !== null && typeof value === "object";
  const entries = Array.isArray(value)
    ? value.map((child, index) => [String(index), child] as const)
    : Object.entries(record(value));
  const large = entries.length > 8;
  const [expanded, setExpanded] = useState(depth < 1 && !large);
  const forcedOpen = Boolean(query) && jsonMatches(value, query);
  const isOpen = expandable && (expanded || forcedOpen);
  const visibleEntries = query
    ? entries.filter(([key, child]) =>
        key.toLowerCase().includes(query.toLowerCase()) || jsonMatches(child, query),
      )
    : entries;
  const pathCopy = useCopyAction();
  const valueCopy = useCopyAction();
  const copyValue = () => {
    const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    void valueCopy.copy(serialized ?? String(value));
  };
  return (
    <div className={cn(depth > 0 && "border-l border-border/60 pl-3")}>
      <div className="group flex min-h-6 items-start gap-1 font-mono text-xs leading-6">
        {expandable ? (
          <button
            type="button"
            className="mt-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setExpanded(!isOpen)}
            aria-label={isOpen ? l10n("local.collapse_json_value_e5d6149e") : l10n("local.expand_json_value_dee3e421")}
          >
            {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-4" />
        )}
        {label !== undefined ? <span className="text-primary">{label}:</span> : null}
        {expandable ? (
          <span className="text-muted-foreground">
            {Array.isArray(value) ? `[${entries.length}]` : l10n("local.value_62c30bb6", {v0: (entries.length)})}
          </span>
        ) : (
          <JsonPrimitive value={value} />
        )}
        <span className="ml-auto hidden items-center gap-0.5 group-hover:flex">
          <button
            type="button"
            title={pathCopy.copied ? l10n("local.json_path_copied_67178a67") : pathCopy.failed ? l10n("local.copy_failed_5b50e7a6") : l10n("local.copy_json_path_5fe87335")}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void pathCopy.copy(path)}
          >
            {pathCopy.copied ? <Check className="h-3 w-3" /> : <Braces className="h-3 w-3" />}
          </button>
          <button
            type="button"
            title={valueCopy.copied ? l10n("local.value_copied_7a764ef3") : valueCopy.failed ? l10n("local.copy_failed_5b50e7a6") : l10n("local.copy_value_c019c0f8")}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={copyValue}
          >
            {valueCopy.copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </span>
      </div>
      {isOpen ? (
        <div>
          {visibleEntries.map(([key, child]) => (
            <JsonNode
              key={`${path}.${key}`}
              label={key}
              value={child}
              path={Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`}
              depth={depth + 1}
              query={query}
            />
          ))}
          {query && visibleEntries.length === 0 ? (
            <p className="pl-5 text-xs text-muted-foreground">{l10n("local.no_fields_match_663bc184")}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function JsonExplorer({ value, label = "Search this JSON" }: { value: unknown; label?: string }) {
  const [query, setQuery] = useState("");
  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/20">
      <div className="relative border-b border-border bg-background/60">
        <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={label}
          className="h-8 border-0 bg-transparent pl-8 text-xs shadow-none focus-visible:ring-0"
        />
      </div>
      <div className="max-h-80 overflow-auto p-3">
        <JsonNode value={value} path="$" depth={0} query={query.trim()} />
      </div>
    </div>
  );
}

function fieldMappings(entry: TraceEntry): ProviderTraceFieldMapping[] {
  const explicit = Array.isArray(entry.fieldMappings)
    ? entry.fieldMappings
        .map(record)
        .filter((mapping) => text(mapping.action))
        .map((mapping) => ({
          inputPath: text(mapping.inputPath) || undefined,
          outputPath: text(mapping.outputPath) || undefined,
          action: text(mapping.action) as ProviderTraceFieldMapping["action"],
          reason: text(mapping.reason) || undefined,
        }))
    : [];
  const knownDrops = new Set(explicit.filter((mapping) => mapping.action === "dropped").map((mapping) => mapping.inputPath));
  const legacy = Array.isArray(entry.droppedFields)
    ? entry.droppedFields
        .map(String)
        .filter((path) => !knownDrops.has(path))
        .map((path) => ({
          inputPath: path,
          action: "dropped" as const,
          reason: text(entry.reason) || "Field was not carried into the next stage",
        }))
    : [];
  return [...explicit, ...legacy];
}

function mappingTone(action: ProviderTraceFieldMapping["action"]) {
  if (action === "dropped" || action === "redacted") return "border-destructive/30 bg-destructive/10 text-destructive";
  if (action === "derived") return "border-secondary bg-secondary text-secondary-foreground";
  return "border-primary/30 bg-primary/10 text-primary";
}

function InterpretationStage({ entry, last }: { entry: TraceEntry; last: boolean }) {
  const mappings = fieldMappings(entry);
  return (
    <div className="relative grid grid-cols-(--gtc-runner-inspector-stage) gap-3">
      <div className="relative flex justify-center">
        {!last ? <span className="absolute bottom-(--sz-neg-1_25rem) top-4 w-px bg-border" /> : null}
        <span className={cn(
          "relative mt-1 h-3 w-3 rounded-full border-2 bg-background",
          entry.disposition === "rejected" ? "border-destructive" : entry.disposition === "ignored" ? "border-muted-foreground" : "border-primary",
        )} />
      </div>
      <div className="mb-4 overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
          <code className="text-xs font-semibold">{text(entry.stage)}</code>
          <Badge variant="outline" className="capitalize">{text(entry.disposition)}</Badge>
          <code className="ml-auto text-(length:--text-nano) text-muted-foreground">{text(entry.ruleId)}</code>
        </div>
        <p className="px-3 py-2 text-xs text-muted-foreground">{text(entry.reason)}</p>
        {mappings.length > 0 ? (
          <div className="overflow-x-auto border-t border-border/70">
            <table className="w-full min-w-(--sz-36rem) text-left text-xs">
              <thead className="bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">{l10n("local.action_64cff131")}</th>
                  <th className="px-3 py-1.5 font-medium">{l10n("local.provider_path_614206ab")}</th>
                  <th className="px-3 py-1.5 font-medium">{l10n("local.output_path_b5ec4c3d")}</th>
                  <th className="px-3 py-1.5 font-medium">{l10n("local.reason_f81ab834")}</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((mapping, index) => (
                  <tr key={`${mapping.inputPath}:${mapping.outputPath}:${index}`} className="border-t border-border/50 align-top">
                    <td className="px-3 py-2">
                      <span className={cn("rounded border px-1.5 py-0.5 text-(length:--text-nano)", mappingTone(mapping.action))}>{mapping.action}</span>
                    </td>
                    <td className="px-3 py-2 font-mono">{mapping.inputPath ?? "—"}</td>
                    <td className="px-3 py-2 font-mono">{mapping.outputPath ?? "—"}</td>
                    <td className="max-w-xs px-3 py-2 text-muted-foreground">{mapping.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="border-t border-border/70 px-3 py-2 text-(length:--text-nano) text-muted-foreground">{l10n("local.no_field_level_mapping_was_recorded_at_this_s_6121eca5")}</p>
        )}
      </div>
    </div>
  );
}

function typedPrpFields(event: HeartbeatRunEvent) {
  const prp = eventPrp(event);
  const payload = record(prp.payload);
  const item = record(payload.item);
  return [
    ["Event type", event.eventType],
    ["Source event", text(prp.sourceEventId)],
    ["Sequence", scalar(prp.sourceSequence) || String(event.seq)],
    ["Item type", text(item.type) || text(payload.kind)],
    ["Status", text(payload.status) || text(item.status)],
    ["Query", text(payload.query) || text(item.query)],
  ].filter(([, value]) => Boolean(value));
}

function ProductionSurfacePreview({ event, runId }: { event: HeartbeatRunEvent; runId: string }) {
  const prp = eventPrp(event);
  const ts = new Date(event.createdAt).toISOString();
  const entries = parsePaperclipRunnerStdoutLine(
    JSON.stringify({ type: "paperclip.prp.event", event: prp }),
    ts,
  );
  const item = transcriptToTaskChatItems(entries, {
    runId,
    agentName: "Runner",
    running: false,
  }).find((candidate): candidate is TaskChatProtocolItem => candidate.kind === "protocol");
  if (item) return <TaskChatProtocolCard item={item} />;
  const decision = visibilityDecision(event);
  const VisibleIcon = decision.visible ? Eye : EyeOff;
  return (
    <div className="rounded-md border border-border bg-card/60 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <VisibleIcon className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{event.eventType}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {l10n("local.production_surface_e6fdb3c0")}{" "}{decision.surface} · {decision.action} {l10n("local.in_58296753")}{" "}{decision.container}
          </p>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

export function RunnerInspector({
  runId,
  run,
  open,
  onOpenChange,
  onRerunWithTrace,
}: {
  runId: string;
  run?: { resultJson: Record<string, unknown> | null; status: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRerunWithTrace?: () => void;
}) {
  const [inspection, setInspection] = useState<ProviderTraceInspection | null>(null);
  const [events, setEvents] = useState<HeartbeatRunEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<InspectorView>("pipeline");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("all");
  const [nativeMethod, setNativeMethod] = useState("all");
  const [disposition, setDisposition] = useState("all");
  const [prpType, setPrpType] = useState("all");
  const [visibility, setVisibility] = useState("all");
  const [revealed, setRevealed] = useState<Record<string, ProviderTraceFrame>>({});
  const [rawTraceAccess, setRawTraceAccess] = useState<RawTraceAccess | null>(null);
  const rawTraceAccessRef = useRef<RawTraceAccess | null>(null);
  const rawTraceAccessEpochRef = useRef(0);
  const canInspectRaw =
    open && rawTraceAccess?.runId === runId ? rawTraceAccess.allowed : null;

  useLayoutEffect(() => {
    rawTraceAccessEpochRef.current += 1;
    rawTraceAccessRef.current = null;
    setRawTraceAccess(null);
    setInspection(null);
    setEvents([]);
    setLoading(open);
    setError(null);
    setSelectedKey(null);
    setSelectedFrameId(null);
    setRevealed({});
  }, [open, runId]);

  const denyRawTraceAccess = useCallback(() => {
    const currentAccess = rawTraceAccessRef.current;
    if (
      currentAccess?.runId === runId &&
      currentAccess.phase === "denied"
    ) {
      return;
    }
    rawTraceAccessEpochRef.current += 1;
    const deniedAccess: RawTraceAccess = {
      runId,
      allowed: false,
      epoch: rawTraceAccessEpochRef.current,
      phase: "denied",
    };
    rawTraceAccessRef.current = deniedAccess;
    setRawTraceAccess(deniedAccess);
    setInspection({ trace: null, entries: [] });
    setLoading(false);
    setError(null);
    setSelectedKey(null);
    setSelectedFrameId(null);
    setRevealed({});
  }, [runId]);

  useEffect(() => {
    if (!open) return;
    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get("traceView");
    if (requestedView === "overview" || requestedView === "pipeline" || requestedView === "trace") setView(requestedView);
    const requestedOperation = params.get("traceOperation");
    if (requestedOperation) setSelectedKey(requestedOperation);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const loadEpoch = rawTraceAccessEpochRef.current;
    setLoading(true);
    setError(null);
    Promise.all([accessApi.getCurrentBoardAccess(), loadAllRunEvents(runId)])
      .then(async ([boardAccess, nextEvents]) => {
        if (!active || rawTraceAccessEpochRef.current !== loadEpoch) return;
        const canRaw = boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin;
        const access: RawTraceAccess = {
          runId,
          allowed: canRaw,
          epoch: rawTraceAccessEpochRef.current,
          phase: canRaw ? "granted" : "denied",
        };
        rawTraceAccessRef.current = access;
        setRawTraceAccess(access);
        if (!canRaw) setRevealed({});
        const trace = canRaw
          ? await heartbeatsApi.providerTrace(runId)
          : ({ trace: null, entries: [] } satisfies ProviderTraceInspection);
        const currentAccess = rawTraceAccessRef.current;
        if (
          !active ||
          currentAccess?.runId !== runId ||
          currentAccess.epoch !== loadEpoch ||
          currentAccess.allowed !== canRaw
        ) {
          return;
        }
        setInspection(trace);
        setEvents(nextEvents);
      })
      .catch((cause) => {
        if (!active || rawTraceAccessEpochRef.current !== loadEpoch) return;
        setError(cause instanceof Error ? cause.message : "Runner inspection failed");
      })
      .finally(() => {
        if (active && rawTraceAccessEpochRef.current === loadEpoch) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [open, runId]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const revalidate = async () => {
      try {
        const boardAccess = await accessApi.getCurrentBoardAccess();
        if (!active) return;
        const canRaw =
          boardAccess.source === "local_implicit" ||
          boardAccess.isInstanceAdmin;
        if (!canRaw) denyRawTraceAccess();
      } catch {
        if (active) denyRawTraceAccess();
      }
    };
    const onFocus = () => void revalidate();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void revalidate();
    };
    const interval = window.setInterval(
      () => void revalidate(),
      RAW_TRACE_ACCESS_REVALIDATION_MS,
    );
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [denyRawTraceAccess, open]);

  const entries = inspection?.entries ?? [];
  const frames = useMemo(() => entries.filter((entry) => entry.kind === "frame"), [entries]);
  const interpretations = useMemo(() => entries.filter((entry) => entry.kind === "interpretation"), [entries]);
  const capturedProviders = unique(frames.map((frame) => text(frame.provider)));
  const operations = useMemo(
    () => buildOperations(frames, interpretations, events),
    [events, frames, interpretations],
  );
  const filteredOperations = useMemo(
    () => operations.filter((operation) => {
      if (query.trim() && !jsonMatches(operation, query.trim())) return false;
      if (direction !== "all" && !operation.directions.includes(direction)) return false;
      if (nativeMethod !== "all" && !operation.nativeMethods.includes(nativeMethod)) return false;
      if (disposition !== "all" && !operation.dispositions.includes(disposition)) return false;
      if (prpType !== "all" && !operation.prpTypes.includes(prpType)) return false;
      if (visibility === "visible" && !operation.visible) return false;
      if (visibility === "hidden" && operation.visible) return false;
      return true;
    }),
    [direction, disposition, nativeMethod, operations, prpType, query, visibility],
  );

  useEffect(() => {
    if (!filteredOperations.length) return;
    if (!selectedKey || !filteredOperations.some((operation) => operation.key === selectedKey)) {
      const preferred =
        filteredOperations.find(
          (operation) => operation.itemType && operation.events.length > 0,
        ) ??
        filteredOperations.find(
          (operation) => operation.frames.length > 0 && operation.events.length > 0,
        ) ??
        filteredOperations[0]!;
      setSelectedKey(preferred.key);
    }
  }, [filteredOperations, selectedKey]);

  const selectedOperation = filteredOperations.find((operation) => operation.key === selectedKey) ?? filteredOperations[0] ?? null;
  useEffect(() => {
    if (!selectedOperation) return;
    if (!selectedOperation.frames.some((frame) => Number(frame.frameId) === selectedFrameId)) {
      const preferred = [...selectedOperation.frames].reverse().find((frame) => frameMethod(frame).includes("completed")) ?? selectedOperation.frames.at(-1);
      setSelectedFrameId(preferred ? Number(preferred.frameId) : null);
    }
  }, [selectedFrameId, selectedOperation]);

  useEffect(() => {
    if (!open || !selectedOperation) return;
    const params = new URLSearchParams(window.location.search);
    params.set("inspectRun", runId);
    params.set("traceView", view);
    params.set("traceOperation", selectedOperation.key);
    const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", next);
  }, [open, runId, selectedOperation, view]);

  const selectedFrame = selectedOperation?.frames.find((frame) => Number(frame.frameId) === selectedFrameId) ?? selectedOperation?.frames.at(-1) ?? null;
  const revealedFrame =
    canInspectRaw === true && selectedFrame
      ? (revealed[
          revealedFrameKey(runId, Number(selectedFrame.frameId))
        ] ?? null)
      : null;
  const selectedInterpretations = selectedFrame
    ? selectedOperation?.interpretations.filter((entry) => Number(entry.frameId) === Number(selectedFrame.frameId)) ?? []
    : selectedOperation?.interpretations ?? [];
  const selectedEvents = selectedOperation?.events ?? [];
  const runResultJson = record(run?.resultJson);
  const presentationDecision = record(runResultJson.presentationDecision);
  const verificationCaveats = Array.isArray(runResultJson.verificationCaveats)
    ? runResultJson.verificationCaveats
    : [];
  const ignoredAttentionRequests = Array.isArray(runResultJson.ignoredAttentionRequests)
    ? runResultJson.ignoredAttentionRequests
    : [];
  const visibleEventCount = events.filter((event) => visibilityDecision(event).visible).length;
  const ignoredCount = interpretations.filter((entry) => entry.disposition === "ignored").length;
  const dispositionCounts = interpretations.reduce<Record<string, number>>((counts, entry) => {
    const key = text(entry.disposition) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  const selectOperation = (operation: TraceOperation) => {
    setSelectedKey(operation.key);
    setView("pipeline");
  };

  const reveal = async (frameId: number) => {
    if (canInspectRaw !== true) return;
    const requestedAccess = rawTraceAccessRef.current;
    if (requestedAccess?.runId !== runId || requestedAccess.allowed !== true) {
      return;
    }
    if (!window.confirm(l10n("local.this_exact_provider_frame_may_contain_prompts_eeb16152"))) return;
    const requestedRunId = runId;
    const frame = await heartbeatsApi.revealProviderTraceFrame(
      requestedRunId,
      frameId,
    );
    const currentAccess = rawTraceAccessRef.current;
    if (
      currentAccess?.runId !== requestedRunId ||
      currentAccess.allowed !== true ||
      currentAccess.epoch !== requestedAccess.epoch
    ) {
      return;
    }
    setRevealed((current) => ({
      ...current,
      [revealedFrameKey(requestedRunId, frameId)]: frame,
    }));
  };

  const downloadTrace = async () => {
    if (canInspectRaw !== true) return;
    const requestedAccess = rawTraceAccessRef.current;
    if (requestedAccess?.runId !== runId || requestedAccess.allowed !== true) {
      return;
    }
    if (!window.confirm(l10n("local.download_the_exact_raw_trace_it_may_contain_s_d4644f6d"))) return;
    const blob = await heartbeatsApi.downloadProviderTrace(runId);
    const currentAccess = rawTraceAccessRef.current;
    if (
      currentAccess?.runId !== runId ||
      currentAccess.allowed !== true ||
      currentAccess.epoch !== requestedAccess.epoch
    ) {
      return;
    }
    downloadBlob(blob, `provider-trace-${runId}.ndjson`);
  };

  const deleteTrace = async () => {
    if (canInspectRaw !== true) return;
    const currentAccess = rawTraceAccessRef.current;
    if (currentAccess?.runId !== runId || currentAccess.allowed !== true) {
      return;
    }
    if (!window.confirm(l10n("local.delete_this_raw_trace_immediately_this_cannot_40b7d456"))) return;
    rawTraceAccessEpochRef.current += 1;
    const deletionAccess: RawTraceAccess = {
      ...currentAccess,
      allowed: false,
      epoch: rawTraceAccessEpochRef.current,
      phase: "deleting",
    };
    rawTraceAccessRef.current = deletionAccess;
    setRawTraceAccess(deletionAccess);
    setRevealed({});
    try {
      await heartbeatsApi.deleteProviderTrace(runId);
    } catch (cause) {
      if (rawTraceAccessRef.current?.epoch === deletionAccess.epoch) {
        setError(
          cause instanceof Error ? cause.message : "Raw trace deletion failed",
        );
      }
      return;
    }
    if (rawTraceAccessRef.current?.epoch !== deletionAccess.epoch) return;
    let boardAccess;
    try {
      boardAccess = await accessApi.getCurrentBoardAccess();
    } catch {
      if (rawTraceAccessRef.current?.epoch === deletionAccess.epoch) {
        denyRawTraceAccess();
      }
      return;
    }
    if (rawTraceAccessRef.current?.epoch !== deletionAccess.epoch) return;
    const canRaw =
      boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin;
    if (!canRaw) {
      denyRawTraceAccess();
      return;
    }
    rawTraceAccessEpochRef.current += 1;
    const restoredAccess: RawTraceAccess = {
      runId,
      allowed: true,
      epoch: rawTraceAccessEpochRef.current,
      phase: "granted",
    };
    rawTraceAccessRef.current = restoredAccess;
    setRawTraceAccess(restoredAccess);
    setInspection({ trace: null, entries: [] });
    setSelectedKey(null);
    setSelectedFrameId(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      rawTraceAccessEpochRef.current += 1;
      rawTraceAccessRef.current = null;
      setRawTraceAccess(null);
      setInspection(null);
      setEvents([]);
      setSelectedKey(null);
      setSelectedFrameId(null);
      setRevealed({});
      const params = new URLSearchParams(window.location.search);
      params.delete("inspectRun");
      params.delete("traceView");
      params.delete("traceOperation");
      const suffix = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${suffix ? `?${suffix}` : ""}${window.location.hash}`,
      );
    }
    onOpenChange(nextOpen);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        className="w-(--sz-calc-43) max-w-none gap-0 p-0 sm:max-w-none"
        aria-describedby="runner-inspector-description"
      >
        <SheetHeader className="border-b border-border pr-12">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle>{l10n("local.runner_inspector_02dc4408")}</SheetTitle>
            {inspection?.trace ? (
              <>
                <Badge variant={statusVariant(inspection.trace.status)}>
                  {traceBadgeLabel(inspection.trace.status, inspection.trace.expiresAt)}
                </Badge>
                <Badge variant="outline" className="font-mono">
                  {capturedProviders.join(", ") || inspection.trace.provider}
                </Badge>
              </>
            ) : null}
          </div>
          <SheetDescription id="runner-inspector-description">
            {l10n("local.correlate_exact_provider_traffic_with_every_i_58234f9c")}</SheetDescription>
          <div className="flex gap-1 pt-1" role="tablist" aria-label={l10n("local.runner_inspector_views_fb8d8dd6")}>
            {VIEW_OPTIONS.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={view === option.value}
                  onClick={() => setView(option.value)}
                  className={cn(
                    "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                    view === option.value ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" /> {option.label}
                </button>
              );
            })}
          </div>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          {error ? <div className="m-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div> : null}
          {!loading && !error && canInspectRaw === false ? (
            <div className="m-4 rounded-md border border-border bg-muted/20 p-4">
              <p className="font-medium">{l10n("local.raw_provider_traces_require_an_instance_admin_f26cd36a")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{l10n("local.canonical_prp_events_and_presentation_decisio_d4253291")}</p>
            </div>
          ) : null}
          {!loading && !error && canInspectRaw === true && !inspection?.trace ? (
            <div className="m-4 flex items-start justify-between gap-4 rounded-md border border-border bg-muted/20 p-4">
              <div>
                <p className="font-medium">{l10n("local.raw_provider_capture_was_off_for_this_run_0c24d886")}</p>
                <p className="mt-1 text-sm text-muted-foreground">{l10n("local.canonical_prp_events_and_persisted_presentati_143b2bcd")}</p>
              </div>
              {onRerunWithTrace && canInspectRaw === true ? (
                <Button size="sm" onClick={onRerunWithTrace}><RefreshCw className="mr-1.5 h-4 w-4" />{l10n("local.re_run_with_provider_trace_296d058e")}</Button>
              ) : null}
            </div>
          ) : null}

          {view === "overview" ? (
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-6 p-5">
                {loading ? <p className="text-sm text-muted-foreground">{l10n("local.loading_run_pipeline_b2b94be9")}</p> : null}
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                  <StatCard label={l10n("local.provider_472590ae")} value={capturedProviders.join(", ") || inspection?.trace?.provider || "PRP only"} detail={inspection?.trace ? l10n("local.captured_through_value_be848a0f", {v0: (inspection.trace.provider)}) : l10n("local.capture_was_off_e061c53d")} />
                  <StatCard label={l10n("local.raw_frames_f1494b22")} value={frames.length} detail={inspection?.trace ? formatBytes(inspection.trace.byteCount) : l10n("local.no_exact_bytes_b144fb58")} />
                  <StatCard label={l10n("local.operations_358cc201")} value={operations.length} detail={l10n("local.correlated_groups_2dff3c1f")} />
                  <StatCard label={l10n("local.prp_events_8fe17fe8")} value={events.length} detail={l10n("local.value_visible_6fe47f66", {v0: (visibleEventCount)})} />
                  <StatCard label={l10n("local.mappings_f64ec16b")} value={interpretations.length} detail={l10n("local.value_ignored_7a47755c", {v0: (ignoredCount)})} />
                  <StatCard label={l10n("local.run_status_3b75c879")} value={run?.status ?? "unknown"} detail={inspection?.trace ? traceBadgeLabel(inspection.trace.status, inspection.trace.expiresAt) : l10n("local.raw_capture_off_0135c0cc")} />
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <section className="rounded-lg border border-border bg-card p-4">
                    <h3 className="text-sm font-semibold">{l10n("local.interpretation_outcomes_4c4e9640")}</h3>
                    <div className="mt-3 space-y-2">
                      {Object.entries(dispositionCounts).length ? Object.entries(dispositionCounts).map(([label, count]) => (
                        <div key={label} className="flex items-center gap-3 text-sm">
                          <Badge variant="outline" className="w-24 justify-center capitalize">{label}</Badge>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(4, (count / Math.max(1, interpretations.length)) * 100)}%` }} /></div>
                          <span className="w-8 text-right font-mono text-xs">{count}</span>
                        </div>
                      )) : <p className="text-sm text-muted-foreground">{l10n("local.no_interpretation_records_were_persisted_8c605a40")}</p>}
                    </div>
                  </section>
                  <section className="rounded-lg border border-border bg-card p-4">
                    <h3 className="text-sm font-semibold">{l10n("local.recent_correlated_operations_09634c8b")}</h3>
                    <div className="mt-2 divide-y divide-border/70">
                      {operations.slice(-6).reverse().map((operation) => (
                        <button key={operation.key} type="button" onClick={() => selectOperation(operation)} className="flex w-full items-center gap-3 py-2 text-left hover:text-primary">
                          <span className={cn("h-2 w-2 rounded-full", operation.events.length ? "bg-primary" : "bg-muted-foreground")} />
                          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{operation.title}</span><span className="block truncate text-xs text-muted-foreground">{operation.subtitle}</span></span>
                          <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
                <section className="rounded-lg border border-border bg-accent/30 p-4">
                  <div className="flex gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-accent-foreground" /><div><h3 className="text-sm font-semibold">{l10n("local.sensitive_debug_data_1244acdc")}</h3><p className="mt-1 text-sm text-muted-foreground">{l10n("local.parsed_frames_are_redacted_on_the_server_exac_c56d5c39")}</p></div></div>
                </section>
              </div>
            </ScrollArea>
          ) : null}

          {view === "pipeline" ? (
            <>
              <div className="grid gap-2 border-b border-border p-3 sm:grid-cols-2 xl:grid-cols-(--gtc-runner-inspector-filters)">
                <div className="relative"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={l10n("local.search_operations_fields_and_events_535b98e7")} /></div>
                <Select value={direction} onValueChange={setDirection}><SelectTrigger><SelectValue placeholder={l10n("local.direction_9c8a9579")} /></SelectTrigger><SelectContent><SelectItem value="all">{l10n("local.all_directions_6cc0f999")}</SelectItem><SelectItem value="client_to_provider">{l10n("local.client_provider_1bd07e0a")}</SelectItem><SelectItem value="provider_to_client">{l10n("local.provider_client_a8950f0b")}</SelectItem><SelectItem value="provider_stderr">{l10n("local.provider_stderr_63b3e297")}</SelectItem></SelectContent></Select>
                <Select value={nativeMethod} onValueChange={setNativeMethod}><SelectTrigger><SelectValue placeholder={l10n("local.native_method_604030e9")} /></SelectTrigger><SelectContent><SelectItem value="all">{l10n("local.all_native_methods_217fc4c5")}</SelectItem>{unique(frames.map(frameMethod)).sort().map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
                <Select value={disposition} onValueChange={setDisposition}><SelectTrigger><SelectValue placeholder={l10n("local.mapping_1ff9a5f8")} /></SelectTrigger><SelectContent><SelectItem value="all">{l10n("local.all_mappings_e1ff97d8")}</SelectItem>{["mapped", "generic", "ignored", "rejected", "operator_only"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
                <Select value={prpType} onValueChange={setPrpType}><SelectTrigger><SelectValue placeholder={l10n("local.prp_type_7b084b20")} /></SelectTrigger><SelectContent><SelectItem value="all">{l10n("local.all_prp_types_3cc13cd2")}</SelectItem>{unique(events.map((event) => event.eventType)).sort().map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
                <Select value={visibility} onValueChange={setVisibility}><SelectTrigger><SelectValue placeholder={l10n("local.visibility_7448611d")} /></SelectTrigger><SelectContent><SelectItem value="all">{l10n("local.visible_hidden_a27b96a9")}</SelectItem><SelectItem value="visible">{l10n("local.visible_8411f5ab")}</SelectItem><SelectItem value="hidden">{l10n("local.hidden_7e6fefff")}</SelectItem></SelectContent></Select>
              </div>
              <div className="grid min-h-0 flex-1 lg:grid-cols-(--gtc-runner-inspector-pipeline)">
                <ScrollArea className="border-r border-border">
                  <div className="p-2">
                    {loading ? <p className="p-3 text-sm text-muted-foreground">{l10n("local.loading_run_pipeline_b2b94be9")}</p> : null}
                    {!loading && filteredOperations.length === 0 ? <p className="p-3 text-sm text-muted-foreground">{l10n("local.no_operations_match_these_filters_bded3d63")}</p> : null}
                    {filteredOperations.map((operation) => (
                      <button key={operation.key} type="button" onClick={() => setSelectedKey(operation.key)} className="mb-1 w-full rounded-lg border border-transparent px-3 py-2.5 text-left hover:bg-muted/50 data-[selected=true]:border-border data-[selected=true]:bg-muted" data-selected={selectedOperation?.key === operation.key}>
                        <span className="flex items-center gap-2"><span className={cn("h-2 w-2 shrink-0 rounded-full", operation.events.length ? operation.visible ? "bg-primary" : "bg-secondary-foreground" : "bg-muted-foreground")} role="img" aria-label={operation.events.length ? operation.visible ? l10n("local.visible_production_event_135026a8") : l10n("local.hidden_production_event_534ae319") : l10n("local.no_production_event_36bc0480")} /><span className="min-w-0 flex-1 truncate text-sm font-medium">{operation.title}</span>{operation.frames.length > 1 ? <Badge variant="outline" className="px-1.5 text-(length:--text-nano)">{operation.frames.length} {l10n("local.frames_594cfd26")}</Badge> : null}</span>
                        <span className="mt-1 block truncate pl-4 text-(length:--text-nano) text-muted-foreground">{operation.subtitle}</span>
                        <span className="mt-1.5 flex flex-wrap gap-1 pl-4">{operation.prpTypes.slice(0, 3).map((type) => <span key={type} className="rounded bg-background px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground">{type}</span>)}</span>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
                <ScrollArea>
                  {selectedOperation ? (
                    <div className="space-y-6 p-5">
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-4 py-3">
                        <strong className="text-sm">{selectedOperation.title}</strong><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /><span className="text-xs text-muted-foreground">{selectedOperation.frames.length} {l10n("local.raw_frame_e97cafc3")}{selectedOperation.frames.length === 1 ? "" : englishPluralSuffix("s")}</span><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /><span className="text-xs text-muted-foreground">{selectedOperation.interpretations.length} {l10n("local.mapping_stage_c85fe0bc")}{selectedOperation.interpretations.length === 1 ? "" : englishPluralSuffix("s")}</span><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /><span className="text-xs text-muted-foreground">{selectedEvents.length} {l10n("local.prp_event_4f8bd49a")}{selectedEvents.length === 1 ? "" : englishPluralSuffix("s")}</span>
                      </div>
                      <section>
                        <div className="mb-2 flex flex-wrap items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">1</span><h3 className="text-sm font-semibold">{l10n("local.provider_frames_52af537b")}</h3><span className="text-xs text-muted-foreground">{l10n("local.server_redacted_by_default_4b8ddeed")}</span></div>
                        {selectedOperation.frames.length > 1 ? <div className="mb-2 flex flex-wrap gap-1">{selectedOperation.frames.map((frame) => <button key={Number(frame.frameId)} type="button" onClick={() => setSelectedFrameId(Number(frame.frameId))} className={cn("rounded-md border px-2 py-1 font-mono text-xs", Number(frame.frameId) === Number(selectedFrame?.frameId) ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted")}>#{String(frame.frameId)} {frameMethod(frame) || text(frame.direction)}</button>)}</div> : null}
                        {selectedFrame ? (
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Badge variant="outline">{l10n("local.frame_9dff50df")}{" "}{String(selectedFrame.frameId)}</Badge><span>{text(selectedFrame.direction).replaceAll("_", " ")}</span><span>{formatBytes(Number(selectedFrame.byteLength) || 0)}</span><code className="truncate">{text(selectedFrame.digest)}</code></div>
                            <JsonExplorer value={selectedFrame.parsed} />
                            {Array.isArray(selectedFrame.withheldPaths) && selectedFrame.withheldPaths.length > 0 ? <div className="flex items-start gap-2 rounded-md border border-border bg-accent/30 px-3 py-2 text-xs text-muted-foreground"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-foreground" /><span>{l10n("local.withheld_paths_a8fad72e")}{" "}{selectedFrame.withheldPaths.join(", ")}</span></div> : null}
                            {canInspectRaw === true ? <Button size="sm" variant="outline" onClick={() => void reveal(Number(selectedFrame.frameId))}><Eye className="mr-1.5 h-4 w-4" />{l10n("local.reveal_exact_frame_2a05878d")}</Button> : null}
                            {revealedFrame ? <div className="rounded-md border border-destructive/30 p-2"><p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-destructive"><ShieldAlert className="h-3.5 w-3.5" />{l10n("local.exact_unredacted_frame_01fa4723")}</p><JsonExplorer value={decodeExactFrame(revealedFrame.rawBase64)} label={l10n("local.search_exact_frame_acf5cb27")} /></div> : null}
                          </div>
                        ) : <p className="text-sm text-muted-foreground">{l10n("local.this_prp_event_has_no_recoverable_raw_frame_60a2b9f5")}</p>}
                      </section>
                      <section>
                        <div className="mb-3 flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">2</span><h3 className="text-sm font-semibold">{l10n("local.interpretation_stages_f709de89")}</h3></div>
                        {selectedInterpretations.length ? selectedInterpretations.map((entry, index) => <InterpretationStage key={`${entry.debugChannel}:${entry.debugSequence}:${index}`} entry={entry} last={index === selectedInterpretations.length - 1} />) : <p className="text-sm text-muted-foreground">{l10n("local.no_interpretation_stage_was_recorded_for_this_6c2197d8")}</p>}
                      </section>
                      <section>
                        <div className="mb-3 flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">3</span><h3 className="text-sm font-semibold">{l10n("local.canonical_prp_events_a9a26523")}</h3></div>
                        {selectedEvents.length ? selectedEvents.map((event) => (
                          <div key={event.id} className="mb-3 overflow-hidden rounded-lg border border-border bg-card">
                            <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2"><code className="text-xs font-semibold">{event.eventType}</code><Badge variant="outline">{l10n("local.seq_4f5260d7")}{" "}{event.seq}</Badge><button type="button" className="ml-auto text-xs text-primary underline-offset-4 hover:underline" onClick={() => { setVisibility(visibilityDecision(event).visible ? "visible" : "hidden"); setSelectedKey(selectedOperation.key); }}>{l10n("local.why_isn_t_this_visible_79081f46")}</button></div>
                            <dl className="grid gap-x-4 gap-y-1 px-3 py-2 text-xs sm:grid-cols-(--gtc-runner-inspector-fields)">{typedPrpFields(event).map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words font-mono">{value}</dd></div>)}</dl>
                            <details className="border-t border-border/70"><summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 text-xs font-medium text-muted-foreground"><ChevronDown className="h-3.5 w-3.5" />{l10n("local.canonical_event_json_66d09e17")}</summary><div className="p-3 pt-0"><JsonExplorer value={eventPrp(event)} /></div></details>
                          </div>
                        )) : <p className="text-sm text-muted-foreground">{l10n("local.this_provider_operation_emitted_no_canonical_d4dc7c0d")}</p>}
                      </section>
                      <section>
                        <div className="mb-3 flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground">4</span><h3 className="text-sm font-semibold">{l10n("local.production_presentation_11135d53")}</h3></div>
                        {selectedEvents.length ? selectedEvents.map((event) => {
                          const decision = visibilityDecision(event);
                          return <div key={event.id} className="mb-4 grid gap-3 xl:grid-cols-(--gtc-runner-inspector-presentation)"><dl className="grid grid-cols-(--gtc-runner-inspector-fields) gap-x-3 gap-y-1 rounded-lg border border-border p-3 text-sm"><dt className="text-muted-foreground">{l10n("local.visible_8411f5ab")}</dt><dd className="flex items-center gap-1.5">{decision.visible ? <Check className="h-3.5 w-3.5 text-primary" /> : <CircleOff className="h-3.5 w-3.5 text-muted-foreground" />}{decision.visible ? l10n("local.yes_8a798890") : l10n("local.no_9390298f")}</dd><dt className="text-muted-foreground">{l10n("local.surface_0905f7f5")}</dt><dd>{decision.surface}</dd><dt className="text-muted-foreground">{l10n("local.container_0c7823e8")}</dt><dd>{decision.container}</dd><dt className="text-muted-foreground">{l10n("local.state_a3b50c47")}</dt><dd>{decision.state}</dd><dt className="text-muted-foreground">{l10n("local.action_64cff131")}</dt><dd>{decision.action}</dd><dt className="text-muted-foreground">{l10n("local.reason_f81ab834")}</dt><dd>{decision.reason}</dd><dt className="text-muted-foreground">{l10n("local.reason_code_9e13ec9e")}</dt><dd><code className="text-xs">{decision.reasonCode}</code></dd></dl><div><p className="mb-2 text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">{l10n("local.production_surface_preview_9cf6232e")}</p><ProductionSurfacePreview event={event} runId={runId} /></div></div>;
                        }) : <p className="text-sm text-muted-foreground">{l10n("local.no_presentation_surface_was_emitted_for_this_74b2ae9d")}</p>}
                        {Object.keys(presentationDecision).length > 0 ? <details className="rounded-lg border border-border"><summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">{l10n("local.resolved_final_response_decision_6c68abe0")}</summary><div className="p-3 pt-0"><JsonExplorer value={presentationDecision} /></div></details> : null}
                        {verificationCaveats.length > 0 || ignoredAttentionRequests.length > 0 ? (
                          <div className="mt-3 rounded-lg border border-border bg-accent/30 p-3">
                            <p className="text-xs font-semibold text-accent-foreground">{l10n("local.semantic_finalization_lineage_7ffc4482")}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {l10n("local.provider_native_transport_and_model_authored_d452048c")}</p>
                            {ignoredAttentionRequests.some((candidate) => record(candidate).sourceKind === "environment_constraint") ? (
                              <p className="mt-2 text-xs">
                                <code>environment_constraint</code> {l10n("local.was_model_authored_tool_payload_data_not_a_co_bbbb960e")}</p>
                            ) : null}
                            <dl className="mt-2 grid grid-cols-(--gtc-runner-inspector-fields) gap-x-3 gap-y-1 text-xs">
                              <dt className="text-muted-foreground">{l10n("local.policy_c611981f")}</dt><dd><code>{text(runResultJson.finalizationPolicyVersion) || "unknown"}</code></dd>
                              <dt className="text-muted-foreground">{l10n("local.decision_reason_733f30ba")}</dt><dd><code>{text(runResultJson.finalizationReasonCode) || "unknown"}</code></dd>
                            </dl>
                            <details className="mt-2"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">{l10n("local.normalized_caveats_and_ignored_requests_1c5d7bb9")}</summary><div className="mt-2"><JsonExplorer value={{ verificationCaveats, ignoredAttentionRequests }} /></div></details>
                          </div>
                        ) : null}
                      </section>
                    </div>
                  ) : <div className="p-5 text-sm text-muted-foreground">{l10n("local.select_a_correlated_operation_to_inspect_its_d89e1320")}</div>}
                </ScrollArea>
              </div>
            </>
          ) : null}

          {view === "trace" ? (
            <div className="grid min-h-0 flex-1 md:grid-cols-(--gtc-runner-inspector-trace)">
              <ScrollArea className="border-r border-border"><div className="p-2">{frames.length ? [...frames].sort((left, right) => Number(left.frameId) - Number(right.frameId)).map((frame) => <button key={Number(frame.frameId)} type="button" onClick={() => { const operation = operations.find((candidate) => candidate.frames.some((candidateFrame) => Number(candidateFrame.frameId) === Number(frame.frameId))); if (operation) setSelectedKey(operation.key); setSelectedFrameId(Number(frame.frameId)); }} className={cn("mb-1 w-full rounded-md border px-3 py-2 text-left", Number(frame.frameId) === Number(selectedFrame?.frameId) ? "border-primary/40 bg-primary/10" : "border-transparent hover:bg-muted/50")}><span className="flex items-center gap-2 text-sm font-medium"><span className="font-mono text-xs text-muted-foreground">#{String(frame.frameId)}</span><span className="truncate">{frameMethod(frame) || text(frame.direction)}</span></span><span className="mt-1 block text-(length:--text-nano) text-muted-foreground">{text(frame.direction).replaceAll("_", " ")} · {formatBytes(Number(frame.byteLength) || 0)}</span></button>) : <p className="p-3 text-sm text-muted-foreground">{l10n("local.no_raw_frames_were_captured_for_this_run_a953ddb5")}</p>}</div></ScrollArea>
              <ScrollArea><div className="space-y-3 p-5">{selectedFrame ? <><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{l10n("local.exact_trace_frame_3f73c89a")}{String(selectedFrame.frameId)}</h3><Badge variant="outline">{frameMethod(selectedFrame) || text(selectedFrame.direction)}</Badge></div><JsonExplorer value={selectedFrame.parsed} />{canInspectRaw === true ? <Button size="sm" variant="outline" onClick={() => void reveal(Number(selectedFrame.frameId))}><Eye className="mr-1.5 h-4 w-4" />{l10n("local.reveal_exact_frame_2a05878d")}</Button> : null}{revealedFrame ? <JsonExplorer value={decodeExactFrame(revealedFrame.rawBase64)} label={l10n("local.search_exact_frame_acf5cb27")} /> : null}</> : <p className="text-sm text-muted-foreground">{l10n("local.select_a_frame_from_the_chronological_trace_6cd161fb")}</p>}</div></ScrollArea>
            </div>
          ) : null}

          {canInspectRaw === true && inspection?.trace?.runId === runId ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-3">
              <p className="text-xs text-muted-foreground">{inspection.trace.frameCount} {l10n("local.frames_e775ba8d")}{" "}{formatBytes(inspection.trace.byteCount)} {l10n("local._expires_1de5fe01")}{" "}{new Date(inspection.trace.expiresAt).toLocaleString()}</p>
              <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void downloadTrace()}><Download className="mr-1.5 h-4 w-4" />{l10n("local.download_exact_trace_8ce74eaf")}</Button><Button size="sm" variant="destructive" onClick={() => void deleteTrace()}><Trash2 className="mr-1.5 h-4 w-4" />{l10n("local.delete_trace_b0a07853")}</Button></div>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
