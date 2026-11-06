---
name: software-engineering
description: How to change real code well - reading a codebase, debugging by evidence, testing, refactoring, reviewing, git and dependency work. Load before a non-trivial code change or a hard bug.
---

# Software engineering

## Change code in this order

1. **Find the conventions.** Read `AGENTS.md`, `CONTRIBUTING`, the test setup, and a neighbouring file. Match what is there, including naming, error handling and test style. Your preference is not a reason to differ.
2. **Find the real code path.** Search for the symbol and trace callers. Do not edit the first thing with a similar name. Check for a second implementation of the same behaviour before fixing one.
3. **Reproduce first.** For a bug, make it fail before changing anything: a failing test is best. A fix you never saw fail is a guess.
4. **Make the smallest change that fixes the class of problem**, including sibling paths with the same flaw. Do not refactor, rename or reformat along the way.
5. **Verify by running it.** Run the affected tests, then the real program or command. Typechecking passing does not prove behaviour.
6. **Read your own diff** before calling it done: leftovers, debug prints, unrelated changes.

## Debugging

- Read the whole error, from the first line of the first failure. Later errors are usually consequences.
- Form one hypothesis, and find the cheapest experiment that could prove it wrong. Bisect: by commit with `git bisect`, by input by halving it, or by path with a log line in the middle.
- Print the actual values. Assumptions about data shape, encoding, time zone and working directory cause most long debugging sessions.
- When you are stuck, list what you have proven and what you have only assumed, and test the assumptions.
- "It works on my machine" means a difference exists: compare versions, environment variables, file paths, locale and line endings.
- Fix the cause, not the symptom. A retry around a race or a catch-all `except` hides the bug and makes the next one harder.

## Tests

- Test behaviour through the public interface, so that a refactor does not break them.
- A test must fail when the code is wrong. Break the code once to see it fail.
- Cover the case that was broken, the boundaries (empty, one, many, maximum) and the failure paths.
- Mock only what you do not own or cannot run. Over-mocking tests the mocks.
- Never weaken or delete a test to make it pass unless the behaviour it describes has really changed, and say so when you do.

## Git

- Look at `git status` and `git diff` before committing, and stage specific files rather than everything.
- Keep commits small and about one thing. Say why in the message.
- `git reset --hard`, `git clean -fd`, `git push --force` and `git checkout -- .` destroy work. Check for uncommitted changes first, ask before using them on anything that is not yours, and prefer `--force-with-lease`.
- Commit or push only when asked.
- Never commit secrets. If one was committed, rotating it is the fix; rewriting history is not enough.

## Dependencies

- Check whether the project already has a library that does this before adding one.
- Verify a package exists and is the one you mean before installing it: invented names are a known attack path.
- Pin versions the way the project does, and commit the lockfile.
- For an API you have not used recently, read the installed version's types or documentation rather than trusting memory. APIs change.

## Writing code

- Handle errors where you can do something useful; otherwise let them propagate with context. Never swallow one silently.
- Validate at real boundaries: user input, files, network. Trust typed internal calls.
- Prefer the simple thing that fits this problem to the general framework for problems you do not have.
- Comments say why, not what. Delete dead code instead of commenting it out.

## Security

Treat as untrusted anything from outside the process. Use parameterized queries and argument arrays, not string-built SQL or shell commands. Check paths stay inside their directory after resolving them. Keep secrets out of code, logs and error messages. Check authorization on the server for every action, not only in the interface.

## Pitfalls

- An edit that compiles is not proof the path it changed is the one that runs. Confirm with a log line or a test.
- Generated files get overwritten: find the generator and change that.
- A passing test suite may not cover your change. Check that something actually exercised it.
- Long-running migrations, background jobs and caches keep old behaviour alive after a deploy.
