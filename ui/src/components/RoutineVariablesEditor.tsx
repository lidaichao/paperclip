import { l10n } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, HelpCircle } from "lucide-react";
import { isValidRoutineDateString, syncRoutineVariablesWithTemplate, type RoutineVariable } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const variableTypes: RoutineVariable["type"][] = ["text", "textarea", "number", "boolean", "select", "date"];

function serializeVariables(value: RoutineVariable[]) {
  return JSON.stringify(value);
}

function parseSelectOptions(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function updateVariableList(
  variables: RoutineVariable[],
  name: string,
  mutate: (variable: RoutineVariable) => RoutineVariable,
) {
  return variables.map((variable) => (variable.name === name ? mutate(variable) : variable));
}

function defaultValueForType(type: RoutineVariable["type"], current: RoutineVariable["defaultValue"]) {
  if (type === "boolean") return null;
  if (type === "date") {
    return typeof current === "string" && isValidRoutineDateString(current) ? current : null;
  }
  return current;
}

export function RoutineVariablesEditor({
  title,
  description,
  value,
  onChange,
}: {
  title: string;
  description: string;
  value: RoutineVariable[];
  onChange: (value: RoutineVariable[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const syncedVariables = useMemo(
    () => syncRoutineVariablesWithTemplate([title, description], value),
    [description, title, value],
  );
  const syncedSignature = serializeVariables(syncedVariables);
  const currentSignature = serializeVariables(value);

  useEffect(() => {
    if (syncedSignature !== currentSignature) {
      onChange(syncedVariables);
    }
  }, [currentSignature, onChange, syncedSignature, syncedVariables]);

  if (syncedVariables.length === 0) {
    return null;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-lg border border-border/70">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
        <div>
          <p className="text-sm font-medium">{l10n("local.variables_02db55ba")}</p>
          <p className="text-xs text-muted-foreground">
            {l10n("local.detected_from_b6cc4da9")}{"{{name}}"}{l10n("local._placeholders_in_the_title_and_instructions_f71c60c7")}</p>
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </CollapsibleTrigger>
      <CollapsibleContent className="divide-y divide-border/70 border-t border-border/70">
        {syncedVariables.map((variable) => (
          <div key={variable.name} className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono text-xs">
                {`{{${variable.name}}}`}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {l10n("local.prompt_the_user_for_this_value_before_each_ma_2b4cc78d")}</span>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{l10n("local.label_0e66373f")}</Label>
                <Input
                  value={variable.label ?? ""}
                  onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                    ...current,
                    label: event.target.value || null,
                  })))}
                  placeholder={variable.name.replaceAll("_", " ")}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">{l10n("local.type_baaddf70")}</Label>
                <Select
                  value={variable.type}
                  onValueChange={(type) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                    ...current,
                    type: type as RoutineVariable["type"],
                    defaultValue: defaultValueForType(type as RoutineVariable["type"], current.defaultValue),
                    options: type === "select" ? current.options : [],
                  })))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {variableTypes.map((type) => (
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 md:col-span-2">
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-xs">{l10n("local.default_value_e6fdffbb")}</Label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={variable.required}
                      onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                        ...current,
                        required: event.target.checked,
                      })))}
                    />
                    {l10n("local.required_4850b174")}</label>
                </div>

                {variable.type === "textarea" ? (
                  <Textarea
                    rows={3}
                    value={variable.defaultValue == null ? "" : String(variable.defaultValue)}
                    onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                      ...current,
                      defaultValue: event.target.value || null,
                    })))}
                  />
                ) : variable.type === "boolean" ? (
                  <Select
                    value={variable.defaultValue === true ? "true" : variable.defaultValue === false ? "false" : "__unset__"}
                    onValueChange={(next) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                      ...current,
                      defaultValue: next === "__unset__" ? null : next === "true",
                    })))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unset__">{l10n("local.no_default_706e7d9f")}</SelectItem>
                      <SelectItem value="true">{l10n("local.true_3cbc87c7")}</SelectItem>
                      <SelectItem value="false">{l10n("local.false_60a33e6c")}</SelectItem>
                    </SelectContent>
                  </Select>
                ) : variable.type === "select" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{l10n("local.options_d0db8b5e")}</Label>
                      <Input
                        value={variable.options.join(", ")}
                        onChange={(event) => {
                          const options = parseSelectOptions(event.target.value);
                          onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                            ...current,
                            options,
                            defaultValue:
                              typeof current.defaultValue === "string" && options.includes(current.defaultValue)
                                ? current.defaultValue
                                : null,
                          })));
                        }}
                        placeholder={l10n("local.high_medium_low_04d2e278")}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{l10n("local.default_option_e98cdb11")}</Label>
                      <Select
                        value={typeof variable.defaultValue === "string" ? variable.defaultValue : "__unset__"}
                        onValueChange={(next) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                          ...current,
                          defaultValue: next === "__unset__" ? null : next,
                        })))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={l10n("local.no_default_706e7d9f")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__unset__">{l10n("local.no_default_706e7d9f")}</SelectItem>
                          {variable.options.map((option) => (
                            <SelectItem key={option} value={option}>{option}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ) : variable.type === "date" ? (
                  <Input
                    type="date"
                    value={typeof variable.defaultValue === "string" ? variable.defaultValue : ""}
                    onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                      ...current,
                      defaultValue: event.target.value || null,
                    })))}
                  />
                ) : (
                  <Input
                    type={variable.type === "number" ? "number" : "text"}
                    value={variable.defaultValue == null ? "" : String(variable.defaultValue)}
                    onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                      ...current,
                      defaultValue: event.target.value || null,
                    })))}
                    placeholder={variable.type === "number" ? "42" : l10n("local.default_value_e6fdffbb")}
                  />
                )}
              </div>
            </div>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

