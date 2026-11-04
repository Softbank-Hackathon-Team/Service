/** 긴 값의 가운데를 줄여 max 글자 안에 넣는다. 지문·이미지는 앞뒤가 남아야 서로 견줄 수 있다. */
export function middleEllipsis(value: string, max: number) {
  if (value.length <= max) return value;
  const keep = Math.max(max - 1, 2);
  const head = Math.ceil(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`;
}

/** 지난 시간을 짧게: "방금", "3분 전", "2시간 전", "1일 전". 시각이 없으면 "기록 없음". */
export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return '기록 없음';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return '방금';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  return seconds < 86400 ? `${Math.floor(seconds / 3600)}시간 전` : `${Math.floor(seconds / 86400)}일 전`;
}
