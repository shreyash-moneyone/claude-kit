import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'savvy-progress'
const PANE = 'savvy-agents'
const MODEL = 'claude-sonnet-5-5'
const band = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } as const
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const UNSEEN = { options: { band: 'unseen', language: 'en' } } as const
const AGENTS = { options: { band: 'agents', language: 'en' } } as const
const FLOW = { options: { band: 'flow', language: 'en' } } as const
// The ribbon is drawn (its toggle's own label follows the pane list, so only its presence counts).
const SHOWN = 'shown'

// The world beneath the plugin: `pane.listed` false lists no pane at all; `isPlaced` / `isShown` are the fields of the one listed.
// `calls` counts ui.panes reads; `hold` answers the next one late (read now, answered later).
const setup = (on: On) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const pane = {
    listed: true,
    isPlaced: true,
    isShown: true as boolean | undefined,
    calls: 0,
    throws: false,
    crewWrites: 0,
    hold: undefined as Promise<void> | undefined,
    reached: () => {},
    clock,
  }
  on('state.set', async (_$, e, next) => {
    const set = await next(e)
    if (e.key === 'crewBand' && (set as unknown as { value?: { isSet?: boolean } }).value?.isSet) pane.crewWrites++
    return set
  })
  on('ui.panes', async () => {
    pane.calls++
    if (pane.throws) throw new Error('boom')
    const listed = pane.listed ? [{ id: PANE, isPlaced: pane.isPlaced, ...(pane.isShown === undefined ? {} : { isShown: pane.isShown }) }] : []
    const hold = pane.hold
    pane.hold = undefined
    if (hold) pane.reached()
    await hold
    return { value: listed } as never
  })
  on('session.attach', (_$, e) => ({ clientId: e.clientId }) as never)
  on('session.detach', (_$, e) => ({ clientId: e.clientId }) as never)
  on('agent.spawn', (_$, e) => ({ model: MODEL, agentId: e.resume?.agentId ?? e.tool_use_id }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="bottom" /> as never
  })
  return pane
}

const spawn = async ($: Engine, id: string) => {
  await $.agent.spawn({ tool_use_id: id, prompt: 'p', description: `Work ${id}`, subagentType: 'general-purpose', provider: 'engine', parentModel: MODEL, background: false, fork: false } as never)
}
const finish = async ($: Engine, id: string) => {
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: id, reason: 'answer', answer: 'ok', usage: null })
}
const attach = ($: Engine, surface = 'desktop') => ($.session.attach as (e: unknown) => Promise<unknown>)({ surface, clientId: `${surface}:SECRET-CLIENT`, viewport: { columns: 99, rows: 41 } })
const detach = ($: Engine, reason = 'detach', surface = 'desktop') => ($.session.detach as (e: unknown) => Promise<unknown>)({ surface, clientId: `${surface}:SECRET-CLIENT`, reason })
const stateOf = async ($: Engine) => ((await $.command.run({ command: 'agents-info', args: 'state' } as never)) as { text: string }).text

const labelNow = async ($: Engine, surface: Surface) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
  const label = (await ui.find({ key: 'savvy-agents' })) === undefined ? undefined : SHOWN
  await ui.unmount()
  return label
}

