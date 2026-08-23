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
};

export default nextConfig;
