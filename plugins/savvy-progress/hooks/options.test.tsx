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

// -- the band without a flow fits the window: 7 running and 2 done agents

type Drawn = { type?: string; props?: Record<string, unknown>; children?: (Drawn | string | null)[] }
const kidsOf = (n: Drawn | undefined): Drawn[] => (n?.children ?? []).filter((c): c is Drawn => typeof c === 'object' && c !== null)
const nodes = (n: Drawn | string | null | undefined): Drawn[] => (typeof n === 'object' && n ? [n, ...(n.children ?? []).flatMap(nodes)] : [])
const textOf = (n: Drawn): string => (n.children ?? []).filter((c): c is string => typeof c === 'string').join('')

const crowd = async ($: Engine, on: On) => {
  setup(on)
  // The session's start is where the language is read.
  on('session.start', () => ({ cwd: '/x' }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  await ($.session as unknown as { start: (e: unknown) => Promise<unknown> }).start({ source: 'startup', cwd: '/x' })
  for (let i = 0; i < 9; i++) await spawn($, `a${i}`)
  for (const id of ['a0', 'a1']) await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: id, reason: 'answer', answer: 'ok', usage: null })
}

// Cells of what the terminal draws, read from the tree: a Text is its characters (every one here is one cell wide), a Button
// `[ label ]` or, plain, the label alone, a Box its children with its own gap between them.
const cellsIn = (n: Drawn): number => {
  if (n.type === 'Text') return [...textOf(n)].length
  if (n.type === 'Button') return [...String(n.props?.label)].length + (n.props?.plain ? 0 : 4)
  const kids = kidsOf(n)
  return kids.reduce((sum, k) => sum + cellsIn(k), 0) + Number(n.props?.gap ?? 0) * Math.max(0, kids.length - 1)
}

const terminalRow = async ($: Engine, bodyColumns: number | undefined) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: { ...band, bodyColumns } as never })
  const row = nodes((await ui.drawn()) as unknown as Drawn).find(n => n.type === 'Box' && n.props?.gap === 2) as Drawn
  const texts = kidsOf(row).filter(k => k.type === 'Text').map(textOf)
  const crabs = nodes(row).filter(n => n.type === 'Text' && textOf(n) === '▣').length
  const more = nodes(row).map(textOf).find(t => /^\+\d+$/.test(t))
  const buttons = nodes(row).filter(n => n.type === 'Button')
  const keys = buttons.map(n => n.props?.key)
  const label = String(buttons[0]?.props?.label)
  await ui.unmount()
  return { cells: cellsIn(row), crabs, more, keys, texts, label }
}

