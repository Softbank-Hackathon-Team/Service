// Azure는 실계정 없이 Mock 실행기로만 돈다 (CLAUDE.md §0-1). 화면 어디서든 같은 배지를 쓴다
export function MockBadge() {
  return <span className="chip mock" title="실제 Azure 호출 없음. 워커가 AZURE_MOCK=1 일 때 가짜 결과를 돌려준다">Mock</span>;
}
