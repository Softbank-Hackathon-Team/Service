#!/bin/sh
# mask.sh — 결과·로그에서 계정 ID와 비밀값을 가린다. stdin → stdout (파일 쓰기·네트워크 없음)
# 사용: some-command 2>&1 | sh tools/real/mask.sh > <결과 폴더>/<이름>.md
#       sh tools/real/mask.sh < 원본 > 가린본
# DRAFT(ai): 규칙은 아래 목록이 전부. 가리는 쪽으로 틀리는 것이 안전하다 (놓치는 것보다 과하게 가리는 것이 낫다).
#   단 해시(sha256 등 순수 16진수)·UUID·IP·포트·시각·버전은 그대로 둔다 (검증에 필요).
#  1) PEM 블록(BEGIN…END) 통째로            → <pem-block>
#  2) kubeconfig *-data / token 값           → <redacted>
#  3) AWS 키 ID  AKIA/ASIA/AIDA/AROA/AGPA…   → <aws-key-id>
#  4) arn:…:<계정 12자리>:                   → 계정 자리만 <aws-account>
#  5) 12자리 숫자(AWS 계정·GCP 프로젝트 번호, 앞뒤가 숫자·점이 아니고 UUID 끝 칸이 아닐 때), 1234-5678-9012 모양 → <account-id>
#  6) 이메일                                 → <email>
#  7) JWT(eyJ….….…), Bearer 값, ya29. / AIza / ghp_ / xox 토큰 → <token>
#  8) KEY=값 / "key": "값" 꼴의 secret·token·password·passwd·api_key·access_key·session_token 값 → <redacted>
#  9) 40자 이상 base64 꼴(대소문자·숫자 섞임, 순수 16진수 아님) → <secret-like>
# 쓰임: REALRUN·MACIMPORT 등 맥 실측 결과를 <결과 폴더>/ 에 저장하기 전에 이 필터를 지난다.
# 의존: perl (macOS 기본 포함). 빈 입력이면 빈 출력, 종료 코드 0.
exec perl -0777 -pe '
  s/-----BEGIN [A-Z0-9 ]+-----.*?-----END [A-Z0-9 ]+-----/<pem-block>/gs;
  s/-----BEGIN [A-Z0-9 ]+-----[^\n]*(?:\n[A-Za-z0-9+\/=\s]*)?\z/<pem-block>/g;
  s/\b((?:certificate-authority-data|client-certificate-data|client-key-data|token|id-token|refresh-token|access-token|password)["\x27]?\s*:\s*)(?!<)(?:"[^"\n]*"|\x27[^\x27\n]*\x27|[^\s#]+)/$1<redacted>/gi;
  s/\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/<aws-key-id>/g;
  s/(arn:aws[a-z\-]*:[a-z0-9\-]*:[a-z0-9\-]*:)\d{12}(:)/$1<aws-account>$2/g;
  s/\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]*/<token>/g;
  s/\b(Bearer\s+)(?!<)[A-Za-z0-9._~+\/\-]{8,}=*/$1<token>/gi;
  s/\b(?:ya29\.[A-Za-z0-9_\-]{10,}|AIza[A-Za-z0-9_\-]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9\-]{10,})/<token>/g;
  s/\b([A-Za-z0-9_.\-]*(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|session[_-]?token|private[_-]?key)[A-Za-z0-9_.\-]*)(["\x27]?\s*[=:]\s*)(?!<)("[^"\n]*"|\x27[^\x27\n]*\x27|[^\s,;&"\x27}]+)/$1$2<redacted>/gi;
  s/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}\b/<email>/g;
  s/(?<![\d.\-])\d{4}-\d{4}-\d{4}(?![\d\-])/<account-id>/g;
  s/(?<![\d.])(?<![0-9a-fA-F]{4}-)\d{12}(?![\d.]?\d)/<account-id>/g;
  s{(?<![A-Za-z0-9+/=_\-])([A-Za-z0-9+/=_\-]{40,})(?![A-Za-z0-9+/=_\-])}{
    my $s = $1;
    ($s =~ /^[0-9a-fA-F]+$/ || $s !~ /[A-Z]/ || $s !~ /[a-z]/ || $s !~ /\d/) ? $s : "<secret-like>"
  }ge;
'
