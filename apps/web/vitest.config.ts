import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Same "@/..." and "@shared/..." aliases as tsconfig, so tests can import route handlers, mock "@/lib/..." modules and
// use the shared report writers (supabase/functions/_shared).
export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../../supabase/functions/_shared", import.meta.url)),
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
