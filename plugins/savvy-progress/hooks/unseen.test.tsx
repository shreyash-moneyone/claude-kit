import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'savvy-progress'
const PANE = 'savvy-agents'
const MODEL = 'claude-sonnet-5-5'
const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } as const
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const UNSEEN = { options: { band: 'unseen' } } as const
const AGENTS = { options: { band: 'agents' } } as const
const FLOW = { options: { band: 'flow' } } as const

// The world beneath the plugin. `pane.isOpen` stands for the engine's pane list; `writes` counts the crewBand writes that landed.
const setup = (on: On) => {
  mock.clock(on)
  // `isPlaced` false: the pane waits undrawn; `refuse`: the open is refused and no pane is listed; `hold`: the next pane list is read now, answered later.
  const pane = { isOpen: false, isPlaced: true, refuse: false, writes: 0, hold: undefined as Promise<void> | undefined, reached: () => {} }
  on('state.set', async (_$, e, next) => {
    const set = await next(e)
    if (e.key === 'crewBand' && (set as unknown as { value?: { isSet?: boolean } }).value?.isSet) pane.writes++
    return set
  })
  on('ui.open', () => {
    if (pane.refuse) return { value: { isPlaced: false, reason: 'no room' } } as never
    pane.isOpen = true
    return { value: { isPlaced: pane.isPlaced } } as never
  })
  on('ui.close', () => ((pane.isOpen = false), { value: undefined }) as never)
  on('ui.panes', async () => {
    const listed = pane.isOpen ? [{ id: PANE, isPlaced: pane.isPlaced }] : []
    const hold = pane.hold
    pane.hold = undefined
    if (hold) pane.reached()
    await hold
    return { value: listed } as never
  })
  on('agent.spawn', (_$, e) => ({ model: MODEL, agentId: e.resume?.agentId ?? e.tool_use_id }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    return { turnId: 'turn', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: MODEL, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="bottom" /> as never
  })
  return pane
}

const spawn = async ($: Engine, id: string, resume?: string) => {
  await $.agent.spawn({ tool_use_id: id, prompt: 'p', description: `Work ${id}`, subagentType: 'general-purpose', provider: 'engine', parentModel: MODEL, background: false, fork: false, ...(resume ? { resume: { agentId: resume } } : {}) } as never)
}

const finish = async ($: Engine, id: string) => {
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: id, reason: 'answer', answer: 'ok', usage: null })
}

// The band: its toggle's label (undefined: no band), and the Text of its counts.
const bandOf = async ($: Engine, surface: Surface) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
  const toggle = await ui.find({ key: 'savvy-agents' })
  const svg = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('\n')
  const counts = async (text: string) =>
    surface === 'desktop' ? svg.includes(`>${text}<`) : (await ui.find({ type: 'Text', text: new RegExp(`^${text}$`) })) !== undefined
  return { ui, label: toggle?.props.label as string | undefined, counts }
}
const labelNow = async ($: Engine, surface: Surface) => {
  const b = await bandOf($, surface)
  await b.ui.unmount()
  return b.label
}
const SHOWN = 'Show panel ▸'

const openByCommand = ($: Engine) => $.command.run({ command: 'agents-info', args: 'open' } as never)

