import { describe, expect, it } from "vitest";
import { loginErrors, newUserErrors, profileErrors, type UserFormValues } from "./user-form";

const base: UserFormValues = { full_name: "Farid Khan", role: "field", region: "Pune", email: "", phone: "98000 00001" };

describe("newUserErrors", () => {
  it("accepts a field operator with region and mobile, no email", () => {
    expect(newUserErrors(base, "mobile_password")).toEqual({});
  });
  it("requires region and mobile for field operators", () => {
    const e = newUserErrors({ ...base, region: "", phone: "" }, "mobile_password");
    expect(e.region).toBeTruthy();
    expect(e.phone).toBeTruthy();
  });
  it("requires email for field operators only under email_password", () => {
    expect(newUserErrors(base, "email_password").email).toBeTruthy();
    expect(newUserErrors(base, "mobile_otp").email).toBeUndefined();
  });
  it("requires email for staff, mobile optional", () => {
    const staff = { ...base, role: "office", region: "", phone: "" };
    expect(newUserErrors(staff, "mobile_password").email).toBeTruthy();
    expect(newUserErrors({ ...staff, email: "a@firm.in" }, "mobile_password")).toEqual({});
  });
  it("rejects bad mobile, bad email, short name and missing role", () => {
    const e = newUserErrors({ full_name: "A", role: "", region: "", email: "nope", phone: "12345" }, "mobile_password");
    expect(Object.keys(e).sort()).toEqual(["email", "full_name", "phone", "role"]);
    expect(e.phone).toBe("Enter a 10-digit Indian mobile number.");
  });
});

describe("profileErrors and loginErrors", () => {
  it("limits region length", () => {
    expect(profileErrors({ full_name: "Asha Rao", role: "admin", region: "x".repeat(61) }).region).toBeTruthy();
  });
  it("needs at least one of email or mobile", () => {
    expect(loginErrors({ email: "", phone: "" }).email).toMatch(/email and\/or mobile/);
    expect(loginErrors({ email: "a@b.in", phone: "" })).toEqual({});
    expect(loginErrors({ email: "", phone: "+91 98000 00001" })).toEqual({});
  });
});
