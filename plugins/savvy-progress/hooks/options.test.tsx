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

// -- the band without a flow fits the window: 7 running and 2 done agents at 30, 40, 60 and 100 columns

type Drawn = { type?: string; props?: Record<string, unknown>; children?: (Drawn | string)[] }
const nodes = (n: Drawn | string | undefined): Drawn[] => (typeof n === 'object' ? [n, ...(n.children ?? []).flatMap(nodes)] : [])
const textOf = (n: Drawn): string => (n.children ?? []).filter((c): c is string => typeof c === 'string').join('')

const crowd = async ($: Engine, on: On, isBooted = false) => {
  setup(on)
  if (isBooted) {
    // The session's start is where the language is read.
    on('session.start', () => ({ cwd: '/x' }) as never)
    on('tool.register', () => ({ value: undefined }) as never)
    on('command.register', () => ({ value: undefined }) as never)
    await ($.session as unknown as { start: (e: unknown) => Promise<unknown> }).start({ source: 'startup', cwd: '/x' })
  }
  for (let i = 0; i < 9; i++) await spawn($, `a${i}`)
  for (const id of ['a0', 'a1']) await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: id, reason: 'answer', answer: 'ok', usage: null })
}

const BUTTON_CELLS = 'Show panel ▸'.length + 4
const COLUMNS = [30, 40, 60, 100] as const

// The terminal row, reckoned from what it draws: cells of text, 2 per crab with its gap, the buttons, and 2 between the row's children.
const terminalRow = async ($: Engine, bodyColumns: number) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: { ...band, bodyColumns } as never })
  const row = nodes((await ui.drawn()) as unknown as Drawn).find(n => n.type === 'Box' && n.props?.gap === 2)
  const kids = row?.children as Drawn[]
  const crabs = nodes(row).filter(n => n.type === 'Text' && textOf(n) === '▣').length
  const cells = kids.reduce((sum, k) => {
    if (k.type === 'Button') return sum + (k.props?.key === 'savvy-agents' ? BUTTON_CELLS : 3)
    if (k.type === 'Box') return sum + (k.children ?? []).reduce((s, c) => s + (typeof c === 'object' && textOf(c) === '▣' ? 2 : [...textOf(c as Drawn)].length + 1), 0) - 1
    return sum + [...textOf(k)].length
  }, 2 * (kids.length - 1))
  const keys = nodes(row).filter(n => n.type === 'Button').map(n => n.props?.key)
  const texts = kids.filter(k => k.type === 'Text').map(textOf)
  await ui.unmount()
  return { cells, crabs, keys, texts }
}

const desktopRow = async ($: Engine, bodyColumns: number) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: { ...band, bodyColumns } as never })
  const svg = (await ui.findAll({ type: 'Svg' }))[0]
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.props.key)
  await ui.unmount()
  const source = String(svg?.props.source)
  return { width: Number(svg?.props.width), source, keys, crabs: (source.match(/<g class="c-/g) ?? []).length }
}

test('terminal: the crew band fits 30, 40, 60 and 100 columns, keeping the button and the ✕ and fewer crabs as it narrows', { options: { band: 'agents' } }, async ($, on) => {
  await crowd($, on)
  const rows = []
  for (const cols of COLUMNS) rows.push({ cols, ...(await terminalRow($, cols)) })
  for (const r of rows) {
    expect(r.cells).toBeLessThanOrEqual(r.cols)
    expect(r.keys).toEqual(['savvy-agents', 'savvy-dismiss'])
    expect(r.crabs).toBeGreaterThanOrEqual(1)
  }
  const crabs = rows.map(r => r.crabs)
  expect(crabs).toEqual([...crabs].sort((a, b) => a - b))
  expect(crabs.at(-1)).toBe(5)
  // Wide: the row as it always was.
  expect(rows.at(-1)?.texts).toEqual(['●', 'Agents', '7 running · 2 done'])
  // Narrower: figures only, then no name.
  expect(rows[1]?.texts.at(-1)).toBe('7 · 2')
  expect(rows[0]?.texts).not.toContain('Agents')
})

test('desktop: the crew band fits 30, 40, 60 and 100 columns, keeping the button and the ✕ and fewer crabs as it narrows', { options: { band: 'agents' } }, async ($, on) => {
  await crowd($, on)
  const rows = []
  for (const cols of COLUMNS) rows.push({ cols, ...(await desktopRow($, cols)) })
  for (const r of rows) {
    // The Svg, then the button and the ✕ with their gaps, at about 8 px per column.
    expect(r.width + (BUTTON_CELLS + 8) * 8).toBeLessThanOrEqual(r.cols * 8)
    expect(r.keys).toEqual(['savvy-agents', 'savvy-dismiss'])
    expect(r.crabs).toBeGreaterThanOrEqual(1)
  }
  const crabs = rows.map(r => r.crabs)
  expect(crabs).toEqual([...crabs].sort((a, b) => a - b))
  expect(crabs.at(-1)).toBe(5)
  expect(rows.at(-1)?.source).toContain('7 running · 2 done')
  expect(rows.at(-1)?.source).toContain('Agents')
  expect(rows[1]?.source).not.toContain('running')
  expect(rows[0]?.source).not.toContain('Agents')
})

test('desktop: a wide window draws the crew band as one fixed Svg, whatever its width', { options: { band: 'agents' } }, async ($, on) => {
  await crowd($, on)
  const a = await desktopRow($, 100)
  const b = await desktopRow($, 240)
  expect(b.source).toBe(a.source)
  expect(b.width).toBe(a.width)
})

test('both surfaces: Hebrew keeps the crew band in budget, right to left, with its button and ✕', { options: { band: 'agents', language: 'he' } }, async ($, on) => {
  await crowd($, on, true)
  const wide = await desktopRow($, 100)
  expect(wide.source).toContain('direction="rtl"')
  expect(wide.source).toContain('בעבודה')
  for (const cols of [30, 40, 60]) {
    const d = await desktopRow($, cols)
    expect(d.width + (BUTTON_CELLS + 8) * 8).toBeLessThanOrEqual(cols * 8)
    expect(d.keys).toEqual(['savvy-agents', 'savvy-dismiss'])
    const t = await terminalRow($, cols)
    expect(t.cells).toBeLessThanOrEqual(cols)
    expect(t.keys).toEqual(['savvy-agents', 'savvy-dismiss'])
  }
})
