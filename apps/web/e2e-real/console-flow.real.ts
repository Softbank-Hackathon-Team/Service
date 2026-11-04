import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

// 새 콘솔(src/)을 목업(dev-mock.ts) 없이 실제 API·워커·DB 로 끝까지 돈다 (playwright.real.config.ts).
// 사람처럼 보이는 버튼만 누르고 API 를 직접 불러 상태를 넘기지 않는다. 화면이 깨지는 곳에서 이 시험도 실패한다.
// 다음 단계를 막는 실패는 그 자리에서 멈추고(expect), 막지 않는 실패는 끝까지 간 뒤 한꺼번에 남긴다(expect.soft).

const EMAIL = process.env.E2E_LOGIN_EMAIL ?? "demo@dev-company.test";
const PASSWORD = process.env.E2E_LOGIN_PASSWORD ?? "";
// DRAFT(ai): 개발 seed 의 환경 이름. 배포된 플랫폼에서 이름이 다르면 환경변수로 바꾼다
const SOURCE = process.env.E2E_SOURCE_ENV ?? "dev-aws";
const TARGET = process.env.E2E_TARGET_ENV ?? "dev-gcp";
// DRAFT(ai): 사람이 누른 뒤 화면이 바뀌기까지, 워커 단계가 끝나기까지 기다리는 한도
const HUMAN_MS = 30_000;
const WORKER_MS = 10 * 60_000;

// 이전 한 건 화면의 큰 카드 제목 (features/migration 의 Hero title). 줄바꿈은 공백으로 바꿔 맞춘다
const SCREEN = {
  spec: /확인하고 확정해 주세요|이 명세로 옮길까요/,
  specBlocked: /막힌 항목 \d+개를 풀어야 합니다/,
  approve: /승인해 주세요|이대로만 실행합니다/,
  approved: /승인했습니다/,
  running: /도착 환경을 만들고 있습니다|도착지에 띄우고 있습니다|DB를 따라잡고 있습니다|트래픽을 옮기고 있습니다|DB 쓰기 담당을 넘기고 있습니다/,
  shifting: /트래픽을 옮기고 있습니다/,
  window: /되돌릴 수 있는 시간입니다/,
  windowOver: /자원을 정리하고 있습니다/,
  cleanup: /임시 자원을 지우고 있습니다/,
  done: /멈추지 않고 .+로 옮겼습니다/,
};
const anyOf = (...patterns: RegExp[]) => new RegExp(patterns.map((pattern) => pattern.source).join("|"));

const STEP_LOGIN = "로그인 화면";

type ApiFailure = { step: string; method: string; path: string; status: number; code: string | null; message: string | null; at: number };
type BrowserProblem = { step: string; kind: "console.error" | "pageerror"; text: string };
type Signal = { type: string; migrationId?: string; status?: string };

type Evidence = {
  migrationId: string | null;
  /** 이전 한 건 화면의 큰 카드 제목이 바뀐 차례 */
  screens: string[];
  /** 트래픽 막대가 보인 도착 비율 (바뀔 때만) */
  trafficShown: number[];
  /** 화면이 받은 GET traffic-shift 값 (바뀔 때만) */
  trafficReceived: string[];
  /** 완료 화면이 읽은 GET report 의 traffic. 아직 안 읽었으면 null */
  report: { traffic: unknown } | null;
  apiFailures: ApiFailure[];
  otherFailures: ApiFailure[];
  refreshOkAt: number[];
  browser: BrowserProblem[];
  sse: { connects: { status: number; contentType: string }[]; signals: Signal[] };
  notes: Record<string, string>;
};

