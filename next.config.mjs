/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdfjs-dist is loaded at runtime by the bet365 importer; keep it external so
  // Next doesn't try to bundle its worker/font assets into the server build.
  experimental: {
    serverComponentsExternalPackages: ["pdfjs-dist", "playwright"],
    // components/icons.tsx imports 50+ icons from the lucide-react barrel;
    // this rewrites those to per-icon paths so a route only pays for what it
    // actually renders.
    optimizePackageImports: ["lucide-react"],
  },
  env: {
    // Playwright's Chromium lives in a user-level cache outside the project, so
    // it is never part of a serverless bundle. Anywhere but a machine we control
    // the launch can only fail — see lib/scrapeEnv.ts.
    NEXT_PUBLIC_CLV_SCRAPE: process.env.VERCEL ? "0" : "1",
  },
};

export default nextConfig;
