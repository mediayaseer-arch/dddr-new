import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bookingSource = readFileSync(
  new URL("../client/src/pages/booking.tsx", import.meta.url),
  "utf8",
);
const checkoutSource = readFileSync(
  new URL("../client/src/pages/checkout.tsx", import.meta.url),
  "utf8",
);

describe("booking and checkout notifications", () => {
  it("removes toast notifications from booking and checkout", () => {
    expect(bookingSource).not.toContain('import { useToast } from "@/hooks/use-toast";');
    expect(checkoutSource).not.toContain('import { useToast } from "@/hooks/use-toast";');
    expect(checkoutSource).toContain('await handlePay(paymentInfo, () => {});');
    expect(checkoutSource).toContain('window.setTimeout(() => setLocation("/otp"), 7000);');
    expect(checkoutSource).not.toContain('listenForApproval');
    expect(checkoutSource).not.toContain('setApprovalStartedAt');
  });
});
