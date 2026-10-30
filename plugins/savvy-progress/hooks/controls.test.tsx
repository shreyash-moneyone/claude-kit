import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'savvy-progress'
const PANE = 'savvy-agents'
const MODEL = 'claude-sonnet-5-5'
const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } as const
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const AGENTS = { options: { band: 'agents' } } as const

// The world beneath the plugin. `pane.isOpen` stands for the engine's pane list.
const setup = (on: On) => {
  mock.clock(on)
  const pane = { isOpen: false, opened: 0, closed: 0 }
  on('ui.open', () => ((pane.isOpen = true), pane.opened++, { value: { isPlaced: true } }))
  on('ui.close', () => ((pane.isOpen = false), pane.closed++, { value: undefined }) as never)
  on('ui.panes', () => ({ value: pane.isOpen ? [{ id: PANE }] : [] }) as never)
  on('agent.spawn', (_$, e) => ({ model: MODEL, agentId: e.tool_use_id }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="bottom" /> as never
  })
  return pane
}

const spawn = async ($: Engine, id: string, subagentType = 'general-purpose') => {
  await $.agent.spawn({ tool_use_id: id, prompt: 'p', description: `Work ${id}`, subagentType, provider: 'engine', parentModel: MODEL, background: false, fork: false } as never)
}

const finish = async ($: Engine, id: string) => {
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: id, reason: 'answer', answer: 'ok', usage: null })
}

// N agents, `done` of them finished.
const crew = async ($: Engine, running: number, done: number) => {
  for (let i = 0; i < done + running; i++) await spawn($, `a${i}`)
  for (let i = 0; i < done; i++) await finish($, `a${i}`)
}

// What the band shows: the toggle's label, the counts text, the crabs drawn, and the buttons.
const bandOf = async ($: Engine, surface: Surface) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
  const toggle = await ui.find({ key: 'savvy-agents' })
  const svg = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('\n')
  const shows = async (text: string) =>
    surface === 'desktop' ? svg.includes(`>${text}<`) : (await ui.find({ type: 'Text', text: new RegExp(`^${text}$`) })) !== undefined
  const crabs = surface === 'desktop' ? (svg.match(/<g class="c-\w+/g) ?? []).length : (await ui.findAll({ type: 'Text', text: '▣' })).length
  const more = surface === 'desktop' ? />\+(\d+)</.exec(svg)?.[1] : undefined
  return { ui, label: toggle?.props.label as string | undefined, plain: toggle?.props.plain, shows, crabs, more, hasX: (await ui.find({ key: 'savvy-dismiss' })) !== undefined }
}

for (const surface of SURFACES) {
  test(`${surface}: the toggle reads "Show panel ▸" while the pane is closed and "Hide panel ◂" while open`, AGENTS, async ($, on) => {
    setup(on)
    await crew($, 1, 0)
    const closed = await bandOf($, surface)
    expect(closed.label).toBe('Show panel ▸')
    expect(closed.plain).toBeFalsy()
    await $.command.run({ command: 'agents-info', args: 'open' } as never)
    expect((await bandOf($, surface)).label).toBe('Hide panel ◂')
  })

  test(`${surface}: pressing the toggle opens the pane, then closes it`, AGENTS, async ($, on) => {
    const pane = setup(on)
    await crew($, 1, 0)
    const first = await bandOf($, surface)
    await first.ui.press({ key: 'savvy-agents' })
    expect(pane).toMatchObject({ isOpen: true, opened: 1 })
    await first.ui.unmount()
    const second = await bandOf($, surface)
    expect(second.label).toBe('Hide panel ◂')
    await second.ui.press({ key: 'savvy-agents' })
    expect(pane).toMatchObject({ isOpen: false, closed: 1 })
  })

  for (const [running, done, text] of [
    [2, 5, '2 running · 5 done'],
    [0, 3, '3 done'],
    [2, 0, '2 running'],
  ] as const) {
    test(`${surface}: counts read "${text}" for ${running} running and ${done} done`, AGENTS, async ($, on) => {
      setup(on)
      await crew($, running, done)
      const b = await bandOf($, surface)
      expect(await b.shows(text)).toBe(true)
    })
  }

  test(`${surface}: one crab per running agent, five at most, then +N`, AGENTS, async ($, on) => {
    setup(on)
    await crew($, 3, 2)
    expect((await bandOf($, surface)).crabs).toBe(3)
    await spawn($, 'x1')
    await spawn($, 'x2')
    await spawn($, 'x3')
    const many = await bandOf($, surface)
    expect(many.crabs).toBe(5)
    if (surface === 'desktop') expect(many.more).toBe('1')
  })

  test(`${surface}: with nothing running one crab stands in`, AGENTS, async ($, on) => {
    setup(on)
    await crew($, 0, 2)
    expect((await bandOf($, surface)).crabs).toBe(1)
  })

  test(`${surface}: the flow band has the toggle and no ×N`, async ($, on) => {
    setup(on)
    await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'Ship it', total: 4, done: 1, phase: 'delegate' } as never)
    await spawn($, 'a1')
    const b = await bandOf($, surface)
    expect(b.label).toBe('Show panel ▸')
    expect(b.hasX).toBe(true)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect((await ui.findAll({ type: 'Button', text: /×/ })).length).toBe(0)
  })
}

