---
name: software-testing
description: Planning and writing tests - unit, integration, end-to-end, API, performance, security and exploratory - plus flaky-test diagnosis and bug reports. Load before writing or fixing tests or assessing quality.
---

# Software testing

## Start from risk

1. Read the requirement, the change or the code under test, and its existing tests.
2. List what could break, who it would hurt, and how likely it is. Test the expensive failures first.
3. Choose the cheapest level that can catch each risk: a pure function gets unit tests; a database query gets an integration test against a real engine; a user journey gets one end-to-end test, not twenty.

## Designing cases

- **Equivalence classes and boundaries:** empty, one, many, maximum, just over the maximum; zero, negative, very large; first and last day of a month, leap day, time zones and DST changes.
- **Error paths:** invalid input, missing files, timeouts, permission denied, network failure, partial failure in the middle of a batch.
- **State transitions:** every allowed transition once, and the forbidden ones refused.
- **Concurrency:** two writers, retry after a crash, the same request twice (idempotency).
- **Data:** Unicode, very long strings, quotes and SQL or HTML metacharacters, nulls.

Name each test for the behaviour it pins, such as `refunds_the_full_amount_when_cancelled_within_24h`, not `test_refund_2`.

## Writing tests

- Use the project's framework and conventions: read a neighbouring test first.
- Arrange, act, assert, with one behaviour per test. Assert outcomes, not implementation details.
- Prefer real collaborators over mocks inside your own code; mock only at slow or external boundaries (network, clock, payment gateway). A test full of mocks proves the mocks.
- Make tests deterministic: inject the clock, seed randomness, wait for conditions instead of sleeping, and keep tests independent of order.
- **Prove the test can fail.** Break the code (or check out the commit before the fix) and watch it fail for the right reason. A test that never failed proves nothing.

## By level

- **Unit:** fast and isolated, run on every change.
- **Integration:** real database or service in a container (Testcontainers, docker compose); reset state between tests.
- **End-to-end (Playwright, Cypress, Selenium):** stable selectors (roles, labels, test ids), never sleeps; cover the critical journeys only.
- **API:** status codes, schema, error bodies, authentication and authorization (one user cannot read another's data), pagination, rate limits.
- **Performance (k6, JMeter, Locust):** define the target first (p95 latency at N requests per second), warm up, run long enough, and report percentiles, not averages.
- **Security basics:** injection, broken access control, secrets in logs, dependency vulnerabilities (`npm audit`, `pip-audit`, `trivy`).

## Flaky tests

1. Reproduce: run it in a loop (`--repeat`, `pytest --count`, `for i in $(seq 50)`), and in a different order.
2. Usual causes: shared state between tests, real time and sleeps, async work not awaited, test order, network, resource limits in CI.
3. Fix the cause. Quarantine visibly with an issue link if a fix must wait; never paper over it with retries.

## Bug reports

Title with the symptom and where; exact steps from a clean state; expected and actual results; environment (version, OS, browser, data); evidence (log lines, screenshot, failing test); severity and how often it happens. One bug per report.

## Coverage

Coverage shows what is not tested, not what is tested well. Look at uncovered branches in risky code; do not chase a percentage with assertion-free tests.

## Pitfalls

- Weakening an assertion or deleting a test to make a build pass.
- Asserting on log text or private internals that change with every refactor.
- Snapshot tests nobody reads: review each snapshot change.
- Testing against production data or services by accident: check the configuration first.

## Verification

Report what you tested, at which level, the command to run it, the result, and that each new test was seen failing before it passed. Name the risks left untested.
