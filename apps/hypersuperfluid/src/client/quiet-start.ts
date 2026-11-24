/**
 * No pop-ups at start. DSH opens two first-run dialogs over a new chat: a welcome notice and a DeepSeek sign-in / API
 * key dialog. Hypersuperfluid reads its keys from the portable key file, the environment or Settings, and runs on
 * subscriptions too, so both stay closed: each is shadowed by a step of the same id that completes at once and shows
 * nothing. Asked for on purpose (the account menu's "use an API key"), the DeepSeek step opens Settings > Models,
 * where keys are added.
 * @module hypersuperfluid/client/quiet-start
 */

import { useEffect, type ReactNode } from 'react'

/** The first-run steps kept closed: DSH's welcome notice and DeepSeek sign-in dialog. */
export const QUIET_ONBOARDING_STEPS = ['welcome-notice', 'deepseek-official'] as const

/** Shadows the original: the slot renders the lowest priority, and the originals register at 0. */
export const QUIET_PRIORITY = -10

/** What the settings shell hands an onboarding step. */
export interface QuietStepProps {
  readonly explicit?: boolean
  readonly complete: () => void
  readonly openSection: (id: string) => void
}

/**
 * Completes the step at once; asked for on purpose, it opens the models settings instead.
 * @param props - the onboarding owner's props.
 * @returns nothing.
 */
export function QuietStep(props: QuietStepProps): ReactNode {
  const { explicit = false, complete, openSection } = props
  useEffect(() => {
    complete()
    if (explicit) openSection('models')
    // Once per mount: the shell mounts a step each time it is shown.
  }, [])
  return null
}
