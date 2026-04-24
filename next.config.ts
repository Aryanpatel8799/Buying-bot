import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Exclude bulky runtime-only directories from build tracing — these contain
  // Chrome user-data (~30k files per profile) and per-job artifacts, none of
  // which are part of the bundle.
  outputFileTracingExcludes: {
    "*": [
      "chrome-profiles/**",
      "error-screenshots/**",
      "order-reports/**",
    ],
  },
};

export default nextConfig;
