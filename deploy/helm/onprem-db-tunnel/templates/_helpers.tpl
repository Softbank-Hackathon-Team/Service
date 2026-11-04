{{- define "dt.required" -}}
{{- if not .Values.relay.host }}{{ fail "relay.host 가 필요하다 (중계 EC2 공개 IP)" }}{{ end }}
{{- if not (regexMatch "^[A-Za-z0-9.-]+$" .Values.relay.host) }}{{ fail "relay.host 는 IP 또는 이름만" }}{{ end }}
{{- if not .Values.relay.knownHosts }}{{ fail "relay.knownHosts 가 필요하다 (중계 호스트 키 고정, 처음 보는 키는 거부)" }}{{ end }}
{{- if not (regexMatch "@sha256:[0-9a-f]{64}$" .Values.image) }}{{ fail "image 는 다이제스트(@sha256:...)로 고정해야 한다" }}{{ end }}
{{- if and (not .Values.forward.enabled) (not .Values.reverse.enabled) }}{{ fail "forward 와 reverse 중 하나는 켜야 한다" }}{{ end }}
{{- if and .Values.forward.enabled (not (regexMatch "^[A-Za-z0-9.-]+:5432$" (toString .Values.forward.target))) }}{{ fail "forward.target 은 \"<RDS 엔드포인트>:5432\"" }}{{ end }}
{{- if and .Values.reverse.enabled (not (regexMatch "^[A-Za-z0-9.-]+:5432$" (toString .Values.reverse.target))) }}{{ fail "reverse.target 은 \"<CNPG>-rw:5432\"" }}{{ end }}
{{- if and .Values.relay.cidr (not (regexMatch "^[0-9.]+/(2[4-9]|3[0-2])$" .Values.relay.cidr)) }}{{ fail "relay.cidr 는 IPv4 /24 보다 좁게" }}{{ end }}
{{- end -}}

{{- define "dt.labels" -}}
app.kubernetes.io/name: db-tunnel
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
