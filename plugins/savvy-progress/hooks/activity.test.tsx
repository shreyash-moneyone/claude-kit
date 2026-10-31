import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { AgentRun } from '../types'

const PLUGIN = 'savvy-progress'
const MODEL = 'claude-sonnet-5-5'
const PROGRESS = 'mcp__savvy-progress__progress'
const STEP = 'mcp__savvy-progress__step'
const ON = { options: { activity: 'on' } } as const

type World = ReturnType<typeof world>
type Run = AgentRun

// The world beneath the plugin: a mocked clock, and a bottom `tool.call` that records what reaches it.
const world = (on: On, tap?: ($: Engine, e: Record<string, unknown>) => Promise<void | Record<string, unknown>>) => {
  const clock = mock.clock(on)
  const seen: Record<string, unknown>[] = []
  const prompts: string[] = []
  // The test cannot read `$.state`; it watches the writes land instead: the last value of each atom and how many writes it took.
  const st = { writes: {} as Record<string, number>, value: {} as Record<string, unknown> }
  on('state.set', async (_$, e, next) => {
    const set = await next(e)
    if ((set as unknown as { value?: { isSet?: boolean } }).value?.isSet) {
      st.writes[e.key] = (st.writes[e.key] ?? 0) + 1
      st.value[e.key] = e.value
    }
    return set
  })
  // The engine's pane list: `/agents-info` and the band's button open and close the pane through it.
  const pane = { isOpen: false, closed: 0 }
  on('ui.open', () => ((pane.isOpen = true), { value: { isPlaced: true } }))
  on('ui.close', () => ((pane.isOpen = false), pane.closed++, { value: undefined }) as never)
  on('ui.panes', () => ({ value: pane.isOpen ? [{ id: 'savvy-agents' }] : [] }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="bottom" /> as never
  })
  on('agent.spawn', (_$, e) => {
    prompts.push(e.prompt)
    return { model: MODEL, agentId: e.resume?.agentId ?? e.tool_use_id } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  // A test holds a model step open by setting `gate.hold`; the step answers once it resolves.
  const gate: { hold?: Promise<void>; noUsage?: boolean } = {}
  on('turn.step', async function* () {
    await gate.hold
    return { turnId: 'turn', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: gate.noUsage ? null : { model: MODEL, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('tool.call', async ($$, e) => {
    seen.push(e as never)
    return ((await tap?.($$ as never, e as never)) ?? { result: 'ran' }) as never
  })
  return { clock, seen, prompts, st, pane, gate }
}

const spawn = async ($: Engine, id: string, o: { prompt?: string; type?: string; desc?: string } = {}) => {
  await $.agent.spawn({ tool_use_id: id, prompt: o.prompt ?? ' ', description: o.desc ?? `Work ${id}`, subagentType: o.type ?? 'general-purpose', provider: 'engine', parentModel: MODEL, background: false, fork: false } as never)
}

const finish = async ($: Engine, id: string, reason = 'answer', answer = 'ok') => {
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: id, reason, answer, usage: null })
}

// One model request of the worker: a resume flips a finished run back to running.
const resume = async ($: Engine, id: string) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 'turn', index: 0, model: MODEL, messageCount: 1, agentId: id })
  for await (const _ of stream) void _
}

const call = ($: Engine, agentId: string | undefined, tool: string, args: Record<string, unknown> = {}) => $.tool.call({ tool, ...(agentId ? { agentId } : {}), ...args } as never)

const runs = (w: World) => (w.st.value.agents ?? []) as Run[]
const run = (w: World, id: string) => runs(w).find(a => a.id === id)
const texts = (w: World, id: string) => (run(w, id)?.activity ?? []).map(a => a.text)
// How many writes each atom has taken so far.
const writes = (w: World) => ({ ...w.st.writes })
const OTHER_ATOMS = ['flow', 'panel', 'crewBand', 'cleared', 'rotation', 'now']
const others = (w: World) => Object.fromEntries(OTHER_ATOMS.map(k => [k, w.st.writes[k] ?? 0]))

// Whether any 4-character piece of the secret survives in the text.
const leaks = (text: string, secret: string): boolean => {
  for (let i = 0; i + 4 <= secret.length; i++) if (text.includes(secret.slice(i, i + 4))) return true
  return false
}

// ---------------------------------------------------------------------------
// activity: off (the default) leaves every behaviour and the stored shape as it was.

test('activity off: a worker\'s calls, brief and result are not recorded, and the run keeps its old shape', async ($, on) => {
  const w = world(on)
  await spawn($, 'a1', { prompt: 'Do it\npassword=hunter2xy' })
  const before = writes(w)
  await call($, 'a1', 'Bash', { command: 'ls' })
  expect(writes(w)).toEqual(before)
  await finish($, 'a1', 'answer', 'all done')
  const a = run(w, 'a1')
  expect(Object.keys(a ?? {}).sort()).toEqual(
    ['id', 'agentId', 'type', 'description', 'model', 'status', 'startedAt', 'endedAt', 'contextTokens', 'contextMax', 'tokens', 'costUsd', 'steps', 'round'].sort(),
  )
})

test('activity off: a step note is stored as the worker wrote it', async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  await call($, 'a1', STEP, { done: 1, total: 3, note: '  password=hunter2xy  ' })
  expect((run(w, 'a1'))?.stepNote).toBe('password=hunter2xy')
})

// ---------------------------------------------------------------------------
// The recorder: what a worker's tool call becomes in its run.

const EXTRACTORS: [name: string, tool: string, args: Record<string, unknown>, text: string][] = [
  ['Bash', 'Bash', { command: 'claude plugin test plugins/savvy-progress' }, 'Bash: claude plugin test plugins/savvy-progress'],
  ['Bash without a command', 'Bash', {}, 'Bash'],
  ['Read', 'Read', { file_path: '/x/y/register.tsx' }, 'Read register.tsx'],
  ['Edit', 'Edit', { file_path: '/x/y/register.tsx', old_string: 'a', new_string: 'b' }, 'Edit register.tsx'],
  ['Write', 'Write', { file_path: '/x/y/out.md', content: 'c' }, 'Write out.md'],
  ['NotebookEdit', 'NotebookEdit', { notebook_path: '/n/a.ipynb', new_source: 's' }, 'NotebookEdit a.ipynb'],
  ['Grep', 'Grep', { pattern: 'foo.*bar' }, 'Grep foo.*bar'],
  ['Glob', 'Glob', { pattern: '**/*.ts' }, 'Glob **/*.ts'],
  ['WebFetch', 'WebFetch', { url: 'https://example.com/a/b?q=1', prompt: 'p' }, 'WebFetch example.com'],
  ['WebFetch, malformed address', 'WebFetch', { url: 'not a url', prompt: 'p' }, 'WebFetch'],
  ['WebSearch', 'WebSearch', { query: 'crab costumes' }, 'WebSearch crab costumes'],
  ['Agent', 'Agent', { subagent_type: 'Explore', description: 'Find the thing', prompt: 'p' }, 'Agent: Find the thing'],
  ['an MCP tool', 'mcp__srv__lookup', {}, 'srv lookup'],
  ['any other tool', 'TodoWrite', { todos: [] }, 'TodoWrite'],
]

for (const [name, tool, args, text] of EXTRACTORS) {
  test(`activity on: ${name} is recorded as "${text}"`, ON, async ($, on) => {
    const w = world(on)
    await spawn($, 'a1')
    await call($, 'a1', tool, args)
    expect(texts(w, 'a1')).toEqual([text])
    expect((run(w, 'a1'))?.activity?.[0]?.at).toBe(0)
  })
}

