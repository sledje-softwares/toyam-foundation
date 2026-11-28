"use client";

import { useActionState } from "react";
import { signIn, type LoginState } from "./actions";

export function LoginForm({ initialError, next }: { initialError: string | null; next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(signIn, {
    error: initialError,
  });
  const input =
    "mt-1 block w-full rounded border border-slate-400 px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-700";
  return (
    <form action={action} className="mt-6 space-y-4">
      {/* Page to return to; the action checks it again with safeNext. */}
      <input type="hidden" name="next" value={next} />
      {state.error && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          {state.error}
        </p>
      )}
      <div>
        <label htmlFor="email" className="text-sm font-medium">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required className={input} />
      </div>
      <div>
        <label htmlFor="password" className="text-sm font-medium">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className={input} />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-blue-800 px-4 py-2 font-medium text-white hover:bg-blue-900 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
