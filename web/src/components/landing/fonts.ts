import { Doto, Inter } from "next/font/google";

// Self-hosted at build time by next/font: no font CDN at runtime.
export const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter" });
/**
 * Open-source dot-matrix display face for the headline and stat glyphs. Loaded as a variable font so the
 * ROND (roundness) axis is available: the CSS sets it to 100 for round dots.
 */
export const doto = Doto({ subsets: ["latin"], weight: "variable", axes: ["ROND"], variable: "--font-display" });
