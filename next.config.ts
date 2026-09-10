import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Enables `forbidden()` + `forbidden.tsx` used by the super-admin
    // area layout to return a real 403 for authenticated non-admins.
    authInterrupts: true,
  },
};

export default nextConfig;
