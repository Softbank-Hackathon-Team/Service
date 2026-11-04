import { CliError, classifyCliError, sourceFail } from "./cli.js";
import { AdapterError } from "./errors.js";

// RF-1 DRAFT(ai): "못 읽음"은 "없음"이 아니다. discover 가 읽기 실패를 삼키던 자리(데이터 자원 목록·ECS·Cloud Run·VM 갈래·버킷 칸 등)는
//   ① 일시 오류(스로틀링·시간 초과)면 SOURCE_TRANSIENT 로 던져 워커가 다시 가져오게 하고
//   ② 거부·그 밖의 오류면 "그 종류 못 읽음" 원본 줄(import.unread)을 남겨 파이프라인이 검토 줄(fieldMeta check.unread.<what>, 신뢰도 0.6)로 올린다.
//   예전엔 둘 다 notes(환경 종류, 명세 판단에서 빠짐)만 남아 "없음"과 구별이 안 됐다.
//   DB 목록처럼 핵심인 것은 이 길을 안 쓰고 sourceFail 로 멈춘다 (discover/index.ts).

export const UNREAD_KIND = "import.unread";
/** 못 읽은 종류 한 줄. what = 검토 키 꼬리(점·영숫자·- 만), reason = 사람이 읽는 이유 (비밀값 없음, CliError 문구는 계정 번호 가림) */
export type RawUnread = { kind: typeof UNREAD_KIND; what: string; reason: string };

const keyOf = (what: string) => what.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "unknown";
export const unreadItem = (what: string, reason: string): RawUnread => ({ kind: UNREAD_KIND, what: keyOf(what), reason: reason.slice(0, 300) });

/** 읽기 실패 e 를 가른다: 일시 오류면 던지고(재시도), 아니면 못 읽음 줄을 돌려준다 */
export function unreadOrThrow(e: unknown, what: string, label: string): RawUnread {
  if (e instanceof AdapterError && e.code === "SOURCE_TRANSIENT") throw e;
  if (e instanceof CliError && classifyCliError(e) === "transient") throw sourceFail(e, `${label} (${e.message.slice(0, 160)})`);
  return unreadItem(what, `${label} 못 읽음: ${(e as Error)?.message?.slice(0, 200) ?? String(e)}`);
}

// K-1 DRAFT(ai): 출발 범위를 안 정해 여러 개 중 자동으로 고른 것(클러스터·네임스페이스·ECS 클러스터) → 검토 줄(check.pick.<what>).
//   이전마다 범위(SourceScope)를 정하면 생기지 않는다. 예전엔 notes(환경 종류)에만 남아 사람이 모른 채 엉뚱한 클러스터를 옮길 수 있었다
export const PICK_KIND = "import.pick";
export type RawPick = { kind: typeof PICK_KIND; what: string; reason: string };
export const pickItem = (what: string, reason: string): RawPick => ({ kind: PICK_KIND, what: keyOf(what), reason: reason.slice(0, 300) });
