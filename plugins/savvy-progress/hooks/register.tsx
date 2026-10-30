import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Cleared, CrewBand, Flow, Panel, Phase, PlannedTask, Rotation } from '../types'

const flow = atom({ plugin: 'savvy-progress', key: 'flow' } as const, null)
const agents = atom({ plugin: 'savvy-progress', key: 'agents' } as const, [])
const panel = atom({ plugin: 'savvy-progress', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  autoOpenedFor: '',
})
const crewBand = atom({ plugin: 'savvy-progress', key: 'crewBand' } as const, { isDismissed: false })
const cleared = atom({ plugin: 'savvy-progress', key: 'cleared' } as const, { ids: [] } as Cleared)
const rotation = atom({ plugin: 'savvy-progress', key: 'rotation' } as const, { next: 0 } as Rotation)
const now = atom({ plugin: 'savvy-progress', key: 'now' } as const, 0)

const TOOL = 'mcp__savvy-progress__progress'
const STEP_TOOL = 'mcp__savvy-progress__step'
// Added to the end of each savvy worker's brief. Their system prompt words step
// reporting as a condition ("if the step tool appears among your tools") and they
// skip it even with the tool listed; the same request in the brief is followed.
const STEP_BRIEF = `

Progress reporting: before any other work, call \`${STEP_TOOL}\` with \`total\` (your plan in 3-8 steps) and \`done: 0\`; call it again with \`done\` and a few-word \`note\` as each step finishes. It only draws a progress bar.`
const PANE = 'savvy-agents'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const TIERS: readonly string[] = ['fable', 'heavy', 'careful', 'medium', 'light']
// The tools' schemas are advice to the model, not a check: what a call may ask
// the band and the panel to draw is bounded here.
const MAX_TASKS = 200
const MAX_AFTER = 20
const MAX_TITLE = 120
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; tier?: string; after?: number[] }[]
}

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else the
// process locale; English when nothing says Hebrew or Russian.

type Lang = 'en' | 'ru' | 'he'

const STRINGS = {
  en: {
    pane: 'Agents',
    cost: 'Cost',
    tokens: 'Tokens',
    time: 'Time',
    collapse: 'Collapse',
    expand: 'Expand',
    running: 'Running',
    finished: 'Finished',
    planned: 'Planned',
    empty: 'No subagents yet.',
    round: 'round',
    failed: 'error',
    after: 'after',
    tokensWord: 'tokens',
    agentsCount: 'agents',
    isRunning: 'running',
    isFinished: 'finished',
    isPlanned: 'planned',
    opened: 'Agents panel opened.',
    closed: 'Agents panel closed.',
    done: 'Done',
    plan: 'Plan',
    design: 'Design',
    tasks: 'Tasks',
    review: 'Review',
    busy: 'running',
    ctx: 'ctx',
    showPanel: 'Show panel ▸',
    hidePanel: 'Hide panel ◂',
    runningWord: 'running',
    doneWord: 'done',
    noneRunning: 'No agents running',
    details: 'details',
    brief: 'Brief',
    calls: 'Activity',
    stepWord: 'Step',
    resultWord: 'Result',
    agoNow: 'now',
    agoS: 's',
    agoM: 'm',
    agoH: 'h',
    tier: { light: 'light', medium: 'medium', careful: 'careful', heavy: 'heavy', fable: 'fable', other: 'other' },
    effort: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  },
  ru: {
    pane: 'Агенты',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    running: 'Работают',
    finished: 'Завершены',
    planned: 'Запланированы',
    empty: 'Субагентов пока нет.',
    round: 'раунд',
    failed: 'ошибка',
    after: 'после',
    tokensWord: 'токенов',
    agentsCount: 'агентов',
    isRunning: 'работает',
    isFinished: 'завершён',
    isPlanned: 'запланирована',
    opened: 'Панель агентов открыта.',
    closed: 'Панель агентов закрыта.',
    done: 'Готово',
    plan: 'План',
    design: 'Дизайн',
    tasks: 'Задачи',
    review: 'Ревью',
    busy: 'в работе',
    ctx: 'ctx',
    showPanel: 'Показать панель ▸',
    hidePanel: 'Скрыть панель ◂',
    runningWord: 'в работе',
    doneWord: 'готово',
    noneRunning: 'Нет работающих агентов',
    details: 'подробности',
    brief: 'Задание',
    calls: 'Действия',
    stepWord: 'Шаг',
    resultWord: 'Результат',
    agoNow: 'сейчас',
    agoS: 'с',
    agoM: 'м',
    agoH: 'ч',
    tier: { light: 'light', medium: 'medium', careful: 'careful', heavy: 'heavy', fable: 'fable', other: 'other' },
    effort: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  },
  he: {
    pane: 'סוכנים',
    cost: 'עלות',
    tokens: 'טוקנים',
    time: 'זמן',
    collapse: 'כיווץ',
    expand: 'הרחבה',
    running: 'פועלים',
    finished: 'הסתיימו',
    planned: 'מתוכננים',
    empty: 'עדיין אין סוכנים.',
    round: 'סבב',
    failed: 'שגיאה',
    after: 'אחרי',
    tokensWord: 'טוקנים',
    agentsCount: 'סוכנים',
    isRunning: 'פועל',
    isFinished: 'הסתיים',
    isPlanned: 'מתוכנן',
    opened: 'חלונית הסוכנים נפתחה.',
    closed: 'חלונית הסוכנים נסגרה.',
    done: 'הושלם',
    plan: 'תכנון',
    design: 'עיצוב',
    tasks: 'משימות',
    review: 'בדיקה',
    busy: 'בעבודה',
    ctx: 'הקשר',
    showPanel: 'הצג חלונית ◂',
    hidePanel: 'הסתר חלונית ▸',
    runningWord: 'בעבודה',
    doneWord: 'הושלמו',
    noneRunning: 'אין סוכנים בעבודה',
    details: 'פרטים',
    brief: 'משימה',
    calls: 'פעילות',
    stepWord: 'שלב',
    resultWord: 'תוצאה',
    agoNow: 'עכשיו',
    agoS: 'שנ׳',
    agoM: 'דק׳',
    agoH: 'שע׳',
    tier: { light: 'קל', medium: 'בינוני', careful: 'זהיר', heavy: 'כבד', fable: 'פייבל', other: 'אחר' },
    effort: { low: 'נמוך', medium: 'בינוני', high: 'גבוה', xhigh: 'גבוה מאוד', max: 'מקסימלי' },
  },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]

