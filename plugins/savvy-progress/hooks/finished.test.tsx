import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'savvy-progress'
const PANE = 'savvy-agents'
const MODEL = 'claude-sonnet-5-5'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } as const
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const CLEAR = { options: { finished: 'clear-on-close' } } as const

const bottomBand = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="bottom" /> as never
  })

// The world beneath the plugin; the clock starts at 1000 ms and moves only when the test moves it.
const setup = (on: On) => {
  const clock = mock.clock(on, { now: 1000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // The pane is up, so `/agents-info` closes it: the plugin's own `$.ui.close`, origin `plugin`.
  on('ui.panes', () => ({ value: [{ id: PANE }] }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$, e) => ({ model: MODEL, agentId: e.tool_use_id }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  bottomBand(on)
  return clock
}

const spawn = async ($: Engine, id: string) => {
  await $.agent.spawn({ tool_use_id: id, prompt: 'p', description: `Work ${id}`, subagentType: 'general-purpose', provider: 'engine', parentModel: MODEL, background: false, fork: false } as never)
}

// One finished run of 1M input and 1M output tokens: 2.0M in the totals.
const finish = async ($: Engine, id: string) => {
  const usage = { model: MODEL, input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: id, reason: 'answer', answer: 'ok', usage })
}

// The test kit raises no `ui.close` of its own: the person's close mark (origin `person`) and an unload
// (origin `unload`) cannot be driven from a test, so only the plugin's own close is exercised.
const close = ($: Engine) => $.command.run({ command: 'agents-info', args: '' } as never)

const panel = async ($: Engine, surface: Surface) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: pane })
  const svgs = (await ui.findAll({ type: 'Svg' })).map(el => `${String(el.props.source)}${String(el.props.alt)}`).join('\n')
  const drawn = async (re: RegExp) => re.test(svgs) || (await ui.findAll({ type: 'Text', text: re })).length > 0
  const done = (await ui.find({ key: 'done' }))?.props.label as string | undefined
  const rows = svgs.match(/Work a\d/g) ?? []
  const terminalRows = (await ui.findAll({ type: 'Text', text: /^Work a\d$/ })).length
  const found = { drawn: await Promise.all([/No subagents yet\./, /Running · 1/, /2\.0M/, /≈\$12\.0/].map(async re => [re.source, await drawn(re)] as const)), done, rows: surface === 'desktop' ? new Set(rows).size : terminalRows }
  await ui.unmount()
  return { ...found, drawn: (re: RegExp) => Boolean(found.drawn.find(([src]) => src === re.source)?.[1]) }
}

const crew = async ($: Engine, surface: Surface) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
  const label = (await ui.find({ key: 'savvy-agents' }))?.props.label as string | undefined
  await ui.unmount()
  return label
}

for (const surface of SURFACES) {
  test(`${surface}: finished "keep" shows the finished agent after the pane closes`, async ($, on) => {
    setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    await close($)
    expect((await panel($, surface)).done).toBe('▾ Finished · 1')
  })

  {
    test(`${surface}: "clear-on-close" hides finished agents after the pane closes`, CLEAR, async ($, on) => {
      setup(on)
      await spawn($, 'a1')
      await finish($, 'a1')
      expect((await panel($, surface)).done).toBe('▾ Finished · 1')
      await close($)
      const after = await panel($, surface)
      expect(after.done).toBeUndefined()
      expect(after.rows).toBe(0)
      expect(after.drawn(/No subagents yet\./)).toBe(true)
    })
  }

  test(`${surface}: "clear-on-close" keeps a running agent and shows one that finishes after the clear`, CLEAR, async ($, on) => {
    const clock = setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    await spawn($, 'a2')
    await close($)
    const running = await panel($, surface)
    expect(running.drawn(/Running · 1/)).toBe(true)
    expect(running.done).toBeUndefined()

    await clock.advance(10)
    await finish($, 'a2')
    const after = await panel($, surface)
    expect(after.done).toBe('▾ Finished · 1')
    expect(after.rows).toBe(1)
  })

  test(`${surface}: "clear-on-close" leaves the header totals covering every agent`, CLEAR, async ($, on) => {
    setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    await close($)
    const after = await panel($, surface)
    expect(after.done).toBeUndefined()
    expect(after.drawn(/2\.0M/)).toBe(true)
    expect(after.drawn(/≈\$12\.0/)).toBe(true)
  })

  test(`${surface}: "clear-on-close" counts only the visible crew in the band`, { options: { finished: 'clear-on-close', band: 'agents' } }, async ($, on) => {
    setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    await spawn($, 'a2')
    expect(await crew($, surface)).toBe('×2')
    await close($)
    expect(await crew($, surface)).toBe('×1')
  })

  // The cut is who had finished at the close, not when: the same clock tick must not hide a later finisher.
  test(`${surface}: "clear-on-close" shows an agent that finishes after the close at the same clock time`, CLEAR, async ($, on) => {
    setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    await close($)
    await spawn($, 'a2')
    await finish($, 'a2')
    const after = await panel($, surface)
    expect(after.done).toBe('▾ Finished · 1')
    expect(after.rows).toBe(1)
  })

  test(`${surface}: "clear-on-close" keeps an earlier clear hidden when another agent finishes`, CLEAR, async ($, on) => {
    const clock = setup(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    await close($)
    await spawn($, 'a2')
    await clock.advance(10)
    await finish($, 'a2')
    await spawn($, 'a3')
    await finish($, 'a3')
    expect((await panel($, surface)).done).toBe('▾ Finished · 2')
    await close($)
    expect((await panel($, surface)).done).toBeUndefined()
  })

  test(`${surface}: "clear-on-close" survives a stored value of the old shape`, CLEAR, async ($, on) => {
    setup(on)
    // Until the plugin writes it, the stored value is the old `{ at }` shape.
    let isOld = true
    on('state.get', { plugin: PLUGIN, key: 'cleared' } as never, ((_$: unknown, e: unknown, next: (e: unknown) => unknown) => (isOld ? { value: { value: { at: 5000 }, version: 0 } } : next(e))) as never)
    on('state.set', { plugin: PLUGIN, key: 'cleared' } as never, ((_$: unknown, e: unknown, next: (e: unknown) => unknown) => ((isOld = false), next(e))) as never)
    await spawn($, 'a1')
    await finish($, 'a1')
    expect((await panel($, surface)).done).toBe('▾ Finished · 1')
    await close($)
    expect((await panel($, surface)).done).toBeUndefined()
  })

  // A resumed agent (SendMessage) goes back to running: when it finishes again it is new to the panel.
  test(`${surface}: "clear-on-close" shows a cleared agent that runs again and finishes again`, CLEAR, async ($, on) => {
    setup(on)
    on('turn.step', async function* () {
      return { turnId: 'turn', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: MODEL, input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
    })
    await spawn($, 'a1')
    await finish($, 'a1')
    await close($)
    expect((await panel($, surface)).done).toBeUndefined()

    const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 'turn', index: 0, model: MODEL, messageCount: 1, agentId: 'a1' })
    for await (const _ of stream) void _
    expect((await panel($, surface)).done).toBeUndefined() // running: listed under Running
    await finish($, 'a1')
    expect((await panel($, surface)).done).toBe('▾ Finished · 1')
  })
}
