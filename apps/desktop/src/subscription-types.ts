/**
 * The renderer-safe shapes of Settings → Subscriptions, shared by the preload bridge and `subscriptions.ts`.
 * @module desktop/subscription-types
 */

/** What Settings shows for one tool. */
export interface SubscriptionInfo {
  readonly id: string
  readonly tool: string
  readonly label: string
  readonly plan: string
  /** The command to type in a terminal, for display. */
  readonly signInCommand: string
  readonly installed: boolean
  readonly note?: string
}

/** Whether a tool is signed in, from asking its ACP server to open a session. */
export type SubscriptionState = 'signed-in' | 'signed-out' | 'not-installed' | 'unknown'

/** The result of a check. */
export interface SubscriptionCheck {
  readonly id: string
  readonly state: SubscriptionState
  /** A short reason, without any credential. */
  readonly detail: string
}

/** The result of a sign-in request. */
export interface SubscriptionSignIn {
  readonly opened: boolean
  readonly detail: string
}

/** The preload bridge the Settings page calls, as `window.dshDesktop.subscriptions`. */
export interface SubscriptionsBridge {
  list(): Promise<readonly SubscriptionInfo[]>
  check(id: string): Promise<SubscriptionCheck>
  signIn(id: string): Promise<SubscriptionSignIn>
}
