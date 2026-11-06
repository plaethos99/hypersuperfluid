/**
 * Approval gate, from the Odoo agent: the agent works like an employee. The person describes the task; the agent looks
 * around and proposes a plan; after the person says go, it acts without asking; before a final submission it
 * shows what will be committed and waits for the person to confirm.
 *
 * A call is denied when its tool name starts with a `denied[].prefix` (the model sees that entry's reason).
 * A call is an action when its name starts with one of `gatedPrefixes` or equals one of `gatedTools`, unless
 * the name is listed in `readOnly`; every other call passes. In the Full access and Auto modes actions pass
 * unchanged (the person chose unattended operation). In every other mode:
 * - an action is refused until the person says go for the current turn, either by ending a message with one
 *   of `goWords` or by choosing "Go" on an `ask_user_question` card whose question id is `go`;
 * - a browser click whose element description names one of `submitWords`, or a call of one of `submitTools`, is
 *   refused until the person chooses "Submit" on an `ask_user_question` card whose question id is `submit`.
 *   That grant covers submissions until the agent asks another question or the turn ends.
 * Refusals carry model-facing instructions, so the agent asks in the chat instead of the person approving
 * each click. Both grants end with the turn. Denials apply in every mode.
 *
 * `toolProviders` binds a tool to the model providers it may run under: a call of such a tool is refused in every
 * mode unless the chat's latest model request went to one of them. A worker runs on its own provider whatever the chat uses,
 * so `{ hermes: ['deepseek-official'] }` keeps a chat on Claude or GPT from handing client data to DeepSeek.
 */

export const name = 'hsf-approval-gate'
export const inject = ['permissionPresets']

const UNATTENDED_PRESETS = new Set(['danger-full-access', 'auto'])
/** The question tool the agent uses for the plan and the submission review, and its protocol ids. */
const QUESTION_TOOL = 'ask_user_question'
const GO_QUESTION = 'go'
const SUBMIT_QUESTION = 'submit'
/** Browser click tools, whose `element` argument is a readable description of the clicked element. */
const BROWSER_CLICK_TOOLS = new Set(['mcp__playwright-mcp__browser_click'])

const GO_REASON = 'Not started: the person has not said go for this task. Look around with read-only tools, '
  + 'then show a short plan with ask_user_question (one question with id "go" and the options "Go" and '
  + '"Change the plan"), or end your turn with the plan so the person can reply "go". Act only after they '
  + 'say go; then work without asking until a final submission.'

/**
 * @param {unknown} value - configured list.
 * @param {string} field - config field name for the error message.
 * @returns {string[]} the validated list.
 */
function stringList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new TypeError(`hsf-approval-gate: ${field} must be a list of non-empty strings`)
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
  if (list.length === 0) throw new TypeError(`hsf-approval-gate: ${field} must not be empty`)
  return list
}

/**
 * @param {unknown} value - configured `denied` list.
 * @returns {{ prefix: string, reason: string }[]} the validated rules.
 */
function deniedRules(value) {
  if (value === undefined) return []
  const valid = Array.isArray(value) && value.every((rule) =>
    typeof rule === 'object' && rule !== null &&
    typeof rule.prefix === 'string' && rule.prefix.length > 0 &&
    typeof rule.reason === 'string' && rule.reason.length > 0)
  if (!valid) throw new TypeError('hsf-approval-gate: denied must be a list of { prefix, reason } entries')
  return value
}

/**
 * @param {{ gatedPrefixes?: string[], gatedTools?: string[], readOnly?: string[],
 *   denied?: { prefix: string, reason: string }[] }} config - gate rules.
 * @returns {(toolName: string) => { kind: 'deny', reason: string } | { kind: 'action' } | { kind: 'pass' }}
 *   the rule that applies to a call of `toolName`.
 */
