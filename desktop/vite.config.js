import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/vditor/dist/**/*",
          dest: "vditor/dist",
          rename: { stripBase: 3 },
        },
      ],
    }),
  ],
});
