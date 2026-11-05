// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BudgetIncident, BudgetPolicySummary } from "@paperclipai/shared";
import { i18n } from "../i18n";
import { BudgetIncidentCard } from "./BudgetIncidentCard";
import { BudgetPolicyCard } from "./BudgetPolicyCard";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("budget cards localization", () => {
  it("renders budget scope types in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    const now = new Date("2026-11-05T00:00:00.000Z");
    const summary: BudgetPolicySummary = {
      policyId: "policy-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      scopeName: "Rabbit",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 10000,
      observedAmount: 2500,
      remainingAmount: 7500,
      utilizationPercent: 25,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
      status: "ok",
      paused: false,
      pauseReason: null,
      windowStart: now,
      windowEnd: now,
    };
    const incident: BudgetIncident = {
      id: "incident-1",
      companyId: "company-1",
      policyId: "policy-1",
      scopeType: "company",
      scopeId: "company-1",
      scopeName: "Alice",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      windowStart: now,
      windowEnd: now,
      thresholdType: "hard",
      amountLimit: 10000,
      amountObserved: 11000,
      status: "open",
      approvalId: null,
      approvalStatus: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const policyHtml = renderToStaticMarkup(<BudgetPolicyCard summary={summary} />);
    const incidentHtml = renderToStaticMarkup(
      <BudgetIncidentCard
        incident={incident}
        onRaiseAndResume={() => {}}
        onKeepPaused={() => {}}
      />,
    );

    expect(policyHtml).toContain("智能体");
    expect(incidentHtml).toContain("公司");
  });
});
