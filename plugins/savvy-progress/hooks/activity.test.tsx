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
const world = (on: On, tap?: ($: Engine, e: Record<string, unknown>) => Promise<void>) => {
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
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', (_$, e) => {
    prompts.push(e.prompt)
    return { model: MODEL, agentId: e.tool_use_id } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    return { turnId: 'turn', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: MODEL, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('tool.call', async ($$, e) => {
    seen.push(e as never)
    await tap?.($$ as never, e as never)
    return { result: 'ran' } as never
  })
  return { clock, seen, prompts, st }
}

const spawn = async ($: Engine, id: string, o: { prompt?: string; type?: string; desc?: string } = {}) => {
  await $.agent.spawn({ tool_use_id: id, prompt: o.prompt ?? 'p', description: o.desc ?? `Work ${id}`, subagentType: o.type ?? 'general-purpose', provider: 'engine', parentModel: MODEL, background: false, fork: false } as never)
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
  await call($, 'a1', 'Bash', { command: 'cd x\n  && ls\r\n' })
  expect(texts(w, 'a1')).toEqual(['Bash: cd x && ls'])
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

const BENIGN = ['mkdir -p src/x', 'git log -p', 'echo $HOME', 'npm test', 'cat keyboard.ts', 'mysql -u root mydb', 'ls /Users/shreyash/Documents/claude-kit-v2/plugins']

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

test('activity on: a step note is clipped to 80 characters, masked first', ON, async ($, on) => {
  const w = world(on)
  await spawn($, 'a1')
  await call($, 'a1', STEP, { done: 0, total: 1, note: 'n'.repeat(200) })
  expect((run(w, 'a1'))?.stepNote).toBe(`${'n'.repeat(79)}…`)
  await call($, 'a1', STEP, { done: 1, total: 1, note: '   ' })
  expect((run(w, 'a1'))?.stepNote).toBeUndefined()
})
