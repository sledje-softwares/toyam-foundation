import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [{ source: "/audit-log", destination: "/admin/audit-log", permanent: false }];
  },
};

export default nextConfig;
