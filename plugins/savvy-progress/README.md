# savvy-progress

A Claude Code mod: a progress bar above the prompt and a live panel of subagents. Made for the [savvy-flow](../savvy-flow) skill, and useful with any subagents.

- **Progress bar**: the flow's title, phase, accepted tasks out of planned, and a `Show panel ▸` / `Hide panel ◂` button for the agents panel. It appears once something reports progress (savvy-flow does) or a `savvy-*` worker starts (with the `band` option, also for any subagent).
- **Agents panel** (`/agents-info` toggles it; `/agents-info open` opens it or brings it forward without toggling): running, finished and planned subagents with model, effort, task progress, context, estimated cost and time. Working crabs walk, and each savvy tier animates its prop: the astronaut floats, the detective sweeps the magnifier, the engineer turns the wrench, the chef tosses the omelette, the racer runs with a fluttering flag. `prefers-reduced-motion` stops them.

## Tools it adds

- `mcp__savvy-progress__progress`: the orchestrator reports the plan, phase and accepted tasks. Only the main session can: a call from a subagent is ignored, so a worker cannot rename, finish or reset the flow.
- `mcp__savvy-progress__step`: a worker reports its own steps (`done`, `total`, `note`). A worker that does not report shows its context fill in grey instead. The tool is listed up front rather than behind ToolSearch, and each `savvy-*` worker gets one line at the end of its brief asking for these reports.

Cost is a rough estimate from token counts and a built-in per-model price table (`PRICES` in `hooks/register.tsx`, list prices as of 2026-10-10), not a bill. Cache writes are priced at the 1-hour rate, which is what Claude Code writes on a subscription; a session that writes 5-minute entries is overestimated there.

## Settings

`language`: `auto` (default), `en`, `ru` or `he`. Hebrew draws the bar and the panel right to left. `auto` follows Claude Code's `language` setting, then the system locale, and falls back to English. Set it in `/config`, or, for a mod loaded by hand, in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "savvy-progress": { "options": { "language": "ru" } } } }
```

`autoOpen`: `savvy` (default) or `any`. With `savvy` the panel opens by itself when a `savvy-*` worker starts or a plan is reported. With `any` it also opens, once per session, when any other subagent starts. `/agents-info` toggles it either way.

`cost`: `show` (default) or `hide`. With `hide`, no dollar figure is drawn: the panel's summary, each agent's row and the collapsed panel keep tokens, context and time only. Handy on a subscription, where the estimate is noise.

`band`: `flow` (default) or `agents`. With `flow` the band above the prompt appears only when a savvy-flow plan is reported or a `savvy-*` worker starts. With `agents` it also appears, compact (a dot that pulses while anything runs, the word "Agents", a small crab per running agent, `2 running · 5 done`, the panel button, and ✕), as soon as any subagent has run, with no flow needed. Its ✕ hides it until the next subagent starts. When a flow exists the band is the usual one.

`finished`: `keep` (default) or `clear-on-close`. With `clear-on-close`, closing the panel (its close mark, `/agents-info`, or the band's panel button) clears the agents that have finished by then from its list: the Finished section, its count, the collapsed crab row and the band's counts. Running agents stay, agents that finish later show normally, and the header totals still cover every agent of the session. The panel being dropped by the engine (unload) does not clear anything.

`costumes`: `savvy` (default) or `rotate`. With `savvy` a crab's costume and colour come from the savvy-flow tier (an `Explore` agent keeps the pirate). With `rotate` every agent is dealt one of the tier costumes in turn when it spawns (`Explore` still keeps the pirate) and keeps it, and its colour follows the model family instead of the tier: Haiku, Sonnet, Opus and Fable each have their own, an unknown model stays grey.

`activity`: `off` (default) or `on`. With `on`, each agent row in the panel gets a small button (`▸ details` under the row on the desktop; on the terminal the row's title line itself) that opens the agent's brief (the first three lines of its prompt), its last 10 tool calls newest first with their age (`now`, `12s`, `3m`, `2h`), its current step note, and, once it has answered, the first three lines of its result. One agent is open at a time; closing the panel closes it. The band above the prompt and the collapsed panel never show details, and `cost: hide`, `finished`, `band` and `costumes` work as before. Hebrew draws the labels right to left and the commands and paths left to right. Ages count from the panel's own clock, which ticks only while an agent runs, so they hold still when none does. Bash lines drop a leading `cd … &&` and show the home directory as `~`. With `off` nothing is recorded and nothing changes.

Everything an agent wrote that the panel shows (calls, brief, step note, result) is masked first and cut after, so a cut never leaves the head of a secret behind. The mask `•••` replaces these, case-insensitively:

- `key=value`, `key: value` and `"key": "value"` for `password`, `passwd`, `pwd`, `secret`, `token`, `api_key`, `api-key`, `apikey`, `access_key`, `auth` and `key`, also as the end of a longer name (`PGPASSWORD=`, `GITHUB_TOKEN=`, `AWS_SECRET_ACCESS_KEY=`); the value is a quoted string (spaces included) or a run up to a space or quote
- `Authorization: <the rest of the header>` and `Bearer <token>`
- `--password <x>` (and `--password=<x>`), and `-p<x>` or `-p <x>` after `mysql`, `mysqldump` or `mariadb` only, so `mkdir -p dir` and `git log -p` stay
- `://user:password@host` in a URL: the password goes, the user and host stay
- keys that announce themselves: `sk-…`, `ghp_…` / `gho_…` / `ghu_…` / `ghs_…` / `ghr_…`, `github_pat_…`, `xoxa-` / `xoxb-` / `xoxp-` / `xoxr-` / `xoxs-` tokens, `AKIA…` access key ids
- any other run of 32 or more base64 or hex characters that holds a letter and a digit (so a git hash goes too), unless it reads as a path (slashes with short parts between them)

This is a best-effort filter for the usual ways credentials show up in a command line, a prompt or an answer, not a guarantee: a secret in none of those shapes (a bare password in prose, a short token with no label) is not caught, and only the first 4,000 characters of each text are looked at. Nothing is logged, written to disk or sent anywhere. One limit: the Agent call's `description` (the row's title) is written by the model, already drawn by the panel without this option, and is not masked.

Install instructions are in the [repository README](../../README.md).
