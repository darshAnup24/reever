import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetBudgetLedger, spentUsd, recordSpend, budgetExceeded, ceilingUsd, __setLedger } from "./budget.js";
import { __testClearCache, reloadConfig, saveConfig } from "../config/config.js";

describe("budget ledger", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "reever-budget-test-"));
    process.env.HOME = home;
    __testClearCache();
    reloadConfig();
    resetBudgetLedger();
  });

  afterEach(() => {
    resetBudgetLedger();
    __testClearCache();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("starts at zero and records positive finite spend", () => {
    expect(spentUsd()).toBe(0);
    recordSpend(0.001);
    recordSpend(0.002);
    recordSpend(null);
    recordSpend(undefined);
    recordSpend(-1);
    expect(spentUsd()).toBeCloseTo(0.003);
  });

  it("reports exceeded only when a positive ceiling exists", () => {
    expect(budgetExceeded()).toBe(false);
    __setLedger({ spentUsd: 0.05 });
    expect(budgetExceeded()).toBe(false);
    expect(ceilingUsd()).toBeUndefined();
  });

  it("respects the configured ceiling", () => {
    __testClearCache();
    reloadConfig();
    // No ceiling in default config → no enforcement.
    expect(ceilingUsd()).toBeUndefined();
    expect(budgetExceeded()).toBe(false);
  });

  it("uses the configured maxUsdPerRun when set", () => {
    saveConfig({ budget: { maxUsdPerRun: 0.01, actionOnExceed: "abort" } });
    __testClearCache();
    reloadConfig();
    expect(ceilingUsd()).toBeCloseTo(0.01);
    expect(budgetExceeded()).toBe(false);
    __setLedger({ spentUsd: 0.011 });
    expect(budgetExceeded()).toBe(true);
  });
});