// 화면이 일부러 받고 넘어가는 4xx. 목록에는 남기고 실패로 세지 않는다
const HANDLED: { why: string; match: (failure: ApiFailure, ev: Evidence) => boolean }[] = [
  {
    why: "첫 확인에서 refresh 쿠키가 없어 401 → 로그인 화면 (lib/auth.ts bootstrap)",
    match: (f) => f.step === STEP_LOGIN && f.method === "POST" && f.path === "/api/auth/refresh" && f.status === 401,
  },
  {
    why: "접근 토큰 만료 401 → refresh 성공 → 같은 요청 다시 (lib/http.ts onUnauthorized)",
    match: (f, ev) => f.status === 401 && f.path !== "/api/auth/refresh" && ev.refreshOkAt.some((at) => at >= f.at),
  },
];
const handledWhy = (failure: ApiFailure, ev: Evidence) => HANDLED.find((rule) => rule.match(failure, ev))?.why ?? null;
// Chrome 은 실패한 요청마다 console.error 를 한 줄 더 낸다. 그 요청은 이미 4xx·5xx 목록에 있다
const NETWORK_ECHO = /^Failed to load resource: the server responded with a status of \d+/;

const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
const heroTitle = (page: Page) => page.getByRole("heading", { level: 2 });
const envButton = (page: Page, name: string) => page.getByRole("button").filter({ has: page.getByText(name, { exact: true }) });
// 새 이전의 출발 줄은 제목이 그 환경에서 서비스 중인 소프트웨어라, 환경 이름은 줄 이름(aria-label) 끝 " · <환경>" 에 있다
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sourceButton = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(` · ${escapeRe(name)}$`) });
const progress = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "진행 단계", exact: true }) });
const stepMark = (page: Page, label: string) => progress(page).getByRole("listitem").filter({ hasText: label }).getByRole("img");
const trafficBar = (page: Page) => page.getByRole("img", { name: /^트래픽 / });

/**
 * 비밀번호는 Playwright 동작 인자로 넘기지 않는다. 동작 인자·DOM 스냅숏·요청 본문이 모두 trace 에 남기 때문이다.
 * 노출 함수로 페이지 안에서 채우고, 로그인 요청이 끝나 입력칸이 사라질 때까지 trace 를 끈다.
 */
async function logIn(page: Page) {
  await page.exposeFunction("__e2eLoginPassword", () => PASSWORD);
  await page.goto("/");
  const form = page.getByRole("form", { name: "로그인" });
  await expect(form).toBeVisible();
  await form.getByLabel("이메일").fill(EMAIL);
  const tracing = page.context().tracing;
  const traced = await tracing.stop().then(() => true, () => false);
  try {
    await form.getByLabel("비밀번호").evaluate(async (input: HTMLInputElement) => {
      const value = await (window as unknown as { __e2eLoginPassword: () => Promise<string> }).__e2eLoginPassword();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await form.getByRole("button", { name: "로그인", exact: true }).click();
    await form.waitFor({ state: "hidden", timeout: HUMAN_MS }).catch(async () => {
      throw new Error(`로그인 화면을 벗어나지 못했습니다. 알림 "${flat((await form.getByRole("alert").allTextContents()).join(" "))}"`);
    });
  } finally {
    if (await form.isVisible()) await form.getByLabel("비밀번호").fill("");
    if (traced) await tracing.start({ screenshots: true, snapshots: true, sources: true });
  }
}

/** 화면 신호(GET /api/events)는 fetch 스트림이라 Playwright 응답 본문으로 못 읽는다. CDP 로 브라우저가 받은 바이트를 본다 */
async function listenSignals(page: Page, sse: Evidence["sse"]) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const streams = new Map<string, { text: string; ready: boolean; early: string[] }>();
  const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8");
  const feed = (requestId: string, chunk: string) => {
    const stream = streams.get(requestId)!;
    stream.text += chunk;
    for (let at = stream.text.indexOf("\n\n"); at >= 0; at = stream.text.indexOf("\n\n")) {
      const block = stream.text.slice(0, at);
      stream.text = stream.text.slice(at + 2);
      for (const line of block.split("\n").filter((l) => l.startsWith("data:"))) {
        try {
          sse.signals.push(JSON.parse(line.slice(5)) as Signal);
        } catch {
          sse.signals.push({ type: `해석 못 함: ${line}` });
        }
      }
    }
  };
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    if (new URL(response.url).pathname !== "/api/events") return;
    sse.connects.push({ status: response.status, contentType: response.headers["content-type"] ?? response.headers["Content-Type"] ?? "" });
    if (response.status !== 200) return;
    const stream = { text: "", ready: false, early: [] as string[] };
    streams.set(requestId, stream);
    // 앞부분(bufferedData)보다 dataReceived 가 먼저 도착할 수 있어 앞부분을 넣은 뒤에 이어 붙인다
    cdp.send("Network.streamResourceContent", { requestId }).then(
      ({ bufferedData }) => {
        feed(requestId, decode(bufferedData));
        stream.ready = true;
        for (const chunk of stream.early.splice(0)) feed(requestId, chunk);
      },
      () => {
        stream.ready = true;
      },
    );
  });
  cdp.on("Network.dataReceived", ({ requestId, data }) => {
    const stream = streams.get(requestId);
    if (!stream || !data) return;
    if (stream.ready) feed(requestId, decode(data));
    else stream.early.push(decode(data));
  });
}

