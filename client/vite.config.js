import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  base: "./",

  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://192.168.100.10:9001",
    },
  },
});
