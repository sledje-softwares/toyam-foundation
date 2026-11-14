import { describe, expect, it } from "vitest";
import { failureReason, isStuck, retryQueuedLabel, statusesForFilter, truncateError } from "./failed-mail";

describe("failureReason", () => {
  it("detects parser errors", () => expect(failureReason("parser: boom")).toBe("parser"));
  it("treats everything else as decode", () => {
    expect(failureReason("bad MIME")).toBe("decode");
    expect(failureReason(null)).toBe("decode");
  });
});

describe("truncateError", () => {
  it("returns a dash for empty", () => expect(truncateError("  ")).toBe("—"));
  it("keeps short text and collapses whitespace", () => expect(truncateError("a\n  b")).toBe("a b"));
  it("cuts long text with an ellipsis", () => {
    const out = truncateError("x".repeat(200), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("…")).toBe(true);
  });
});

const NOW = new Date("2026-11-14T12:00:00Z");

describe("isStuck", () => {
  it("is false for a fresh queued retry", () =>
    expect(isStuck({ status: "retry_requested", retry_requested_at: "2026-11-14T11:30:00Z", retry_alerted_at: null }, NOW)).toBe(false));
  it("is false at exactly 60 minutes", () =>
    expect(isStuck({ status: "retry_requested", retry_requested_at: "2026-11-14T11:00:00Z", retry_alerted_at: null }, NOW)).toBe(false));
  it("is true after 60 minutes", () =>
    expect(isStuck({ status: "retry_requested", retry_requested_at: "2026-11-14T10:59:00Z", retry_alerted_at: null }, NOW)).toBe(true));
  it("is true for failed after an alert", () =>
    expect(isStuck({ status: "failed", retry_requested_at: null, retry_alerted_at: "2026-11-14T11:00:00Z" }, NOW)).toBe(true));
  it("is false for plain failed", () =>
    expect(isStuck({ status: "failed", retry_requested_at: null, retry_alerted_at: null }, NOW)).toBe(false));
});

describe("retryQueuedLabel", () => {
  it("returns null without a request", () => expect(retryQueuedLabel(null, NOW)).toBeNull());
  it("says just now", () => expect(retryQueuedLabel("2026-11-14T11:59:40Z", NOW)).toBe("Retry queued just now"));
  it("uses minutes", () => expect(retryQueuedLabel("2026-11-14T11:48:00Z", NOW)).toBe("Retry queued 12 min ago"));
  it("uses hours", () => expect(retryQueuedLabel("2026-11-14T09:00:00Z", NOW)).toBe("Retry queued 3 h ago"));
  it("uses days", () => expect(retryQueuedLabel("2026-11-11T12:00:00Z", NOW)).toBe("Retry queued 3 d ago"));
});

describe("statusesForFilter", () => {
  it("maps known values", () => {
    expect(statusesForFilter("failed")).toEqual(["failed"]);
    expect(statusesForFilter("retry_requested")).toEqual(["retry_requested"]);
  });
  it("defaults to both", () => {
    expect(statusesForFilter(undefined)).toEqual(["failed", "retry_requested"]);
    expect(statusesForFilter("x")).toEqual(["failed", "retry_requested"]);
  });
});
