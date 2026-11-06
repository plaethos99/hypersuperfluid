---
name: mlops
description: MLOps - reproducible training pipelines, experiment tracking (MLflow, Weights & Biases), model registry, evaluation, packaging and serving (FastAPI, BentoML, KServe, Triton), and monitoring for drift. Load before training, evaluating, deploying or monitoring a model.
---

# MLOps

## Reproducibility first

Every training run records: the data version (a DVC or lakeFS hash, a table snapshot, or a file hash), the code commit, the environment (lock file or image digest), random seeds, all parameters, and the resulting metrics and artifacts. A model nobody can rebuild is a liability.

- Track with MLflow or Weights & Biases when the project uses one; otherwise write a `run.json` beside the artifacts.
- Pin dependencies, CUDA and driver versions in the image.
- Split data once, deterministically, and keep the test set untouched until the final evaluation.

## Data and features

- Check for leakage: features computed with information from after the prediction time, target-derived features, and duplicates across splits.
- Training and serving must compute features the same way: one shared function or a feature store, not two implementations.
- Validate inputs with a schema (Great Expectations, pandera, or plain assertions): types, ranges, null rates, category sets.

## Training

- Start with a simple baseline (a heuristic, logistic regression, gradient boosting) and beat it before adding complexity.
- Cross-validate when data is small; use time-based splits for anything temporal.
- Log learning curves; stop early on a validation metric.
- Estimate cost before large runs: GPU type, hours and money. Starting costly training or provisioning GPUs waits for a yes, with that estimate stated.

## Evaluation and promotion

- Compare candidate and current model on the same held-out data with the metric that matches the business cost, and with confidence intervals or a significance test.
- Check slices: performance by segment, region, device and other groups, to catch regressions hidden in the average and unfair behaviour.
- Calibrate probabilities when they drive decisions.
- Promotion through the registry with stages (staging, production) and a recorded reason. Promoting to production waits for a yes. Keep the previous version ready for rollback.

## Packaging and serving

- Package the model with its preprocessing; version the API.
- Serve with the project's stack (FastAPI, BentoML, KServe, Triton, SageMaker, Vertex AI). Set resource limits and timeouts, and batch requests where throughput matters.
- Roll out gradually: shadow, then canary, then full, with automatic rollback on error-rate or latency breaches.
- Load-test p95 and p99 latency and memory before production.

## Monitoring

- Operational: latency, errors, throughput, resource use.
- Data drift: compare live input distributions with training (population stability index, Kolmogorov-Smirnov, chi-square) per feature, with thresholds chosen in advance.
- Prediction drift, and model quality once labels arrive.
- Alert on sustained drift, not single points; retraining is a decision, not an automatic reflex, unless the person set up an approved policy.

## LLM applications

Version prompts and model ids like code; keep an evaluation set with expected behaviours and run it on every change; track cost and latency per request; log inputs and outputs only within the data policy, with personal data redacted.

## Pitfalls

- Reporting accuracy on imbalanced data: use precision, recall, PR-AUC or a cost-weighted metric.
- Tuning on the test set.
- A notebook-only pipeline: move it into scripts or a pipeline tool with fixed inputs.
- Deleting runs, artifacts or registry versions: wait for a yes.

## Verification

Report the run id, data and code versions, metrics with intervals against the baseline and the current model, slice results, and the command to reproduce training and evaluation.
