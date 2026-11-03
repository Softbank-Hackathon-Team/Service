{{- define "app.labels" -}}
app.kubernetes.io/name: {{ .Values.app.name }}
{{- range $k, $v := .Values.labels }}
{{ $k }}: {{ $v | quote }}
{{- end }}
{{- end }}

{{- /* A4 workloads[]: 워크로드 하나의 라벨 (공통 라벨 + 이름 구분). 선택자는 name+component 두 개 */}}
{{- define "app.wlabels" -}}
{{ include "app.labels" .root }}
app.kubernetes.io/component: {{ .w.name | quote }}
{{- end }}

{{- /* A4·PB-1: 파드 모양 (Deployment·Job·CronJob 공통). 입력 dict: root, w, restart(Job 류만).
       값이 없는 칸은 키 자체를 안 그린다 (프로브·requests 기본값을 지어내지 않음, 재현성) */}}
{{- define "app.wpod" -}}
{{- $w := .w }}
{{- $sa := $w.serviceAccount | default dict }}
{{- $sec := $w.securityContext | default dict }}
{{- $vols := list }}
{{- $mounts := list }}
{{- range $w.configs }}
{{- $vols = append $vols (dict "name" (printf "cfg-%s" .name) "configMap" (dict "name" .name)) }}
{{- $mounts = append $mounts (dict "name" (printf "cfg-%s" .name) "mountPath" .mountPath "readOnly" true) }}
{{- end }}
{{- range $w.secretMounts }}
{{- $vols = append $vols (dict "name" (printf "sec-%s" .name) "secret" (dict "secretName" .secretName)) }}
{{- $mounts = append $mounts (dict "name" (printf "sec-%s" .name) "mountPath" .mountPath "readOnly" true) }}
{{- end }}
{{- range $w.pvcs }}
{{- $vols = append $vols (dict "name" (printf "pvc-%s" .name) "persistentVolumeClaim" (dict "claimName" (printf "%s-%s" $w.name .name))) }}
{{- $mounts = append $mounts (dict "name" (printf "pvc-%s" .name) "mountPath" .mountPath) }}
{{- end }}
{{- range $w.volumes }}{{- $vols = append $vols . }}{{- end }}
{{- range $w.volumeMounts }}{{- $mounts = append $mounts . }}{{- end }}
{{- with $sa.name }}
serviceAccountName: {{ . }}
{{- end }}
{{- with .restart }}
restartPolicy: {{ . }}
{{- end }}
{{- with $sec.pod }}
securityContext: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $w.initContainers }}
initContainers: {{- toYaml . | nindent 2 }}
{{- end }}
containers:
  - name: {{ $w.container | default "app" }}
    image: {{ $w.image | quote }}
    {{- with $w.command }}
    command: {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with $w.args }}
    args: {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with $w.ports }}
    ports:
      {{- range . }}
      - containerPort: {{ .containerPort }}
        {{- with .name }}
        name: {{ . }}
        {{- end }}
        {{- with .protocol }}
        protocol: {{ . }}
        {{- end }}
      {{- end }}
    {{- end }}
    {{- with $w.env }}
    env: {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with $w.envFrom }}
    envFrom: {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with $w.resources }}
    resources: {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with ($w.probes | default dict).readiness }}
    readinessProbe: {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with ($w.probes | default dict).liveness }}
    livenessProbe: {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with ($w.probes | default dict).startup }}
    startupProbe: {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with $sec.container }}
    securityContext: {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- if $mounts }}
    volumeMounts: {{- toYaml $mounts | nindent 6 }}
    {{- end }}
  {{- range $w.sidecars }}
  - {{- toYaml . | nindent 4 }}
  {{- end }}
{{- if $vols }}
volumes: {{- toYaml $vols | nindent 2 }}
{{- end }}
{{- end }}
