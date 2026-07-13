import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// COOP/COEP make the page cross-origin isolated so SharedArrayBuffer is
// available (frame streaming + threaded WASM). Everything is self-hosted, so
// require-corp is safe. Production headers are set in vercel.json.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // The Emscripten glues must NOT be bundled: mujoco's pthread build spawns
    // workers from its own import.meta.url, which has to point at the pristine
    // glue file, and ORT fetches its runtime relative to wasmPaths. Serve both
    // as plain static files and import them at runtime.
    viteStaticCopy({
      targets: [
        { src: "node_modules/mujoco/mujoco.js", dest: "vendor/mujoco" },
        { src: "node_modules/mujoco/mujoco.wasm", dest: "vendor/mujoco" },
        { src: "node_modules/onnxruntime-web/dist/ort.wasm.min.mjs", dest: "vendor/ort" },
        {
          src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
          dest: "vendor/ort",
        },
        {
          src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
          dest: "vendor/ort",
        },
      ],
    }),
  ],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4096,
  },
  optimizeDeps: {
    exclude: ["mujoco", "onnxruntime-web"],
  },
});