// The session's start: registers the tools and starts the 1-second timer (`language` set so no env lookup is needed).
const boot = async ($: Engine, on: On) => {
  on('session.start', () => ({ cwd: '/x' }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  await ($.session as unknown as { start: (e: unknown) => Promise<unknown> }).start({ source: 'startup', cwd: '/x' })
}

// The reported case: the result lands while the person is in another session (the pane is not drawn).
const unseenResult = async ($: Engine, pane: ReturnType<typeof setup>, id = 'a1') => {
  pane.isPlaced = false
  await spawn($, id)
  await finish($, id)
}

for (const surface of SURFACES) {
  test(`${surface}: attach after the pane became placed and shown clears an unseen ribbon (S1)`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await unseenResult($, pane)
    expect(await labelNow($, surface)).toBe(SHOWN)
    pane.isPlaced = true
    await attach($)
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: attach while the pane is placed but behind another tab stays unseen (S2)`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await unseenResult($, pane)
    pane.isPlaced = true
    pane.isShown = false
    await attach($)
    expect(await labelNow($, surface)).toBe(SHOWN)
  })

  test(`${surface}: attach with no pane listed stays unseen (S3)`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await unseenResult($, pane)
    pane.listed = false
    await attach($)
    expect(await labelNow($, surface)).toBe(SHOWN)
  })

  test(`${surface}: the timer clears an unseen ribbon once the pane is placed and shown, with no attach (S4)`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await boot($, on)
    await unseenResult($, pane)
    await pane.clock.advance(1000)
    expect(await labelNow($, surface)).toBe(SHOWN)
    pane.isPlaced = true
    await pane.clock.advance(1000)
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: a result completing with the pane placed but behind a tab is unseen, then seen once it is shown (S6)`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await boot($, on)
    pane.isShown = false
    await spawn($, 'a1')
    await finish($, 'a1')
    expect(await labelNow($, surface)).toBe(SHOWN)
    pane.isShown = true
    await pane.clock.advance(1000)
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: a result unseen behind a tab becomes seen on attach once shown (S6)`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    pane.isShown = false
    await spawn($, 'a1')
    await finish($, 'a1')
    pane.isShown = true
    await attach($)
    expect(await labelNow($, surface)).toBeUndefined()
  })

  test(`${surface}: a newer result that lands between the attach's crewBand read and its write stays unseen (S7)`, UNSEEN, async ($, on) => {
    const pane = setup(on)
    await unseenResult($, pane, 'a1')
    pane.isPlaced = true
    let release = () => {}
    pane.hold = new Promise<void>(r => (release = r))
    const reached = new Promise<void>(r => (pane.reached = r))
    const attaching = attach($) // has read crewBand (a1 unseen), asks the pane list, waits
    await reached
    pane.isPlaced = false
    await spawn($, 'a2')
    await finish($, 'a2') // pane not drawn: a newer unseen result
    release()
    await attaching
    expect(await labelNow($, surface)).toBe(SHOWN)
  })
}

test('agents: attach and the timer never write crewBand (S9)', AGENTS, async ($, on) => {
  const pane = setup(on)
  await boot($, on)
  await spawn($, 'a1')
  await finish($, 'a1')
  const before = pane.crewWrites
  await attach($)
  await pane.clock.advance(3000)
  expect(pane.crewWrites).toBe(before)
})

test('flow: attach and the timer never write crewBand (S9)', FLOW, async ($, on) => {
  const pane = setup(on)
  await boot($, on)
  await spawn($, 'a1')
  await finish($, 'a1')
  const before = pane.crewWrites
  await attach($)
  await pane.clock.advance(3000)
  expect(pane.crewWrites).toBe(before)
})

test('unseen: the timer asks the pane list nothing when nothing is unseen and nothing runs (S5)', UNSEEN, async ($, on) => {
  const pane = setup(on)
  await boot($, on)
  await pane.clock.advance(5000)
  expect(pane.calls).toBe(0)
  // Seen results: still nothing to ask.
  await spawn($, 'a1')
  await finish($, 'a1') // pane placed and shown: seen
  const before = pane.calls
  await pane.clock.advance(5000)
  expect(pane.calls).toBe(before)
})

test('unseen: attach with nothing unseen asks the pane list nothing', UNSEEN, async ($, on) => {
  const pane = setup(on)
  await attach($)
  expect(pane.calls).toBe(0)
})

test('unseen: attach returns what the engine answers', UNSEEN, async ($, on) => {
  setup(on)
  const result = (await attach($)) as { clientId?: string } | undefined
  expect(result?.clientId).toBe('desktop:SECRET-CLIENT')
})

const hhmmss = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

test('state: surfaces: none before any attach or detach (S8)', UNSEEN, async ($, on) => {
  setup(on)
  const text = await stateOf($)
  expect(text).toContain('\nsurfaces: none')
})

test('state: attach and detach are recorded with surface, reason and mod-clock time (S8)', UNSEEN, async ($, on) => {
  const pane = setup(on)
  await attach($, 'desktop')
  const t1 = pane.clock.now()
  await pane.clock.advance(39_000)
  await detach($, 'detach', 'desktop')
  const t2 = pane.clock.now()
  const text = await stateOf($)
  expect(text).toContain(`\nsurfaces: attach desktop ${hhmmss(t1)} · detach desktop detach ${hhmmss(t2)}`)
  expect(text).not.toContain('SECRET-CLIENT')
  expect(text).not.toContain('99')
})

test('state: the surface log keeps the newest 10 entries (S8)', UNSEEN, async ($, on) => {
  const pane = setup(on)
  for (let i = 0; i < 12; i++) {
    await attach($, i < 2 ? 'terminal' : 'desktop')
    await pane.clock.advance(1000)
  }
  const line = (await stateOf($)).split('\n').find(l => l.startsWith('surfaces:')) as string
  expect(line.split(' · ').length).toBe(10)
  expect(line).not.toContain('terminal')
})

test('state: stored state from before the log (no field) reads as empty and attach still works (S8)', UNSEEN, async ($, on) => {
  setup(on)
  on('state.get', { plugin: PLUGIN, key: 'surfaceLog' } as never, (() => ({ value: { value: undefined, version: 0 } })) as never)
  await attach($)
  expect(await stateOf($)).toContain('\nsurfaces: none')
})

test('state: prints isPaneSeenable true only when placed and shown; absent fields count as true (S8)', UNSEEN, async ($, on) => {
  const pane = setup(on)
  expect(await stateOf($)).toContain('isPaneSeenable: true')
  pane.isShown = false
  expect(await stateOf($)).toContain('isPaneSeenable: false')
  pane.isShown = undefined
  expect(await stateOf($)).toContain('isPaneSeenable: true')
  pane.isPlaced = false
  expect(await stateOf($)).toContain('isPaneSeenable: false')
  pane.isPlaced = true
  pane.listed = false
  expect(await stateOf($)).toContain('isPaneSeenable: false')
})

test('unseen: a throwing ui.panes counts as not visible on attach and on the timer', UNSEEN, async ($, on) => {
  const pane = setup(on)
  await boot($, on)
  await unseenResult($, pane)
  pane.throws = true
  await attach($)
  await pane.clock.advance(2000)
  expect(await labelNow($, 'terminal')).toBe(SHOWN)
})
