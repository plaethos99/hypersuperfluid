---
name: aiops
description: AI for IT operations - log and metric analysis, anomaly detection, alert noise reduction, incident correlation, root-cause hypotheses and runbook automation with Prometheus, Grafana, ELK, Loki, Datadog and similar. Load before analysing telemetry or automating operations.
---

# AIOps

## Ground everything in telemetry

1. Establish the time window, the affected service and the symptom with numbers (error rate, latency percentile, saturation), and a baseline period to compare against (same hour last week, before the deploy).
2. Pull the data yourself: PromQL, LogQL, Elasticsearch or OpenSearch queries, Datadog or CloudWatch queries, `kubectl logs`, `journalctl`. Quote the queries and the lines or series you base a finding on.
3. State each finding with its evidence, a confidence level, and what would confirm or refute it.

## Logs

- Reduce volume before reading: group by message template (strip ids, numbers and timestamps), count per template per minute, and compare the incident window with the baseline. New templates and templates whose rate jumped are the leads.
- Follow one request across services by its trace or correlation id.
- Distinguish the first error from the cascade it caused: sort by time and find the earliest anomaly.

## Metrics and anomaly detection

- Golden signals per service: latency, traffic, errors, saturation (USE for resources: utilization, saturation, errors).
- Simple methods first and explainable: rolling z-score or median absolute deviation against a seasonal baseline (same weekday and hour), percent change from the baseline, rate of change. Use heavier models (Prophet, isolation forest) only when the simple ones demonstrably miss.
- Account for seasonality, deploys and known events before calling something anomalous.
- Report the size of the deviation and how often similar deviations happened without an incident.

## Correlation and root cause

- Build a timeline: deploys, configuration changes, feature flags, certificate expiries, scaling events, dependency incidents, and the first anomaly in each signal.
- Correlation is a lead, not a cause. A cause needs a mechanism and, ideally, a test: roll back, toggle the flag, or reproduce in staging.
- Use topology: an anomaly in a shared dependency (database, DNS, queue, identity provider) explains many downstream alerts at once.

## Alert quality

- Alert on symptoms users feel (SLO burn rates over two windows, such as 1 hour and 6 hours), not on every cause.
- Measure noise: alerts per week, the share closed without action, and duplicates. Deduplicate and group by service and incident; route by ownership; add runbook links to every alert.
- Every change to alerting states the expected effect and is reviewed after a week.

## Runbook automation

1. Write the runbook as explicit steps with preconditions, checks and a rollback.
2. Automate in stages: suggest only, then dry run that prints the actions, then act with approval, then act on its own for a narrow, well-tested case.
3. Guardrails: rate limits, blast-radius limits (one node, one pod at a time), a kill switch, and a log of every automated action.
4. Restarting, scaling, failing over or changing configuration in production waits for a yes unless the person has approved that exact runbook for automatic use.

## Pitfalls

- Treating a detector's output as truth without looking at the raw series.
- Thresholds tuned on an incident week.
- Sampling that drops the rare errors that matter.
- Feeding secrets or personal data from logs into prompts or reports: redact them.

## Verification

Deliver a short report: the symptom with numbers, the timeline, the most likely cause with evidence and confidence, alternatives ruled out and how, and the queries to reproduce every chart or count.
