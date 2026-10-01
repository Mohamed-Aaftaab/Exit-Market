import path from "node:path";
import type { NextConfig } from "next";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "../scripts/lib/networks.ts";

const isDev = process.env.NODE_ENV === "development";
const origin = (url: string) => new URL(url).origin;

/**
 * Every origin the site talks to: the two chains' public RPCs (reads, wallet-independent), the display font and
 * the landing's background video. Wallet traffic goes through the browser extension, not the page.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  // Next's inline bootstrap scripts need 'unsafe-inline' without per-request nonces (the pages are static).
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data: https://db.onlinewebfonts.com",
  "media-src 'self' https://d8j0ntlcm91z4.cloudfront.net",
  `connect-src 'self' ${origin(ARBITRUM_SEPOLIA.rpcUrl)} ${origin(XAI_TESTNET.rpcUrl)}${isDev ? " ws:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // The web app imports the proof builder from ../scripts/lib (single source of truth, verified on-chain).
  turbopack: { root: path.join(__dirname, "..") },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