type BuiltinVariableDoc = {
  name: string;
  example: string;
  description: string;
};

const BUILTIN_VARIABLE_DOCS: BuiltinVariableDoc[] = [
  {
    name: "date",
    example: "2026-04-28",
    description: l10n("local.current_date_in_yyyy_mm_dd_format_utc_at_the_2855ef35"),
  },
  {
    name: "timestamp",
    example: "April 28, 2026 at 12:17 PM UTC",
    description: l10n("local.human_readable_date_and_time_utc_at_the_time_43844b71"),
  },
];

export function RoutineVariablesHint() {
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
        <span>
          {l10n("local.use_48995044")}{"{{variable_name}}"}{l10n("local._placeholders_in_the_title_or_instructions_to_2f70c3ce")}</span>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={l10n("local.show_variable_help_e638b7dd")}
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </div>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{l10n("local.routine_variables_991b3b51")}</DialogTitle>
            <DialogDescription>
              {l10n("local.how_to_prompt_for_inputs_and_which_variables_c32330f9")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5 text-sm">
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
                {l10n("local.custom_variables_6e1560c2")}</h3>
              <p className="text-muted-foreground">
                {l10n("local.type_baaddf70")}{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                  {"{{variable_name}}"}
                </code>{" "}
                {l10n("local.anywhere_in_the_title_or_instructions_papercl_26b4419d")}{" "}<span className="font-medium text-foreground">{l10n("local.variables_02db55ba")}</span>{l10n("local._and_prompts_for_a_value_before_each_run_5ada67b5")}</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>{l10n("local.names_must_start_with_a_letter_and_may_use_le_00f8d741")}</li>
                <li>{l10n("local.pick_a_type_text_textarea_number_boolean_sele_a1bc2c5f")}</li>
                <li>{l10n("local.variable_names_ending_in_capital_date_such_as_b3b6177f")}</li>
                <li>{l10n("local.the_same_name_reused_across_the_title_and_ins_1d070af9")}</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
                {l10n("local.built_in_variables_d6a95f07")}</h3>
              <p className="text-muted-foreground">
                {l10n("local.these_are_filled_in_automatically_no_setup_ne_c0e4e61f")}</p>
              <div className="overflow-hidden rounded-lg border border-border/70">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">{l10n("local.placeholder_f4b24fed")}</th>
                      <th className="px-3 py-2 font-medium">{l10n("local.example_d029f87e")}</th>
                      <th className="px-3 py-2 font-medium">{l10n("local.description_526e0087")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {BUILTIN_VARIABLE_DOCS.map((entry) => (
                      <tr key={entry.name} className="align-top">
                        <td className="px-3 py-2">
                          <Badge variant="outline" className="font-mono text-xs">{`{{${entry.name}}}`}</Badge>
                        </td>
                        <td className="px-3 py-2 font-mono text-muted-foreground">{entry.example}</td>
                        <td className="px-3 py-2 text-muted-foreground">{entry.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
