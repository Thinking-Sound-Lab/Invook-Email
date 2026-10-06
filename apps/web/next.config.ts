import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Vercel packages the server through its build adapter; Docker needs standalone output.
  output: process.env.VERCEL ? undefined : "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
};

export default nextConfig;