// A worker's `cd <dir> &&` prefix would eat the 80 columns; it goes, and home shortens to `~`.
const CD_CASES: [name: string, command: string, text: string][] = [
  ['a leading cd &&', 'cd /Users/shreyash/Documents/work/finpro/FinProServer && npm test', 'Bash: npm test'],
  ['a quoted dir with a space and ;', 'cd "/Users/x/My Dir"; git diff --stat', 'Bash: git diff --stat'],
  ['a single-quoted dir', "cd '/tmp/a b' && ls", 'Bash: ls'],
  ['repeated cds', 'cd a && cd b && npm test', 'Bash: npm test'],
  ['whitespace and a line end around the cd', '  cd a \n && ls  ', 'Bash: ls'],
  ['a cd with nothing after it', 'cd /Users/x/proj', 'Bash: cd ~/proj'],
  ['a cd then only a separator', 'cd /tmp &&', 'Bash: cd /tmp &&'],
  ['a cd later in the command', 'ls && cd /tmp && ls', 'Bash: ls && cd /tmp && ls'],
  ['/home paths', 'cat /home/bob/proj/a.ts', 'Bash: cat ~/proj/a.ts'],
  ['/Users paths after the cd is gone', 'cd /tmp && cat /Users/x/a.ts /home/y/b.ts', 'Bash: cat ~/a.ts ~/b.ts'],
  ['a blob that only drops under 32 characters once ~ shortens it', 'echo /home/bob/Ab3defghijklmnopqrstuvwxyz12', 'Bash: echo •••'],
  ['a /Users blob that only drops under 32 characters once ~ shortens it', 'cat /Users/bob/Ab3defghijklmnopqrstuvwxyz123456', 'Bash: cat •••'],
  ['an escaped quote inside the cd dir', 'cd "foo\\" && echo secret" && ls', 'Bash: ls'],
  ['a secret behind an escaped quote in the cd dir', 'cd "x\\" && mysql -pS3cretPw" && ls', 'Bash: cd "x\\" && mysql -p•••'],
  ['a secret after a cd is still masked', 'cd /tmp && PGPASSWORD=S3cretPw psql', 'Bash: PGPASSWORD=••• psql'],
]

for (const [name, command, text] of CD_CASES) {
  test(`activity on: Bash with ${name} is recorded as "${text}"`, ON, async ($, on) => {
    const w = world(on)
    await spawn($, 'a1')
    await call($, 'a1', 'Bash', { command })
    expect(texts(w, 'a1')).toEqual([text])
    const dump = JSON.stringify(run(w, 'a1'))
    expect(dump).not.toContain('S3cretPw')
    expect(dump).not.toContain('Ab3defghij')
  })
}

test('activity on: an entry carries the time of the call', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  await w.clock.advance(7000)
  await call($, 'a1', 'Bash', { command: 'ls' })
  expect((run(w, 'a1'))?.activity).toEqual([{ at: 7000, text: 'Bash: ls' }])
})

test('activity on: a call without an agent id, or for an agent with no row, writes nothing', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  const before = writes(w)
  await call($, undefined, 'Bash', { command: 'ls' })
  await call($, 'ghost', 'Bash', { command: 'ls' })
  expect(writes(w)).toEqual(before)
  expect((run(w, 'a1'))?.activity).toBeUndefined()
})

test('activity on: a recorded call changes the agents list and nothing else', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  const before = others(w)
  const agentsBefore = w.st.writes.agents ?? 0
  await call($, 'a1', 'Bash', { command: 'ls' })
  expect(others(w)).toEqual(before)
  expect(w.st.writes.agents).toBe(agentsBefore + 1)
})

test('activity on: the plugin\'s own progress and step tools are not recorded and still work once', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  expect(await call($, undefined, PROGRESS, { title: 'Ship it', total: 2, phase: 'delegate' })).toMatchObject({ result: 'ok: Tasks 0/2' })
  expect(await call($, 'a1', PROGRESS, { title: 'Hijack' })).toMatchObject({ result: 'ignored: only the main session reports the flow' })
  expect(await call($, 'a1', STEP, { done: 1, total: 3, note: 'reading' })).toMatchObject({ result: 'ok' })
  expect(await call($, 'ghost', STEP, { done: 1 })).toMatchObject({ result: 'ignored: no panel row for agent ghost' })
  const a = run(w, 'a1')
  expect(a).toMatchObject({ stepDone: 1, stepTotal: 3, stepNote: 'reading' })
  expect(a?.activity).toBeUndefined()
  expect(w.seen).toEqual([])
})

test('activity on: an ordinary tool\'s bottom receives the unchanged event exactly once and its answer passes through', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  const answer = await call($, 'a1', 'Bash', { command: 'ls -la', description: 'list' })
  expect(answer).toMatchObject({ result: 'ran' })
  expect(w.seen).toHaveLength(1)
  expect(w.seen[0]).toMatchObject({ tool: 'Bash', command: 'ls -la', description: 'list', agentId: 'a1' })
})

// What a refusal from beneath the recorder does to the call is the same with the option on and off.
const refused = async ($: Engine, on: On) => {
  world(on, async (_$, e) => (e.command === 'rm -rf /' ? { deny: 'not that' } : undefined))
  await spawn($, 'a1')
  try {
    return await call($, 'a1', 'Bash', { command: 'rm -rf /' })
  } catch (err) {
    return `threw: ${String(err)}`
  }
}

test('activity off: a refusal from beneath passes through (the reference outcome)', async ($, on) => {
  expect(await refused($, on)).toEqual({ deny: 'not that' })
})

test('activity on: a refusal from beneath passes through exactly as with the option off', ON, async ($, on) => {
  expect(await refused($, on)).toEqual({ deny: 'not that' })
})

test('activity on: a worker\'s nested savvy Agent call still counts in flow.running while it runs', ON, async ($, on) => {
  let during: number | undefined
  const w: World = world(on, async (_$, e) => {
    if (e.tool === 'Agent') during = (w.st.value.flow as { running: number } | null)?.running
  })
  await spawn($, 'a1')
  await call($, 'a1', 'Agent', { subagent_type: 'savvy-light', description: 'Nested', prompt: 'p' })
  expect(during).toBe(1)
  expect((w.st.value.flow as { running: number }).running).toBe(0)
  expect(texts(w, 'a1')).toEqual(['Agent: Nested'])
})

test('activity on: only the last 10 calls are kept, oldest dropped', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  for (let i = 1; i <= 11; i++) await call($, 'a1', 'Bash', { command: `c${i}` })
  expect(texts(w, 'a1')).toEqual(Array.from({ length: 10 }, (_, i) => `Bash: c${i + 2}`))
})

test('activity on: a long command is cut to 80 characters with an ellipsis', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  await call($, 'a1', 'Bash', { command: 'x'.repeat(200) })
  const [text] = texts(w, 'a1')
  expect(text).toBe(`Bash: ${'x'.repeat(73)}…`)
  expect(text).toHaveLength(80)
})

test('activity on: a multi-line command is one line', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  await call($, 'a1', 'Bash', { command: 'ls\n  -la\r\n' })
  expect(texts(w, 'a1')).toEqual(['Bash: ls -la'])
})

test('activity on: two interleaved workers keep their own calls and touch nothing else of each other', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  await spawn($, 'a2')
  await call($, 'a1', STEP, { done: 1, total: 4, note: 'one' })
  await call($, 'a2', STEP, { done: 2, total: 5, note: 'two' })
  for (let i = 0; i < 3; i++) {
    await call($, 'a1', 'Bash', { command: `one${i}` })
    await call($, 'a2', 'Bash', { command: `two${i}` })
  }
  expect(texts(w, 'a1')).toEqual(['Bash: one0', 'Bash: one1', 'Bash: one2'])
  expect(texts(w, 'a2')).toEqual(['Bash: two0', 'Bash: two1', 'Bash: two2'])
  expect(run(w, 'a1')).toMatchObject({ stepDone: 1, stepTotal: 4, stepNote: 'one', tokens: 0, steps: 0, status: 'running' })
  expect(run(w, 'a2')).toMatchObject({ stepDone: 2, stepTotal: 5, stepNote: 'two', tokens: 0, steps: 0, status: 'running' })
})