type Snapshot = { title: string; trafficTarget: number | null; stopped: string | null; alert: string };

async function snapshot(page: Page): Promise<Snapshot> {
  const title = flat(await heroTitle(page).first().textContent({ timeout: 2_000 }).catch(() => ""));
  const bar = (await trafficBar(page).count()) > 0 ? await trafficBar(page).first().getAttribute("aria-label", { timeout: 1_000 }).catch(() => null) : null;
  const stopped = progress(page).getByRole("listitem").filter({ has: page.getByRole("img", { name: /^(실패|멈춤)$/ }) });
  return {
    title,
    trafficTarget: bar ? Number(/(\d+)%$/.exec(bar)?.[1]) : null,
    stopped: (await stopped.count()) > 0 ? flat(await stopped.first().textContent()) : null,
    alert: flat((await page.getByRole("alert").allTextContents()).join(" | ")),
  };
}

/** 화면이 바뀔 때까지 보며 지나간 제목과 트래픽 막대를 남긴다. 진행 단계에 멈춤·실패가 뜨면 바로 실패한다 */
async function waitForScreen(page: Page, ev: Evidence, want: RegExp, ms: number, refuse?: RegExp): Promise<Snapshot> {
  const deadline = Date.now() + ms;
  for (;;) {
    const now = await snapshot(page);
    if (now.title && now.title !== ev.screens.at(-1)) ev.screens.push(now.title);
    if (now.trafficTarget !== null && now.trafficTarget !== ev.trafficShown.at(-1)) ev.trafficShown.push(now.trafficTarget);
    if (want.test(now.title)) return now;
    const why = now.stopped
      ? `진행 단계에 "${now.stopped}"`
      : refuse?.test(now.title)
        ? "다른 화면에서 막힘"
        : Date.now() > deadline
          ? `${ms / 1000}초 동안 오지 않음`
          : null;
    if (why) throw new Error(`"${want.source}" 화면을 기다렸지만 ${why}. 지금 화면 "${now.title}"${now.alert ? `, 알림 "${now.alert}"` : ""}`);
    await page.waitForTimeout(250);
  }
}

