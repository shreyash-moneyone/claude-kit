import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { VERSION } from './register'

const PANE = 'savvy-agents'
const MODEL = 'claude-sonnet-5-5'
const UNSEEN = { options: { band: 'unseen' } } as const

// The world beneath the plugin: a stubbed pane list, and a record of every pane open/close and every state write.
const setup = (on: On, panes: unknown[] | null = []) => {
  mock.clock(on)
  const seen = { opened: 0, closed: 0, writes: [] as string[] }
  on('state.set', async (_$, e, next) => {
    seen.writes.push(String(e.key))
    return next(e)
  })
  on('ui.open', () => (seen.opened++, { value: { isPlaced: true } }) as never)
  on('ui.close', () => (seen.closed++, { value: undefined }) as never)
  // `null`: nothing answers ui.panes, so the call throws.
  if (panes) on('ui.panes', () => ({ value: panes }) as never)
  on('agent.spawn', (_$, e) => ({ model: MODEL, agentId: e.tool_use_id }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  return seen
}

const spawn = async ($: Engine, id: string) => {
  await $.agent.spawn({ tool_use_id: id, prompt: 'p', description: `SECRET-BRIEF ${id}`, subagentType: 'general-purpose', provider: 'engine', parentModel: MODEL, background: false, fork: false } as never)
}
const finish = async ($: Engine, id: string) => {
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: id, reason: 'answer', answer: 'ok', usage: null })
}
const stateOf = async ($: Engine) => ((await $.command.run({ command: 'agents-info', args: 'state' } as never)) as { text: string }).text

// Not testable here: the runner loads only code modules (a JSON import is refused: "is not named like code") and a test has no fs.
// Keep VERSION in register.tsx equal to `version` in .claude-plugin/plugin.json by hand (`claude plugin validate` shows the manifest's).
test('state: the readout\'s first line carries the version', UNSEEN, async ($, on) => {
  setup(on)
  const text = await stateOf($)
  expect(text.split('\n')[0]).toBe(`savvy-progress ${VERSION}`)
})

test('state: does not toggle the pane and writes nothing', UNSEEN, async ($, on) => {
  const seen = setup(on, [{ id: PANE, isPlaced: true, isShown: true }])
  await spawn($, 'a1')
  const writesBefore = seen.writes.length
  await stateOf($)
  await stateOf($)
  expect(seen.opened).toBe(0)
  expect(seen.closed).toBe(0)
  expect(seen.writes.length).toBe(writesBefore)
})

test('state: a finished, unseen run with an undrawn pane shows the flag, pane fields and ribbon', UNSEEN, async ($, on) => {
  setup(on, [{ id: PANE, title: 'Agents SECRET-TITLE', isPlaced: false }, { id: 'other', isPlaced: true, width: 40 }])
  await spawn($, 'done1')
  await finish($, 'done1')
  const text = await stateOf($)
  expect(text).toContain('band=unseen')
  expect(text).toContain('unseen: true')
  expect(text).toContain('"isPlaced":false')
  expect(text).toContain('"isPlaced":true')
  expect(text).toContain('isPaneOpen: true')
  expect(text).toContain('isPaneSeenable: false')
  expect(text).toContain('total 1')
  expect(text).toContain('done 1')
  expect(text).toContain('flow: none')
  expect(text).toContain('ribbon: shown')
  expect(text).not.toContain('SECRET-BRIEF')
  expect(text).not.toContain('SECRET-TITLE')
})

test('state: counts by status and lists only the running agentIds', UNSEEN, async ($, on) => {
  setup(on)
  await spawn($, 'run1')
  await spawn($, 'done1')
  await finish($, 'done1')
  const text = await stateOf($)
  expect(text).toContain('total 2 running 1 done 1 failed 0')
  expect(text).toContain('running ids: run1')
  expect(text).not.toContain('SECRET-BRIEF')
})

test('state: a throwing ui.panes prints an error line', UNSEEN, async ($, on) => {
  setup(on, null)
  on('ui.panes', () => {
    throw new Error('LEAK-SECRET-TITLE')
  })
  const text = await stateOf($)
  expect(text).toContain('panes: error\n')
  expect(text).not.toContain('LEAK-SECRET-TITLE')
  expect(text).not.toContain('no implementation')
  expect(text).toContain('isPaneOpen: false')
})

test('state: ribbon hidden when nothing is unseen and nothing runs', UNSEEN, async ($, on) => {
  setup(on)
  expect(await stateOf($)).toContain('ribbon: hidden')
})

test('state: a finished run seen with a placed pane open reads unseen false and ribbon hidden', UNSEEN, async ($, on) => {
  setup(on, [{ id: PANE, isPlaced: true, isShown: true }])
  await spawn($, 'a1')
  await finish($, 'a1')
  const text = await stateOf($)
  expect(text).toContain('total 1 running 0 done 1')
  expect(text).toContain('unseen: false')
  expect(text).toContain('ribbon: hidden')
})
