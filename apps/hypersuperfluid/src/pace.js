/**
 * Task pace, from the Odoo agent: the agent thinks as hard as the task needs. Entering tables, uploading documents and
 * filling forms run without thinking, so each click and keystroke comes back quickly; writing SQL, scripts and
 * formulas, reconciling and finding the cause of an error think the most; everything else thinks a little.
 *
 * The pace is read from what the person types. A message that asks for a pace (`askedDeep`, `askedQuick`)
 * wins; otherwise one naming deep work (`deepWords`) is deep and one naming quick work (`quickWords`) is quick.
 * A message that names neither ("go", "yes", "looks right") keeps the pace of the task in hand, so the plan and
 * the work after "go" run at the same pace; a chat starts at the standard pace. Each pace maps to a DeepSeek
 * thinking effort (`efforts`) that replaces the effort of every model request in the chat.
 *
 * The pace is chosen at step boundaries from the person's messages, so it does not change between the tool
 * calls of one step. When the person picks an effort with the composer's model control, that choice is kept
 * for the rest of the chat (until a restart) and the pace no longer applies to it.
 */

export const name = 'hsf-task-pace'
export const inject = ['sessionProjections']

const PACES = ['quick', 'standard', 'deep']
const EFFORTS = new Set(['off', 'low', 'high', 'max'])
const DEFAULT_EFFORTS = { quick: 'off', standard: 'low', deep: 'max' }
/** Session projection the Session Controller keeps for the composer's model control. */
const MODEL_SELECTION = 'modelSelection'

/**
 * @param {unknown} value - configured list.
 * @param {string} field - config field name for the error message.
 * @returns {string[]} the validated list.
 */
function stringList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new TypeError(`hsf-task-pace: ${field} must be a list of non-empty strings`)
  }
  return value
}

/**
 * @param {unknown} value - configured list that must not be empty.
 * @param {string} field - config field name for the error message.
 * @returns {string[]} the validated list.
 */
function requiredList(value, field) {
  const list = stringList(value, field)
  if (list.length === 0) throw new TypeError(`hsf-task-pace: ${field} must not be empty`)
  return list
}

/**
 * @param {string[]} words - words or phrases, matched case-insensitively as whole words; the last word may
 *   carry an ending (upload, uploads, uploaded, uploading).
 * @returns {RegExp} a pattern matching any of them.
 */
function wordsPattern(words) {
  const escaped = words.map((word) => word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
  return new RegExp(`\\b(?:${escaped.join('|')})(?:s|es|d|ed|ing)?\\b`, 'i')
}

/**
 * @param {unknown} value - configured `efforts` (pace -> DeepSeek thinking effort); missing paces keep
 *   their defaults.
 * @returns {{ quick: string, standard: string, deep: string }} the effort for each pace.
 */
export function paceEfforts(value) {
  if (value === undefined) return { ...DEFAULT_EFFORTS }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hsf-task-pace: efforts must map quick, standard and deep to an effort')
  }
  const efforts = { ...DEFAULT_EFFORTS }
  for (const [pace, effort] of Object.entries(value)) {
    if (!PACES.includes(pace)) throw new TypeError(`hsf-task-pace: efforts has an unknown pace "${pace}"`)
    if (!EFFORTS.has(effort)) {
      throw new TypeError(`hsf-task-pace: efforts.${pace} must be one of ${[...EFFORTS].join(', ')}`)
    }
    efforts[pace] = effort
  }
  return efforts
}

/**
 * @param {{ askedDeep?: string[], askedQuick?: string[], deepWords: string[], quickWords: string[] }} config -
 *   word lists, checked in that order.
 * @returns {(text: string) => 'quick' | 'deep' | undefined} the pace a message from the person names, or
 *   undefined when it names none.
 */
export function createPaceDetector(config) {
  const rules = [
    ['deep', stringList(config.askedDeep, 'askedDeep')],
    ['quick', stringList(config.askedQuick, 'askedQuick')],
    ['deep', requiredList(config.deepWords, 'deepWords')],
    ['quick', requiredList(config.quickWords, 'quickWords')],
  ].filter(([, words]) => words.length > 0).map(([pace, words]) => [pace, wordsPattern(words)])
  return (text) => rules.find(([, pattern]) => pattern.test(text))?.[0]
}

/**
 * @param {unknown} message - one message entering a step.
 * @returns {string | undefined} the text of a message the person typed, otherwise undefined.
 */
function personText(message) {
  if (typeof message !== 'object' || message === null || message.source?.kind !== 'user') return undefined
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ efforts?: { quick?: string, standard?: string, deep?: string }, askedDeep?: string[],
 *   askedQuick?: string[], deepWords: string[], quickWords: string[] }} config - paces and word lists.
 */
export function apply(ctx, config) {
  const efforts = paceEfforts(config?.efforts)
  const detect = createPaceDetector(config ?? {})
  const projections = ctx.sessionProjections
  /** @type {WeakMap<object, 'quick' | 'standard' | 'deep'>} the pace of each agent's task in hand */
  const paces = new WeakMap()
  /** @type {WeakSet<object>} sessions whose effort the person picked in the composer */
  const picked = new WeakSet()

  // A pick waits in the projection's `pending` until a request uses it; once seen, it is kept for the chat.
  const personPicked = (session) => {
    if (picked.has(session)) return true
    if (projections.stateOf(session, MODEL_SELECTION)?.pending == null) return false
    picked.add(session)
    return true
  }

  ctx.on('agent/pre-step', (payload, next) => {
    for (const message of payload.messages) {
      const text = personText(message)
      const pace = text === undefined ? undefined : detect(text)
      if (pace !== undefined) paces.set(payload.agent, pace)
    }
    return next()
  })

  // Prepended so the pace wraps the composer's selection listener, which re-applies the last logged effort.
  ctx.on('agent/request', async (payload, next) => {
    const proposed = await next()
    if (personPicked(payload.agent.session)) return proposed
    const effort = efforts[paces.get(payload.agent) ?? 'standard']
    // A route that proposes no effort takes none: a custom endpoint may reject the field or fail on an unmapped value.
    if (proposed.reasoningEffort === undefined) return proposed
    return proposed.reasoningEffort === effort ? proposed : { ...proposed, reasoningEffort: effort }
  }, { prepend: true })
}