async function writeEvidence(info: TestInfo, ev: Evidence) {
  const lines = [
    `이전 ${ev.migrationId ?? "(만들지 못함)"}`,
    `화면 차례: ${ev.screens.join(" → ")}`,
    `트래픽 막대 도착 비율: ${ev.trafficShown.join(" → ") || "못 봄"}`,
    `화면이 받은 traffic-shift: ${ev.trafficReceived.join(" → ") || "없음"}`,
    ...Object.entries(ev.notes).map(([name, value]) => `${name}: ${value}`),
    `/api 4xx·5xx ${ev.apiFailures.length}건`,
    ...ev.apiFailures.map((f) => {
      const why = handledWhy(f, ev);
      return `  [${f.step}] ${f.method} ${f.path} → ${f.status} ${f.code ?? ""} "${f.message ?? ""}"${why ? ` (처리됨: ${why})` : ""}`;
    }),
    `/api 밖 4xx·5xx ${ev.otherFailures.length}건`,
    ...ev.otherFailures.map((f) => `  [${f.step}] ${f.method} ${f.path} → ${f.status}`),
    `브라우저 오류 ${ev.browser.length}건`,
    ...ev.browser.map((p) => `  [${p.step}] ${p.kind} ${p.text}`),
    `화면 신호 연결: ${ev.sse.connects.map((c) => `${c.status} ${c.contentType}`).join(", ") || "없음"}`,
    `화면 신호 ${ev.sse.signals.length}건: ${ev.sse.signals.map((s) => (s.migrationId === ev.migrationId ? s.status : s.type)).join(" → ")}`,
  ];
  console.log(lines.map((line) => `[real] ${line}`).join("\n"));
  const file = info.outputPath("evidence.json");
  writeFileSync(file, JSON.stringify(ev, null, 2));
  await info.attach("evidence", { path: file, contentType: "application/json" });
}

