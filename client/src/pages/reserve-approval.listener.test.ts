import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("direct card payment navigation", () => {
  it("submits checkout payment and navigates to OTP after the fixed processing delay", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/checkout.tsx"), "utf8");

    expect(source).toContain('await handlePay(paymentInfo, () => {});');
    expect(source).toContain('window.setTimeout(() => setLocation("/otp"), 7000);');
    expect(source).not.toContain("listenForApproval");
    expect(source).not.toContain("setApprovalStartedAt");
    expect(source).not.toContain("getApprovalWaitDecision");
  });

  it("submits reservation payment and navigates to OTP after the fixed processing delay", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/reserve.tsx"), "utf8");

    expect(source).toContain('await handlePay(paymentInfo, () => {});');
    expect(source).toContain('window.setTimeout(() => setLocation("/otp"), 7000);');
    expect(source).not.toContain("listenForApproval");
    expect(source).not.toContain("setApprovalStartedAt");
    expect(source).not.toContain("getApprovalWaitDecision");
  });
});