test('activity on: past 200 runs the list stays at 200, entries stay bounded, a call for an evicted run writes nothing', ON, async ($, on) => {
  const w = world(on)
  const long = Array.from({ length: 6 }, (_, i) => `line ${i} ${'w'.repeat(120)}`).join('\n')
  for (let i = 0; i < 205; i++) await spawn($, `r${i}`, { prompt: long })
  const list = runs(w)
  expect(list).toHaveLength(200)
  expect(list.some(a => a.id === 'r0')).toBe(false)
  for (const a of list.slice(0, 3)) {
    expect(a.brief?.split('\n')).toHaveLength(3)
    for (const l of a.brief?.split('\n') ?? []) expect(l.length).toBeLessThanOrEqual(80)
  }
  const before = writes(w)
  await call($, 'r0', 'Bash', { command: 'ls' })
  expect(writes(w)).toEqual(before)
  for (let i = 0; i < 25; i++) await call($, 'r204', 'Bash', { command: `c${i}` })
  expect((run(w, 'r204'))?.activity).toHaveLength(10)
  // A new flow still prunes the finished runs and keeps the running ones.
  await finish($, 'r204')
  await call($, undefined, PROGRESS, { title: 'Fresh flow', total: 1, phase: 'delegate' })
  expect((runs(w)).every(a => a.status === 'running')).toBe(true)
  expect(runs(w)).toHaveLength(199)
})

// ---------------------------------------------------------------------------
// The brief and the result: the first three non-empty lines, each cut to 80.

test('activity on: the brief is the first three lines of the prompt, masked, without the step-report line', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1', { type: 'savvy-light', prompt: 'Refactor the parser\nuse password=hunter2xy to log in\nthird\nfourth\nfifth' })
  expect((run(w, 'a1'))?.brief).toBe('Refactor the parser\nuse password=••• to log in\nthird')
  expect((run(w, 'a1'))?.brief).not.toContain('Progress reporting')
  expect((run(w, 'a1'))?.brief).not.toContain(STEP)
  // The worker still receives its step-report line.
  expect(w.prompts[0]).toContain(STEP)
})

test('activity on: brief lines are trimmed, CRLF and blank lines are skipped', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1', { prompt: '  a  \r\n\r\n   \r\nb\r\n\r\nc\r\nd' })
  expect((run(w, 'a1'))?.brief).toBe('a\nb\nc')
})

test('activity on: a blank prompt leaves no brief', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1', { prompt: ' \n\r\n  ' })
  expect(Object.keys((run(w, 'a1')) ?? {})).not.toContain('brief')
})

test('activity on: a brief line of 80 stays, 81 is cut to 79 and an ellipsis', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1', { prompt: `${'a'.repeat(80)}\n${'b'.repeat(81)}` })
  expect((run(w, 'a1'))?.brief).toBe(`${'a'.repeat(80)}\n${'b'.repeat(79)}…`)
})

test('activity on: the result is the first three lines of the answer, only for a finished answer', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  await spawn($, 'a2')
  await spawn($, 'a3')
  await finish($, 'a1', 'answer', 'one\ntwo\nthree\nfour\nfive\nsix')
  await finish($, 'a2', 'error', 'boom')
  await finish($, 'a3', 'aborted', 'half')
  expect((run(w, 'a1'))?.result).toBe('one\ntwo\nthree')
  expect((run(w, 'a2'))?.result).toBeUndefined()
  expect((run(w, 'a3'))?.result).toBeUndefined()
  expect((run(w, 'a2'))?.status).toBe('failed')
})

test('activity on: a main-loop or unknown-agent completion writes no result', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'main answer', usage: null })
  await finish($, 'ghost', 'answer', 'ghost answer')
  expect((run(w, 'a1'))?.result).toBeUndefined()
})

test('activity on: a resumed worker drops its old result, keeps its brief and history, and takes the new answer', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1', { prompt: 'Original task' })
  await call($, 'a1', 'Bash', { command: 'first' })
  await finish($, 'a1', 'answer', 'first answer')
  expect((run(w, 'a1'))?.result).toBe('first answer')

  await resume($, 'a1')
  const resumed = run(w, 'a1')
  expect(resumed).toMatchObject({ status: 'running', brief: 'Original task' })
  expect(resumed?.result).toBeUndefined()
  expect(texts(w, 'a1')).toEqual(['Bash: first'])

  await call($, 'a1', 'Bash', { command: 'second' })
  await finish($, 'a1', 'error', 'nope')
  expect((run(w, 'a1'))?.result).toBeUndefined()
  expect(texts(w, 'a1')).toEqual(['Bash: first', 'Bash: second'])
})

// ---------------------------------------------------------------------------
// Masking: the secret never reaches the stored state through any of the four channels
// (tool summary, brief, step note, result), and what surrounds it survives.

