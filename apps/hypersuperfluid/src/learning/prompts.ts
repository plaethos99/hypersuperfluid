/**
 * Review prompts adapted from Hermes Agent's `agent/background_review.py` (MIT; see THIRD_PARTY.md), with tool names
 * changed to this bundle's. They encode what years of a hoarding library taught that project, so wording changes
 * should be evidence-led.
 * @module hypersuperfluid/learning/prompts
 */

const MEMORY_ROUTING = `TWO distinct stores. Pick the right one for each fact:
- memory tool, target "user": who the person is: preferences, communication and work style, and how they expect you to behave.
- memory tool, target "memory": facts about the ENVIRONMENT: tool quirks, project conventions, configuration gotchas, paths and endpoints that matter.

One fact goes to ONE store, never both.

Save only facts GROUNDED in this conversation: a message or tool result you can point to. Never infer traits, skill level, role, mood or preferences from topic, tone or tools used, and never turn a one-off request into a standing preference unless the person marked it general ("always", "from now on", "remember") or stated a standing like or dislike. If unsure, leave it out: a wrong fact misleads every future session.
`

const LESSON_SHAPE = `What a skill IS: the instructions for doing a class of task the most efficient and correct way, to THIS person's specifications: the procedure, the tools and commands that work, the order, how the result should look, and the pitfalls that cost time. A future session should be able to follow it and produce what the person wants on the first try.
- Procedure first: steps in the order they are done, with concrete commands, tool calls and decision points. Pitfalls attach to the step they affect.
- A pitfall is a generalizable rule plus one clause of WHY, in the imperative. Not a narrative of what happened.
- No ticket numbers, dates or quoted incident text. The rule must stand without the incident behind it.
- The same lesson learned twice is ONE rule. Search the skill first, and strengthen the rule rather than appending a copy.
- Do not restate what the environment already teaches: AGENTS.md files, tool descriptions, always-loaded context.
- Always-on rules live in SKILL.md, whole. references/ holds depth needed only sometimes, each file topical and reusable.
- Fix a wrong skill in place by editing the sentence that misled. Never append "UPDATE: actually...".
`

const DO_NOT_CAPTURE = `Do NOT capture as skills:
- Environment-dependent failures: missing binaries, unconfigured credentials, fresh-install errors. The person can fix these. Capture the FIX under a setup skill, never "this tool does not work".
- Negative claims about tools ("X is broken"). They harden into refusals long after the cause is fixed.
- Transient errors that resolved before the conversation ended.
- One-off task narratives.
- Unresolved failures: if the session ended without a working method, do NOT write the attempts up as a recommended approach. That presents an untested sequence of failures as validated guidance.
`

/** The prompt of a periodic review of both memory and skills, delivered to a fork of the conversation. */
export const REVIEW_PROMPT = `Review the conversation above and update two things. This is a background pass: the person is not reading this, so do not ask questions. You may use only memory, skill_view and skill_manage.

**Memory**: ${MEMORY_ROUTING}
**Skills**: how to do this class of task.

${LESSON_SHAPE}
Signals that warrant a skill update, any one is enough:
- The person corrected your style, format, verbosity, approach or sequence of steps. Frustration is a first-class signal: embed the lesson in the skill governing that task, so the next session starts fixed.
- A non-trivial technique, fix, workaround or debugging path emerged.
- A skill you consulted turned out wrong, missing a step, or outdated. Patch it now.

Preference order, take the earliest that fits:
1. Update a skill loaded in this conversation. Call skill_view on it first; patches are refused otherwise.
2. Update an existing class-level skill: skill_view without a name lists them.
3. Add a support file under an existing skill: references/<topic>.md, templates/<name>.<ext> or scripts/<name>.<ext>, and add a one-line pointer to it in SKILL.md.
4. Create a new class-level skill when nothing covers the class. Its name must not be a ticket number, an error string, or anything that only fits today's task.

A preference lives in exactly ONE place: the skill that governs the task when one exists, the user memory only for cross-cutting preferences no skill owns.

${DO_NOT_CAPTURE}
If nothing stands out, reply "Nothing to save." and stop. Otherwise act, then reply with one line per change.`

/** The prompt of a model-driven consolidation of the library. */
export const CURATOR_PROMPT = `Consolidate the skill library. This is a background pass: do not ask questions. You may use only skill_view and skill_manage.

1. Call skill_view without a name to list the skills, with their usage counts and states.
2. Read the skills whose names or descriptions overlap, and any marked stale.
3. Merge overlapping narrow skills into one class-level skill: keep every rule that still applies, one copy of each, then archive the narrower skills with skill_manage action archive.
4. Only ever touch skills whose createdBy is "agent", never pinned skills, and archive rather than delete. A skill you cannot judge stays as it is.

Reply with one line per change, or "Nothing to consolidate."`

/** Tools a review fork may call. */
export const REVIEW_TOOLS: ReadonlySet<string> = new Set(['memory', 'skill_view', 'skill_manage'])
