import type { PermissionGap } from '../../lib/types';

// PERM-GATE 화면 모델 (CSS 없이 시험할 수 있게 따로)
/** 고객 링크로 고쳐지는 묶음 = 빠진 권한·API 가 있는 것 (권한표에 없는 권한만 있는 묶음·확인 못 한 묶음은 뺀다) */
export const fixableGaps = (gaps: PermissionGap[]) => gaps.filter((g) => g.missing.length > 0 || g.missingApis.length > 0);
