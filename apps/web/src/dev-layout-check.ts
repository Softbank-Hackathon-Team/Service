// 개발 서버(npm run dev)에서만 불러온다. 운영 빌드에는 들어가지 않는다 (main.tsx).
// 지금 창 크기에서 레이아웃이 깨진 곳을 잰다. 브라우저 콘솔에서 __layoutCheck() 로 부른다.
// 크기별로 보려면 창을 1024×768, 1280×720, 1440×900, 1920×1080 으로 바꿔 가며 다시 부른다.

type LayoutProblem = { kind: '겹침' | '가로 넘침' | '버튼 화면 밖' | '쌓는 순서' | '대비'; detail: string };
type Box = { top: number; left: number; right: number; bottom: number };

const label = (el: Element) => (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24) || el.tagName.toLowerCase();

/** 스크롤 칸과 overflow 로 잘린 부분을 뺀, 실제로 보이는 사각형. 다 잘렸으면 null. */
function shownBox(el: Element): Box | null {
  const r = el.getBoundingClientRect();
  let box: Box = { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
    const style = getComputedStyle(up);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const c = up.getBoundingClientRect();
    box = { top: Math.max(box.top, c.top), left: Math.max(box.left, c.left), right: Math.min(box.right, c.right), bottom: Math.min(box.bottom, c.bottom) };
  }
  return box.right - box.left > 1 && box.bottom - box.top > 1 ? box : null;
}

const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

function rgb(color: string) {
  const [r = 0, g = 0, b = 0, a = 1] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return { r, g, b, a };
}
function luminance({ r, g, b }: { r: number; g: number; b: number }) {
  const [R, G, B] = [r, g, b].map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
}
function backgroundOf(el: Element | null) {
  for (let up = el; up; up = up.parentElement) {
    const color = rgb(getComputedStyle(up).backgroundColor);
    if (color.a > 0.5) return color;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

function layoutCheck(): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const main = document.querySelector('main');
  if (!main) return problems;
  const scroller = document.scrollingElement ?? document.documentElement;
  const keep = scroller.scrollTop;
  const narrow = window.innerWidth < 1200;
  // 색이 바뀌는 중에 재지 않도록 잴 동안 전환을 끈다
  const still = document.createElement('style');
  still.textContent = '*, *::before, *::after { transition: none !important; }';
  document.head.append(still);

  // 1. 겹침: 카드(section), 버튼, 행동 버튼 줄끼리 보이는 부분이 겹치면 안 된다. 좁은 화면은 버튼 줄이 화면 아래에 붙으므로 맨 아래로 내려서 잰다.
  if (narrow) scroller.scrollTop = scroller.scrollHeight;
  const blocks = [...main.querySelectorAll('section, button, [data-dock]')];
  const boxes = blocks.map((el) => ({ el, box: shownBox(el) })).filter((item): item is { el: Element; box: Box } => item.box !== null);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (overlapArea(a.box, b.box) > 4) problems.push({ kind: '겹침', detail: `${label(a.el)} ↔ ${label(b.el)}` });
    }
  }
  scroller.scrollTop = 0;

  // 2. 가로로 넘치면 안 된다.
  if (scroller.scrollWidth > window.innerWidth + 1) problems.push({ kind: '가로 넘침', detail: `${scroller.scrollWidth}px > ${window.innerWidth}px` });

  // 3. 처음 연 화면에서 행동 버튼이 화면 안에 있어야 한다.
  for (const button of main.querySelectorAll('[data-dock] button')) {
    const r = button.getBoundingClientRect();
    if (r.bottom > window.innerHeight + 1 || r.top < 0) problems.push({ kind: '버튼 화면 밖', detail: `${label(button)} (${Math.round(r.top)}~${Math.round(r.bottom)}, 창 ${window.innerHeight})` });
  }

  // 4. 좁은 화면에서는 진행 단계가 큰 카드 바로 다음에 와야 한다.
  const hero = main.querySelector('[style*="tile-hero"]');
  const steps = main.querySelector('[style*="tile-steps"]');
  if (narrow && hero && steps) {
    const heroBottom = hero.getBoundingClientRect().bottom;
    const stepsTop = steps.getBoundingClientRect().top;
    const between = [...main.querySelectorAll('section')].filter((el) => !hero.contains(el) && !steps.contains(el)).some((el) => {
      const top = el.getBoundingClientRect().top;
      return top > heroBottom && top < stepsTop;
    });
    if (stepsTop < heroBottom || between) problems.push({ kind: '쌓는 순서', detail: '진행 단계가 큰 카드 바로 다음에 있지 않습니다' });
  }

  // 5. 일반 크기 글자는 바탕과 4.5:1 이상. 누를 수 없는 버튼의 글자는 기준에서 뺀다(WCAG 1.4.3).
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || seen.has(el) || !node.textContent?.trim() || el.closest('[aria-hidden="true"], :disabled')) continue;
    seen.add(el);
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    if (large || style.visibility === 'hidden' || !shownBox(el)) continue;
    const fg = luminance(rgb(style.color));
    const bg = luminance(backgroundOf(el));
    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    if (ratio < 4.5) problems.push({ kind: '대비', detail: `${label(el)} ${ratio.toFixed(2)}:1 (${size}px)` });
  }

  scroller.scrollTop = keep;
  still.remove();
  const unique = new Map(problems.map((p) => [`${p.kind}|${p.detail}`, p]));
  return [...unique.values()];
}

(window as unknown as { __layoutCheck?: () => LayoutProblem[] }).__layoutCheck = () => {
  const problems = layoutCheck();
  console.info(`[화면 점검] ${window.innerWidth}×${window.innerHeight} ${window.location.hash || '#/'}: 문제 ${problems.length}건`);
  if (problems.length > 0) console.table(problems);
  return problems;
};

export {};