// Hebrew draws every row mirrored: crab and title on the right, numbers on the left.
const isRtl = () => lang === 'he'

// Tier and effort words as shown; anything unknown shows as it came.
const tierWord = (tier: string): string => (tr().tier as Record<string, string>)[tier] ?? tier
const effortWord = (effort: string): string => (tr().effort as Record<string, string>)[effort] ?? effort

const isRussian = (v: unknown): boolean => typeof v === 'string' && /^(ru|russian|рус)/i.test(v.trim())
const isHebrew = (v: unknown): boolean => typeof v === 'string' && /^(he|iw|hebrew|עברית)/i.test(v.trim())
const langOf = (v: unknown): Lang => (isHebrew(v) ? 'he' : isRussian(v) ? 'ru' : 'en')

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ru' || option === 'he') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return langOf(settings.language)
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return langOf(locale)
}

const blank = (): Flow => ({
  title: 'savvy-flow',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  isFinished: false,
  tasks: [],
})

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && clip(input.title.trim(), MAX_TITLE) !== prev.title)

// Only a known tier is kept: the name is later a key into the tier tables.
const tierName = (v: string): string => {
  const t = v.replace(/^savvy-/, '').trim().toLowerCase()
  return TIERS.includes(t) ? t : ''
}

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .slice(0, MAX_TASKS)
    .map(t => ({
      title: (t.title ?? '').trim(),
      tier: tierName(t.tier ?? ''),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0).slice(0, MAX_AFTER),
    }))

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = Math.min(MAX_TASKS, Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total))))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: clip(input.title?.trim() || base.title, MAX_TITLE),
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
  }
}

