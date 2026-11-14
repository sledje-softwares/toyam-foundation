import { describe, expect, it } from "vitest";
import { passwordErrors } from "./password-rules";

describe("passwordErrors", () => {
  it("accepts a valid password", () => expect(passwordErrors({ password: "Abcdefgh12", confirm: "Abcdefgh12" })).toEqual({}));
  it("explains each rule", () => {
    expect(passwordErrors({ password: "", confirm: "" }).password).toMatch(/Enter/);
    expect(passwordErrors({ password: "Ab1", confirm: "Ab1" }).password).toMatch(/10 characters/);
    expect(passwordErrors({ password: "abcdefghij1", confirm: "abcdefghij1" }).password).toMatch(/upper/);
    expect(passwordErrors({ password: "ABCDEFGHIJ1", confirm: "ABCDEFGHIJ1" }).password).toMatch(/lower/);
    expect(passwordErrors({ password: "Abcdefghijk", confirm: "Abcdefghijk" }).password).toMatch(/number/);
  });
  it("requires the confirmation to match", () => {
    expect(passwordErrors({ password: "Abcdefgh12", confirm: "Abcdefgh13" }).confirm).toMatch(/do not match/);
  });
});
