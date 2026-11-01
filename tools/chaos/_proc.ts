// 장애 시험(작업 Z12) 공용 도구: 진짜 워커·API 프로세스를 띄우고 죽인다.
// 자식 프로세스마다 PGAPPNAME을 달리 줘서, DB 쪽에서 "그 프로세스의 연결만" 골라 끊을 수 있게 한다.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface Proc { name: string; child: ChildProcess; out: string[]; exited: Promise<number | null> }

export function startProc(name: string, entry: string, env: Record<string, string> = {}): Proc {
  const child = spawn(process.execPath, ["--env-file=.env", "--import", "tsx", entry], {
    cwd: ROOT, env: { ...process.env, PGAPPNAME: name, WORKER_METRICS_PORT: "0", ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  const out: string[] = [];
  const keep = (b: Buffer) => { for (const l of b.toString().split("\n")) if (l.trim()) out.push(l); };
  child.stdout!.on("data", keep); child.stderr!.on("data", keep);
  const exited = new Promise<number | null>((r) => child.on("exit", (code, sig) => r(code ?? (sig ? -1 : null))));
  return { name, child, out, exited };
}

export async function waitOut(p: Proc, re: RegExp, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (p.out.some((l) => re.test(l))) return;
    if (p.child.exitCode !== null) throw new Error(`${p.name} exited: ${p.out.slice(-10).join("\n")}`);
    await sleep(50);
  }
  throw new Error(`${p.name}: ${re} not seen in ${ms} ms\n${p.out.slice(-10).join("\n")}`);
}

export async function until<T>(f: () => Promise<T | null | undefined | false>, ms: number, step = 50): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout ${ms} ms`);
    await sleep(step);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ownerClient() {
  return new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL });
}

// application_name이 name으로 시작하는 연결을 전부 끊는다 (그 프로세스의 풀·pg-boss·생존 신호 연결)
export async function killBackends(owner: pg.Client, name: string): Promise<number> {
  const r = await owner.query(
    `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS n
       FROM pg_stat_activity WHERE application_name LIKE $1 AND pid <> pg_backend_pid()`, [`${name}%`]);
  return r.rows[0].n as number;
}

export async function stopProc(p: Proc) {
  if (p.child.exitCode === null) { p.child.kill("SIGKILL"); await p.exited; }
}
