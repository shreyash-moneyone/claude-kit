export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  tier: string
  after: number[]
  /** The title was cut to the length limit: matched to an Agent description by its start. */
  isClipped?: boolean
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** `costumes: "rotate"`: the costume dealt at spawn, kept for the run's life. */
  costume?: string
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
  /** `activity: "on"`: the first lines of the worker's prompt, credentials masked. */
  brief?: string
  /** `activity: "on"`: the worker's last tool calls, oldest first, at most 10. */
  activity?: Activity[]
  /** `activity: "on"`: the first lines of the latest answer; unset while the run works. */
  result?: string
}

/** One tool call of a worker: when it was made and a masked, one-line summary. */
export type Activity = {
  at: number
  text: string
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
  /** `activity: "on"`: the run whose details are open, `''` for none. */
  expandedId?: string
}

/** The compact band shown without a flow (`band: "agents"`, `"unseen"`): hidden by its dismiss until the next subagent spawns. */
export type CrewBand = {
  isDismissed: boolean
  /** `band: "unseen"`: a counter that only grows, bumped by each change below. */
  seq?: number
  /** `band: "unseen"`: `seq` when the last running agent finished. Unset means nothing is unseen (state from before the option never brings a band back). */
  doneSeq?: number
  /** `band: "unseen"`: `seq` when the panel last showed the results, or when the last agent finished with it up. Results are unseen while `doneSeq` is past it. */
  seenSeq?: number
}

/** `finished: "clear-on-close"`: ids of the runs that had finished when the panel last closed; they are not listed. */
export type Cleared = {
  ids: string[]
}

/** `costumes: "rotate"`: how many costumes have been dealt this session; the next one is this index. */
export type Rotation = {
  next: number
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      crewBand: CrewBand
      cleared: Cleared
      rotation: Rotation
      now: number
    }
  }
}
