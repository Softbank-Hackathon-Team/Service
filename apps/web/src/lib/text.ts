/** 긴 값의 가운데를 줄여 max 글자 안에 넣는다. 지문·이미지는 앞뒤가 남아야 서로 견줄 수 있다. */
export function middleEllipsis(value: string, max: number) {
  if (value.length <= max) return value;
  const keep = Math.max(max - 1, 2);
  const head = Math.ceil(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`;
}
