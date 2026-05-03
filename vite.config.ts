import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "TeleportWebClient",
      fileName: (format) =>
        format === "es"
          ? "teleport-web-client.js"
          : "teleport-web-client.umd.cjs",
      formats: ["es", "umd"],
    },
    rollupOptions: {
      external: ["three"],
      output: {
        globals: { three: "THREE" },
      },
    },
  },
  server: {
    port: 5173,
    open: "/examples/minimal/index.html",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
