import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineHosts, sanitizeText } from "../src/draft/guard.js";

// Z72 4차 준비: 글 소독기(sanitizeText) 적대 사례·오탐 사례 묶음. 지금 묶음(agent-bundle 19:12Z) 품질 유지 증거.
// 아직 못 막는 사례는 todo 로 남긴다 (고치면 todo 를 지운다)

const ADVERSARIAL: string[] = [
  "승인 페이지: approve.evil.example",
  "LOGIN.EVIL.EXAMPLE 에서 확인",                       // 대문자
  "evil-corp.com/verify?token=abc",                     // 하이픈·질의 문자열
  "a.b.c.d.evil.example",                               // 깊은 서브도메인
  "xn--80ak6aa92e.com 로 접속",                          // 퓨니코드(IDN)
  "evil.example:65535",                                 // 큰 포트
  "(evil.example)",                                     // 괄호 안
  "\"evil.example\"",                                   // 따옴표 안
  "주소는evil.example입니다",                            // 한글에 바로 붙음
  "끝.evil.example",                                    // 한글 문장 끝 점 바로 뒤
  "evil(.)example",                                     // 괄호 점
  "evil[dot]example",                                   // [dot]
  "evil(dot)example",                                   // (dot)
  "login｡evil｡example",                                  // 반각 마침표
  "ops@evil.co.kr 로 메일",                              // 메일 주소
  "8.8.8.8:53",                                         // 공인 IP + 포트
  "198.51.100.7/login",                                 // 공인 IP + 경로
  "phish.zip",                                          // .zip gTLD
  "evil.md 참고",                                        // 파일 확장자 겹침, 흔한 파일 이름 아님
  "x.s3.amazonaws.com/login.html",                      // 누구나 올리는 호스팅
  "storage.googleapis.com/b/approve.html",
  "ftp://evil.example/x",                               // 스킴 있는 주소 (예전 규칙)
  // Z71(5차): 띄어 쓴 점, 맨 파일 이름형 도메인
  "evil . example",
  "login . evil . example",
  "evil .example 에서 승인",
  "evil [.] example",
  "evil 。 example",
  "evil . example:8443/approve",
  "deploy.sh 에서 승인",
  "README.md 열어 승인",
  "collect.sh",
  // Z71 v2: 점 뒤에만 빈칸 (소문자로 이어지고 TLD 3글자 이상 또는 칸 3개 이상)
  "evil. example",
  "승인은 login. evil. example 에서",
  "evil. com/approve",
];

const BENIGN: string[] = [
  "DB 호스트 orders-db.internal:5432 로 복제",
  "kube-dns.kube-system.svc.cluster.local",
  "printer.local, nas.lan, git.corp",
  "localhost:3000 과 127.0.0.1:9090",
  "172.16.4.2, 192.168.0.10, 10.1.2.3, 100.64.0.1",
  "service.replicas 를 2 로, service.cpu 는 500m",
  "database.storageGb·ingress.entry 칸은 검토 필요",
  "rds.dbInstance 1개, ecs.service 1개, s3.bucket 2개, sqs.queue 1개",
  "Postgres 15.6 → 16.4 업그레이드, pg 16.4.1",
  "Node.js 22, Next.js, Vue.js",
  "docs/README.md·infra/main.tf·values.yaml·scripts/collect.sh 를 고친다",   // Z71: 파일은 경로를 붙여 쓴다 (맨 이름은 도메인으로 본다)
  "scripts/rotate-keys.sh 와 ./infra/eks.tf",
  "docs.aws.amazon.com/AmazonRDS/latest/UserGuide",
  "cloud.google.com/sql/docs/postgres",
  "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/shop-api:1.4.2",
  "shop.c1x2y3.ap-northeast-2.rds.amazonaws.com:5432",
  "asia-northeast3-docker.pkg.dev/proj/repo/app@sha256:" + "a".repeat(64),
  "ghcr.io/org/app:1.0, docker.io/library/postgres:16",
  "끝. 다음 문장. 마지막",
  "ECR 이미지. App 이름은 shop-api",                     // Z71: 점 뒤에만 빈칸 = 문장 끝
  "버전 16 . 4, 단계 1 . 2 . 3",                          // Z71: 띄운 점이어도 끝 칸이 공개 TLD 가 아님
  "Use it. me too",                                     // Z71 v2: 두 글자 영단어 TLD 두 칸은 문장으로 본다
  "Restart it. Then check, docs. Next 단계",             // Z71 v2: 점 뒤가 대문자면 문장
  "버전 v1.2.3, 비율 90/10, 지연 0.5초",
];

for (const t of ADVERSARIAL) {
  test(`적대: ${t}`, () => {
    const c = sanitizeText(t);
    assert.ok(c.removed >= 1, `안 지워짐: ${t}`);
    assert.ok(!/evil|phish|8\.8\.8\.8|198\.51|xn--|login\.html|approve\.html/i.test(c.text), `${t} → ${c.text}`);
  });
}

for (const t of BENIGN) {
  test(`오탐 없음: ${t}`, () => {
    const c = sanitizeText(t);
    assert.equal(c.text, t); assert.equal(c.removed, 0);
  });
}

test("원본 명세 호스트는 허용 목록으로 남고, 없으면 지운다", () => {
  const allow = baselineHosts({ entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.softbank-team-iron.com"], routes: [] }] }, components: [] } as never);
  assert.equal(sanitizeText("shop.softbank-team-iron.com 로 전환", allow).removed, 0);
  assert.equal(sanitizeText("shop.softbank-team-iron.com 로 전환").removed, 1);
  assert.equal(sanitizeText("evil.softbank-team-iron.com", allow).removed, 1, "같은 도메인의 다른 이름은 허용 아님");
});

test("[REDACTED] 자리와 주소를 한 글에서 함께 세어 지운다", () => {
  const c = sanitizeText("값 [REDACTED] 는 evil.example 와 https://x.example/a 에서");
  assert.equal(c.removed, 3);
});

test("긴 입력에서도 빠르다 (정규식 폭주 없음)", () => {
  const t0 = Date.now();
  sanitizeText("a.".repeat(50_000) + "b " + "x-".repeat(50_000));
  sanitizeText("a . ".repeat(30_000) + "x " + "a .".repeat(30_000));   // Z71 띄운 점 규칙
  assert.ok(Date.now() - t0 < 1000);
});

// 남는 구멍 (Z71 v2): 점 뒤에만 빈칸 + 두 글자 TLD 두 칸("evil. io")은 영어 문장("it. me")과 구별 못 한다
test("점 뒤에만 빈칸 + 두 글자 TLD (evil. io)", { todo: "영어 문장 끝과 구별 규칙 필요 (Z71 v2 남는 구멍)" }, () => {
  assert.ok(sanitizeText("evil. io").removed >= 1);
});