const MASKS: [name: string, input: string, masked: string, secret: string][] = [
  ['mysql -p<x>', 'mysql -u root -pS3cretPw db', 'mysql -u root -p••• db', 'S3cretPw'],
  ['mysql -p<x> with the command in capitals', 'MYSQL -u root -pS3cretPw db', 'MYSQL -u root -p••• db', 'S3cretPw'],
  ['mysqldump -p <x> in mixed case', 'MySqlDump -p S3cretPw db', 'MySqlDump -p ••• db', 'S3cretPw'],
  ['mariadb -p<x> in capitals', 'MARIADB -pS3cretPw', 'MARIADB -p•••', 'S3cretPw'],
  ['an escaped double quote in a quoted value', 'login password="abc\\"defghi" tail', 'login password=••• tail', 'abc\\"defghi'],
  ['an escaped single quote in a quoted value', "login token='abc\\'defghi' tail", 'login token=••• tail', "abc\\'defghi"],
  ['an escaped backslash before the closing quote', 'login secret="abcdefghi\\\\" tail', 'login secret=••• tail', 'abcdefghi'],
  ['a backslash-escaped LF inside a quoted value', 'login password="abc\\\ndefghi" tail', 'login password=••• tail', 'abc\\\ndefghi'],
  ['a backslash-escaped CRLF inside a quoted value', "login token='abc\\\r\ndefghi' tail", 'login token=••• tail', 'abc\\\r\ndefghi'],
  ['mysql -P (the port) next to -p<x>', 'mysql -P 3306 -pS3cretPw db', 'mysql -P 3306 -p••• db', 'S3cretPw'],
  ['--password "<x with a space>"', 'login --password "hello secretdata" run', 'login --password ••• run', 'hello secretdata'],
  ['--password \'<x with a space>\'', "login --password 'hello secretdata' run", 'login --password ••• run', 'hello secretdata'],
  ['--password="<x with a space>"', 'login --password="hello secretdata" run', 'login --password=••• run', 'hello secretdata'],
  ['--password "<x with an escaped quote>"', 'login --password "abcd\\" efghijk" run', 'login --password ••• run', 'abcd\\" efghijk'],
  ['--password "<x across an escaped line end>"', 'login --password "abcd\\\nefghijk" run', 'login --password ••• run', 'abcd\\\nefghijk'],
  ['mysql -p"<x with a space>"', 'mysql -u root -p"abcd efgh" db', 'mysql -u root -p••• db', 'abcd efgh'],
  ["mysql -p '<x with a space>'", "mysql -p 'abcd efgh' db", 'mysql -p ••• db', 'abcd efgh'],
  ['mysql -p<x> next to a quoted part', 'mysql -pabcd"efgh ijkl" db', 'mysql -p••• db', 'abcdefgh ijkl'],
  ['an Authorization value with an escaped quote', 'authorization: "foo\\" secretword" tail', 'authorization: ••• tail', 'foo\\" secretword'],
  ['an Authorization value across an escaped line end', "Authorization: 'foo\\\nsecretword' tail", 'Authorization: ••• tail', 'foo\\\nsecretword'],
  ['mysql -p <x>', 'mysql -p S3cretPw', 'mysql -p •••', 'S3cretPw'],
  ['URL userinfo', 'psql postgres://u:S3cretPw@h/db', 'psql postgres://u:•••@h/db', 'S3cretPw'],
  ['Authorization header', "curl -H 'Authorization: Bearer abc123xyz'", "curl -H 'Authorization: •••'", 'abc123xyz'],
  ['a bare Bearer', 'echo Bearer abc123xyz', 'echo Bearer •••', 'abc123xyz'],
  ['export API_KEY', 'export API_KEY=abc123xyz', 'export API_KEY=•••', 'abc123xyz'],
  ['PGPASSWORD env', 'PGPASSWORD=S3cretPw psql', 'PGPASSWORD=••• psql', 'S3cretPw'],
  ['a *_TOKEN env', 'GITHUB_TOKEN=abc123xyz gh api', 'GITHUB_TOKEN=••• gh api', 'abc123xyz'],
  ['query string', 'curl "x.io/?token=abc123xyz&key=def456uvw"', 'curl "x.io/?token=•••"', 'def456uvw'],
  ['--password=', 'mysqldump --password=S3cretPw db', 'mysqldump --password=••• db', 'S3cretPw'],
  ['--password <x>', 'tool --password S3cretPw run', 'tool --password ••• run', 'S3cretPw'],
  ['a quoted value with spaces', "export SECRET='two words here' && ls", 'export SECRET=••• && ls', 'two words here'],
  ['a JSON member', '{"password": "hunter2xy"}', '{"password": •••}', 'hunter2xy'],
  ['token: value', 'token: abc123xyz', 'token: •••', 'abc123xyz'],
  ['an sk- key', 'echo sk-ant-api03-AbCdEf0123456789', 'echo •••', 'AbCdEf0123456789'],
  ['a ghp_ token', 'git clone https://ghp_abcdefgh12345678@github.com/x/y', 'git clone https://•••@github.com/x/y', 'abcdefgh12345678'],
  ['a Slack token', 'notify xoxb-1234567890-abcdefghij', 'notify •••', 'abcdefghij'],
  ['an AWS access key id', 'aws --key AKIAIOSFODNN7EXAMPLE', 'aws --key •••', 'IOSFODNN7EXAMPLE'],
  ['a long unlabelled blob', 'curl -d aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7r', 'curl -d •••', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7r'],
]

for (const [name, input, masked, secret] of MASKS) {
  test(`activity on: ${name} is masked in the tool summary, brief, step note and result`, ON, async ($, on) => {
    const w = world(on)
    await spawn($, 'a1', { prompt: `Do the thing\n${input}\nthird` })
    await call($, 'a1', 'Bash', { command: input })
    await call($, 'a1', STEP, { done: 1, total: 2, note: input })
    await finish($, 'a1', 'answer', `${input}\nfine`)
    const a = run(w, 'a1')
    expect(a?.brief).toBe(`Do the thing\n${masked}\nthird`)
    expect(a?.activity?.[0]?.text).toBe(`Bash: ${masked}`)
    expect(a?.stepNote).toBe(masked)
    expect(a?.result).toBe(`${masked}\nfine`)
    expect(leaks(JSON.stringify(a), secret)).toBe(false)
  })
}

const BENIGN = ['mkdir -p src/x', 'git log -p', 'echo $HOME', 'npm test', 'cat keyboard.ts', 'mysql -u root mydb']

for (const command of BENIGN) {
  test(`activity on: "${command}" is left as it is`, ON, async ($, on) => {
    const w = world(on)
    await spawn($, 'a1', { prompt: command })
    await call($, 'a1', 'Bash', { command })
    expect((run(w, 'a1'))?.brief).toBe(command)
    expect(texts(w, 'a1')).toEqual([`Bash: ${command}`])
  })
}

test('activity on: Read keeps the file name', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  await call($, 'a1', 'Read', { file_path: '/a/b/register.tsx' })
  expect(texts(w, 'a1')).toEqual(['Read register.tsx'])
})

// Mask first, then cut: a secret that straddles a limit must not leave a piece of itself behind.
test('activity on: a secret straddling the 80-character limit of a tool summary is masked, not cut', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  const secret = 'Zq8Zq8Zq8Zq8'
  await call($, 'a1', 'Bash', { command: `echo ${'a'.repeat(54)} password=${secret}` })
  const [text] = texts(w, 'a1')
  expect(text).toBe(`Bash: echo ${'a'.repeat(54)} password=•••`)
  expect(leaks(text ?? '', secret)).toBe(false)
})

test('activity on: a secret straddling the 80-character limit of a brief line, a step note and a result line is masked, not cut', ON, async ($, on) => {
  const w = world(on)
  const secret = 'Zq8Zq8Zq8Zq8'
  const line = `${'a'.repeat(60)} password=${secret}`
  await spawn($, 'a1', { prompt: line })
  await call($, 'a1', STEP, { done: 0, total: 1, note: line })
  await finish($, 'a1', 'answer', line)
  const a = run(w, 'a1')
  const expected = `${'a'.repeat(60)} password=•••`
  expect(a?.brief).toBe(expected)
  expect(a?.stepNote).toBe(expected)
  expect(a?.result).toBe(expected)
  expect(leaks(JSON.stringify(a), secret)).toBe(false)
})

// A key that announces itself has no `key=` to hold the mask once a cut has taken its tail: only masking first keeps it out.
test('activity on: an sk- key straddling the 80-character limit is masked in every channel, not cut to a stub', ON, async ($, on) => {
  const w = world(on)
  const secret = 'sk-ant-api03-AbCdEf0123456789'
  const line = `echo ${'a'.repeat(68)} ${secret}`
  await spawn($, 'a1', { prompt: line })
  // "Bash: " leads the summary, which moves the key 6 characters on.
  await call($, 'a1', 'Bash', { command: `echo ${'a'.repeat(62)} ${secret}` })
  await call($, 'a1', STEP, { done: 0, total: 1, note: line })
  await finish($, 'a1', 'answer', line)
  const a = run(w, 'a1')
  const expected = `echo ${'a'.repeat(68)} •••`
  expect(a?.brief).toBe(expected)
  expect(a?.stepNote).toBe(expected)
  expect(a?.result).toBe(expected)
  expect(a?.activity?.[0]?.text).toBe(`Bash: echo ${'a'.repeat(62)} •••`)
  expect(leaks(JSON.stringify(a), secret)).toBe(false)
})

test('activity on: a masked line that is still too long is cut after masking', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1', { prompt: `${'a'.repeat(70)} password=Zq8Zq8Zq8Zq8` })
  expect((run(w, 'a1'))?.brief).toBe(`${'a'.repeat(70)} password…`)
})

test('activity on: a quoted secret that spans lines is masked before the lines are split', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1', { prompt: 'a\npassword="line1secret\nline2secret"\nz\nw' })
  expect((run(w, 'a1'))?.brief).toBe('a\npassword=•••\nz')
})

test('activity on: an adversarial 4000-character quoted value is masked quickly and fully', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  const started = Date.now()
  for (const evil of [`password="${'\\"'.repeat(1300)}`, `token='${'\\\\'.repeat(2000)}`, `key=${'"'.repeat(4000)}`, `secret="${'\\\n'.repeat(1300)}`]) await call($, 'a1', 'Bash', { command: evil })
  expect(Date.now() - started).toBeLessThan(2000)
  const [a, b, c, d] = texts(w, 'a1')
  expect(a).toBe('Bash: password=•••')
  // The 4000-character cap can leave one unpaired backslash of the input behind; no more.
  expect(b).toMatch(/^Bash: token=•••\\?$/)
  expect(c?.startsWith('Bash: key=•••')).toBe(true)
  expect(d).toBe('Bash: secret=•••')
  expect(texts(w, 'a1').every(t => t.length <= 80)).toBe(true)
})

