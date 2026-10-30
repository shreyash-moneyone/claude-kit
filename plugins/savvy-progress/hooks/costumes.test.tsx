import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'savvy-progress'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const ROTATE = { options: { costumes: 'rotate' } } as const

// An agent whose id starts with `o` runs on Opus, any other on Sonnet.
const setup = (on: On) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', (_$, e) => ({ model: e.tool_use_id.startsWith('o') ? 'claude-opus-5-5' : 'claude-sonnet-5-5', agentId: e.tool_use_id }) as never)
}

const spawn = async ($: Engine, id: string, subagentType = 'general-purpose') => {
  await $.agent.spawn({ tool_use_id: id, prompt: 'p', description: `Work ${id}`, subagentType, provider: 'engine', parentModel: 'claude-sonnet-5-5', background: false, fork: false } as never)
}

// Per agent id: the costume and the colour its row draws. The terminal has no costume, only the ▣ glyph's colour.
// `spawned` are the ids in spawn order: the terminal lists running agents newest first and its rows carry no id.
const looks = async ($: Engine, surface: Surface, spawned: string[]) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'savvy-agents', props: pane })
  const out: Record<string, { costume?: string; color?: string }> = {}
  if (surface === 'desktop') {
    for (const el of await ui.findAll({ type: 'Svg' })) {
      const src = String(el.props.source)
      const id = /Work (\w+)/.exec(src)?.[1]
      if (id) out[id] = { costume: /class="c-(\w+)/.exec(src)?.[1], color: /<tspan fill="(#\w+)"/.exec(src)?.[1] }
    }
  } else {
    const glyphs = await ui.findAll({ type: 'Text', text: '▣' })
    ;[...spawned].reverse().forEach((id, i) => {
      out[id] = { color: glyphs[i]?.props.color as string | undefined }
    })
  }
  await ui.unmount()
  return out
}

for (const surface of SURFACES) {
  test(`${surface}: costumes "savvy" draws a non-savvy agent as the plain crab in the neutral colour`, async ($, on) => {
    setup(on)
    await spawn($, 's1')
    const l = (await looks($, surface, ['s1'])).s1
    expect(l?.color).toBe('#888780')
    if (surface === 'desktop') expect(l?.costume).toBe('other')
  })

  test(`${surface}: colour follows the model family: Sonnet differs from Opus, two Sonnets match`, ROTATE, async ($, on) => {
    setup(on)
    await spawn($, 's1')
    await spawn($, 's2')
    await spawn($, 'o1')
    const l = await looks($, surface, ['s1', 's2', 'o1'])
    expect(l.s1?.color).toBe(l.s2?.color)
    expect(l.s1?.color).not.toBe(l.o1?.color)
    expect(l.s1?.color).not.toBe('#888780')
  })
}

test('desktop: "rotate" gives consecutive agents different costumes, and they stay put', ROTATE, async ($, on) => {
  setup(on)
  await spawn($, 's1')
  await spawn($, 's2')
  const first = await looks($, 'desktop', [])
  expect(first.s1?.costume).toBeDefined()
  expect(first.s1?.costume).not.toBe('other')
  expect(first.s1?.costume).not.toBe(first.s2?.costume)
  // Re-rendering, and a later spawn, leave the earlier costumes as they were.
  expect(await looks($, 'desktop', [])).toEqual(first)
  await spawn($, 's3')
  const later = await looks($, 'desktop', [])
  expect(later.s1).toEqual(first.s1)
  expect(later.s2).toEqual(first.s2)
  expect(later.s3?.costume).not.toBe(later.s2?.costume)
})

test('desktop: "rotate" lets Explore keep its costume', ROTATE, async ($, on) => {
  setup(on)
  await spawn($, 's1', 'Explore')
  await spawn($, 's2')
  const l = await looks($, 'desktop', [])
  expect(l.s1?.costume).toBe('explore')
  expect(l.s2?.costume).not.toBe('explore')
})

test('desktop: costumes "savvy" leaves Explore as it was', async ($, on) => {
  setup(on)
  await spawn($, 's1', 'Explore')
  expect((await looks($, 'desktop', [])).s1?.costume).toBe('explore')
})

const ORDER = ['fable', 'heavy', 'careful', 'medium', 'light', 'fable']

test('desktop: "rotate" deals fable, heavy, careful, medium, light and wraps; Explore takes no turn', ROTATE, async ($, on) => {
  setup(on)
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
  for (const [i, id] of ids.entries()) {
    await spawn($, id)
    // An Explore agent in the middle of the sequence must not use up a costume.
    if (i === 2) await spawn($, 'e1', 'Explore')
  }
  const l = await looks($, 'desktop', [])
  expect(ids.map(id => l[id]?.costume)).toEqual(ORDER)
  expect(l.e1?.costume).toBe('explore')
})

test('desktop: "rotate" still draws a run stored without a costume', ROTATE, async ($, on) => {
  setup(on)
  const run = { id: 'x1', type: 'savvy-light', description: 'Work x1', model: 'claude-sonnet-5-5', status: 'running', startedAt: 0, contextTokens: 0, contextMax: 1e6, tokens: 0, costUsd: 0, steps: 0, round: 1 }
  on('state.get', { plugin: PLUGIN, key: 'agents' } as never, (() => ({ value: { value: [run], version: 0 } })) as never)
  const l = await looks($, 'desktop', [])
  expect(l.x1?.costume).toBe('light')
})
