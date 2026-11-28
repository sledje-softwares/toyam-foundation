import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/database.types";
import { supabaseEnv } from "@/lib/supabase/env";
import { loginPathFor, REQUEST_PATH_HEADER } from "@/lib/safe-next";

// Edge middleware (OpenNext-compatible). Refreshes the session cookie on every request and redirects anonymous
// visitors to /login?next=<requested page>. Role checks happen in the layouts/pages (and RLS).
export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const params = new URLSearchParams(request.nextUrl.search);
  params.delete("_rsc"); // client-navigation cache buster, not part of the page address
  const query = params.toString();
  const requested = query ? `${path}?${query}` : path;
  // Lets server layouts / guards that find no profile send the user back here after sign-in. Always overwritten, so a
  // client-sent value never reaches them.
  request.headers.set(REQUEST_PATH_HEADER, requested);

  let response = NextResponse.next({ request });
  const { url, anonKey } = supabaseEnv();

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);

  const isLogin = path === "/login" || path.startsWith("/login/");
  if (!signedIn && !isLogin) {
    // No `next` for "/" or "/dashboard", or for anything safeNext rejects.
    return NextResponse.redirect(new URL(loginPathFor(requested), request.url));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
