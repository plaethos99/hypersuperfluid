---
name: autonomous-work
description: Working alone from a folder and a goal to a verified result - understanding the folder, planning, recording the goal, executing without check-ins, verifying, handing off when context fills, and reporting. Load at the start of any autonomous or hand-off task.
---

# Autonomous work

The person gave you a folder and a goal and will come back for the result. Your job is a finished, verified deliverable and a short report, not a conversation.

## 1. Understand the folder and the goal (a few minutes, not an hour)

- List the folder; read its README, AGENTS.md, build files and any task notes the person left.
- Restate the goal in one sentence and write the definition of done: what files or behaviour will exist, and how you will prove it.
- Identify the kind of task and read that domain's skill (software-engineering, data-engineering, office-documents, and so on).

## 2. Decide instead of asking

When something is ambiguous, pick the most reasonable reading, write it down as an assumption, and continue. Ask only when every reasonable reading leads to a different, expensive outcome, or when the next step is outside the limits below. Collect smaller questions for the final report.

## 3. Plan and record

- Break the work into steps with `todo_write`, and keep it current: one step in progress, completed steps marked as they finish.
- For work that will take many steps, record the goal with the goal tools so it survives a restart, and update its progress.
- Order steps so a usable result exists early and improves, rather than everything landing at the end.

## 4. Execute

- Work inside the folder. Keep the person's original files intact: create new files, or keep a copy before rewriting one, unless the goal is to change them.
- Run things to learn, not to guess: build, test, open the output.
- When a step fails, read the error, fix the cause, and retry; try a different approach after two failed attempts at the same one. Note what failed in the report.
- Keep long outputs out of the conversation: write them to files and read the parts you need.

## 5. Limits that still hold

Anything outside the folder, anything hard to undo, anything visible to others or costing money waits for a yes: deleting the person's files, installing software system-wide, pushing to remotes, deploying, sending messages, buying, posting in an ERP. If the goal cannot be met without one of these, finish everything else and ask once, at the end, with the exact action proposed.

## 6. Verify

Check the definition of done item by item with real evidence: the test run, the rendered document, the query result, the running program's output. Fix what fails. Do not report a step you did not verify as done.

## 7. Long tasks

When you are told the context is filling, or before a new large phase, call `handoff`: the work continues in a fresh session with your notes. Write the handoff for someone who saw nothing of this session.

## 8. Report

Short and scannable:

1. **Result:** one or two sentences, and whether the goal is fully met.
2. **What I did:** the main steps.
3. **How I verified it:** commands and outcomes.
4. **Files:** every file produced or changed, with paths.
5. **Assumptions** I made, and **open questions**.
6. **Not done:** anything left, and why.
