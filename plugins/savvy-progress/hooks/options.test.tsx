import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'savvy-progress'
const MODEL = 'claude-sonnet-5-5'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } as const
const SURFACES = ['terminal', 'desktop'] as const

// What sits beneath the plugin's band: an empty row, so a band the plugin declines to draw mounts as that.
const bottomBand = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="bottom" /> as never
  })

// One finished subagent with a non-zero cost, and no savvy-flow report.
const setup = (on: On) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  bottomBand(on)
  on('agent.spawn', (_$, e) => ({ model: MODEL, agentId: e.tool_use_id }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
}

const ran = async ($: Engine, on: On, id = 'a1') => {
  setup(on)
  await spawn($, id)
  const usage = { model: MODEL, input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: id, reason: 'answer', answer: 'ok', usage })
}

const spawn = async ($: Engine, id: string) => {
  await $.agent.spawn({ tool_use_id: id, prompt: 'p', description: `Work ${id}`, subagentType: 'general-purpose', provider: 'engine', parentModel: MODEL, background: false, fork: false } as never)
}

// What the panel draws: whether any Text matches `re`, and the Svg sources with their alt text.
const panelDrawing = async ($: Engine, surface: (typeof SURFACES)[number], isCompact = false) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'savvy-agents', props: pane })
  if (isCompact) await ui.press({ key: 'compact' })
  const svgs = (await ui.findAll({ type: 'Svg' })).map(el => `${String(el.props.source)}${String(el.props.alt)}`).join('\n')
  const hasText = async (re: RegExp) => (await ui.findAll({ type: 'Text', text: re })).length > 0
  const drawn = async (re: RegExp) => re.test(svgs) || (await hasText(re))
  return { drawn }
}

const crewButton = async ($: Engine, surface: (typeof SURFACES)[number]) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
  const crew = await ui.find({ key: 'savvy-agents' })
  const dismiss = await ui.find({ key: 'savvy-dismiss' })
  const svg = (await ui.findAll({ type: 'Svg' })).length
  return { ui, label: crew?.props.label as string | undefined, hasDismiss: dismiss !== undefined, svg }
}

for (const surface of SURFACES) {
  test(`${surface}: cost is drawn by default`, async ($, on) => {
    await ran($, on)
    expect(await (await panelDrawing($, surface)).drawn(/≈\$\d/)).toBe(true)
  })

  test(`${surface}: cost "hide" draws no dollar figure in the panel, tokens and time stay`, { options: { cost: 'hide' } }, async ($, on) => {
    await ran($, on)
    const { drawn } = await panelDrawing($, surface)
    expect(await drawn(/\$/)).toBe(false)
    expect(await drawn(/≈/)).toBe(false)
    expect(await drawn(/2\.0M/)).toBe(true) // tokens
    expect(await drawn(/ctx /)).toBe(true)
  })

  test(`${surface}: cost "hide" draws no dollar figure in the collapsed panel`, { options: { cost: 'hide' } }, async ($, on) => {
    await ran($, on)
    const { drawn } = await panelDrawing($, surface, true)
    expect(await drawn(/\$/)).toBe(false)
    expect(await drawn(/2\.0M/)).toBe(true)
  })

  test(`${surface}: with the default band option, no flow means no band`, async ($, on) => {
    await ran($, on)
    const b = await crewButton($, surface)
    expect(b.label).toBeUndefined()
    expect(b.hasDismiss).toBe(false)
  })

  test(`${surface}: band "agents" shows a compact band once an agent has run`, { options: { band: 'agents' } }, async ($, on) => {
    setup(on)
    // Nothing has run yet: no band.
    expect((await crewButton($, surface)).label).toBeUndefined()

    await spawn($, 'a1')
    const b = await crewButton($, surface)
    expect(b.label).toBe('Show panel ▸')
    expect(b.hasDismiss).toBe(true)
    expect(b.svg).toBe(surface === 'desktop' ? 1 : 0)
  })

  test(`${surface}: band "agents" dismissed stays hidden until the next spawn`, { options: { band: 'agents' } }, async ($, on) => {
    await ran($, on)
    const shown = await crewButton($, surface)
    expect(shown.label).toBe('Show panel ▸')
    await shown.ui.press({ key: 'savvy-dismiss' })
    expect((await crewButton($, surface)).label).toBeUndefined()

    await spawn($, 'a2')
    expect((await crewButton($, surface)).label).toBe('Show panel ▸')
  })

  test(`${surface}: band "agents" leaves the flow band as it is`, { options: { band: 'agents' } }, async ($, on) => {
    mock.clock(on)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    bottomBand(on)
    on('agent.spawn', () => ({ model: MODEL, agentId: 'a1' }))
    await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'Ship it', total: 4, done: 1, phase: 'delegate' } as never)
    await spawn($, 'a1')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    const flowTexts = await ui.findAll({ type: 'Text', text: /^Tasks 1\/4$/ })
    expect(flowTexts.length).toBe(surface === 'terminal' ? 1 : 0)
    expect((await ui.find({ key: 'savvy-agents' }))?.props.label).toBe('Show panel ▸')
  })

  test(`${surface}: band "agents" dismissing the flow band hides both bands until the next spawn`, { options: { band: 'agents' } }, async ($, on) => {
    mock.clock(on)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    bottomBand(on)
    on('agent.spawn', (_$, e) => ({ model: MODEL, agentId: e.tool_use_id }) as never)
    await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'Ship it', total: 4, done: 1, phase: 'delegate' } as never)
    await spawn($, 'a1')

    const shown = await crewButton($, surface)
    expect(shown.hasDismiss).toBe(true)
    await shown.ui.press({ key: 'savvy-dismiss' })

    const hidden = await crewButton($, surface)
    expect(hidden.label).toBeUndefined()
    expect(hidden.hasDismiss).toBe(false)
    expect(await hidden.ui.findAll({ type: 'Text', text: /^Tasks 1\/4$/ })).toHaveLength(0)

    await spawn($, 'a2')
    expect((await crewButton($, surface)).label).toBe('Show panel ▸')
  })
}
