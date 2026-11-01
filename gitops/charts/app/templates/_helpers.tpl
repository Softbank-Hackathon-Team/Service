{{- define "app.labels" -}}
app.kubernetes.io/name: {{ .Values.app.name }}
{{- range $k, $v := .Values.labels }}
{{ $k }}: {{ $v | quote }}
{{- end }}
{{- end }}
