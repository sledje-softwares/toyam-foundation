import { describe, expect, it } from "vitest";
import { GENERIC_FAILURE, mapAdminUsersError, parseAdminUsersBody, readInvokeError } from "./admin-users-errors";

describe("mapAdminUsersError", () => {
  it("keeps the function message and field for duplicates", () => {
    expect(mapAdminUsersError({ code: "duplicate", message: "This mobile number is already used by Vijay More.", field: "phone" })).toEqual({
      ok: false,
      code: "duplicate",
      message: "This mobile number is already used by Vijay More.",
      field: "phone",
    });
  });
  it("uses readable wording for technical codes", () => {
    expect(mapAdminUsersError({ code: "internal", message: "boom" }).message).toBe(GENERIC_FAILURE);
    expect(mapAdminUsersError({ code: "auth_failed", message: "x" }).message).toBe(GENERIC_FAILURE);
    expect(mapAdminUsersError({ code: "unauthenticated", message: "x" }).message).toMatch(/Sign in again/);
    expect(mapAdminUsersError({ code: "sign_in_block_failed", message: "x" }).message).toMatch(/Try again/);
  });
  it("passes through last_admin and self_deactivate messages", () => {
    expect(mapAdminUsersError({ code: "last_admin", message: "There must be at least one active admin." }).message).toBe(
      "There must be at least one active admin.",
    );
    expect(mapAdminUsersError({ code: "self_deactivate", message: "You can't deactivate yourself." }).code).toBe("self_deactivate");
  });
  it("drops unknown fields and survives garbage", () => {
    expect(mapAdminUsersError({ code: "invalid_input", message: "Bad", field: "nope" }).field).toBeUndefined();
    expect(mapAdminUsersError(null)).toEqual({ ok: false, code: "internal", message: GENERIC_FAILURE });
  });
});

describe("parseAdminUsersBody", () => {
  it("returns success bodies as they are", () => {
    expect(parseAdminUsersBody({ ok: true, user_id: "u", temporary_password: "abcd-efgh-jkmn" })).toEqual({
      ok: true,
      user_id: "u",
      temporary_password: "abcd-efgh-jkmn",
    });
  });
  it("maps an ok:false body and a non-object", () => {
    expect(parseAdminUsersBody({ ok: false, error: { code: "not_found", message: "No such user." } })).toMatchObject({ ok: false, code: "not_found" });
    expect(parseAdminUsersBody("nope")).toMatchObject({ ok: false });
  });
});

describe("readInvokeError", () => {
  it("reads the error from the response body of a non-2xx reply", async () => {
    const context = new Response(JSON.stringify({ ok: false, error: { code: "duplicate", message: "Used.", field: "email" } }), { status: 409 });
    expect(await readInvokeError({ context })).toMatchObject({ code: "duplicate", field: "email" });
  });
  it("falls back when the body is not JSON", async () => {
    expect(await readInvokeError({ context: new Response("<html>", { status: 502 }) })).toEqual({ ok: false, code: "internal", message: GENERIC_FAILURE });
  });
});
