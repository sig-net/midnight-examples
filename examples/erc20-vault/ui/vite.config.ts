// One config serves both the bundler and the test runner: `defineConfig` comes
// from vitest/config so the `test` block is typed, and `vite build` ignores it.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
  },
  build: {
    // Fail the build rather than ship a chunk that stalls first paint.
    chunkSizeWarningLimit: 600,
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
