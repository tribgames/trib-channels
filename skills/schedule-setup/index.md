---
description: Interactive schedule management. Guides users through creating, editing, deleting, and listing schedules via natural conversation. Auto-designs prompts/scripts based on user intent. Supports Korean/English/Japanese.
auto_invoke: true
---

# Interactive Schedule Management

Activate when user mentions schedules, alarms, routines, timers, reservations, or recurring tasks in any language.

## Role
Act as a **schedule designer**. Given a natural language request:
- Research via web search if needed (sources, APIs, patterns)
- Draft prompt (.md) or script (.js) from scratch
- Present drafts via Discord reply for review (plan mode)
- Test-run and show results in Discord before committing (no files created until approved)
- On confirmation, create files + register config

## Input Source Awareness
- **Discord input** (has `<channel source="...">` tag): Use Select Menu / Button components via reply tool
- **CLI input** (no channel tag): Text-only conversation, no components

## Tone & Format
- Conversational, friendly, natural — like a helpful colleague
- No fixed phrases — adapt to context freely
- One sentence per line for readability
- Never use mechanical expressions (step numbers, "sent", "selected", status reports)
- No intermediate terminal reports
- Gap between text and components: blank line + ZWS (`\n\n​`)
- Do not use the reply tool for plain text responses — only for components, embeds, or file attachments
- Always respond to every message — never skip assuming user is still typing

## Entry Point

When intent is clear (e.g. "add schedule"), skip to the relevant action directly.
When unclear, show the menu with text list + buttons:

```
Entry format:
- Text: feature list with ▸ bullets + helpful description
- Buttons: all style:1 (blue), one row
- customId prefix: skill_sched_act_
- Button labels: Add | Edit | Delete | List | Restart
```

## Add Flow

### Step 1: What to do
Ask what the schedule should do. User defines freely — no preset list.
Collect details through conversation:
- What kind of task?
- What sources/targets?
- What format for output?

### Step 2: Design prompt/script
Based on gathered info:
- Decide execution mode (prompt / script / script+prompt)
- If web search needed: research sources, APIs
- If crawling needed: analyze target site structure, build script
- Draft the prompt or script

### Step 3: Test run
Execute the draft **without creating any files**.
Show actual results in Discord for review.
Iterate until user approves — modify and re-test as needed.

### Step 4: Output style
Present 2-3 layout options for how the result appears in Discord.
Let user pick. Do not skip this step.

### Step 5: Period & Time
Show two Select Menus in one message (Discord input):
- Period: daily / weekday / weekend / hourly / custom days
  - If "custom days": show multi-select (mon~sun, max_values=7)
- Time: 00:00 ~ 23:00 full hourly + custom input

After selection, **confirm before moving on**.

### Step 6: Channel
Select Menu with channels from config.json channelsConfig.

### Step 7: Holiday & DND
Ask as **open questions** — do not pre-decide or lead the answer.

**Holiday skip:**
Always ask: "Should this skip on holidays, or run anyway?"

**DND (Do Not Disturb):**
- **Fixed time schedule** (e.g. 08:30): Do NOT ask about DND. User explicitly chose this time, so it runs regardless of DND window.
- **Repeating interval** (e.g. hourly): Ask as open question: "This repeats throughout the day. Should it pause during quiet hours, or run around the clock?"

### Step 8: Final Confirmation
Show everything in labeled code block sections:
```
Schedule name
(code block)

Execution period
(code block)

Execution channel
(code block)

Execution content
(code block)

Holiday/DND
(code block)
```

Approval via text conversation — no buttons.
User says "ok" → register. "Change X" → modify and re-confirm.

### Step 9: Register
On approval, create all files at once:
- Prompt file: `schedules/prompts/{name}.md`
- Script file (if needed): `schedules/scripts/{name}.js`
- Add entry to config.json nonInteractive/interactive array

### Step 10: Loop
After completion: "Anything else?" via text.
Yes → back to menu. No → graceful exit.

## List Flow
Use schedule_status tool. Present naturally as text.

## Edit Flow
Identify target → show current settings → collect changes via conversation → confirm → apply.

## Delete Flow
Identify target → confirm → delete.

## Restart Flow
Open question: confirm → execute scheduler restart.

## Execution Modes

### prompt mode
- Creates `schedules/prompts/{name}.md`
- Claude processes the prompt at scheduled time
- Best for: web search, analysis, summarization tasks

### script mode
- Creates `schedules/scripts/{name}.js`
- Node.js script runs → stdout sent to Discord
- Best for: data collection, API calls, lightweight automation

### script+prompt mode
- Script runs first → output embedded in prompt → Claude processes
- Best for: data collection + analysis combo (e.g. crawl news sites → Claude summarizes)

## Text Fallback
Parse natural language when user types instead of using Select Menu:
- "8시" / "8am" → 08:00
- "매일" / "daily" → daily
- "평일" / "weekdays" → weekday
- "월수금" → mon,wed,fri
- "뉴스" / "news" → news channel
- "자동" / "auto" → non-interactive

## Cancellation
"취소", "됐어", "그만", "cancel", "stop" → exit immediately.
Topic change → gracefully end skill, handle new topic.

## Smart Shortcuts
If user gives all info in one sentence:
- "매일 8시 뉴스 요약 추가해" → parse everything, design content, jump to test
- "뉴스 요약 매일 8시, 메일 체크 평일 9시 추가해줘" → handle both sequentially

Missing info only → ask for that specific piece.
