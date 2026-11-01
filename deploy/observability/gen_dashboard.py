import json, sys
DS = {"type": "prometheus", "uid": "prometheus"}
pid = [0]
def panel(kind, title, exprs, x, y, w, h, unit=None, thresholds=None, desc=None, legend=None, opts=None):
    pid[0] += 1
    p = {"id": pid[0], "type": kind, "title": title, "datasource": DS,
         "gridPos": {"x": x, "y": y, "w": w, "h": h},
         "targets": [{"refId": chr(65+i), "datasource": DS, "expr": e, "legendFormat": l}
                     for i, (e, l) in enumerate(exprs)],
         "fieldConfig": {"defaults": {}, "overrides": []}, "options": opts or {}}
    if unit: p["fieldConfig"]["defaults"]["unit"] = unit
    if thresholds:
        p["fieldConfig"]["defaults"]["thresholds"] = {"mode": "absolute", "steps":
            [{"color": c, "value": v} for c, v in thresholds]}
        p["fieldConfig"]["defaults"]["color"] = {"mode": "thresholds"}
    if desc: p["description"] = desc
    return p
ACTIVE = 'status!~"completed|rolled_back|cancelled|rejected|stale|draft"'
panels = [
  panel("stat", "진행 중 이전", [(f'sum(svc_migrations{{{ACTIVE}}})', "")], 0, 0, 4, 4,
        thresholds=[("green", None)], desc="끝 상태·draft 를 뺀 이전 수"),
  panel("stat", "실패·일시정지", [('sum(svc_migrations{status=~"failed|paused"})', "")], 4, 0, 4, 4,
        thresholds=[("green", None), ("red", 1)]),
  panel("stat", "마지막 컷오버 멈춤", [("svc_cutover_pause_last_ms", "")], 8, 0, 4, 4, unit="ms",
        thresholds=[("green", None), ("orange", 1000), ("red", 2000)], desc="목표 1초 이하"),
  panel("stat", "생존 신호 지연(최대)", [("max(svc_lease_heartbeat_lag_seconds)", "")], 12, 0, 4, 4, unit="s",
        thresholds=[("green", None), ("orange", 30), ("red", 60)],
        desc="워커가 쥔 환경 잠금의 마지막 연장 뒤 경과. 30초마다 연장, 60초면 워커가 스스로 멈춘다"),
  panel("stat", "큐 대기", [('sum(svc_queue_jobs{state=~"created|retry"})', "")], 16, 0, 4, 4,
        thresholds=[("green", None), ("orange", 5)]),
  panel("stat", "큐 실패(보관 중)", [('sum(svc_queue_jobs{state="failed"})', "")], 20, 0, 4, 4,
        thresholds=[("green", None), ("red", 1)]),
  panel("bargauge", "상태별 이전 수", [("svc_migrations > 0", "{{status}}")], 0, 4, 12, 8,
        opts={"orientation": "horizontal", "displayMode": "basic"}),
  panel("bargauge", "상태별 평균 머문 시간", [(
        "svc_migration_state_duration_seconds_sum / svc_migration_state_duration_seconds_count", "{{state}}")],
        12, 4, 12, 8, unit="s", opts={"orientation": "horizontal", "displayMode": "basic"},
        desc="감사 기록 누적 기준. 데모 STUB 은 0.2~0.9초, 실제 Terraform 은 수 분"),
  panel("timeseries", "상태 이동 (5분)", [("sum by (to) (increase(svc_migration_transitions_total[5m]))", "→ {{to}}")],
        0, 12, 12, 8),
  panel("timeseries", "큐 대기·가장 오래 기다린 작업",
        [('sum by (queue) (svc_queue_jobs{state=~"created|retry"})', "대기 {{queue}}"),
         ("max by (queue) (svc_queue_oldest_waiting_seconds) > 0", "최장 대기(s) {{queue}}")], 12, 12, 12, 8),
  panel("timeseries", "워커 작업 시간 p95", [(
        "histogram_quantile(0.95, sum by (le, queue) (rate(svc_job_duration_seconds_bucket[5m])))", "{{queue}}")],
        0, 20, 12, 8, unit="s"),
  panel("timeseries", "워커 작업 결과 (5분)", [("sum by (queue, result) (increase(svc_job_runs_total[5m]))",
        "{{queue}} {{result}}")], 12, 20, 12, 8),
  panel("timeseries", "API 응답 p95", [(
        "histogram_quantile(0.95, sum by (le, route) (rate(svc_http_request_duration_seconds_bucket[5m])))",
        "{{route}}")], 0, 28, 12, 8, unit="s"),
  panel("timeseries", "API 5xx (5분)", [('sum by (route) (increase(svc_http_requests_total{status=~"5.."}[5m]))',
        "{{route}}")], 12, 28, 12, 8),
]
dash = {"uid": "svc-migrations", "title": "이전 관측 (Service)", "tags": ["service", "DRAFT(ai)"],
        "timezone": "browser", "schemaVersion": 39, "version": 1, "refresh": "10s",
        "time": {"from": "now-30m", "to": "now"}, "panels": panels, "templating": {"list": []},
        "annotations": {"list": []}, "editable": True}
json.dump(dash, open(sys.argv[1], "w"), ensure_ascii=False, indent=2)
print(len(panels))