test('activity on: a step note is clipped to 80 characters, masked first', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  await call($, 'a1', STEP, { done: 0, total: 1, note: 'n'.repeat(200) })
  expect((run(w, 'a1'))?.stepNote).toBe(`${'n'.repeat(79)}…`)
  await call($, 'a1', STEP, { done: 1, total: 1, note: '   ' })
  expect((run(w, 'a1'))?.stepNote).toBeUndefined()
})

// ---------------------------------------------------------------------------
// The panel: a plain button per agent row opens its details.

const PANE = 'savvy-agents'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } as const
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

type Node = { type: string; props: Record<string, unknown>; children?: (Node | string)[] }
const textOf = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))
const walk = (n: Node | string, out: Node[] = []): Node[] => {
  if (typeof n !== 'string') {
    out.push(n)
    for (const c of n.children ?? []) walk(c, out)
  }
  return out
}

const mountPane = ($: Engine, surface: Surface, props: Record<string, unknown> = pane) => $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props } as never)
type Pane = Awaited<ReturnType<typeof mountPane>>

// The lines of a run's open details, or undefined while it is closed.
const detailNode = async (ui: Pane, id: string) => (await ui.find({ key: `det-${id}` })) as unknown as Node | undefined
const detail = async (ui: Pane, id: string) => (await detailNode(ui, id))?.children?.map(textOf)

// Every string the drawing holds: texts, button labels, the Svg's source and alt.
const everything = async (ui: Pane): Promise<string> => {
  const parts: string[] = []
  for (const n of walk((await ui.drawn()) as unknown as Node)) {
    for (const c of n.children ?? []) if (typeof c === 'string') parts.push(c)
    for (const k of ['label', 'source', 'alt', 'text']) if (typeof n.props[k] === 'string') parts.push(n.props[k] as string)
  }
  return parts.join('\n')
}

const actKeys = async (ui: Pane) => (await ui.findAll({ type: 'Button' })).map(b => String(b.props.key)).filter(k => k.startsWith('act-'))
const actLabel = async (ui: Pane, id: string) => (await ui.find({ key: `act-${id}` }))?.props.label as string | undefined
// What the button reads: the desktop's own control, the terminal's description line.
const label = (surface: Surface, isOpen: boolean, desc: string) => `${isOpen ? '▾' : '▸'} ${surface === 'desktop' ? 'details' : desc}`

// Agents the panel stored before this option: no brief, activity or result, and a panel with no `expandedId`.
const OLD_RUN = { id: 'a1', agentId: 'a1', type: 'general-purpose', description: 'Work a1', model: MODEL, status: 'running', startedAt: 0, contextTokens: 0, contextMax: 1e6, tokens: 0, costUsd: 0, steps: 0, round: 1 }
const seed = (on: On, list: unknown[]) => on('state.get', { plugin: PLUGIN, key: 'agents' } as never, (() => ({ value: { value: list, version: 0 } })) as never)

// One worker with a brief, a call, a step note; `a1` at clock 0.
const worker = async ($: Engine, id = 'a1', prompt = 'Task one') => {
  await spawn($, id, { prompt })
  await call($, id, 'Read', { file_path: '/x/y/register.tsx' })
  await call($, id, STEP, { done: 1, total: 3, note: 'reading' })
}

for (const surface of SURFACES) {
  test(`${surface}: activity off draws no details button, even over stored activity`, async ($, on) => {
    world(on)
    seed(on, [{ ...OLD_RUN, brief: 'Task one', activity: [{ at: 0, text: 'Read register.tsx' }], result: 'done' }])
    const ui = await mountPane($, surface)
    expect(await actKeys(ui)).toEqual([])
    expect(await detailNode(ui, 'a1')).toBeUndefined()
  })

  test(`${surface}: activity off leaves a step note as stored`, async ($, on) => {
    world(on)
    seed(on, [{ ...OLD_RUN, stepDone: 1, stepTotal: 3, stepNote: 'password=hunter2xy' }])
    expect(await everything(await mountPane($, surface))).toContain('hunter2xy')
  })

  test(`${surface}: pressing details opens the block, pressing again closes it`, ON, async ($, on) => {
    const w = world(on)
    await worker($)
    const ui = await mountPane($, surface)
    expect(await actLabel(ui, 'a1')).toBe(label(surface, false, 'Work a1'))
    expect(await detailNode(ui, 'a1')).toBeUndefined()

    await ui.press({ key: 'act-a1' })
    expect(await actLabel(ui, 'a1')).toBe(label(surface, true, 'Work a1'))
    expect(await detail(ui, 'a1')).toEqual(['Brief', '  Task one', 'Activity', '  now  Read register.tsx', 'Step', '  reading'])
    expect(w.st.value.panel).toMatchObject({ expandedId: 'a1' })

    await ui.press({ key: 'act-a1' })
    expect(await detailNode(ui, 'a1')).toBeUndefined()
    expect(w.st.value.panel).toMatchObject({ expandedId: '' })
  })

  test(`${surface}: one run is open at a time`, ON, async ($, on) => {
    world(on)
    await worker($, 'a1', 'Task one')
    await worker($, 'a2', 'Task two')
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    expect((await detail(ui, 'a1'))?.[1]).toBe('  Task one')
    await ui.press({ key: 'act-a2' })
    expect(await detailNode(ui, 'a1')).toBeUndefined()
    expect((await detail(ui, 'a2'))?.[1]).toBe('  Task two')
    expect(await actLabel(ui, 'a1')).toBe(label(surface, false, 'Work a1'))
  })

  test(`${surface}: activity shows newest first, with its age`, ON, async ($, on) => {
    const w = world(on)
    await spawn($, 'a1')
    await call($, 'a1', 'Bash', { command: 'first' })
    await w.clock.advance(5000)
    await call($, 'a1', 'Bash', { command: 'second' })
    await w.clock.advance(4000)
    await $.command.run({ command: 'agents-info', args: 'open' } as never)
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    expect(await detail(ui, 'a1')).toEqual(['Activity', '  4s  Bash: second', '  9s  Bash: first'])
  })

  for (const [ms, age] of [[0, 'now'], [999, 'now'], [1000, '1s'], [59_000, '59s'], [60_000, '1m'], [3_599_000, '59m'], [3_600_000, '1h'], [7_300_000, '2h']] as const) {
    test(`${surface}: an entry ${ms} ms old reads "${age}"`, ON, async ($, on) => {
      const w = world(on)
      await spawn($, 'a1')
      await call($, 'a1', 'Bash', { command: 'x' })
      await w.clock.advance(ms)
      await $.command.run({ command: 'agents-info', args: 'open' } as never)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'act-a1' })
      expect(await detail(ui, 'a1')).toEqual(['Activity', `  ${age}  Bash: x`])
    })
  }

  test(`${surface}: a finished run shows its result, a running one does not`, ON, async ($, on) => {
    world(on)
    await worker($)
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    expect(await detail(ui, 'a1')).not.toContain('Result')
    await finish($, 'a1', 'answer', 'all done\nsecond line')
    // The same drawing, not remounted: still open, now with the result.
    expect(await detail(ui, 'a1')).toEqual(['Brief', '  Task one', 'Activity', '  now  Read register.tsx', 'Step', '  reading', 'Result', '  all done', '  second line'])
    expect(await actLabel(ui, 'a1')).toBe(label(surface, true, 'Work a1'))
  })

  test(`${surface}: the open block follows a worker live: new calls, a new step note, no remount`, ON, async ($, on) => {
    world(on)
    await spawn($, 'a1')
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    expect(await detail(ui, 'a1')).toEqual([])
    await call($, 'a1', 'Bash', { command: 'ls' })
    expect(await detail(ui, 'a1')).toEqual(['Activity', '  now  Bash: ls'])
    await call($, 'a1', STEP, { done: 1, total: 2, note: 'listing' })
    expect(await detail(ui, 'a1')).toEqual(['Activity', '  now  Bash: ls', 'Step', '  listing'])
  })

  test(`${surface}: stored runs from before the option open to an empty block without a throw`, ON, async ($, on) => {
    world(on)
    seed(on, [OLD_RUN])
    const ui = await mountPane($, surface)
    expect(await actKeys(ui)).toEqual(['act-a1'])
    await ui.press({ key: 'act-a1' })
    expect(await detail(ui, 'a1')).toEqual([])
  })

  test(`${surface}: a stored step note is masked when drawn, in the row and in the block`, ON, async ($, on) => {
    world(on)
    seed(on, [{ ...OLD_RUN, stepDone: 1, stepTotal: 3, stepNote: `password=hunter2xy ${'n'.repeat(100)}` }])
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    const all = await everything(ui)
    expect(leaks(all, 'hunter2xy')).toBe(false)
    expect(all).toContain('password=•••')
    expect((await detail(ui, 'a1'))?.[1]).toBe(`  password=••• ${'n'.repeat(66)}…`)
  })

  test(`${surface}: a secret through every channel appears nowhere in the open panel`, ON, async ($, on) => {
    world(on)
    const secret = 'hunter2xy'
    await spawn($, 'a1', { prompt: `use password=${secret}` })
    await call($, 'a1', 'Bash', { command: `mysql -u root -p${secret} db` })
    await call($, 'a1', STEP, { done: 0, total: 1, note: `token: ${secret}` })
    await finish($, 'a1', 'answer', `done with PGPASSWORD=${secret}`)
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    const all = await everything(ui)
    expect(all).toContain('•••')
    expect(all).toContain('mysql -u root -p••• db')
    expect(leaks(all, secret)).toBe(false)
  })
}

