---
name: repo-builder
description: Taking any codebase from a GitHub link, a downloaded zip or a folder to installed, configured, building, tested and running on this computer, fixing the errors in the codebase on the way, then building on it when asked. Load at the start of any "set up / run / implement this repo" task.
---

# Repo builder

The person hands you a codebase and wants it working, with as little of their effort as possible. Decide instead of asking, verify by running, and report once at the end.

## 1. Find the codebase

In this order, without asking:

1. A git link, an `@folder` or a path in the message. The side panel note lists what the message points at.
2. The working folder, when it is already a codebase (the side panel note says what kind).
3. `repo_find`, for what they downloaded recently ("the repo I just downloaded"). Take the newest match that fits their words; say which one you took.

Then call `repo_fetch` with it. It clones, unpacks, or copies the codebase into the working folder, and makes that copy the working folder. It also returns a survey: kind, commands, settings names, Docker, subprojects and the README's setup section. Work on the copy. Never change the person's original download.

## 2. Plan from the survey and the docs

- Read the README setup section, then CONTRIBUTING, AGENTS.md or CLAUDE.md, the CI workflow (`.github/workflows/*.yml` shows the exact install, build and test commands), and the Dockerfile.
- Find the required runtime versions: `.nvmrc`, `.python-version`, `engines`, `requires-python`, `go.mod`, `rust-toolchain`.
- Check which tools are installed (`node -v`, `python --version`, `git --version`, `docker --version`).
- Write the plan in the todo list: install, configure, build, test, run, verify.

## 3. Install, into the project only

- Node: use the package manager the lock file names (pnpm, yarn, bun or npm). Install with its frozen or ci mode first; fall back to a plain install only if the lock file is broken, and say so.
- Python: make `.venv` in the project and install into it (`uv sync`, `poetry install`, or `pip install -r requirements.txt`, or `-e .`). Never install with the system pip.
- Other stacks: use the survey's commands.
- A missing runtime or system tool (Node, Python, Docker, a C compiler) is the one install that needs the person's yes. Name the exact thing and the official installer.
- Long installs and servers run as background jobs. Do not block on them.

## 4. Configure

- Copy the example settings (`.env.example` and similar) to `.env` when there is none. Keep the example's non-secret defaults, and leave keys, tokens and passwords empty.
- Never ask for, print or write a secret's value. At the end, list the names the person must fill and what each is for (from the README or the code).
- Choose local defaults that need nothing from the person: SQLite or the project's docker compose for a database, a free port, development mode.

## 5. Build, test, run, and fix what breaks

Loop until it works or you are truly blocked:

1. Run the build, then the tests, then start it (a server as a background job).
2. On an error, read the whole message and find the cause in the code or the configuration. Fix the cause in the codebase: missing imports, wrong paths, version mismatches, broken scripts, type errors, failing tests caused by real bugs, Windows path or shell issues.
3. Run it again to verify the fix. Keep a list of every fix with its file and one line of why.

Rules:
- Fix the code. Never delete or skip a failing test, loosen a check, or pin around an error to make it pass, unless the test is plainly wrong. Then say why.
- Upgrade a dependency only when the error says that version is broken here, and record it.
- When the project also lints or typechecks in CI, run that too and fix what it reports in the files you touched.
- After three different failed fixes for one error, stop that branch, write down what you tried, and move on to what you can still finish.

## 6. Show it working

- A web app: open its local address in the browser and check the page loads, or fetch it.
- A CLI or library: run its example or its `--help`, and the tests.
- Something that needs the person's secrets: get as far as possible without them, and say exactly what will work once they fill which names.

## 7. Build on it, when asked

Read how the codebase already does similar things (folders, naming, patterns, tests) and do it the same way. Add tests for what you add, run the whole suite, and keep unrelated code unchanged.

## 8. Report

Keep it short:
- What it is.
- Where it is.
- How to run it: the exact commands.
- What you fixed: each fix with its file.
- How you verified it.
- What the person must still do: settings names to fill, anything that needed a yes.
