import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Insurer report templates (.docx, up to 10 MB) are uploaded through a server action.
  experimental: { serverActions: { bodySizeLimit: "11mb" } },
  async redirects() {
    return [{ source: "/audit-log", destination: "/admin/audit-log", permanent: false }];
  },
};

export default nextConfig;
