/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdfjs-dist is loaded at runtime by the bet365 importer; keep it external so
  // Next doesn't try to bundle its worker/font assets into the server build.
  experimental: {
    serverComponentsExternalPackages: ["pdfjs-dist"],
  },
};

export default nextConfig;
