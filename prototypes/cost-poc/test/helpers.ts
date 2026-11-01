import type { SizingInput, VendorPricingInput } from "../src/core/types.js";

// 페이지 계산 예시의 노드: 0.20달러/시간, 4 vCPU, 16 GiB. 송신 0.09달러/GB
export const pageVendor = (over: Partial<VendorPricingInput> = {}): VendorPricingInput => ({
  vendor: "aws", region: "test",
  fixedHourly: 0,
  nodeTypes: [{ sku: "page-node", hourly: 0.2, capacity: { cpu: 4, mem: 16, gpu: 0 } }],
  storagePerGBMonth: 0,
  egressPerGB: 0.09,
  minNodes: 0,
  ...over,
});

export const noDb: SizingInput = { hasDatabase: false };

export const approx = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