const desktopRow = async ($: Engine, bodyColumns: number | undefined) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: { ...band, bodyColumns } as never })
  const svg = (await ui.findAll({ type: 'Svg' }))[0]
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.props.key)
  await ui.unmount()
  const source = String(svg?.props.source)
  return {
    width: Number(svg?.props.width),
    keys,
    crabs: (source.match(/<g class="c-/g) ?? []).length,
    hasTitle: source.includes('>Agents<'),
    counts: source.includes('running') ? 'long' : source.includes('7 · 2') ? 'short' : 'none',
    more: /font-size="12">(\+\d+)</.exec(source)?.[1],
  }
}

const KEYS = ['savvy-agents', 'savvy-dismiss']
const BAND = { options: { band: 'agents' } } as const

// English, 7 running and 2 done. The button is `[ Show panel ▸ ]` (16), the ✕ is 1, ● is 1; gaps are 2 between the row's children
// and 1 between crabs. A step costs: 5 crabs 64, 4 crabs 62, 3 crabs 60, 2 crabs 58, 1 crab 56 (name, crabs and `+N`, "7 running · 2 done"),
// then figures "7 · 2" 43, no name 35, no figures 28 (`+6` kept), no `+N` 25.
const TERMINAL = [
  [200, 5, 'Agents', '7 running · 2 done', '+2'],
  [64, 5, 'Agents', '7 running · 2 done', '+2'],
  [63, 4, 'Agents', '7 running · 2 done', '+3'],
  [62, 4, 'Agents', '7 running · 2 done', '+3'],
  [61, 3, 'Agents', '7 running · 2 done', '+4'],
  [60, 3, 'Agents', '7 running · 2 done', '+4'],
  [59, 2, 'Agents', '7 running · 2 done', '+5'],
  [58, 2, 'Agents', '7 running · 2 done', '+5'],
  [57, 1, 'Agents', '7 running · 2 done', '+6'],
  [56, 1, 'Agents', '7 running · 2 done', '+6'],
  [55, 1, 'Agents', '7 · 2', '+6'],
  [43, 1, 'Agents', '7 · 2', '+6'],
  [42, 1, undefined, '7 · 2', '+6'],
  [35, 1, undefined, '7 · 2', '+6'],
  [34, 1, undefined, undefined, '+6'],
  [28, 1, undefined, undefined, '+6'],
  [27, 1, undefined, undefined, undefined],
  [0, 1, undefined, undefined, undefined],
] as const

test('terminal: the crew band takes each step down at the width its cells run out', BAND, async ($, on) => {
  await crowd($, on)
  for (const [cols, crabs, title, counts, more] of TERMINAL) {
    const r = await terminalRow($, cols)
    expect({ cols, crabs: r.crabs, texts: r.texts, more: r.more, keys: r.keys }).toEqual({ cols, crabs, texts: ['●', ...(title ? [title] : []), ...(counts ? [counts] : [])], more, keys: KEYS })
    if (cols >= 25) expect(r.cells).toBeLessThanOrEqual(cols)
  }
  // No width reported: as 100 columns. Width 0: the last step.
  expect(await terminalRow($, undefined)).toEqual(await terminalRow($, 100))
  expect((await terminalRow($, 0)).cells).toBe(25)
})

// English desktop, hand-worked from the font estimate: the row is 338, 312, 286, 260, 234 px with 5 to 1 crabs, 156 with figures,
// 98 with no name, 66 with no figures, 44 with no `+N`; it must fit columns × 8 less the button, the ✕ and their gaps (192 px).
const DESKTOP = [
  [240, 5, 338, true, 'long', '+2'],
  [67, 5, 338, true, 'long', '+2'],
  [66, 4, 312, true, 'long', '+3'],
  [63, 4, 312, true, 'long', '+3'],
  [62, 3, 286, true, 'long', '+4'],
  [60, 3, 286, true, 'long', '+4'],
  [59, 2, 260, true, 'long', '+5'],
  [57, 2, 260, true, 'long', '+5'],
  [56, 1, 234, true, 'long', '+6'],
  [54, 1, 234, true, 'long', '+6'],
  [53, 1, 156, true, 'short', '+6'],
  [44, 1, 156, true, 'short', '+6'],
  [43, 1, 98, false, 'short', '+6'],
  [37, 1, 98, false, 'short', '+6'],
  [36, 1, 66, false, 'none', '+6'],
  [33, 1, 66, false, 'none', '+6'],
  [32, 1, 44, false, 'none', undefined],
  [0, 1, 44, false, 'none', undefined],
] as const

test('desktop: the crew band takes each step down at the width its pixels run out', BAND, async ($, on) => {
  await crowd($, on)
  for (const [cols, crabs, width, hasTitle, counts, more] of DESKTOP) {
    const r = await desktopRow($, cols)
    expect({ cols, crabs: r.crabs, width: r.width, hasTitle: r.hasTitle, counts: r.counts, more: r.more, keys: r.keys }).toEqual({ cols, crabs, width, hasTitle, counts, more, keys: KEYS })
    if (cols >= 33) expect(r.width + 192).toBeLessThanOrEqual(cols * 8)
  }
  expect(await desktopRow($, undefined)).toEqual(await desktopRow($, 100))
})

for (const language of ['ru', 'he'] as const) {
  test(`both surfaces: the crew band in ${language} keeps in budget, with fewer crabs as it narrows and its button and ✕ always`, { options: { band: 'agents', language } }, async ($, on) => {
    await crowd($, on)
    const floor = await terminalRow($, 0)
    // The narrowest row: ●, one crab, `[ label ]` and ✕, with 2-cell gaps.
    expect(floor.cells).toBe(1 + 1 + [...floor.label].length + 4 + 1 + 6)
    let last = 99
    for (const cols of [100, 80, 70, 60, 50, 40, 36, 30, 20, 0]) {
      const t = await terminalRow($, cols)
      expect(t.keys).toEqual(KEYS)
      if (cols >= floor.cells) expect(t.cells).toBeLessThanOrEqual(cols)
      expect(t.crabs).toBeLessThanOrEqual(last)
      last = t.crabs
      const d = await desktopRow($, cols)
      expect(d.keys).toEqual(KEYS)
      const isLast = d.crabs === 1 && d.counts === 'none' && !d.more
      if (!isLast) expect(d.width).toBeLessThanOrEqual(cols * 8 - ([...floor.label].length + 4 + 8) * 8)
    }
  })
}

test('desktop: Hebrew draws the crew band right to left', { options: { band: 'agents', language: 'he' } }, async ($, on) => {
  await crowd($, on)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: { ...band, bodyColumns: 100 } as never })
  const source = String((await ui.findAll({ type: 'Svg' }))[0]?.props.source)
  expect(source).toContain('direction="rtl"')
  await ui.unmount()
})