for (const surface of SURFACES) {
  test(`${surface}: unseen shows the band while an agent runs (U1)`, UNSEEN, async ($, on) => {
    setup(on)
    expect(await labelNow($, surface)).toBeUndefined()
    await spawn($, 'a1')
    expect(await labelNow($, surface)).toBe(SHOWN)
  })

  test(`${surface}: unseen keeps the band, with its done count, when an agent finishes with the pane closed (U2)`, UNSEEN, async ($, on) => {
    setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    const b = await bandOf($, surface)
    expect(b.label).toBe(SHOWN)
    expect(await b.counts('1 done')).toBe(true)
  })

  test(`${surface}: unseen hides the band once /agents-info opens the pane after the results (U3)`, UNSEEN, async ($, on) => {
    setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    expect(await labelNow($, surface)).toBe(SHOWN)
    await openByCommand($)
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: unseen hides the band once its own toggle opens the pane (U3)`, UNSEEN, async ($, on) => {
    setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    const b = await bandOf($, surface)
    await b.ui.press({ key: 'savvy-agents' })
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: unseen hides the band right away when the agent finishes with the pane open (U4)`, UNSEEN, async ($, on) => {
    setup(on)
    await spawn($, 'a1')
    await openByCommand($)
    expect(await labelNow($, surface)).toBeDefined()
    await finish($, 'a1')
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: unseen brings the band back on a new spawn, and keeps it after that run finishes unseen (U5)`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    await openByCommand($)
    expect(await labelNow($, surface)).toBeUndefined()
    pane.isOpen = false
    await spawn($, 'a2')
    expect(await labelNow($, surface)).toBe(SHOWN)
    await finish($, 'a2')
    expect(await labelNow($, surface)).toBe(SHOWN)
  })

  test(`${surface}: unseen with two agents: one done while the pane is open, the other still running, then unseen, then seen (U6)`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    await spawn($, 'a2')
    await openByCommand($)
    await finish($, 'a1')
    expect(await labelNow($, surface)).toBeDefined()
    pane.isOpen = false
    await finish($, 'a2')
    expect(await labelNow($, surface)).toBe(SHOWN)
    await openByCommand($)
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: unseen keeps the ✕: it dismisses, the next spawn returns the band (U7)`, UNSEEN, async ($, on) => {
    setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    const b = await bandOf($, surface)
    await b.ui.press({ key: 'savvy-dismiss' })
    expect(await labelNow($, surface)).toBeUndefined()
    await spawn($, 'a2')
    expect(await labelNow($, surface)).toBe(SHOWN)
  })

  test(`${surface}: unseen over stored band state from before the option: finished runs, nothing running, no band (U8)`, UNSEEN, async ($, on) => {
    setup(on)
    on('state.get', { plugin: PLUGIN, key: 'crewBand' } as never, (() => ({ value: { value: { isDismissed: false }, version: 0 } })) as never)
    on('state.get', { plugin: PLUGIN, key: 'agents' } as never, (() => ({ value: { value: [OLD_DONE], version: 0 } })) as never)
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: agents over the same stored state still shows the band (U8)`, AGENTS, async ($, on) => {
    setup(on)
    on('state.get', { plugin: PLUGIN, key: 'crewBand' } as never, (() => ({ value: { value: { isDismissed: false }, version: 0 } })) as never)
    on('state.get', { plugin: PLUGIN, key: 'agents' } as never, (() => ({ value: { value: [OLD_DONE], version: 0 } })) as never)
    expect(await labelNow($, surface)).toBe(SHOWN)
  })

  test(`${surface}: agents keeps the band after the results are seen (U9)`, AGENTS, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    await openByCommand($)
    expect(await labelNow($, surface)).toBeDefined()
    pane.isOpen = false
    await spawn($, 'a2')
    await openByCommand($)
    await finish($, 'a2')
    expect(await labelNow($, surface)).toBeDefined()
  })

  test(`${surface}: unseen leaves an active flow band alone after agents finish and the pane opens (U10)`, UNSEEN, async ($, on) => {
    setup(on)
    await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'Ship it', total: 4, done: 1, phase: 'delegate' } as never)
    await spawn($, 'a1')
    await finish($, 'a1')
    await openByCommand($)
    const b = await bandOf($, surface)
    expect(b.label).toBe('Hide panel ◂')
    if (surface === 'terminal') expect((await b.ui.findAll({ type: 'Text', text: /^Tasks 1\/4$/ })).length).toBe(1)
    expect(await b.ui.find({ key: 'savvy-dismiss' })).toBeDefined()
  })

  test(`${surface}: unseen counts a resumed agent as running (U11)`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    await openByCommand($)
    pane.isOpen = false
    expect(await labelNow($, surface)).toBeUndefined()
    await spawn($, 'r1', 'a1')
    expect(await labelNow($, surface)).toBe(SHOWN)
  })

  test(`${surface}: unseen counts an agent that a model step resumes as running (U11)`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    await openByCommand($)
    pane.isOpen = false
    const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 'turn', index: 0, model: MODEL, messageCount: 1, agentId: 'a1' })
    for await (const _ of stream) void _
    expect(await labelNow($, surface)).toBe(SHOWN)
  })
}

for (const [name, opts] of [['agents', AGENTS], ['flow', FLOW]] as const) {
  test(`${name}: turn.complete writes no crewBand state (U12)`, opts, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    await spawn($, 'a2')
    const before = pane.writes
    await finish($, 'a1')
    await finish($, 'a2')
    expect(pane.writes).toBe(before)
    await openByCommand($)
    expect(pane.writes).toBe(before)
  })
}

test('unseen: writes crewBand only when its seen state changes', UNSEEN, async ($, on) => {
  const pane = setup(on)
  await spawn($, 'a1')
  await spawn($, 'a2')
  const before = pane.writes
  await finish($, 'a1') // a2 still runs
  expect(pane.writes).toBe(before)
  await finish($, 'a2') // last one, pane closed: unseen
  expect(pane.writes).toBe(before + 1)
  await openByCommand($) // seen
  expect(pane.writes).toBe(before + 2)
  await openByCommand($) // already seen
  expect(pane.writes).toBe(before + 2)
})

const OLD_DONE = { id: 'a1', agentId: 'a1', type: 'general-purpose', description: 'Work a1', model: MODEL, status: 'done', startedAt: 0, endedAt: 1, contextTokens: 0, contextMax: 1e6, tokens: 0, costUsd: 0, steps: 0, round: 1 }

const resume = async ($: Engine, id: string) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 'turn', index: 0, model: MODEL, messageCount: 1, agentId: id })
  for await (const _ of stream) void _
}

for (const surface of SURFACES) {
  test(`${surface}: unseen: a pane that waits undrawn (auto-open on a narrow window) has shown nothing`, { options: { band: 'unseen', autoOpen: 'any' } }, async ($, on) => {
    const pane = setup(on)
    pane.isPlaced = false
    await spawn($, 'a1')
    await finish($, 'a1')
    expect(await labelNow($, surface)).toBeDefined()
    pane.isPlaced = true
    await openByCommand($)
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: unseen: a refused open has shown nothing; a later placed one has`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    pane.refuse = true
    await openByCommand($)
    expect(await labelNow($, surface)).toBe(SHOWN)
    const b = await bandOf($, surface)
    await b.ui.press({ key: 'savvy-agents' })
    expect(await labelNow($, surface)).toBe(SHOWN)
    pane.refuse = false
    await openByCommand($)
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: unseen: a pane that opens between the last completion's read and its write still counts as seen`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    let release = () => {}
    pane.hold = new Promise<void>(r => (release = r))
    const reached = new Promise<void>(r => (pane.reached = r))
    const finishing = finish($, 'a1') // reads the pane list: closed
    await reached
    await openByCommand($) // the pane opens; nothing is unseen yet
    release()
    await finishing
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: unseen: a step resume brings back a dismissed band, and its completion is judged anew`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    const b = await bandOf($, surface)
    await b.ui.press({ key: 'savvy-dismiss' })
    expect(await labelNow($, surface)).toBeUndefined()
    await resume($, 'a1')
    expect(await labelNow($, surface)).toBe(SHOWN)
    await finish($, 'a1')
    expect(await labelNow($, surface)).toBe(SHOWN) // pane closed: unseen
    await openByCommand($)
    expect(await labelNow($, surface)).toBeUndefined()
    pane.isOpen = false
    await resume($, 'a1')
    await openByCommand($)
    await finish($, 'a1') // pane placed and open
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: agents: a step resume leaves a dismissed band dismissed, as before`, AGENTS, async ($, on) => {
    setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    const b = await bandOf($, surface)
    await b.ui.press({ key: 'savvy-dismiss' })
    await resume($, 'a1')
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: unseen: one mounted band follows completion, open, close and clear-on-close`, { options: { band: 'unseen', finished: 'clear-on-close' } }, async ($, on) => {
    setup(on)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    const label = async () => (await ui.find({ key: 'savvy-agents' }))?.props.label
    expect(await label()).toBeUndefined()
    await spawn($, 'a1')
    expect(await label()).toBe(SHOWN)
    await finish($, 'a1')
    expect(await label()).toBe(SHOWN)
    await openByCommand($)
    expect(await label()).toBeUndefined()
    await $.command.run({ command: 'agents-info' } as never) // toggles it closed
    expect(await label()).toBeUndefined()
    await spawn($, 'a2')
    expect(await label()).toBe(SHOWN)
    await finish($, 'a2')
    expect(await label()).toBe(SHOWN)
    await ui.press({ key: 'savvy-agents' })
    expect(await label()).toBeUndefined()
  })
}

// One after another: with completions at once a write may repeat, which the counter makes harmless.
test('unseen: a completion writes crewBand only on a real transition of a tracked run', UNSEEN, async ($, on) => {
  const pane = setup(on)
  await spawn($, 'a1')
  await spawn($, 'a2')
  const w = () => pane.writes
  const before = w()
  await finish($, 'ghost') // untracked
  expect(w()).toBe(before)
  await openByCommand($)
  await finish($, 'a1') // a2 runs
  expect(w()).toBe(before)
  await finish($, 'a2') // last, pane open, already seen
  expect(w()).toBe(before)
  pane.isOpen = false
  await spawn($, 'a3')
  const mid = w()
  await finish($, 'a3') // unseen: one write
  expect(w()).toBe(mid + 1)
  await finish($, 'ghost')
  expect(w()).toBe(mid + 1) // an untracked run, still nothing
})

// A completion that has read the pane list and waits: `finishing` resolves when released.
const paused = async ($: Engine, pane: ReturnType<typeof setup>, id: string) => {
  let release = () => {}
  pane.hold = new Promise<void>(r => (release = r))
  const reached = new Promise<void>(r => (pane.reached = r))
  const finishing = finish($, id)
  await reached
  return async () => (release(), await finishing)
}

for (const surface of SURFACES) {
  test(`${surface}: unseen: a completion that lands after a spawn leaves the new run shown, then unseen, then seen`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    const release = await paused($, pane, 'a1')
    await spawn($, 'a2')
    await release()
    expect(await labelNow($, surface)).toBe(SHOWN) // a2 runs
    await finish($, 'a2')
    expect(await labelNow($, surface)).toBe(SHOWN) // pane closed: unseen
    await openByCommand($)
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: unseen: a pane that closes after the completion read it placed counts as seen at the completion`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    await openByCommand($)
    const release = await paused($, pane, 'a1') // read: placed
    pane.isOpen = false
    await release()
    // The panel redrew with the result as the agent list changed, so it was seen.
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: unseen: two completions at once leave the results unseen, then seen`, UNSEEN, async ($, on) => {
    setup(on)
    await spawn($, 'a1')
    await spawn($, 'a2')
    await Promise.all([finish($, 'a1'), finish($, 'a2')])
    expect(await labelNow($, surface)).toBe(SHOWN)
    await openByCommand($)
    expect(await labelNow($, surface)).toBeUndefined()
  })

  // Any gap fails toward showing the band (an extra ✕), never toward hiding an unseen result.
  test(`${surface}: unseen: a slow completion that read the pane closed brings the band back even if the panel showed its result meanwhile`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    const release = await paused($, pane, 'a1') // its pane read said closed
    await spawn($, 'a2')
    await finish($, 'a2')
    await openByCommand($) // the panel shows both results, then closes
    pane.isOpen = false
    await release()
    expect(await labelNow($, surface)).toBe(SHOWN)
  })

  test(`${surface}: unseen: an open that is paused after it saw the pane drawn does not mark a result that came later`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await spawn($, 'a1')
    await finish($, 'a1') // unseen
    let release = () => {}
    pane.hold = new Promise<void>(r => (release = r))
    const reached = new Promise<void>(r => (pane.reached = r))
    const opening = openByCommand($) // marks seen: has read the results and the pane, waits
    await reached
    pane.isOpen = false
    await spawn($, 'a2')
    await finish($, 'a2') // pane closed: a new unseen result
    release()
    await opening
    expect(await labelNow($, surface)).toBe(SHOWN)
  })
}
