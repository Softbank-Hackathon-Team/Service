{{- define "oa.required" -}}
{{- $_ := required "tenant 가 필요하다 (예: t-0a1b2c3d)" .Values.tenant -}}
{{- if not (regexMatch "^t-[0-9a-f]{8}$" .Values.tenant) -}}{{- fail "tenant 는 t-<16진수 8자> 모양이어야 한다 (워커 tenantSlug)" -}}{{- end -}}
{{- if and .Values.site (not (regexMatch "^[0-9a-f]{8}$" (toString .Values.site))) -}}{{- fail "site 는 환경 uuid 앞 16진수 8자여야 한다 (워커 siteOf)" -}}{{- end -}}
{{- $_ := required "gitops.repoURL 이 필요하다" .Values.gitops.repoURL -}}
{{- $_ := required "agent.reportURL 이 필요하다" .Values.agent.reportURL -}}
{{- if not (regexMatch "^https://" .Values.agent.reportURL) -}}{{- fail "agent.reportURL 은 https:// 이어야 한다 (보고는 밖으로 443)" -}}{{- end -}}
{{- if not (regexMatch "^[^@:]+(:[0-9]+)?/[^@]+@sha256:[0-9a-f]{64}$" .Values.agent.image) -}}{{- fail "agent.image 는 digest 고정(repo@sha256:<64자>)이어야 한다" -}}{{- end -}}
{{- end -}}

{{- define "oa.labels" -}}
app.kubernetes.io/name: onprem-agent
app.kubernetes.io/part-of: svc-onprem
svc.tenant: {{ .Values.tenant | quote }}
{{- end -}}