export function createClassifier(config) {
  const prefixes = stringList(config.gatedPrefixes, 'gatedPrefixes')
  const tools = new Set(stringList(config.gatedTools, 'gatedTools'))
  const readOnly = new Set(stringList(config.readOnly, 'readOnly'))
  const denied = deniedRules(config.denied)
  if (prefixes.length === 0 && tools.size === 0 && denied.length === 0) {
    throw new TypeError('hsf-approval-gate: configure gatedPrefixes, gatedTools or denied')
  }
  return (toolName) => {
    const rule = denied.find((entry) => toolName.startsWith(entry.prefix))
    if (rule !== undefined) return { kind: 'deny', reason: rule.reason }
    if (readOnly.has(toolName)) return { kind: 'pass' }
    if (tools.has(toolName) || prefixes.some((prefix) => toolName.startsWith(prefix))) return { kind: 'action' }
    return { kind: 'pass' }
  }
}

/**
 * @param {string[]} words - words or phrases, matched case-insensitively as whole words.
 * @returns {string} a regular-expression source matching any of them.
 */
function wordsSource(words) {
  const escaped = words.map((word) => word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
  return `\\b(?:${escaped.join('|')})\\b`
}

/**
 * @param {string[]} goWords - phrases that start the work when a message ends with them ("go", "go ahead").
 * @returns {(text: string) => boolean} whether a message from the person says go.
 */
export function createGoDetector(goWords) {
  const pattern = new RegExp(`${wordsSource(requiredList(goWords, 'goWords'))}[\\s.!]*$`, 'i')
  return (text) => pattern.test(text.trim())
}

/**
 * @param {string[]} submitWords - button words that commit work ("import", "confirm", "post", "submit").
 * @param {string[] | undefined} notSubmitWords - words that mark an element as navigation ("menu", "tab"),
 *   which is never a submission even when it names a submit word.
 * @param {string[] | undefined} submitTools - tools whose every call commits work (applying an Odoo change set).
 * @returns {(toolName: string, args: unknown) => string | undefined} a description of what is about to be
 *   committed when a call clicks a browser element that looks like a final submission or calls one of
 *   `submitTools`, otherwise undefined.
 */
export function createSubmitDetector(submitWords, notSubmitWords, submitTools) {
  const pattern = new RegExp(wordsSource(requiredList(submitWords, 'submitWords')), 'i')
  const navigation = stringList(notSubmitWords, 'notSubmitWords')
  const exempt = navigation.length === 0 ? undefined : new RegExp(wordsSource(navigation), 'i')
  const tools = new Set(stringList(submitTools, 'submitTools'))
  return (toolName, args) => {
    if (tools.has(toolName)) {
      const values = typeof args === 'object' && args !== null ? Object.values(args) : []
      const target = values.find((value) => typeof value === 'string')
      return target === undefined ? toolName : `${toolName} ${target}`
    }
    if (!BROWSER_CLICK_TOOLS.has(toolName) || typeof args !== 'object' || args === null) return undefined
    const element = /** @type {{ element?: unknown }} */ (args).element
    if (typeof element !== 'string' || !pattern.test(element)) return undefined
    return exempt?.test(element) ? undefined : element
  }
}

/**
 * @param {unknown} value - an `ask_user_question` result value (`{ answers: [{ id, selected, custom? }] }`).
 * @returns {{ go?: boolean, submit?: boolean }} the grants the person's answers give or withdraw: an answer
 *   to question `go` grants when its chosen option starts with "Go", one to `submit` when it starts with
 *   "Submit".
 */
export function grantsFromAnswers(value) {
  /** @type {{ go?: boolean, submit?: boolean }} */
  const grants = {}
  const answers = typeof value === 'object' && value !== null && Array.isArray(value.answers) ? value.answers : []
  for (const answer of answers) {
    if (typeof answer !== 'object' || answer === null || !Array.isArray(answer.selected)) continue
    const chose = (word) => answer.selected.some((label) =>
      typeof label === 'string' && label.trim().split(/[\s(]/, 1)[0].toLowerCase() === word)
    if (answer.id === GO_QUESTION) grants.go = chose('go')
    if (answer.id === SUBMIT_QUESTION) grants.submit = chose('submit')
  }
  return grants
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
 * @param {string} element - description of the browser element about to be clicked.
 * @returns {string} the model-facing instruction for a submission the person has not confirmed.
 */
function submitReason(element) {
  return `Not submitted: "${element}" looks like a final submission. First show the person exactly what will `
    + 'be committed (records, amounts, files) with ask_user_question (one question with id "submit" and the '
    + 'options "Submit" and "Not yet"); click or run it only after they choose Submit.'
}

/**
 * @param {unknown} value - configured `toolProviders`: tool name -> provider ids it may run under.
 * @returns {Map<string, Set<string>>} the binding per tool; empty when not configured.
 */
export function providerBindings(value) {
  const bindings = new Map()
  if (value === undefined) return bindings
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hsf-approval-gate: toolProviders must map tool names to provider lists')
  }
  for (const [tool, providers] of Object.entries(value)) {
    bindings.set(tool, new Set(requiredList(providers, `toolProviders.${tool}`)))
  }
  return bindings
}

/**
 * @param {string} tool - the refused tool.
 * @param {string | undefined} provider - the chat's current model provider, when known.
 * @returns {string} the model-facing reason for refusing a provider-bound tool.
 */
function providerReason(tool, provider) {
  const where = provider === undefined ? 'this chat has not used a model yet' : `this chat runs on ${provider}`
  return `Refused: ${tool} runs on a different model provider and ${where}, so handing work to it would send this ` +
    `client's data to a provider the person did not choose. Do the work yourself in this chat.`
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context; inside an agent preset it sees only
 *   that preset's calls.
 * @param {{ gatedPrefixes?: string[], gatedTools?: string[], readOnly?: string[],
 *   denied?: { prefix: string, reason: string }[], goWords: string[], submitWords: string[],
 *   notSubmitWords?: string[], submitTools?: string[] }} config - gate rules.
 */
export function apply(ctx, config) {
  const classify = createClassifier(config ?? {})
  const saysGo = createGoDetector(config?.goWords)
  const submission = createSubmitDetector(config?.submitWords, config?.notSubmitWords, config?.submitTools)
  const permissionPresets = ctx.permissionPresets
  const bindings = providerBindings(config?.toolProviders)
  /** @type {WeakMap<object, string>} the provider of each agent's latest model request */
  const providers = new WeakMap()
  /** @type {WeakMap<object, { go: boolean, submit: boolean }>} per-agent grants for the current turn */
  const grants = new WeakMap()
  const stateOf = (agent) => {
    let state = grants.get(agent)
    if (state === undefined) {
      state = { go: false, submit: false }
      grants.set(agent, state)
    }
    return state
  }

  ctx.on('agent/pre-step', (payload, next) => {
    const said = payload.messages.some((message) => {
      const text = personText(message)
      return text !== undefined && saysGo(text)
    })
    if (said) stateOf(payload.agent).go = true
    return next()
  })

  if (bindings.size > 0) {
    ctx.on('agent/request', async (payload, next) => {
      const call = await next()
      if (typeof call?.provider === 'string') providers.set(payload.agent, call.provider)
      return call
    })
  }

  // Prepended so the gate wraps every other pre-execute listener, including ones that return `allow`
  // without calling `next()`.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    const rule = classify(exec.name)
    if (rule.kind === 'deny') return { kind: 'deny', reason: rule.reason }
    const allowed = bindings.get(exec.name)
    if (allowed !== undefined) {
      // Fails closed: an agent whose provider is unknown has not made a model request this gate saw.
      const provider = exec.agent === undefined ? undefined : providers.get(exec.agent)
      if (provider === undefined || !allowed.has(provider)) {
        return { kind: 'deny', reason: providerReason(exec.name, provider) }
      }
    }
    if (rule.kind === 'pass') return decision
    const agent = exec.agent
    if (agent === undefined) return { kind: 'deny', reason: GO_REASON }
    if (UNATTENDED_PRESETS.has(permissionPresets.current(agent.session))) return decision
    const state = stateOf(agent)
    if (!state.go) return { kind: 'deny', reason: GO_REASON }
    const element = submission(exec.name, exec.arguments)
    if (element !== undefined && !state.submit) return { kind: 'deny', reason: submitReason(element) }
    return decision
  }, { prepend: true })

  ctx.on('tools/post-execute', (exec, result, next) => {
    if (exec.name === QUESTION_TOOL && exec.agent !== undefined) {
      const state = stateOf(exec.agent)
      // A new question closes the previous submission grant; its answers may open a new one.
      state.submit = false
      if (!result.isError) Object.assign(state, grantsFromAnswers(result.value))
    }
    return next()
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    grants.delete(agent)
  })
}
