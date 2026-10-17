import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Vercel packages the server through its build adapter; Docker needs standalone output.
  output: process.env.VERCEL ? undefined : "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  experimental: {
    // The marketing site and the product use separate root layouts, so unmatched
    // URLs need a 404 page that does not depend on either layout.
    globalNotFound: true,
  },
};

export default nextConfig;