const label = (f: Flow): string => {
  const s = tr()
  if (f.isFinished) return s.done
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  const count = f.total ? `${f.done}/${f.total}` : `${f.running} ${s.busy}`
  return `${f.phase === 'review' ? s.review : s.tasks} ${count}`
}

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const BAR_H = 16
const CRAB_W = 26
// The crab's drawing grid is 30 units wide, props included.
const CRAB_BOX = 30
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// CJK, fullwidth forms and emoji advance about 1em; at 0.56em a Chinese title was sized at half its width and the bar drew over it.
// 中日韩文字、全角标点和 emoji 约占 1em；按 0.56em 算时中文标题宽度被低估近一半，进度条会压到标题上。
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const rowSvg = (f: Flow, W: number, isWorking: boolean): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(f.title, 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const color = f.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(f))
  const runW = f.total ? Math.round((BAR_W * Math.min(f.total, f.done + f.running)) / f.total) : 0
  const dots: string[] = []
  // Positions are worked out left to right; right to left mirrors each box
  // inside the bar (`bx`) and across the row (`rx`). Text is never mirrored.
  const rtl = isRtl()
  const bx = (x: number, w: number): number => (rtl ? BAR_W - x - w : x)
  const rx = (x: number, w: number): number => (rtl ? W - x - w : x)

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${bx(c * CELL + 1, 2)}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  // Handed to workers, not yet accepted: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${bx(c * CELL + 1, 1.7)}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }

  const ticks: string[] = []
  for (let i = 1; i < f.total; i++) {
    const x = Math.round((BAR_W * i) / f.total)
    if (x > fillW + 4) ticks.push(`<rect x="${bx(x, 1.5)}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = label(f)
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = bx(Math.max(0, Math.min(BAR_W - pillW, fillW - pillW)), pillW)
  const percent = `${Math.round(ratio(f) * 100)}%`
  // `direction="rtl"` puts Hebrew words and numbers in reading order; `start` is then the right edge.
  const titleAt = rtl ? `x="${W - 16}" direction="rtl" text-anchor="start"` : 'x="16"'
  const percentAt = rtl ? `x="${CRAB_W + 6}" y="${H / 2 + 4.5}"` : `x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end"`
  const crabW = CRAB_BOX * 0.8

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${f.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${f.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${f.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${f.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${f.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="${rtl ? W - 5 : 5}" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" ${titleAt} y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${rx(BAR_X, BAR_W)},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle"${rtl ? ' direction="rtl"' : ''} font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" ${percentAt} font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(rx(W - CRAB_W + 1, crabW), 0, 'other', false, isWorking, 0.8, rtl)}
</svg>`
}

// The crew line of the band without a flow: "2 running · 5 done", or that there is nothing running.
const crewText = (running: number, done: number): string => {
  const s = tr()
  const parts = [running ? `${running} ${s.runningWord}` : '', done ? `${done} ${s.doneWord}` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : s.noneRunning
}

const MAX_CRABS = 5
// Cells a button adds around its label.
const BUTTON_PAD = 4
const CRAB_SLOT = 26

// The band without a flow, in one drawing as wide as it needs: a dot that pulses while anything runs, the
// panel's name, one small crab per running agent (a dimmed one when none runs), and the counts.
const crewRowSvg = (running: AgentRun[], done: number, isRotating: boolean): { source: string; width: number } => {
  const label = tr().pane
  const counts = crewText(running.length, done)
  const shown = running.slice(0, MAX_CRABS)
  const more = running.length - shown.length
  const crabsX = Math.ceil(16 + textWidth(label, 13) + 12)
  const moreX = crabsX + Math.max(1, shown.length) * CRAB_SLOT + 2
  const countsX = Math.ceil(moreX + (more ? textWidth(`+${more}`, 12) + 8 : 0))
  const W = Math.ceil(countsX + textWidth(counts, 12) + 4)
  const crabW = CRAB_BOX * 0.8
  const crabs = shown.length
    ? shown
        .map((a, i) => {
          const look = lookOf(a, isRotating)
          return crab(mx(W, crabsX + i * CRAB_SLOT, crabW), 0, look.costume, false, true, 0.8, isRtl(), look.color)
        })
        .join('')
    : crab(mx(W, crabsX, crabW), 0, 'other', true, false, 0.8, isRtl())
  const dot = running.length
    ? `<circle class="live" cx="${mx(W, 5)}" cy="${H / 2}" r="4" fill="${ACCENT}"/>`
    : `<circle cx="${mx(W, 5)}" cy="${H / 2}" r="4" fill="#9a9a96"/>`
  const source = svg(
    W,
    H,
    `${dot}
<text class="t" ${startText(W, 16, H / 2 + 4.5)} font-family="${FONT}" font-size="13" font-weight="500">${xml(label)}</text>
${crabs}${more ? `<text class="s" ${startText(W, moreX, H / 2 + 4, false)} font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" ${startText(W, countsX, H / 2 + 4)} font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">${xml(counts)}</text>`,
  )
  return { source, width: W }
}

const barText = (f: Flow, width: number): string => {
  const filled = Math.round(width * ratio(f))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session, plus the tasks the flow planned.

const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}

// What each savvy tier runs on, for planned tasks that have no run yet.
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

const TIER_MODEL: Record<string, [model: string, effort: string]> = {
  fable: ['Fable', 'high'],
  heavy: ['Opus', 'xhigh'],
  careful: ['Opus', 'high'],
  medium: ['Opus', 'medium'],
  light: ['Opus', 'low'],
}

// "Opus · xhigh", with the effort word in the panel's language; '' for an unknown tier.
const tierModel = (tier: string): string => {
  const m = TIER_MODEL[tier]
  return m ? `${m[0]} · ${effortWord(m[1])}` : ''
}

// "Opus 5.5 · low" for a run, or just the model when no effort was seen.
const runModel = (a: AgentRun): string => (a.effort ? `${modelName(a.model)} · ${effortWord(a.effort)}` : modelName(a.model))

// USD per million tokens: input, output, cache read, cache write. The first row that
// matches a model id wins, so a release sits above its family.
// The engine reports tokens, not money, so the panel's cost is an estimate. It reports
// one cache-write count with no split by lifetime; writes are priced at the 1-hour
// rate (2x input), which is what Claude Code writes on a subscription.
type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

// Haiku 5.5 is priced by prompt length: a request whose prompt (input, cache reads and
// cache writes together) is over 100,000 tokens pays these prices instead.
const HAIKU_LONG_PROMPT = 100_000
const HAIKU_LONG: Price = [0.5, 2.5, 0.05, 1]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string, prompt: number): Price => {
  const id = model.toLowerCase()
  if (prompt > HAIKU_LONG_PROMPT && /haiku-5-5/.test(id)) return HAIKU_LONG
  return PRICES.find(([re]) => re.test(id))?.[1] ?? [4, 20, 0.2, 8]
}

// `isRequest` says the usage is one model request, which is what a prompt-length price
// is set by; a turn's sum is priced at the model's ordinary prices.
const costOf = (model: string, u: Usage, isRequest: boolean): number => {
  const prompt = isRequest ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0
  const [i, o, r, w] = priceOf(model, prompt)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

// Haiku 4.5 and the Claude 3 models have a 200K window; the rest, Haiku 5.5 included, 1M.
const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

// `savvy-careful`, or `savvy-flow:savvy-careful` when the agents ship in a plugin.
const tierOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  const t = bare.replace(/^savvy-/, '').toLowerCase()
  return Object.hasOwn(TIER_COLOR, t) && bare.startsWith('savvy-') ? t : 'other'
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

type Planned = PlannedTask & { n: number }

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => {
  if (!f || f.isFinished) return []
  const started = new Set(list.map(a => norm(a.description)))
  return (f.tasks ?? []).map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
}

// The ids a clear hides. A value stored by an older version (`{ at }`) has none.
const clearedIds = (c: Cleared): readonly string[] => (Array.isArray(c.ids) ? c.ids : [])

// The runs the panel lists: with `finished: "clear-on-close"`, those that had finished at the last
// close drop out. A running agent is never hidden. Totals and the planned tasks still look at every run.
// A run that is not running again is new to the panel: its id leaves the cleared set.
const unclear = async ($: EngineInterface, ids: string[]): Promise<void> => {
  if (!ids.length) return
  if (!clearedIds(await read($, cleared)).some(id => ids.includes(id))) return
  await update($, cleared, prev => ({ ids: clearedIds(prev).filter(id => !ids.includes(id)) }))
}

const visibleOf = (list: AgentRun[], hidden: readonly string[]): AgentRun[] => {
  if (!hidden.length) return list
  const ids = new Set(hidden)
  return list.filter(a => a.status === 'running' || !ids.has(a.id))
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// The figures a summary line shows: the cost, unless hidden, then tokens and time.
const summaryParts = (t: ReturnType<typeof totals>, isCostShown: boolean): string[] => [
  ...(isCostShown ? [`≈${fmtCost(t.cost)}`] : []),
  fmtTokens(t.tokens),
  fmtTime(t.time),
]

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

// The pane's backdrop: a dotted grid as tall as the content laid over it; the
// row SVGs are transparent, so it shows through between their marks.
const GRID_STEP = 16
// A Text or Button row on the desktop is about 20px; the grid errs taller.
const LINE_H = 24
// The engine refuses an Svg taller than 4096px, so a long grid is stacked from
// tiles of at most this height; a multiple of GRID_STEP keeps the dots aligned.
const GRID_TILE = 4096
const gridTiles = (H: number) => Array.from({ length: Math.ceil(H / GRID_TILE) }, (_, i) => Math.min(GRID_TILE, H - i * GRID_TILE))
const gridSvg = (W: number, H: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>.d{fill:#d9d8d4}@media (prefers-color-scheme: dark){.d{fill:#3a3a38}}</style>
<defs><pattern id="g" width="${GRID_STEP}" height="${GRID_STEP}" patternUnits="userSpaceOnUse"><circle class="d" cx="${GRID_STEP / 2}" cy="${GRID_STEP / 2}" r="1"/></pattern></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
</svg>`

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective with a deerstalker; the magnifier sweeps and glints.
  heavy: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  medium: (f, t) => {
    crabBody(f, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t) => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: t, w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => crabBody(f),
}

const costumeOf = (type: string): string => (type === 'Explore' ? 'explore' : tierOf(type))

// `costumes: "rotate"` colours by model family, not tier; an unknown model keeps the neutral grey.
const FAMILY_COLOR: [RegExp, string][] = [
  [/fable|mythos/i, colorOf('fable')],
  [/opus/i, colorOf('heavy')],
  [/sonnet/i, colorOf('medium')],
  [/haiku/i, colorOf('light')],
]

// The costume and colour a run is drawn with. Under `rotate` the costume was dealt at spawn
// (a run from before the option was set falls back to its tier's).
const lookOf = (a: AgentRun, isRotating: boolean): { costume: string; color: string } =>
  isRotating
    ? { costume: a.costume ?? costumeOf(a.type), color: FAMILY_COLOR.find(([re]) => re.test(a.model))?.[1] ?? colorOf('other') }
    : { costume: costumeOf(a.type), color: colorOf(tierOf(a.type)) }

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own. `mirror` flips the crab inside its
// own box (x .. x + CRAB_BOX * scale) so it faces left.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE, mirror = false, accent = colorOf(costume)): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g))
  draw(f, accent)
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  const place = mirror ? `translate(${x + CRAB_BOX * scale},${y}) scale(${-scale},${scale})` : `translate(${x},${y}) scale(${scale})`
  return `<g transform="${place}" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

// Panel rows are laid out left to right; in Hebrew each box mirrors across the
// row (`mx`) and text hugs the mirrored side. `words` text may hold Hebrew and
// takes `direction="rtl"` (whose `start` is the right edge); numbers stay
// left to right so "≈$0.25" keeps its order.
const mx = (W: number, x: number, w = 0): number => (isRtl() ? W - x - w : x)

// Text that starts at x: left-aligned, or right-aligned at the mirrored x.
const startText = (W: number, x: number, y: number, words = true): string =>
  !isRtl()
    ? `x="${x}" y="${y}"`
    : `x="${W - x}" y="${y}"${words ? ' direction="rtl" text-anchor="start"' : ' text-anchor="end"'}`

// Text that ends at x: right-aligned, or left-aligned at the mirrored x.
const endText = (W: number, x: number, y: number, words = false): string =>
  !isRtl() ? `x="${x}" y="${y}" text-anchor="end"` : `x="${W - x}" y="${y}"${words ? ' direction="rtl" text-anchor="end"' : ''}`

const crabWidth = (scale: number): number => Math.round(CRAB_BOX * scale * 100) / 100

// A panel crab at x in a row of width W: on the mirrored side and facing left in Hebrew.
const rowCrab = (W: number, x: number, y: number, costume: string, dim = false, isWalking = false, accent = colorOf(costume)): string =>
  crab(mx(W, x, crabWidth(CRAB_SCALE)), y, costume, dim, isWalking, CRAB_SCALE, isRtl(), accent)

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// The pane's own title already says "Agents": the header names the flow, if any.
const headerSvg = (W: number, title: string, t: ReturnType<typeof totals>, isCostShown: boolean): string => {
  const s = tr()
  const gap = 6
  const tiles = isCostShown ? 3 : 2
  const tw = (W - gap * (tiles - 1)) / tiles
  const top = title ? 28 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${mx(W, i * (tw + gap), tw)}" y="${top}" width="${tw}" height="40" rx="8"/>
<text class="s" ${startText(W, i * (tw + gap) + 9, top + 16)} font-family="${FONT}" font-size="11">${k}</text>
<text class="t" ${startText(W, i * (tw + gap) + 9, top + 33, false)} font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" ${startText(W, 0, 15)} font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(title, 14, W))}</text>` : ''}
${isCostShown ? tile(0, s.cost, '≈' + fmtCost(t.cost)) : ''}${tile(tiles - 2, s.tokens, fmtTokens(t.tokens))}${tile(tiles - 1, s.time, fmtTime(t.time))}`,
  )
}

const headerHeight = (title: string): number => (title ? 72 : 44)

// The task's own progress when the worker reports steps; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

// ---------------------------------------------------------------------------
// Activity (`activity: "on"`): what a worker did, kept on its run and drawn on request. Everything a
// worker wrote goes through `safe` first: credentials are masked, then the text is cut, never the other
// way round, or a cut could leave the head of a secret behind. Nothing here is logged or sent anywhere.

const MASK = '•••'
const MAX_TEXT = 80
const MAX_LINES = 3
const MAX_CALLS = 10
// Text is looked at up to here: a prompt or a command can be as long as the model likes.
const MAX_RAW = 4000

// A value after `key=`: a quoted string (spaces and escaped quotes and all, an unclosed one runs to the end) or a run up to a space or quote.
const VALUE = `"(?:[^"\\\\]|\\\\[\\s\\S])*"?|'(?:[^'\\\\]|\\\\[\\s\\S])*'?|[^\\s'"]+`
const SECRET_KEY = 'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|key'

const anyCase = (word: string): string => [...word].map(c => `[${c}${c.toUpperCase()}]`).join('')

// What is masked, in order: each rule keeps the words around the secret and replaces the secret.
const MASKS: [RegExp, string][] = [
  // postgres://user:pass@host
  [/(:\/\/[^\s:@/]+:)\S*@/g, `$1${MASK}@`],
  // Authorization: Basic …, "Authorization": "Bearer …"; the rest of the header goes.
  [/(\bAuthorization["']?[ \t]*[:=][ \t]*)(?:"[^"]*"|'[^']*'|[^\r\n'"]*)/gi, `$1${MASK}`],
  [/\b(Bearer[ \t]+)[^\s'"]+/gi, `$1${MASK}`],
  // mysql -pS3cret and mysql -p S3cret; only after the mysql family, so `mkdir -p dir` stays.
  // The command's name is any case; `-p` is not (`-P` is the port).
  [new RegExp(`\\b((?:${['mysql', 'mysqldump', 'mariadb'].map(anyCase).join('|')})\\b[^\\n|;&]*?[ \\t]-p[ \\t]*)(?!-)\\S+`, 'g'), `$1${MASK}`],
  [/(--passw(?:or)?d[ \t]+)(?![-\s])\S+/gi, `$1${MASK}`],
  // key=value, key: value, "key": "value"; a longer name that ends in one (PGPASSWORD, GITHUB_TOKEN) counts.
  [new RegExp(`\\b([\\w.-]*?(?:${SECRET_KEY}))(["']?[ \\t]*[:=][ \\t]*)(?:${VALUE})`, 'gi'), `$1$2${MASK}`],
  // Keys that announce themselves: sk-…, ghp_…, github_pat_…, xoxb-…, AKIA….
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{16})/g, MASK],
]

// A long run of base64 or hex with letters and digits is taken for a key, unless it reads as a path.
const BLOB = /[A-Za-z0-9+/_=-]{32,}/g
const isBlob = (run: string): boolean =>
  /\d/.test(run) && /[A-Za-z]/.test(run) && !(run.includes('/') && run.split('/').every(part => part.length <= 24))

const mask = (s: string): string => MASKS.reduce((t, [re, to]) => t.replace(re, to), s.slice(0, MAX_RAW)).replace(BLOB, run => (isBlob(run) ? MASK : run))

// Mask, then cut.
const safe = (s: string, max: number): string => clip(mask(s), max)

// The first three non-empty lines, each cut to 80; undefined when there are none. Masked as a whole first, so a secret that spans lines goes.
const linesOf = (s: unknown): string | undefined => {
  const lines = mask(typeof s === 'string' ? s : '')
    .split(/\r\n|\r|\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, MAX_LINES)
    .map(l => clip(l, MAX_TEXT))
  return lines.length ? lines.join('\n') : undefined
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// One call as a line: `Bash: npm test`, `Read register.tsx`, `srv tool`; the bare tool name when there is nothing to say.
const callText = (e: Record<string, unknown>): string => {
  const tool = String(e.tool ?? '')
  const s = (k: string): string => (typeof e[k] === 'string' ? e[k] : '')
  const name = (path: string): string => path.split(/[\\/]/).pop() ?? ''
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  const label = mcp ? `${mcp[1]} ${mcp[2]}` : tool
  const arg =
    tool === 'Bash' ? s('command')
    : tool === 'Agent' ? s('description')
    : tool === 'Read' || tool === 'Edit' || tool === 'Write' ? name(s('file_path'))
    : tool === 'NotebookEdit' ? name(s('notebook_path'))
    : tool === 'Grep' || tool === 'Glob' ? s('pattern')
    : tool === 'WebFetch' ? hostOf(s('url'))
    : tool === 'WebSearch' ? s('query')
    : ''
  return arg ? `${label}${tool === 'Bash' || tool === 'Agent' ? ':' : ''} ${arg}` : label
}

// The entry's text: masked, on one line, cut. A call that cannot be summed up is still named.
const callEntry = (e: Record<string, unknown>): string => {
  try {
    return clip(mask(callText(e)).replace(/\s+/g, ' ').trim(), MAX_TEXT)
  } catch {
    return safe(String(e.tool ?? ''), MAX_TEXT)
  }
}

// "now", "12s", "3m", "2h": how long ago, from the pane's own clock.
const ago = (ms: number): string => {
  const s = Math.floor(Math.max(0, ms) / 1000)
  const t = tr()
  return s < 1 ? t.agoNow : s < 60 ? `${s}${t.agoS}` : s < 3600 ? `${Math.floor(s / 60)}${t.agoM}` : `${Math.floor(s / 3600)}${t.agoH}`
}

// A step note as drawn: with `activity` on, notes stored before it (or by anything else) are masked and cut here too.
const noteOf = (a: AgentRun, isActivity: boolean): string | undefined => (isActivity && a.stepNote ? safe(a.stepNote, MAX_TEXT) : a.stepNote)

// The open block of a run, one row per line: labels, then what they head, indented; a part the run does not have is left out.
type DetailLine = { text: string; isLabel: boolean }

const detailOf = (a: AgentRun, at: number): DetailLine[] => {
  const s = tr()
  const head = (text: string): DetailLine => ({ text, isLabel: true })
  const body = (text: string): DetailLine => ({ text: `  ${text}`, isLabel: false })
  const calls = [...(a.activity ?? [])].reverse()
  const note = noteOf(a, true)
  const result = a.status === 'running' ? undefined : a.result
  return [
    ...(a.brief ? [head(s.brief), ...a.brief.split('\n').map(body)] : []),
    ...(calls.length ? [head(s.calls), ...calls.map(c => body(`${ago(at - c.at)}  ${c.text}`))] : []),
    ...(note ? [head(s.stepWord), body(note)] : []),
    ...(result ? [head(s.resultWord), ...result.split('\n').map(body)] : []),
  ]
}

const agentSvg = (W: number, a: AgentRun, at: number, isCostShown: boolean, isRotating: boolean, isActivity: boolean): string => {
  const s = tr()
  const tier = tierOf(a.type)
  const { costume, color } = lookOf(a, isRotating)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const meta = [runModel(a)]
  if (a.round > 1) meta.push(`${s.round} ${a.round}`)
  if (a.status === 'failed') meta.push(s.failed)
  const barW = textW
  const progress = progressOf(a)
  const stats = `${s.ctx} ${ctx}% · ${fmtTokens(a.contextTokens)}  ${isCostShown ? `≈${fmtCost(a.costUsd)}  ` : ''}${fmtTime(elapsed(a, at))}`
  const note = noteOf(a, isActivity)
  const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${note ? ' · ' + note : ''}` : ''
  const stepsW = Math.max(0, barW - textWidth(stats, 11) - 12)
  // Without reported steps the bar falls back to the context, drawn grey.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  return svg(
    W,
    66,
    `${rowCrab(W, 0, 14, costume, false, a.status === 'running', color)}
<text class="t" ${startText(W, 42, 18)} font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text ${startText(W, 42, 34)} font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier === 'other' ? a.type : tierWord(tier))}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
${steps && stepsW > 30 ? `<text class="t" ${startText(W, 42, 49)} font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(steps, 11, stepsW))}</text>` : ''}
<text class="s" ${endText(W, 42 + barW, 49, true)} font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<rect class="k" x="${mx(W, 42, barW)}" y="55" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="${mx(W, 42, fillW)}" y="55" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${color}"`}/>
${statusMark(mx(W, W - 8), 16, a.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

const plannedSvg = (W: number, p: Planned): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const color = colorOf(tier)
  const textW = W - 42 - 22
  const meta = [tierModel(tier)]
  if (p.after.length) meta.push(`${tr().after} ${p.after.join(', ')}`)
  return svg(
    W,
    46,
    `${rowCrab(W, 0, 6, tier, true)}
<text class="s" ${startText(W, 42, 18)} font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 13, textW))}</text>
<text ${startText(W, 42, 34)} font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tierWord(tier))}</tspan><tspan class="m">  ${xml(meta.filter(Boolean).join('  ·  '))}</tspan></text>
${statusMark(mx(W, W - 8), 16, 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], planned: Planned[], t: ReturnType<typeof totals>, isCostShown: boolean, isRotating: boolean): string => {
  const look = (a: AgentRun) => lookOf(a, isRotating)
  const icons = [
    ...list.filter(a => a.status === 'running').map(a => ({ k: look(a).costume, c: look(a).color, s: 'running', dim: false })),
    ...list.filter(a => a.status !== 'running').map(a => ({ k: look(a).costume, c: look(a).color, s: a.status, dim: false })),
    ...planned.map(p => ({ k: p.tier in TIER_COLOR ? p.tier : 'other', c: colorOf(p.tier), s: 'planned', dim: true })),
  ]
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((ic, i) => rowCrab(W, i * 36, 0, ic.k, ic.dim, ic.s === 'running', ic.c) + (ic.s === 'running' ? `<circle class="live" cx="${mx(W, i * 36 + 32)}" cy="4" r="3" fill="${ic.c}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" ${startText(W, x, 21, false)} font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" ${endText(W, W, 21)} font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">${summaryParts(t, isCostShown).join(' · ')}</text>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }

// Whether the agents pane is up, as `togglePane` decides it.
const isPaneOpen = async ($: EngineInterface): Promise<boolean> => {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    return false
  }
}

// An open block closes with the pane: written only when one was open, and only with `activity` on.
async function closeDetails($: EngineInterface, isActivity: boolean): Promise<void> {
  if (!isActivity || !(await read($, panel)).expandedId) return
  await update($, panel, prev => ({ ...prev, expandedId: '' }))
}

// Opens the agents pane, or closes it when it is up (and the block that was open with it); true when it ends up open.
async function togglePane($: EngineInterface, isActivity = false): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    await closeDetails($, isActivity)
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: tr().pane })
  return true
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  void $.ui.open({ id: PANE, title: tr().pane })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language)
    await $.tool.register({
      name: 'progress',
      description:
        'Report /savvy-flow progress to the progress bar above the prompt and the agents panel. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their previous value. ' +
        'For the main session only: a call from a subagent is ignored (workers report with `step`).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
          tasks: {
            type: 'array',
            description:
              'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the panel can match runs to tasks.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                tier: { type: 'string', enum: [...TIERS] },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title', 'tier'],
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For savvy-flow workers: report progress on your own task to the agents panel. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
      // In every agent's tool list, not behind ToolSearch: workers do not go looking for it.
      isDeferred: false,
    })
    await $.command.register({
      name: 'agents-info',
      description: 'Show or hide the panel of subagents: running, finished and planned, with model, context, cost and time',
    })

    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('command.run', { command: 'agents-info' }, async ($, e) => {
    // `/agents-info open` opens the panel, or brings it forward from behind another tab, without toggling it.
    if ((e.args ?? '').trim() === 'open') {
      const at = await $.clock.now()
      await update($, now, () => at)
      await $.ui.open({ id: PANE, title: tr().pane })
      return { text: tr().opened }
    }
    const isOpen = await togglePane($, options.activity === 'on')
    return { text: isOpen ? tr().opened : tr().closed }
  })

  // Every worker call goes on its run's list while `activity` is on. This hook stands first, so it sees each call; it only
  // writes `agents`, and only when the worker has a row, and always hands the call on as it came.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (options.activity === 'on' && agentId && e.tool !== TOOL && e.tool !== STEP_TOOL) {
      try {
        if ((await read($, agents)).some(a => a.agentId === agentId)) {
          const entry = { at: await $.clock.now(), text: callEntry(e as unknown as Record<string, unknown>) }
          await update($, agents, list => list.map(a => (a.agentId !== agentId ? a : { ...a, activity: [...(a.activity ?? []), entry].slice(-MAX_CALLS) })))
        }
      } catch {
        // A record that fails is a line missing from a panel, never a worker's call refused.
      }
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // The flow is the main session's: a call from a worker's loop carries its agentId
    // and changes nothing, or any subagent could rename, finish or reset the flow.
    if (e.agentId) return { result: 'ignored: only the main session reports the flow' }
    const input = e as unknown as ProgressInput
    const prev = await read($, flow)
    if (isNewFlow(prev, input) && input.title !== undefined) {
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    const next = await update($, flow, p => merge(p, input))
    if (next && input.tasks?.length) await autoOpen($, next.title)
    return { result: `ok: ${label(next ?? blank())}` }
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    let matched = false
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        matched = true
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        const note = input.note?.trim()
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: (options.activity === 'on' && note ? safe(note, MAX_TEXT) : note) || undefined }
      }),
    )
    return { result: matched ? 'ok' : `ignored: no panel row for agent ${agentId}` }
  })

  // Safety net: worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (!type.startsWith('savvy-')) return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const isUnbriefed = e.subagentType.startsWith('savvy-') && !e.prompt.includes(STEP_TOOL)
    const started = await next(isUnbriefed ? { ...e, prompt: e.prompt + STEP_BRIEF } : e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    // The brief is the worker's own prompt, before the step-report line was added to it.
    const brief = options.activity === 'on' ? linesOf(e.prompt) : undefined
    // `costumes: "rotate"`: deal the next tier costume, in spawn order; Explore keeps its own.
    let costume: string | undefined
    if (options.costumes === 'rotate') {
      if (e.subagentType === 'Explore') costume = 'explore'
      else {
        const dealt = await update($, rotation, r => ({ next: r.next + 1 }))
        costume = TIERS[((dealt?.next ?? 1) - 1) % TIERS.length]
      }
    }
    await update($, agents, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
        costume,
        ...(brief ? { brief } : {}),
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    await unclear($, [started.agentId ?? e.tool_use_id])
    // A new subagent brings the crew band back after its ✕.
    await update($, crewBand, () => ({ isDismissed: false }))
    if (e.subagentType.startsWith('savvy-')) {
      const f = await read($, flow)
      await autoOpen($, f && !f.isFinished ? f.title : 'savvy-flow')
    } else if (options.autoOpen === 'any') {
      await autoOpen($, 'any-agent')
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    // A resumed run's old answer is not this turn's: it goes as the step starts, not when it ends.
    if (options.activity === 'on' && e.agentId && (await read($, agents)).some(a => a.agentId === e.agentId && a.result !== undefined)) {
      await update($, agents, list => list.map(a => (a.agentId === e.agentId ? { ...a, result: undefined } : a)))
    }
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    // A resumed agent (SendMessage) runs again: it is no longer one the panel was cleared of.
    await unclear($, (await read($, agents)).filter(a => a.agentId === agentId).map(a => a.id))
    await update($, agents, list =>
      list.map((a): AgentRun =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              // The run answers again: its old result is not this turn's.
              ...(options.activity === 'on' ? { result: undefined } : {}),
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage, true),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map((a): AgentRun => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(options.activity === 'on' ? { result: e.reason === 'answer' ? linesOf(e.answer) : undefined } : {}),
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage, false),
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  // `finished: "clear-on-close"`: the person's close mark or our own toggle ends what the panel showed.
  // An unload is the engine dropping the pane, not the person finishing with it.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    // The pane list is not reactive: ask the band to draw again so its toggle label follows.
    if (e.id === PANE) $.ui.invalidate('ui.render')
    if (e.id === PANE && e.origin.kind !== 'unload' && options.finished === 'clear-on-close') {
      const all = await read($, agents)
      const present = new Set(all.map(a => a.id))
      // Kept to the runs still listed, so the set stays within the agent list's own cap.
      await update($, cleared, prev => ({
        ids: [...new Set([...clearedIds(prev), ...all.filter(a => a.status !== 'running').map(a => a.id)])].filter(id => present.has(id)),
      }))
    }
    // The person's close mark comes only this way; our own toggles reset it themselves (a close made from a button's handler may not reach this hook).
    if (e.id === PANE && e.origin.kind !== 'unload') await closeDetails($, options.activity === 'on')
    return closed
  })

  // Likewise when the pane opens by any route (the band's button, `/agents-info`, an auto-open).
  on('ui.open', async ($, e, next) => {
    const opened = await next(e)
    if (e.id === PANE) $.ui.invalidate('ui.render')
    return opened
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const all = await read($, agents)
    const list = visibleOf(all, options.finished === 'clear-on-close' ? clearedIds(await read($, cleared)) : [])
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...all.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const planned = plannedOf(f, all)
    const t = totals(all, at)
    // The pane's title says "Agents"; inside, only the flow's own name.
    const title = f && !f.isFinished ? f.title : ''

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? s.expand : s.collapse}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? (isRtl() ? '◂' : '▸') : '▾'} ${s.finished} · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const isEmpty = list.length === 0 && planned.length === 0
    const isCostShown = options.cost !== 'hide'
    const isRotating = options.costumes === 'rotate'
    const isActivity = options.activity === 'on'
    const summary = `${isCostShown ? `≈${fmtCost(t.cost)}, ` : ''}${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`

    // One run is open at a time; a press on the open one closes it. Written from the press, never while drawing.
    const openToggle = (a: AgentRun, text: string) => (
      <Button
        key={`act-${a.id}`}
        label={`${p.expandedId === a.id ? '▾' : isRtl() ? '◂' : '▸'} ${text}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, expandedId: prev.expandedId === a.id ? '' : a.id }))}
      />
    )
    // Each line is one row, cut at the edge; labels read right to left in Hebrew, what the worker wrote left to right.
    const detailBox = (a: AgentRun) => (
      <Box key={`det-${a.id}`} flexDirection="column" alignItems={isRtl() ? 'flex-end' : undefined}>
        {detailOf(a, at).map((l, i) => (
          <Text key={`l${i}`} dimColor wrap="truncate-end" dir={isRtl() ? (l.isLabel ? 'rtl' : 'ltr') : undefined}>
            {l.text}
          </Text>
        ))}
      </Box>
    )

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )

      // In Hebrew the column hugs the right edge: section heads and buttons right-aligned.
      const align = isRtl() ? 'flex-end' : undefined
      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1} alignItems={align}>
            <Svg source={compactSvg(W, list, planned, t, isCostShown, isRotating)} alt={`${list.length} ${s.agentsCount}, ${summary}`} width={W} height={32} />
            {toggleCompact}
          </Box>
        )
      }
      const shownDone = p.isDoneCollapsed ? 0 : finished.length
      const lines = 1 + (isEmpty ? 1 : 0) + (running.length > 0 ? 1 : 0) + (finished.length > 0 ? 1 : 0) + (planned.length > 0 ? 1 : 0)
      // With `activity`, each drawn row adds its button's line, and the open block its lines.
      const drawn = [...running, ...(p.isDoneCollapsed ? [] : finished)]
      const open = isActivity ? drawn.find(a => a.id === p.expandedId) : undefined
      const extraLines = isActivity ? drawn.length + (open ? detailOf(open, at).length : 0) : 0
      const gridH = headerHeight(title) + (lines + extraLines) * LINE_H + (running.length + shownDone) * 66 + planned.length * 46
      // A row's Svg, and under it with `activity` its button and, when open, its block.
      const rowOf = (a: AgentRun, word: string) => [
        <Svg key={a.id} source={agentSvg(W, a, at, isCostShown, isRotating, isActivity)} alt={`${a.description}: ${modelName(a.model)}, ${word}`} width={W} height={66} />,
        ...(isActivity ? [openToggle(a, s.details), ...(p.expandedId === a.id ? [detailBox(a)] : [])] : []),
      ]
      return (
        <Box flexDirection="column">
          {/* The grid sizes the pane; the content is placed over it, as an
              absolute Box paints over the siblings before it. */}
          {gridTiles(gridH).map((tileH, i) => (
            <Svg key={`grid-${i}`} source={gridSvg(W, tileH)} alt="dotted grid" width={W} height={tileH} />
          ))}
          <Box flexDirection="column" position="absolute" top={0} left={0} right={0} alignItems={align}>
            <Svg source={headerSvg(W, title, t, isCostShown)} alt={title ? `${title}: ${summary}` : summary} width={W} height={headerHeight(title)} />
            {toggleCompact}
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {running.length > 0 && section('h-run', `${s.running} · ${running.length}`)}
            {running.flatMap(a => rowOf(a, s.isRunning))}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.flatMap(a => rowOf(a, s.isFinished))}
            {planned.length > 0 && section('h-plan', `${s.planned} · ${planned.length}`)}
            {planned.map(pl => (
              <Svg key={`plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={46} />
            ))}
          </Box>
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const row = (a: AgentRun) => {
      const tier = tierOf(a.type)
      const color = lookOf(a, isRotating).color
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const model = runModel(a)
      const note = noteOf(a, isActivity)
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${note ? ' ' + note : ''} · ` : ''
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={color}>▣</Text>
            {isActivity ? (
              openToggle(a, a.description || a.type)
            ) : (
              <Text bold wrap="truncate-end">
                {a.description || a.type}
              </Text>
            )}
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {tier === 'other' ? a.type : tierWord(tier)} · {model}
            {a.round > 1 ? ` · ${s.round} ${a.round}` : ''}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
            <Text dimColor>
              {' '}
              {steps}{s.ctx} {ctx}% · {fmtTokens(a.contextTokens)} {isCostShown ? `≈${fmtCost(a.costUsd)} ` : ''}{fmtTime(elapsed(a, at))}
            </Text>
          </Text>
          {isActivity && p.expandedId === a.id && detailBox(a)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {toggleCompact}
        </Box>
        <Text dimColor>
          {isCostShown ? `≈${fmtCost(t.cost)} · ` : ''}{fmtTokens(t.tokens)} {s.tokensWord} · {fmtTime(t.time)}
        </Text>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={lookOf(a, isRotating).color}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
            {planned.map(pl => (
              <Text key={`plan-${pl.n}`} dimColor>
                ◷{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {running.length > 0 && <Text dimColor>{s.running} · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
            {planned.length > 0 && <Text dimColor>{s.planned} · {planned.length}</Text>}
            {planned.map(pl => {
              const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
              return (
                <Box key={`plan-${pl.n}`} flexDirection="column" marginBottom={1}>
                  <Text dimColor wrap="truncate-end">
                    <Text color={colorOf(tier)}>▢</Text> {pl.n}. {pl.title} ◷
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {tierWord(tier)} · {tierModel(tier)}
                    {pl.after.length ? ` · ${s.after} ${pl.after.join(', ')}` : ''}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, flow)
    if (e.props.hasSurvey || (f === null && options.band !== 'agents')) return next(e)
    const all = await read($, agents)
    const list = visibleOf(all, options.finished === 'clear-on-close' ? clearedIds(await read($, cleared)) : [])
    // With `band: "agents"` and no flow, a compact band shows once any subagent has run, until its ✕.
    const isCrewOnly = f === null && all.length > 0 && !(await read($, crewBand)).isDismissed
    if (f === null && !isCrewOnly) return next(e)
    // Draw this row with the other mods' bands beneath it. Claude Code's own placeholder ({ type: 'engine' }) is
    // never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const isRotating = options.costumes === 'rotate'
    const running = list.filter(a => a.status === 'running')
    const isWorking = running.length > 0
    const isOpen = await isPaneOpen($)
    // A labelled toggle, not a bare count: it names what a press does, for the pane as it stands now.
    const toggleLabel = isOpen ? tr().hidePanel : tr().showPanel
    // The row's budget is for the longer of the two labels, so the band does not reflow when it flips.
    const toggleCells = Math.max([...tr().showPanel].length, [...tr().hidePanel].length) + BUTTON_PAD
    const crewButton = (
      <Button
        key="savvy-agents"
        label={toggleLabel}
        onPress={async () => {
          await togglePane($, options.activity === 'on')
          $.ui.invalidate('ui.render')
        }}
      />
    )
    const dismiss = (
      <Button
        key="savvy-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={async () => {
          await update($, crewBand, () => ({ isDismissed: true }))
          await update($, flow, () => null)
        }}
      />
    )
    const isSvg = e.surface !== 'terminal' && 'Svg' in ui

    if (!f) {
      // No flow: the panel's name, the crew button and the dismiss.
      if (isSvg) {
        const { Svg } = ui
        const row = crewRowSvg(running, list.length - running.length, isRotating)
        return (
          <Box flexDirection="column">
            <Box flexDirection={isRtl() ? 'row-reverse' : 'row'} alignItems="center" gap={1}>
              <Svg source={row.source} alt={`${tr().pane}: ${crewText(running.length, list.length - running.length)}`} width={row.width} height={H} />
              {crewButton}
              {dismiss}
            </Box>
            {below}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={2}>
            <Text color={isWorking ? ACCENT : undefined} dimColor={!isWorking}>
              ●
            </Text>
            <Text bold>{tr().pane}</Text>
            <Box flexDirection="row" gap={1}>
              {running.slice(0, MAX_CRABS).map(a => (
                <Text key={a.id} color={lookOf(a, isRotating).color}>
                  ▣
                </Text>
              ))}
              {!isWorking && <Text dimColor>▣</Text>}
              {running.length > MAX_CRABS && <Text dimColor>+{running.length - MAX_CRABS}</Text>}
            </Box>
            <Text dimColor>{crewText(running.length, list.length - running.length)}</Text>
            {crewButton}
            {dismiss}
          </Box>
          {below}
        </Box>
      )
    }
    const percent = `${Math.round(ratio(f) * 100)}%`

    // The terminal's element table is completed with an `Svg` that draws nothing: test the surface too.
    if (isSvg) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - (toggleCells + 8) * 8))
      return (
        <Box flexDirection="column">
          <Box flexDirection={isRtl() ? 'row-reverse' : 'row'} alignItems="center" gap={1}>
            <Svg source={rowSvg(f, width, isWorking)} alt={`${f.title}: ${label(f)}, ${percent}`} width={width} height={H} />
            {crewButton}
            {dismiss}
          </Box>
          {below}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    // Beside the title and the bar: six 2-cell gaps, the label, the percent, the crab, the button and the ✕.
    const reserved = 12 + label(f).length + percent.length + 1 + toggleCells + 3
    const width = Math.max(6, Math.min(40, cols - titleW - reserved))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Box width={titleW} flexShrink={0}>
            <Text color={f.isFinished ? DONE : ACCENT}>● </Text>
            <Text wrap="truncate-end">{f.title}</Text>
          </Box>
          <Text color={f.isFinished ? DONE : ACCENT}>{barText(f, width)}</Text>
          <Text bold>{label(f)}</Text>
          <Text dimColor>{percent}</Text>
          <Text color={CLAY}>▣</Text>
          {crewButton}
          {dismiss}
        </Box>
        {below}
      </Box>
    )
  })
}