test("새 콘솔 · 실제 서버: 로그인부터 이전 완료까지 화면으로 한 번", async ({ page }, info) => {
  const ev: Evidence = {
    migrationId: null, screens: [], trafficShown: [], trafficReceived: [], report: null,
    apiFailures: [], otherFailures: [], refreshOkAt: [], browser: [], sse: { connects: [], signals: [] }, notes: {},
  };
  let current = "시작 전";
  const step = <T>(title: string, body: () => Promise<T>) =>
    test.step(title, () => {
      current = title;
      return body();
    });

  page.on("response", async (res) => {
    const url = new URL(res.url());
    const path = url.pathname;
    if (path === "/api/auth/refresh" && res.ok()) ev.refreshOkAt.push(Date.now());
    if (ev.migrationId && res.ok() && path === `/api/migrations/${ev.migrationId}/traffic-shift`) {
      const shift = (await res.json().catch(() => null)) as { available?: boolean; targetWeightPct?: number | null; observedWeightPct?: number | null } | null;
      const seen = shift?.available ? `목표 ${shift.targetWeightPct}·실측 ${shift.observedWeightPct}` : "기록 없음";
      if (seen !== ev.trafficReceived.at(-1)) ev.trafficReceived.push(seen);
    }
    if (ev.migrationId && res.ok() && path === `/api/migrations/${ev.migrationId}/report` && !url.searchParams.has("format")) {
      ev.report = { traffic: ((await res.json().catch(() => null)) as { traffic?: unknown } | null)?.traffic ?? null };
    }
    if (res.status() < 400) return;
    const failure: ApiFailure = { step: current, method: res.request().method(), path: path + url.search, status: res.status(), code: null, message: null, at: Date.now() };
    (path.startsWith("/api/") ? ev.apiFailures : ev.otherFailures).push(failure);
    const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    failure.code = body?.code ?? null;
    failure.message = body?.message ?? null;
  });
  page.on("console", (message) => {
    if (message.type() === "error") ev.browser.push({ step: current, kind: "console.error", text: message.text() });
  });
  page.on("pageerror", (error) => ev.browser.push({ step: current, kind: "pageerror", text: error.message }));
  await listenSignals(page, ev.sse);

  try {
    await step(STEP_LOGIN, () => logIn(page));

    await step("대시보드", async () => {
      await expect(page).toHaveURL(/\/(#\/?)?$/);
      await expect(heroTitle(page)).toHaveText(/환경 \d+개/);
      await expect(envButton(page, SOURCE)).toBeVisible();
      await expect(envButton(page, TARGET)).toBeVisible();
      await expect(page.getByRole("button", { name: /^검토 필요/ }), "이전 목록을 읽음").toBeVisible();
    });

    await step("새 이전 · 출발 고르기", async () => {
      await page.getByRole("button", { name: "새 이전 시작", exact: true }).click();
      await expect(page).toHaveURL(/#\/migrations\/new$/);
      await expect(heroTitle(page)).toHaveText(/어디에서\s*옮길까요/);
      await sourceButton(page, SOURCE).click();
    });

    // 출발 범위(sourceScope)는 자동으로 고른다. 찾은 자원을 다 읽으면 "옮길 서비스" 칸이 사람 입력을 기다린다
    await step("새 이전 · 옮길 서비스", async () => {
      await expect(heroTitle(page)).toHaveText(/무엇을\s*옮길까요/);
      await expect(page.getByRole("listitem").filter({ hasText: "옮길 서비스" }).getByRole("img")).toHaveAccessibleName("입력 기다림", { timeout: HUMAN_MS });
      ev.notes["찾은 자원"] = flat(await page.locator('[style*="grid-area: found"]').innerText({ timeout: 5_000 }).catch(() => "칸을 못 찾음"));
      await page.getByRole("button", { name: /^자동으로 고르기/ }).click();
    });

    await step("새 이전 · 도착 고르기", async () => {
      await expect(heroTitle(page)).toHaveText(/어디로\s*옮길까요/);
      await envButton(page, TARGET).click();
      await page.getByRole("button", { name: `${TARGET}로 옮기기`, exact: true }).click();
      await expect(page).toHaveURL(/#\/migrations\/[0-9a-f-]{36}$/, { timeout: HUMAN_MS });
      ev.migrationId = page.url().split("/").at(-1)!;
    });

    await step("가져오기", () => waitForScreen(page, ev, SCREEN.spec, WORKER_MS, SCREEN.specBlocked));

    await step("명세 확정", async () => {
      await expect(page.getByRole("button", { name: /^읽은 값/ })).toContainText(/\d+칸/);
      await page.getByRole("button", { name: /명세 확정$/ }).click();
    });

    await step("사전 점검 · 계획 만들기", async () => {
      await waitForScreen(page, ev, SCREEN.approve, WORKER_MS);
      await expect(page.getByRole("button", { name: /^실행 단계/ }), "계획서를 읽음").toContainText(/\d+단계/);
      await expect(page.getByRole("button", { name: /^사전 점검/ })).toContainText(/\d+건/);
      ev.notes["사전 점검"] = flat(await page.getByRole("button", { name: /^사전 점검/ }).textContent());
    });

    await step("계획 승인", async () => {
      const acks = page.locator("label").filter({ has: page.getByRole("checkbox") });
      ev.notes["승인 전에 확인"] = (await acks.allTextContents()).map(flat).join(" / ") || "없음";
      for (const box of await page.getByRole("checkbox").all()) await box.check();
      const approve = page.getByRole("button", { name: "이 계획 승인", exact: true });
      await expect(approve).toBeEnabled();
      await approve.click();
      await waitForScreen(page, ev, SCREEN.approved, HUMAN_MS);
    });

    await step("실행 시작", async () => {
      await page.getByRole("button", { name: "실행 시작", exact: true }).click();
      await waitForScreen(page, ev, anyOf(SCREEN.running, SCREEN.window, SCREEN.windowOver, SCREEN.cleanup, SCREEN.done), HUMAN_MS);
    });

    await step("트래픽 이동 10 → 50 → 100 · 컷오버", async () => {
      await waitForScreen(page, ev, anyOf(SCREEN.window, SCREEN.windowOver, SCREEN.cleanup, SCREEN.done), WORKER_MS);
      expect.soft(ev.screens.some((title) => SCREEN.shifting.test(title)), "트래픽 이동 화면을 봄").toBe(true);
      expect.soft(ev.trafficShown, "트래픽 막대의 도착 비율은 줄지 않음").toEqual([...ev.trafficShown].sort((a, b) => a - b));
      await expect.soft(stepMark(page, "트래픽 이동")).toHaveAccessibleName("끝남");
      await expect.soft(stepMark(page, "DB 컷오버")).toHaveAccessibleName("끝남");
    });

    await step("롤백 대기", async () => {
      expect.soft(ev.screens.some((title) => SCREEN.window.test(title)), "롤백 대기 화면(되돌릴 수 있는 시간)을 봄").toBe(true);
      const now = await snapshot(page);
      if (!SCREEN.window.test(now.title)) {
        ev.notes["리소스 회수"] = `누르기 전에 창이 끝남 (지금 화면 "${now.title}")`;
        return;
      }
      const clock = page.getByText(/^\d{2}:\d{2}$/);
      await expect(clock).toBeVisible();
      await expect(trafficBar(page)).toHaveAccessibleName(new RegExp(`${TARGET} 100%$`));
      await expect(page.getByRole("button", { name: "롤백", exact: true })).toBeVisible();
      const [minutes = 0, seconds = 0] = (await clock.textContent())!.split(":").map(Number);
      const left = minutes * 60 + seconds;
      // 창 길이는 서버 설정(ROLLBACK_WINDOW_SEC)이다. 거의 끝났으면 누르는 사이 버튼이 사라지므로 저절로 끝나기를 기다린다
      if (left < 8) {
        ev.notes["리소스 회수"] = `창이 ${left}초만 남아 누르지 않음`;
        return;
      }
      await page.getByRole("button", { name: "리소스 회수", exact: true }).click();
      await page.getByRole("button", { name: "되돌릴 수 없습니다. 회수하기", exact: true }).click();
      // 창이 저절로 끝나기 전에 넘어가야 회수가 먹은 것이다
      await waitForScreen(page, ev, anyOf(SCREEN.windowOver, SCREEN.cleanup, SCREEN.done), (left - 3) * 1000);
      ev.notes["리소스 회수"] = `창이 ${left}초 남았을 때 누름`;
    });

    await step("정리 · 완료", async () => {
      await waitForScreen(page, ev, SCREEN.done, WORKER_MS);
      await expect(progress(page).getByRole("img", { name: "끝남" }).first()).toBeVisible();
      await expect(progress(page).getByRole("img", { name: /^(진행 중|대기|멈춤|실패)$/ }), "진행 단계가 모두 끝남").toHaveCount(0);
    });

    await step("완료 · 전환 판정과 증적 리포트", async () => {
      await expect.poll(() => ev.report !== null, { message: "완료 화면이 증적 리포트(GET report)를 읽음", timeout: HUMAN_MS }).toBe(true);
      ev.notes["리포트 traffic"] = JSON.stringify(ev.report?.traffic);
      await expect
        .soft(page.getByRole("button", { name: /^전환 판정/ }), "트래픽을 옮기고 끝난 이전이면 전환 판정 요약이 보여야 함 (#174)")
        .not.toContainText("아직 없음");
      const opened = page.context().waitForEvent("page");
      await page.getByRole("button", { name: "증적 리포트", exact: true }).click();
      const report = await opened;
      await expect(report.getByRole("heading", { level: 1 })).toHaveText("이전 증적 리포트");
      await expect(report.locator("body")).toContainText(ev.migrationId!);
      await report.close();
    });
  } finally {
    await writeEvidence(info, ev);
    expect.soft(ev.apiFailures.filter((f) => !handledWhy(f, ev)), "화면이 처리하지 못한 /api 4xx·5xx").toEqual([]);
    expect.soft(ev.otherFailures, "/api 밖 4xx·5xx").toEqual([]);
    expect.soft(ev.browser.filter((p) => !(p.kind === "console.error" && NETWORK_ECHO.test(p.text))), "브라우저 console.error·pageerror").toEqual([]);
    if (ev.migrationId) {
      expect.soft(ev.sse.connects.some((c) => c.status === 200 && c.contentType.startsWith("text/event-stream")), "화면 신호 GET /api/events 가 붙음").toBe(true);
      expect.soft(ev.sse.signals.some((s) => s.migrationId === ev.migrationId), "이 이전의 화면 신호를 받음").toBe(true);
    }
  }
});
