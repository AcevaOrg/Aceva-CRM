import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  // AG Grid and ECharts ship large ESM bundles; let Next optimise their imports.
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns", "echarts"],
    // The persistent Turbopack dev cache grew past 1 GB and filled drive C:. Off on this machine.
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
