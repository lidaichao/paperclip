import { l10n } from "../../../i18n";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatEndpointSetupAction,
} from "@/api/chatEndpoints";
import { sanitizedSetupErrorMessage } from "./chat-setup-error";

export function PhotonConnectStep({
  endpoint,
  agentName,
  repairing,
  pending,
  onAction,
}: {
  endpoint: ChatEndpoint;
  agentName: string;
  repairing: boolean;
  pending: boolean;
  onAction(
    action: ChatEndpointSetupAction,
    values?: Record<string, string>,
  ): void;
}) {
  const [projectId, setProjectId] = useState(endpoint.providerAccountId ?? "");
  const [projectSecret, setProjectSecret] = useState("");
  const [lineId, setLineId] = useState("");
  const inspection = useMutation({
    mutationFn: () =>
      chatEndpointsApi.inspectPhoton(endpoint.id, {
        projectId: projectId.trim(),
        projectSecret,
      }),
    onSuccess: (result) => {
      const eligible = result.lines.filter((line) => line.eligible);
      setLineId(eligible.length === 1 ? eligible[0].lineId : "");
    },
  });
  const resetInspection = () => {
    inspection.reset();
    setLineId("");
  };
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-xl font-bold">{l10n("local.connect_imessage_photon_32def631")}</h1>
        <p className="text-sm text-muted-foreground">
          {l10n("local.connect_1a2303ed")}{" "}{agentName} {l10n("local.to_photon_cloud_pro_supports_direct_messages_35f25898")}</p>
        <p className="text-sm">
          <a
            className="underline"
            href="https://app.photon.codes/"
            target="_blank"
            rel="noreferrer"
          >
            {l10n("local.photon_dashboard_5da11f56")}</a>
          {" · "}
          <a
            className="underline"
            href="https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing"
            target="_blank"
            rel="noreferrer"
          >
            {l10n("local.photon_line_setup_d3a4d1f0")}</a>
        </p>
      </div>
      {repairing && (
        <p className="text-sm text-muted-foreground">
          {l10n("local.reconnect_keeps_this_project_and_2f29d282")}{" "}
          {endpoint.photonAllocation === "shared" ? l10n("local.shared_dm_allocation_10e5a47f") : endpoint.botExternalId ?? l10n("local.dedicated_number_4475cb1e")}{l10n("local._leave_the_secret_blank_to_reuse_the_saved_co_475a76a4")}</p>
      )}
      <label className="grid gap-2 text-sm font-medium">
        {l10n("local.project_id_e511470b")}<Input
          value={projectId}
          autoComplete="off"
          disabled={pending || inspection.isPending || !!endpoint.botExternalId}
          onChange={(event) => {
            setProjectId(event.target.value);
            resetInspection();
          }}
        />
      </label>
      <label className="grid gap-2 text-sm font-medium">
        {l10n("local.project_secret_e34f019a")}<Input
          type="password"
          value={projectSecret}
          autoComplete="new-password"
          disabled={pending || inspection.isPending}
          onChange={(event) => {
            setProjectSecret(event.target.value);
            resetInspection();
          }}
        />
      </label>
      <Button
        variant="outline"
        disabled={
          pending || inspection.isPending || !projectId.trim() || !projectSecret
        }
        onClick={() => inspection.mutate()}
      >
        {inspection.isPending ? l10n("local.inspecting_photon_7906bcc6") : l10n("local.inspect_photon_project_f3ed3263")}
      </Button>
      {inspection.isError && (
        <p role="alert" className="text-sm text-destructive">
          {sanitizedSetupErrorMessage(inspection.error, { projectSecret })}
        </p>
      )}
      {inspection.data && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">
            {inspection.data.allocation === "shared" ? l10n("local.shared_dms_d71f88ac") : l10n("local.dedicated_numbers_4c9a8c79")} {l10n("local.in_58296753")}{" "}{inspection.data.projectName}
          </legend>
          {!inspection.data.eligible && (
            <p role="alert" className="text-sm text-destructive">
              {inspection.data.allocation === "shared"
                ? l10n("local.this_shared_project_already_belongs_to_anothe_2dd07c3f")
                : l10n("local.no_eligible_dedicated_number_is_available_che_56febe59")}
            </p>
          )}
          {inspection.data.allocation === "shared" && inspection.data.eligible && (
            <p className="text-sm text-muted-foreground">
              {l10n("local.direct_messages_only_enroll_each_test_sender_9cc8aad1")}</p>
          )}
          {inspection.data.lines.map((line) => (
            <label
              key={line.lineId}
              className="flex items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="photon-line"
                value={line.lineId}
                checked={lineId === line.lineId}
                disabled={
                  !line.eligible ||
                  pending ||
                  (!!endpoint.botExternalId &&
                    endpoint.botExternalId !== line.phoneNumber)
                }
                onChange={() => setLineId(line.lineId)}
              />
              <span>
                {line.phoneNumber}
                {line.unavailableReason ? ` — ${line.unavailableReason}` : ""}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div>
        <Button
          disabled={
            pending ||
            inspection.isPending ||
            (!(inspection.data?.eligible && (inspection.data.allocation === "shared" || lineId)) && !(repairing && !projectSecret))
          }
          onClick={() =>
            onAction(
              repairing ? "reconnect" : "configure",
              inspection.data?.eligible && inspection.data.allocation === "shared"
                ? { projectId: projectId.trim(), projectSecret, allocation: "shared" }
                : lineId
                ? { projectId: projectId.trim(), projectSecret, lineId, allocation: "dedicated" }
                : undefined,
            )
          }
        >
          {pending
            ? l10n("local.connecting_72021eb7")
            : repairing
              ? l10n("local.reconnect_photon_7d239345")
              : inspection.data?.allocation === "shared" ? l10n("local.connect_shared_dms_889e1116") : l10n("local.connect_selected_number_1a1bb17b")}
        </Button>
      </div>
    </div>
  );
}
