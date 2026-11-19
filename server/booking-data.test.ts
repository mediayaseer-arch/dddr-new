import { describe, expect, it } from "vitest";
import { sanitizeBookingData } from "./booking-data";

describe("booking data pass-through", () => {
  it("preserves booking data intact without dropping fields", () => {
    const data = {
      test: "sample",
      payment: {
        status: "pending",
      },
      currentPage: "checkout",
    };
    expect(sanitizeBookingData(data)).toEqual(data);
  });
});