// The session's start: registers the tools and starts the 1-second clock that ages a running row.
const boot = async ($: Engine, on: On) => {
  on('session.start', () => ({ cwd: '/x' }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  await ($.session as unknown as { start: (e: unknown) => Promise<unknown> }).start({ source: 'startup', cwd: '/x' })
}

const EN_ON = { options: { activity: 'on', language: 'en' } } as const
const HE_ON = { options: { activity: 'on', language: 'he' } } as const
const RU_ON = { options: { activity: 'on', language: 'ru' } } as const

for (const surface of SURFACES) {
  test(`${surface}: the ages move with the pane's own clock while an agent runs, in the mounted drawing`, EN_ON, async ($, on) => {
    const w = world(on)
    await boot($, on)
    await spawn($, 'a1')
    await call($, 'a1', 'Bash', { command: 'ls' })
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    expect(await detail(ui, 'a1')).toEqual(['Activity', '  now  Bash: ls'])
    await w.clock.advance(12_000)
    expect(await detail(ui, 'a1')).toEqual(['Activity', '  12s  Bash: ls'])
    await w.clock.advance(48_000)
    expect(await detail(ui, 'a1')).toEqual(['Activity', '  1m  Bash: ls'])
  })

  test(`${surface}: every detail line is one row, cut at the edge`, ON, async ($, on) => {
    world(on)
    await worker($)
    await finish($, 'a1', 'answer', 'done')
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    const lines = ((await detailNode(ui, 'a1'))?.children ?? []) as Node[]
    expect(lines).toHaveLength(8)
    for (const l of lines) expect(l.props).toMatchObject({ dimColor: true, wrap: 'truncate-end' })
  })

  // -- right to left and localized
  test(`${surface}: Hebrew labels read right to left, machine lines left to right, the block flush right`, HE_ON, async ($, on) => {
    world(on)
    await boot($, on)
    await worker($)
    const ui = await mountPane($, surface)
    expect(await actLabel(ui, 'a1')).toBe(`◂ ${surface === 'desktop' ? 'פרטים' : 'Work a1'}`)
    await ui.press({ key: 'act-a1' })
    expect(await actLabel(ui, 'a1')).toBe(`▾ ${surface === 'desktop' ? 'פרטים' : 'Work a1'}`)
    const box = await detailNode(ui, 'a1')
    expect(box?.props.alignItems).toBe('flex-end')
    expect((box?.children ?? []).map(textOf)).toEqual(['משימה', '  Task one', 'פעילות', '  עכשיו  Read register.tsx', 'שלב', '  reading'])
    expect(((box?.children ?? []) as Node[]).map(n => n.props.dir)).toEqual(['rtl', 'ltr', 'rtl', 'ltr', 'rtl', 'ltr'])
  })

  test(`${surface}: Hebrew ages read in Hebrew units`, HE_ON, async ($, on) => {
    const w = world(on)
    await boot($, on)
    await spawn($, 'a1')
    await call($, 'a1', 'Bash', { command: 'x' })
    await w.clock.advance(7_300_000)
    await $.command.run({ command: 'agents-info', args: 'open' } as never)
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    expect((await detail(ui, 'a1'))?.[1]).toBe('  2שע׳  Bash: x')
  })

  test(`${surface}: Russian labels and units`, RU_ON, async ($, on) => {
    const w = world(on)
    await boot($, on)
    await worker($)
    await finish($, 'a1', 'answer', 'ok')
    await w.clock.advance(180_000)
    await $.command.run({ command: 'agents-info', args: 'open' } as never)
    const ui = await mountPane($, surface)
    expect(await actLabel(ui, 'a1')).toBe(`▸ ${surface === 'desktop' ? 'подробности' : 'Work a1'}`)
    await ui.press({ key: 'act-a1' })
    expect(await detail(ui, 'a1')).toEqual(['Задание', '  Task one', 'Действия', '  3м  Read register.tsx', 'Шаг', '  reading', 'Результат', '  ok'])
    const box = await detailNode(ui, 'a1')
    expect(box?.props.alignItems).toBeUndefined()
    expect(((box?.children ?? []) as Node[]).every(n => n.props.dir === undefined)).toBe(true)
  })

  // -- the other options
  test(`${surface}: cost "hide" leaves every generated cost out of the open panel`, { options: { activity: 'on', cost: 'hide' } }, async ($, on) => {
    world(on)
    await worker($)
    const usage = { model: MODEL, input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a1', reason: 'answer', answer: 'done', usage })
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    const all = await everything(ui)
    expect(all).toContain('Result')
    expect(all).not.toMatch(/≈|\$/)
  })

  test(`${surface}: finished rows hidden by the done section draw no button and no block, and come back with it`, ON, async ($, on) => {
    world(on)
    await worker($, 'a1')
    await spawn($, 'a2')
    await finish($, 'a1')
    const ui = await mountPane($, surface)
    expect(await actKeys(ui)).toEqual(expect.arrayContaining(['act-a1', 'act-a2']))
    await ui.press({ key: 'act-a1' })
    expect(await detailNode(ui, 'a1')).toBeDefined()
    await ui.press({ key: 'done' })
    expect(await actKeys(ui)).toEqual(['act-a2'])
    expect(await detailNode(ui, 'a1')).toBeUndefined()
    await ui.press({ key: 'done' })
    expect((await detail(ui, 'a1'))?.[0]).toBe('Brief')
  })

  test(`${surface}: the compact panel draws no button and no block, and the block returns when it is expanded again`, ON, async ($, on) => {
    world(on)
    await worker($)
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    await ui.press({ key: 'compact' })
    expect(await actKeys(ui)).toEqual([])
    expect(await detailNode(ui, 'a1')).toBeUndefined()
    await ui.press({ key: 'compact' })
    expect((await detail(ui, 'a1'))?.[0]).toBe('Brief')
  })

  test(`${surface}: the band above the prompt never shows details or their buttons`, { options: { activity: 'on', band: 'agents' } }, async ($, on) => {
    world(on)
    await worker($)
    await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 2, phase: 'delegate' } as never)
    const pane1 = await mountPane($, surface)
    await pane1.press({ key: 'act-a1' })
    for (const withFlow of [true, false]) {
      if (!withFlow) await $.tool.call({ tool: PROGRESS, finished: true } as never)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
      expect(await ui.find({ key: 'savvy-agents' })).toBeDefined()
      expect((await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key).startsWith('act-'))).toEqual([])
      const all = await everything(ui as never)
      expect(all).not.toContain('Task one')
      expect(all).not.toContain('Read register.tsx')
    }
  })

  test(`${surface}: the flow band (band "flow") never shows details or their buttons either`, ON, async ($, on) => {
    world(on)
    await worker($)
    await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 2, phase: 'delegate' } as never)
    await (await mountPane($, surface)).press({ key: 'act-a1' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect(await ui.find({ key: 'savvy-agents' })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key).startsWith('act-'))).toEqual([])
    expect(await everything(ui as never)).not.toContain('Read register.tsx')
  })

  // The old answer is not the new turn's: it leaves the panel when the resumed step starts, not when it ends.
  test(`${surface}: a resumed run's old result is not drawn while its model step is still pending`, ON, async ($, on) => {
    const w = world(on)
    await worker($)
    await finish($, 'a1', 'answer', 'old answer')
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    expect((await detail(ui, 'a1'))?.slice(-2)).toEqual(['Result', '  old answer'])

    let release = () => {}
    w.gate.hold = new Promise<void>(r => (release = r))
    const stepping = resume($, 'a1')
    await w.clock.settle()
    expect(await everything(ui)).not.toContain('old answer')
    expect(run(w, 'a1')?.result).toBeUndefined()
    release()
    await stepping
    expect(run(w, 'a1')?.status).toBe('running')
    expect(await everything(ui)).not.toContain('old answer')
  })

  test(`${surface}: finishing an open run keeps it open and shows its result`, ON, async ($, on) => {
    world(on)
    await worker($, 'a1')
    await worker($, 'a2', 'Task two')
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a2' })
    await finish($, 'a2', 'answer', 'finished it')
    expect((await detail(ui, 'a2'))?.slice(-2)).toEqual(['Result', '  finished it'])
    expect(await detailNode(ui, 'a1')).toBeUndefined()
  })

  // -- closing the pane resets the open run
  for (const mode of ['keep', 'clear-on-close'] as const) {
    test(`${surface}: finished "${mode}": closing the pane with /agents-info closes the open block`, { options: { activity: 'on', finished: mode } }, async ($, on) => {
      const w = world(on)
      await worker($, 'a1')
      await worker($, 'a2', 'Task two')
      await finish($, 'a1')
      await $.command.run({ command: 'agents-info', args: 'open' } as never)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'act-a2' })
      expect(w.st.value.panel).toMatchObject({ expandedId: 'a2' })

      await $.command.run({ command: 'agents-info', args: '' } as never) // closes
      expect(w.pane.closed).toBe(1)
      expect(w.st.value.panel).toMatchObject({ expandedId: '' })
      expect(await detailNode(ui, 'a2')).toBeUndefined()
      // The finished run is gone with `clear-on-close`; the running one stays, and opens again with a press.
      expect((await actKeys(ui)).includes('act-a1')).toBe(mode === 'keep')
      await ui.press({ key: 'act-a2' })
      expect((await detail(ui, 'a2'))?.[0]).toBe('Brief')
    })
  }

  test(`${surface}: the band's own panel button closes the pane and the open block with it`, { options: { activity: 'on', band: 'agents' } }, async ($, on) => {
    const w = world(on)
    await worker($)
    await $.command.run({ command: 'agents-info', args: 'open' } as never)
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    const b = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    await b.press({ key: 'savvy-agents' })
    expect(w.pane.closed).toBe(1)
    expect(w.st.value.panel).toMatchObject({ expandedId: '' })
  })

  test(`${surface}: closing writes the panel only when a run was open`, ON, async ($, on) => {
    const w = world(on)
    await worker($)
    await $.command.run({ command: 'agents-info', args: 'open' } as never)
    const before = w.st.writes.panel ?? 0
    await $.command.run({ command: 'agents-info', args: '' } as never)
    expect(w.st.writes.panel ?? 0).toBe(before)
  })

  test(`${surface}: activity off never writes the panel on close`, async ($, on) => {
    const w = world(on)
    await worker($)
    await $.command.run({ command: 'agents-info', args: 'open' } as never)
    await $.command.run({ command: 'agents-info', args: '' } as never)
    expect(w.st.writes.panel).toBeUndefined()
  })

  // The kit raises no `ui.close` of its own, so the person's close mark and an unload (origin `unload`: the hook leaves the block
  // alone) cannot be driven here; both are read from `ui.close` in register.tsx.

  test(`${surface}: an open run that leaves the list draws nothing and the next press works`, ON, async ($, on) => {
    world(on)
    await worker($, 'a1')
    const ui = await mountPane($, surface)
    await ui.press({ key: 'act-a1' })
    await finish($, 'a1')
    await $.tool.call({ tool: PROGRESS, title: 'Next flow', total: 1, phase: 'delegate' } as never) // prunes the finished run
    expect(await detailNode(ui, 'a1')).toBeUndefined()
    await worker($, 'a3', 'Task three')
    await ui.press({ key: 'act-a3' })
    expect((await detail(ui, 'a3'))?.[1]).toBe('  Task three')
  })
}

