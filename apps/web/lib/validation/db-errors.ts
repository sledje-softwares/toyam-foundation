/** Maps database errors (PostgREST / Postgres) to messages for forms. Never shows raw SQL text to people. */

export type DbErrorLike = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null } | null | undefined;

export type MappedError = { field?: string; message: string };

export const NOT_SAVED_MESSAGE = "Not saved. You may not have permission, or the record was changed. Reload and try again.";
export const GENERIC_MESSAGE = "Not saved. Try again.";

/** Constraint name -> field + message. Extend as screens are built. */
const CONSTRAINTS: Record<string, MappedError> = {
  insurers_name_key: { field: "name", message: "An insurer with this name already exists." },
  insurers_code_key: { field: "code", message: "This code is already used by another insurer." },
};

function constraintOf(e: NonNullable<DbErrorLike>): string | null {
  const m = /constraint "([^"]+)"/.exec(e.message ?? "");
  return m ? m[1] : null;
}

function looksTechnical(msg: string): boolean {
  return /duplicate key|violates|constraint|relation |syntax|row-level security|permission denied/i.test(msg);
}

export function mapDbError(error: DbErrorLike): MappedError {
  if (!error) return { message: GENERIC_MESSAGE };
  const msg = error.message ?? "";
  const constraint = constraintOf(error);
  switch (error.code) {
    case "23505": {
      if (constraint && CONSTRAINTS[constraint]) return CONSTRAINTS[constraint];
      // Messages written by our own triggers (e.g. "siu.example.in is already used by Test Life Assurance.")
      if (msg && !looksTechnical(msg)) return { message: msg };
      return { message: "This value is already used by another record." };
    }
    case "23514": {
      if (msg && !looksTechnical(msg)) return { message: msg };
      return { message: "One of the values is not allowed. Check the form and try again." };
    }
    case "23503":
      return { message: "This record is still in use elsewhere, so it can't be changed this way." };
    case "23502":
      return { message: "A required value is missing." };
    case "42501": {
      if (/at least one active admin/i.test(msg)) return { message: "There must be at least one active admin." };
      if (msg && !looksTechnical(msg)) return { message: msg };
      return { message: "You don't have permission to do this." };
    }
    case "40001":
      return { message: "This was changed by someone else. Reload to see their changes." };
    default:
      return { message: GENERIC_MESSAGE };
  }
}

/** For updates that return 0 rows because RLS filtered them out (not an error from the database). */
export function mapZeroRows(): MappedError {
  return { message: NOT_SAVED_MESSAGE };
}
