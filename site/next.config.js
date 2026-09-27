/** @type {import('next').NextConfig} */
const base = process.env.NEXT_BASE_PATH || "";

const nextConfig = {
  output: "export",
  reactStrictMode: true,
  ...(base
    ? { basePath: base, assetPrefix: `${base}/` }
    : {}),
  images: { unoptimized: true },
};

module.exports = nextConfig;
