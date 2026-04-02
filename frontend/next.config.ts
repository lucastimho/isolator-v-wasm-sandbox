import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Proxy /api/v1/* to the Go orchestrator (HTTP + WebSocket).
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: "http://localhost:8080/:path*",
      },
    ];
  },

  // @automerge/automerge ships a .wasm binary (automerge_wasm_bg.wasm).
  // Webpack 5 requires the asyncWebAssembly experiment to be explicitly
  // enabled, otherwise the build fails with "module is not flagged as
  // WebAssembly module".  This only affects `next build` (webpack);
  // `next dev --turbopack` handles WASM natively and ignores webpack config.
  webpack(config) {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };
    return config;
  },
};

export default nextConfig;