// ---------------------------------------------------------------------------
// Desktop only: the grid behind the rows is as tall as what is drawn over it.

const gridHeight = async (ui: Pane): Promise<number> =>
  (await ui.findAll({ type: 'Svg' })).filter(el => el.props.alt === 'dotted grid').reduce((sum, el) => sum + Number(el.props.height), 0)

// Header 44 + 2 section lines of 24 + one 66px row; each button and each detail line is another 24.
const BASE = 44 + 2 * 24 + 66

test('desktop: activity off leaves the grid as tall as before', async ($, on) => {
  world(on)
  await worker($)
  expect(await gridHeight(await mountPane($, 'desktop'))).toBe(BASE)
})

test('desktop: the grid adds a line for each details button and each line of the open block', ON, async ($, on) => {
  world(on)
  await worker($)
  const ui = await mountPane($, 'desktop')
  expect(await gridHeight(ui)).toBe(BASE + 24)
  await ui.press({ key: 'act-a1' })
  // Brief, its line, Activity, its line, Step, its line.
  expect(await gridHeight(ui)).toBe(BASE + 24 + 6 * 24)
  await ui.press({ key: 'act-a1' })
  expect(await gridHeight(ui)).toBe(BASE + 24)
})

test('desktop: finished rows hidden by the done section add no button to the grid', ON, async ($, on) => {
  world(on)
  await worker($)
  await finish($, 'a1')
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'done' })
  // Header, the Finished line and its toggle only: no row, no button.
  expect(await gridHeight(ui)).toBe(44 + 2 * 24)
})

