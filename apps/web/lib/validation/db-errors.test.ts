import { describe, expect, it } from "vitest";
import { GENERIC_MESSAGE, mapDbError } from "./db-errors";

describe("mapDbError for our own function errors", () => {
  it("passes through human messages raised with 22023 / P0002", () => {
    expect(mapDbError({ code: "22023", message: "Claim number is required" })).toEqual({ message: "Claim number is required" });
    expect(mapDbError({ code: "55000", message: "Only a submitted case can be reopened" })).toEqual({ message: "Only a submitted case can be reopened" });
    expect(mapDbError({ code: "P0002", message: "Nothing to confirm" })).toEqual({ message: "Nothing to confirm" });
  });
  it("hides technical text", () => {
    expect(mapDbError({ code: "22023", message: 'invalid input syntax for type uuid: "x"' })).toEqual({ message: GENERIC_MESSAGE });
  });
});
