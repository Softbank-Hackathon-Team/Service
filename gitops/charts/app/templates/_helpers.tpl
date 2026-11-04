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

{{- /* CV-1: 파드 템플릿 metadata (라벨 + 허용 목록 annotation). 입력 dict: root, w */}}
{{- define "app.wpodmeta" -}}
{{- /* PL-2: 출발 파드 라벨 + 플랫폼 라벨 (겹치면 플랫폼 우선 = selector 가 깨지지 않게) */}}
{{- $pl := include "app.wlabels" (dict "root" .root "w" .w) | fromYaml }}
labels: {{- toYaml (merge $pl (.w.podLabels | default dict)) | nindent 2 }}
{{- with .w.podAnnotations }}
annotations: {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}
{{- /* A4·PB-1: 파드 모양 (Deployment·Job·CronJob 공통). 입력 dict: root, w, restart(Job 류만).
       값이 없는 칸은 키 자체를 안 그린다 (프로브·requests 기본값을 지어내지 않음, 재현성) */}}
{{- define "app.wpod" -}}
{{- $w := .w }}
{{- $sa := $w.serviceAccount | default dict }}
{{- $sec := $w.securityContext | default dict }}
{{- $vols := list }}
{{- $mounts := list }}
{{- /* CM-2: env·envFrom 으로만 쓰는 ConfigMap(mountPath 없음)은 객체만 있고 마운트하지 않는다.
       CM-3: 마운트 원문(volumes·volumeMounts)이 있으면 Builder 가 mountPath 를 안 넣어 두 번 마운트하지 않음 */}}
{{- range $w.configs }}
{{- if .mountPath }}
{{- $vols = append $vols (dict "name" (printf "cfg-%s" .name) "configMap" (dict "name" .name)) }}
{{- $mounts = append $mounts (dict "name" (printf "cfg-%s" .name) "mountPath" .mountPath "readOnly" true) }}
{{- end }}
{{- end }}
{{- range $w.secretMounts }}
{{- $vols = append $vols (dict "name" (printf "sec-%s" .name) "secret" (dict "secretName" .secretName)) }}
{{- $mounts = append $mounts (dict "name" (printf "sec-%s" .name) "mountPath" .mountPath "readOnly" true) }}
{{- end }}
{{- range $w.pvcs }}
{{- if .mountPath }}
{{- if .claimTemplate }}
{{- /* D6: volumeClaimTemplates 이름 그대로 마운트 (볼륨 칸 없음, StatefulSet 이 파드마다 붙임) */}}
{{- $mounts = append $mounts (dict "name" .name "mountPath" .mountPath) }}
{{- else }}
{{- $vols = append $vols (dict "name" (printf "pvc-%s" .name) "persistentVolumeClaim" (dict "claimName" (printf "%s-%s" $w.name .name))) }}
{{- $mounts = append $mounts (dict "name" (printf "pvc-%s" .name) "mountPath" .mountPath) }}
{{- end }}
{{- end }}
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
{{- /* CV-1: 노드 공유(hostNetwork·hostPID·hostIPC, host_access 승인 뒤)·배치 원문 그대로 */}}
{{- $host := $w.host | default dict }}
{{- if $host.network }}
hostNetwork: true
{{- end }}
{{- if $host.pid }}
hostPID: true
{{- end }}
{{- if $host.ipc }}
hostIPC: true
{{- end }}
{{- $sch := $w.scheduling | default dict }}
{{- with $sch.nodeSelector }}
nodeSelector: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $sch.tolerations }}
tolerations: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $sch.affinity }}
affinity: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $sch.topologySpreadConstraints }}
topologySpreadConstraints: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $sch.priorityClassName }}
priorityClassName: {{ . }}
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
        {{- with .hostPort }}
        hostPort: {{ . }}
        {{- end }}
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
