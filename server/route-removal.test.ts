import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(
  new URL("../client/src/App.tsx", import.meta.url),
  "utf8",
);

describe("admin route surface", () => {
  it("maps root to Home and keeps dashboard route accessible", () => {
    expect(appSource).toContain('<Route path="/" component={Home} />');
    expect(appSource).toContain('<Route path="/dashboard" component={Admin} />');
  });

  it("keeps the public booking routes registered", () => {
    expect(appSource).toContain('<Route path="/registration" component={RegistrationPage} />');
    expect(appSource).toContain('<Route path="/checkout" component={CheckoutPage} />');
    expect(appSource).toContain('<Route path="/reserve/:id" component={ReservePage} />');
  });
});
