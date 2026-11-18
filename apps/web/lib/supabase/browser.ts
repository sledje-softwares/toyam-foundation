import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";
import { supabaseEnv } from "./env";

let client: ReturnType<typeof createBrowserClient<Database>> | null = null;

/**
 * Supabase client in the browser, as the signed-in user: the anon (publishable) key and the session from the auth
 * cookies the server set (@supabase/ssr). Never a service-role key (rule 4): RLS, the storage policies and the RPCs'
 * own checks decide what this client may do. One client per page load. Import only from client code.
 */
export function createClient() {
  if (!client) {
    const { url, anonKey } = supabaseEnv();
    client = createBrowserClient<Database>(url, anonKey);
  }
  return client;
}
