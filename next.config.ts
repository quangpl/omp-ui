import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `vite build` emits a self-contained server at dist/standalone/server.js
  // (run with `node dist/standalone/server.js`; honours PORT and HOST).
  output: "standalone",
};

export default nextConfig;
