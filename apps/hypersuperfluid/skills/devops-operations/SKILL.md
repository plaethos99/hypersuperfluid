---
name: devops-operations
description: Deploying, operating and debugging services - Docker, Kubernetes, CI/CD, Terraform, nginx, systemd, monitoring and incident response. Load before touching a server, a pipeline or production.
---

# DevOps operations

## Before changing anything

1. Name the environment. Run a command that proves which one you are on: `kubectl config current-context`, `terraform workspace show`, `hostname`, `aws sts get-caller-identity`. A wrong context is the most expensive mistake here, so check it again before every destructive command.
2. Read the current state before designing a change: running versions, recent deploys, open alerts, the last few minutes of logs.
3. Know how you will undo it, and write the rollback command down before running the change. A step with no rollback waits for a yes.
4. Production, shared infrastructure, DNS, firewall rules, secrets and anything billed wait for a yes. Staging or a local copy goes first when one exists.

## Incident response

Work in this order, and do not skip to the fix:

1. **Stop the bleeding first.** A rollback, a feature flag or more capacity beats a root cause found an hour later. Say what you did.
2. **Define the symptom with numbers:** what fails, for whom, since when. Compare against the last known good time.
3. **Ask what changed:** deploys, configuration, certificates, dependencies, traffic, disk. Most incidents begin with a change.
4. **Follow the request path layer by layer:** DNS, load balancer, ingress, service, pod or process, database. Test each hop directly with `curl -v`, `dig` and `nc -vz`, because each test splits the search space in half.
5. **Keep a timeline** with exact commands and outputs. It becomes the report.

Check first, because they cause a large share of outages: full disks (`df -h`, `df -i`), expired certificates (`openssl s_client -connect host:443 | openssl x509 -noout -dates`), OOM kills (`dmesg -T | grep -i oom`), exhausted connection pools, clock drift, and DNS.

## Docker

- `docker logs --tail 100 <c>`, `docker inspect <c>` and `docker stats --no-stream` before any guess. `docker compose config` shows the merged configuration that actually runs.
- Exit code 137 is usually an OOM kill and 143 is SIGTERM. Check `docker inspect -f '{{.State.OOMKilled}}' <c>`.
- Pin base images by digest in production. Multi-stage builds keep toolchains out of the final image. Order the Dockerfile so that dependency installation is cached before source is copied.
- Never bake a secret into an image: it stays in the layers even if a later step removes it.

## Kubernetes

- Diagnose with `kubectl describe pod`, `kubectl logs --previous`, and `kubectl get events --sort-by=.lastTimestamp`.
- `CrashLoopBackOff`: read `--previous` logs. `ImagePullBackOff`: name, tag or registry credentials. `Pending`: `describe` shows the unmet resource or affinity. `OOMKilled`: raise the limit or fix the leak, after looking at actual usage.
- Roll out with `kubectl rollout status`, and undo with `kubectl rollout undo`. Use `kubectl diff -f` before `apply`.
- A Service with no endpoints means its selector matches no ready pod: compare `kubectl get endpoints` and the pod labels.

## CI/CD

- Reproduce a failing job locally with the same image and commands before changing the pipeline.
- Read the first error in the log, not the last. Later errors are usually consequences.
- Pin action and image versions to a digest or commit. Keep secrets in the platform's secret store, scoped to the environment that needs them.
- A flaky test is a bug. Quarantine it visibly; do not add blind retries.

## Infrastructure as code

- `terraform plan -out=plan.tfplan`, read every `destroy` and `replace`, then `terraform apply plan.tfplan`. Never apply a plan you did not read.
- Never hand-edit state. Use `terraform state mv`, `terraform import` or `moved` blocks. Treat drift as a finding to report before overwriting it.
- Remote state with locking. State files contain secrets, so never commit them.

## Pitfalls

- Restarting a broken service before capturing logs destroys the evidence: capture first.
- `kubectl delete` and `docker system prune` have no undo. Name exactly what they will remove before running them.
- A green deploy is not a working service. Check a real request and the error rate after deploying.
- Changing two things at once leaves you unable to say which one fixed or broke it.

## Verification

Finish with evidence: the real request that now succeeds, the metric that recovered, and the version now running. Name anything you could not verify.
