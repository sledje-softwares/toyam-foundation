import { describe, expect, it } from "vitest";
import { parseFieldSignIn } from "./auth-config";

describe("parseFieldSignIn", () => {
  it.each(["mobile_password", "mobile_otp", "email_password"] as const)("accepts %s", (v) => {
    expect(parseFieldSignIn(v)).toBe(v);
    expect(parseFieldSignIn(` ${v} `)).toBe(v);
  });
  it.each([undefined, "", "email", "EMAIL_PASSWORD"])("falls back to mobile_password for %j", (v) => {
    expect(parseFieldSignIn(v)).toBe("mobile_password");
  });
});
