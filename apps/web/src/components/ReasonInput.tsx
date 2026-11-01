// 승인·거절·롤백·취소에 붙이는 사유 칸 (서버 한도 500자). 자리표시 글자만으로는 화면 낭독기가 이름을 못 읽어 aria-label 을 같이 단다
export function ReasonInput(p: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <input className="reason" placeholder="사유 (선택, 500자까지)" maxLength={500}
      aria-label={p.label ?? "사유 (선택)"} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  );
}