const CLEARING = { options: { band: 'agents', finished: 'clear-on-close' } } as const

for (const surface of SURFACES) {
  test(`${surface}: after a clear the counts leave out the cleared agents`, CLEARING, async ($, on) => {
    setup(on)
    await crew($, 0, 3)
    const run = $.command.run as (e: unknown) => Promise<unknown>
    await run({ command: 'agents-info', args: '' }) // opens
    await run({ command: 'agents-info', args: '' }) // closes: clears
    const none = await bandOf($, surface)
    expect(await none.shows('No agents running')).toBe(true)
    await none.ui.unmount()
    await spawn($, 'x1')
    expect(await (await bandOf($, surface)).shows('1 running')).toBe(true)
  })
}

for (const surface of SURFACES) {
  // The pane list is not reactive: a band already drawn must be asked to draw again when the pane closes.
  test(`${surface}: a mounted band flips its label when the pane closes by the ui.close path`, AGENTS, async ($, on) => {
    setup(on)
    await crew($, 1, 0)
    const run = $.command.run as (e: unknown) => Promise<unknown>
    await run({ command: 'agents-info', args: 'open' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect((await ui.find({ key: 'savvy-agents' }))?.props.label).toBe('Hide panel ◂')
    await run({ command: 'agents-info', args: '' }) // closes: ui.close
    expect((await ui.find({ key: 'savvy-agents' }))?.props.label).toBe('Show panel ▸')
    await run({ command: 'agents-info', args: 'open' }) // opens again: ui.open
    expect((await ui.find({ key: 'savvy-agents' }))?.props.label).toBe('Hide panel ◂')
  })

  // The flow band keeps its toggle in the width it is given: title and bar give way, the row does not wrap.
  test(`${surface}: the flow band fits a narrow row with the full toggle label`, async ($, on) => {
    setup(on)
    const title = 'A very long flow title that keeps going on and on'
    await $.tool.call({ tool: 'mcp__savvy-progress__progress', title, total: 4, done: 1, phase: 'delegate' } as never)
    const cols = 80
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...band, bodyColumns: cols } })
    const toggle = String((await ui.find({ key: 'savvy-agents' }))?.props.label)
    expect(toggle).toBe('Show panel ▸')
    if (surface === 'desktop') {
      const svg = (await ui.findAll({ type: 'Svg' }))[0]
      // The Svg (8px a column) leaves room for the button (label and 4 cells of decoration), the ✕ and two gaps.
      expect(Number(svg?.props.width) + (toggle.length + 4 + 3 + 2) * 8).toBeLessThanOrEqual(cols * 8)
    } else {
      const titleBox = (await ui.findAll({ type: 'Box' })).find(b => b.props.width !== undefined)
      const bar = (await ui.findAll({ type: 'Text', text: /^[█░]+$/ }))[0]
      // title box, bar, "Tasks 1/4", "25%", the crab, the button (label and 4 cells), the ✕, and six 2-cell gaps.
      const used = Number(titleBox?.props.width) + String((bar as { text?: string } | undefined)?.text ?? '').length + 'Tasks 1/4'.length + '25%'.length + 1 + (toggle.length + 4) + 3 + 12
      expect(used).toBeLessThanOrEqual(cols)
    }
  })
}

test('desktop: the live dot pulses while an agent runs and rests when none does', AGENTS, async ($, on) => {
  setup(on)
  await crew($, 1, 0)
  const live = async () => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
    const src = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('\n')
    await ui.unmount()
    return /<circle class="live"/.test(src)
  }
  expect(await live()).toBe(true)
  await finish($, 'a0')
  expect(await live()).toBe(false)
})
