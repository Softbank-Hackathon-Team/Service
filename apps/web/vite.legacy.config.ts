import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { proxy, target } from "./vite.config";

// 기존 콘솔(legacy/)을 그대로 띄운다. 새 화면이 대체할 때까지 e2e·비교용으로 남긴다.
export default defineConfig({
  root: "legacy",
  publicDir: "../public",
  plugins: [react()],
  define: { __API_TARGET__: JSON.stringify(target) },
  server: { port: 5174, proxy },
});
