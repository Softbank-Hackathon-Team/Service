import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 화면은 언제나 /api/... 로 부른다. Vite가 받아서 API 서버(기본 localhost:3000)로 넘긴다.
// 같은 출처처럼 보이므로 API 서버에 CORS 설정이 없어도 된다.
//   /api/healthz, /api/readyz → 서버 /healthz, /readyz   (k8s 프로브용이라 루트에 남는다)
//   /api/그 밖               → 서버 {API_PREFIX}/그 밖     (Jeong 결정 10/31: /api/v1)
const target = process.env.API_URL ?? "http://localhost:3000";
const prefix = process.env.API_PREFIX ?? "/api/v1"; // 접두사를 없애려면 API_PREFIX= 로 띄운다
const toRoot = { target, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") };
const proxy = {
  // 위에서부터 먼저 맞는 줄을 쓴다. 프로브 두 줄이 반드시 먼저
  "/api/healthz": toRoot,
  "/api/readyz": toRoot,
  "/api": { target, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, prefix) },
};

export default defineConfig({
  plugins: [react()],
  // 화면의 "API 응답 없음 (…)" 문구에 실제 프록시 대상을 보여 주려고 넣는다 (비밀값 아님)
  define: { __API_TARGET__: JSON.stringify(target) },
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
});