test('desktop: the costume of a run does not change when its block opens or a call lands', { options: { activity: 'on', costumes: 'rotate' } }, async ($, on) => {
  world(on)
  await spawn($, 'a1')
  await spawn($, 'a2')
  const costume = async (ui: Pane, id: string) => {
    const src = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).find(t => t.includes(`Work ${id}`)) ?? ''
    return /class="c-(\w+)/.exec(src)?.[1]
  }
  const ui = await mountPane($, 'desktop')
  const before = [await costume(ui, 'a1'), await costume(ui, 'a2')]
  expect(before[0]).toBeDefined()
  await ui.press({ key: 'act-a1' })
  await call($, 'a1', 'Bash', { command: 'ls' })
  await call($, 'a2', 'Bash', { command: 'ls' })
  expect([await costume(ui, 'a1'), await costume(ui, 'a2')]).toEqual(before)
})

// ---------------------------------------------------------------------------
// A resumed agent (SendMessage) is the same run again: the engine raises `agent.spawn` for it with `resume`, then model steps.

const respawn = async ($: Engine, id: string, agentId: string) => {
  await $.agent.spawn({ tool_use_id: id, prompt: 'more', description: 'resumed', subagentType: 'general-purpose', provider: 'engine', parentModel: MODEL, background: false, fork: false, resume: { agentId } } as never)
}

const CLOSE = ($: Engine) => $.command.run({ command: 'agents-info', args: '' } as never)

for (const costumes of ['savvy', 'rotate'] as const) {
  test(`resume (costumes "${costumes}"): the run keeps its row, history, clock and costume and is running again`, { options: { activity: 'on', costumes } }, async ($, on) => {
    const w = world(on)
    await spawn($, 'a1', { prompt: 'Original task', desc: 'Same work' })
    await spawn($, 'a2')
    await call($, 'a1', 'Bash', { command: 'first' })
    await finish($, 'a1', 'answer', 'first answer')
    await w.clock.advance(5000)
    const before = run(w, 'a1')
    const rotation = w.st.writes.rotation
    await respawn($, 'r1', 'a1')
    await resume($, 'a1')
    expect(runs(w).filter(a => a.agentId === 'a1')).toHaveLength(1)
    const after = run(w, 'a1')
    expect(after).toMatchObject({ status: 'running', startedAt: before?.startedAt, round: before?.round, brief: 'Original task', description: 'Same work' })
    expect(after?.costume).toBe(before?.costume)
    expect(after?.endedAt).toBeUndefined()
    expect(after?.result).toBeUndefined()
    expect(after?.steps).toBe(1)
    expect(texts(w, 'a1')).toEqual(['Bash: first'])
    expect(w.st.writes.rotation).toBe(rotation)
  })
}

test('resume: with the option off the run is kept too', async ($, on) => {
  const w = world(on)
  await spawn($, 'a1', { desc: 'Same work' })
  await finish($, 'a1')
  await w.clock.advance(5000)
  await respawn($, 'r1', 'a1')
  expect(runs(w)).toHaveLength(1)
  expect(run(w, 'a1')).toMatchObject({ status: 'running', startedAt: 0, round: 1, description: 'Same work' })
})

test('resume: an id with no row starts a new one, as before', ON, async ($, on) => {
  const w = world(on)
  await respawn($, 'r1', 'ghost')
  expect(runs(w).map(a => a.id)).toEqual(['ghost'])
  expect(run(w, 'ghost')).toMatchObject({ status: 'running', round: 1 })
})

test('resume (finished "clear-on-close"): a cleared run is listed again, under Running', { options: { finished: 'clear-on-close' } }, async ($, on) => {
  world(on)
  await spawn($, 'a1')
  await finish($, 'a1')
  await $.command.run({ command: 'agents-info', args: 'open' } as never)
  await CLOSE($)
  const running = async () => {
    const ui = await mountPane($, 'terminal')
    const n = (await ui.findAll({ type: 'Text', text: /^Running · 1$/ })).length
    await ui.unmount()
    return n
  }
  expect(await running()).toBe(0)
  await respawn($, 'r1', 'a1')
  expect(await running()).toBe(1)
})

// -- a resumed step flips the run at its start, not when it returns

for (const mode of ['off', 'on'] as const) {
  const options: Record<string, string> = mode === 'on' ? { activity: 'on' } : {}
  test(`resume step (activity ${mode}): the run is Running, and listed after a clear, while the step is pending`, { options: { ...options, finished: 'clear-on-close' } }, async ($, on) => {
    const w = world(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    await $.command.run({ command: 'agents-info', args: 'open' } as never)
    await CLOSE($)
    let release = () => {}
    w.gate.hold = new Promise<void>(r => (release = r))
    const stepping = resume($, 'a1')
    await w.clock.settle()
    expect(run(w, 'a1')).toMatchObject({ status: 'running' })
    expect(run(w, 'a1')?.endedAt).toBeUndefined()
    const ui = await mountPane($, 'terminal')
    expect((await ui.findAll({ type: 'Text', text: /^Running · 1$/ })).length).toBe(1)
    release()
    await stepping
    expect(run(w, 'a1')).toMatchObject({ status: 'running', steps: 1 })
  })

  test(`resume step (activity ${mode}): a step that returns no usage still leaves the run running`, { options }, async ($, on) => {
    const w = world(on)
    await spawn($, 'a1')
    await finish($, 'a1')
    w.gate.noUsage = true
    await resume($, 'a1')
    expect(run(w, 'a1')).toMatchObject({ status: 'running', steps: 0 })
    expect(run(w, 'a1')?.endedAt).toBeUndefined()
  })
}

test('resume step: a running run is not written to by a step that only reads', async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  w.gate.noUsage = true
  const before = writes(w)
  await resume($, 'a1')
  expect(writes(w)).toEqual(before)
})

// -- planned task titles are held to the same length as the flow's

test('flow: a planned title is stored at most 120 characters, and still matches its Agent description by its start', async ($, on) => {
  const w = world(on)
  const long = `Refactor ${'the parser '.repeat(20)}`.trim()
  await $.tool.call({ tool: PROGRESS, title: 'Ship', total: 2, phase: 'delegate', tasks: [{ title: long, tier: 'light' }, { title: 'Normal title', tier: 'light' }] } as never)
  const flow = w.st.value.flow as { tasks: { title: string }[] }
  expect(flow.tasks[0]?.title).toHaveLength(120)
  expect(flow.tasks[0]?.title.endsWith('…')).toBe(true)
  expect(flow.tasks[1]?.title).toBe('Normal title')
  const planned = async () => {
    const ui = await mountPane($, 'terminal')
    const found = (await ui.findAll({ type: 'Text', text: /^Planned · / })).map(t => t.text)
    await ui.unmount()
    return found
  }
  expect(await planned()).toEqual(['Planned · 2'])
  await spawn($, 'a1', { desc: long })
  expect(await planned()).toEqual(['Planned · 1'])
  await spawn($, 'a2', { desc: 'Normal title' })
  expect(await planned()).toEqual([])
})

// An unclosed quote runs to the end of the text, so it is the last thing in each channel.
for (const [name, input, masked, secret] of [
  ['--password "<unclosed x>"', 'login --password "abcd efghijk', 'login --password •••', 'abcd efghijk'],
  ['an unclosed Authorization value', 'authorization: "foo secretdata', 'authorization: •••', 'foo secretdata'],
] as const) {
  test(`activity on: ${name} is masked to the end in the tool summary, brief, step note and result`, ON, async ($, on) => {
    const w = world(on)
    await spawn($, 'a1', { prompt: `Do the thing\n${input}` })
    await call($, 'a1', 'Bash', { command: input })
    await call($, 'a1', STEP, { done: 1, total: 2, note: input })
    await finish($, 'a1', 'answer', input)
    const a = run(w, 'a1')
    expect(a?.brief).toBe(`Do the thing\n${masked}`)
    expect(a?.activity?.[0]?.text).toBe(`Bash: ${masked}`)
    expect(a?.stepNote).toBe(masked)
    expect(a?.result).toBe(masked)
    expect(leaks(JSON.stringify(a), secret)).toBe(false)
  })
}
