# Third-party notices

This package adapts code and text from the projects below. Their full license texts are in [licenses/](licenses/).

## Harness²

- **Source:** the `harness2` folder of this workspace, Copyright 2026 Google LLC.
- **License:** Apache-2.0, [licenses/harness2-LICENSE.txt](licenses/harness2-LICENSE.txt).
- **Used in:** `src/recursion/engine.ts`, `src/recursion/library.ts`, `src/recursion/prompts.ts`, `src/recursion/tree.ts`.
- **Changes:** rewritten from Python to TypeScript. The recursion schedule (4k rollouts, 3k stages), the retry rule, the per-domain library and the mission text follow the original. Benchmarks, grading and the OpenCode and Codex substrates were removed; rollouts run as DeepSeek Harness child sessions in isolated workspace copies. The editable surface is reduced to `AGENTS.md`, skills and scripts, so subagents and plugins cannot be edited by a candidate. Mission text was shortened and its benchmark and grader wording removed.

## Hermes Agent

- **Source:** the `hermes-agent` folder of this workspace, Copyright Nous Research.
- **License:** MIT, [licenses/hermes-agent-LICENSE.txt](licenses/hermes-agent-LICENSE.txt).
- **Used in:** `src/learning/` (memory limits and routing, skill layout and read-before-write guard, curator lifecycle rules, review prompts).
- **Changes:** rewritten from Python to TypeScript for DeepSeek Harness plugin interfaces. Review prompts were shortened and their tool names changed.

## DeepSeek Harness superagent

- **Source:** the `dsh-superagent-prototype` folder of this workspace, Copyright DeepSeek Harness Team.
- **License:** MIT, [licenses/superagent-LICENSE.txt](licenses/superagent-LICENSE.txt).
- **Used in:** `optional/superagent-dsh-0.2.2.patch` updates it for interfaces this DSH version removed; none of its code ships in this package. The persona in `cordis.patch.yml` follows its attention principles.

## Odoo agent (Superfluid)

- **Source:** `oodo-agent` and `superfluid`, in the Downloads folder next to this workspace.
- **License:** MIT, according to the `oodo-agent` README.
- **Used in:** `erp/` (the ERP server), `skills/erp-*` and `skills/odoo-*`, `src/gate.js`, `src/pace.js`.
- **Changes:** plugin names changed. Task pace now leaves a request alone when its route proposes no reasoning effort, so custom endpoints do not fail on an unmapped value.

The bundled ERP knowledge skills name vendors' products for identification only.

## CareerOps

- **Source:** [career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops), the `career-ops` folder of this workspace, Copyright 2026 Santiago Fernández de Valderrama.
- **License:** MIT, [licenses/career-ops-LICENSE.txt](licenses/career-ops-LICENSE.txt).
- **Used in:** the career mode runs it unchanged from its own folder through its `career-ops` skill; `src/career.ts` only finds the install and reports its state. The portable build copies its tracked system files, never a person's data.

## Bundled dependencies

| Package | License | Used for |
|---|---|---|
| `firecrawl-mcp` 3.33.4 | MIT | Firecrawl web research tools |
| `@viz-js/viz` 3.31.0 | MIT; it compiles [Graphviz](https://graphviz.org), which is under the Eclipse Public License 1.0 | Rendering DOT diagrams |
| `@resvg/resvg-wasm` 2.6.2 | MPL-2.0, used unmodified | Rendering SVG to PNG |
