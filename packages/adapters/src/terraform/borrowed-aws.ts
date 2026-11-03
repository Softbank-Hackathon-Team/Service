import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// L5b: 빌린 AWS 실행 역할 자격을 terraform 자식 프로세스에 넘기는 길.
// 왜 환경변수(AWS_ACCESS_KEY_ID…)가 아니라 credential_process 인가:
//   실행 역할은 15분(STS 최소, broker OPERATE_MAX_TTL_SEC)이고 apply 는 45분까지 간다(TF_APPLY_TIMEOUT_SEC).
//   자식 프로세스 환경변수는 시작 때 고정이라 10분마다 재발급(_roles.ts)해도 terraform 이 새 키를 못 받는다.
//   credential_process 는 AWS SDK 가 Expiration 이 지나면 다시 부른다 → 재발급 때 파일만 바꾸면 terraform 이 새 키를 읽는다
// 【추정】 terraform AWS provider(aws-sdk-go-v2)가 credential_process 결과를 Expiration 기준으로 다시 부른다. 실계정 확인 필요 (실측 안 함)
// 파일은 임시 폴더(0700) 안 0600, 단계 끝(dispose)에 지운다. 값은 로그·감사에 안 남긴다
// --profile·AWS_PROFILE 은 쓰지 않는다: 임시 설정 파일의 [default] 만 있다

export interface AwsSessionKeys { accessKeyId: string; secretAccessKey: string; sessionToken: string }
export interface BorrowedAwsCreds {
  /** terraform 자식 env 에 덮을 값 (자격 값 자체는 없음, 파일 경로만) */
  env: Record<string, string>;
  dir: string;
  update(k: AwsSessionKeys, expiresAt: Date): void;
  dispose(): void;
}

const processJson = (k: AwsSessionKeys, expiresAt: Date) => JSON.stringify({
  Version: 1, AccessKeyId: k.accessKeyId, SecretAccessKey: k.secretAccessKey, SessionToken: k.sessionToken,
  Expiration: expiresAt.toISOString(),
});

export function borrowedAwsCreds(k: AwsSessionKeys, expiresAt: Date, o: { region: string; root?: string }): BorrowedAwsCreds {
  const dir = mkdtempSync(join(o.root ?? tmpdir(), "svc-aws-"));
  chmodSync(dir, 0o700);
  const credFile = join(dir, "process.json");
  const write = (kk: AwsSessionKeys, at: Date) => {
    // 쓰는 도중 SDK 가 읽어 반쪽 JSON 을 보지 않게: 임시 파일 → rename (같은 폴더라 원자적)
    const tmp = `${credFile}.tmp`;
    writeFileSync(tmp, processJson(kk, at), { mode: 0o600 });
    renameSync(tmp, credFile);
  };
  write(k, expiresAt);
  const config = join(dir, "config"), shared = join(dir, "credentials");
  // DRAFT(ai): cat 으로 파일을 돌려준다 (맥·리눅스 기본 명령, 새 의존성 없음). 경로는 mkdtemp 라 공백 없음
  // 경로에 공백·특수문자가 있으면(o.root 가 그런 곳일 때) 따옴표로 묶는다. 안전한 글자만이면 그대로 (모양 불변)
  const q = /^[A-Za-z0-9_./:@%+=-]+$/.test(credFile) ? credFile : `"${credFile.replace(/(["\\])/g, "\\$1")}"`;
  writeFileSync(config, `[default]\nregion = ${o.region}\ncredential_process = cat ${q}\n`, { mode: 0o600 });
  writeFileSync(shared, "", { mode: 0o600 });   // 맥의 ~/.aws/credentials 를 안 읽게 빈 파일
  return {
    dir,
    env: { AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: shared, AWS_SDK_LOAD_CONFIG: "1", AWS_REGION: o.region },
    update: write,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
