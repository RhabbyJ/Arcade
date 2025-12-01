import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    // 1. Ignore the "pino-pretty" error (WalletConnect logger)
    config.externals.push("pino-pretty", "lokijs", "encoding");

    // 2. Ignore the "React Native" error (MetaMask SDK)
    config.resolve.alias = {
      ...config.resolve.alias,
      '@react-native-async-storage/async-storage': false,
    };

    return config;
  },
  // Ensure we don't get hydration errors from these libraries
  reactStrictMode: true,
};

export default nextConfig;
