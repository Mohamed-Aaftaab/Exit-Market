import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The web app imports the proof builder from ../scripts/lib (single source of truth, verified on-chain).
  turbopack: { root: path.join(__dirname, "..") },
};

export default nextConfig;
