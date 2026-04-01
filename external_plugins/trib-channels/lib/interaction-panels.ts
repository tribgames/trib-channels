type Embed = Record<string, unknown>
type Component = Record<string, unknown>
type SelectOption = Record<string, unknown>

export type InteractionPanel = {
  embeds: Embed[]
  components: Component[]
}

const PANEL_COLOR = 0x5865F2

function actionRow(components: Component[]): Component {
  return { type: 1, components }
}

function selectMenu(
  customId: string,
  placeholder: string,
  options: SelectOption[],
): Component {
  return { type: 3, custom_id: customId, placeholder, options }
}

function button(style: number, label: string, customId: string): Component {
  return { type: 2, style, label, custom_id: customId }
}

function panel(title: string, description: string, components: Component[]): InteractionPanel {
  return {
    embeds: [{ title, description, color: PANEL_COLOR }],
    components,
  }
}

function schedulePeriodOptions(): SelectOption[] {
  return [
    { label: 'Daily', value: 'daily' },
    { label: 'Weekday', value: 'weekday' },
    { label: 'Hourly', value: 'hourly' },
    { label: 'Once', value: 'once' },
  ]
}

function scheduleExecOptions(): SelectOption[] {
  return [
    { label: 'Prompt (.md)', value: 'prompt' },
    { label: 'Script (.js/.py)', value: 'script' },
    { label: 'Script + Prompt', value: 'script+prompt' },
  ]
}

function scheduleModeOptions(): SelectOption[] {
  return [
    { label: 'Interactive', value: 'interactive' },
    { label: 'Non-interactive', value: 'non-interactive' },
  ]
}

export function buildScheduleAddPanel(): InteractionPanel {
  return panel('\uD83D\uDCC5 Add Schedule', 'Select options and press **Next**', [
    actionRow([selectMenu('sched_add_period', 'Select Period', schedulePeriodOptions())]),
    actionRow([selectMenu('sched_add_exec', 'Exec Mode', scheduleExecOptions())]),
    actionRow([selectMenu('sched_add_mode', 'Mode', scheduleModeOptions())]),
    actionRow([
      button(1, 'Next \u2192', 'sched_add_next'),
      button(2, '← List', 'bot_schedule'),
      button(4, '\u2715', 'gui_close'),
    ]),
  ])
}

export function buildScheduleEditPanel(name: string): InteractionPanel {
  return panel(`\uD83D\uDCC4 ${name} Edit`, 'Select options and press **Next**', [
    actionRow([selectMenu('sched_edit_period', 'Select Period', schedulePeriodOptions())]),
    actionRow([selectMenu('sched_edit_exec', 'Exec Mode', scheduleExecOptions())]),
    actionRow([selectMenu('sched_edit_mode', 'Mode', scheduleModeOptions())]),
    actionRow([
      button(1, 'Next \u2192', 'sched_edit_next'),
      button(2, '← List', 'bot_schedule'),
      button(4, '\u2715', 'gui_close'),
    ]),
  ])
}

export function buildAutotalkFrequencyPanel(): InteractionPanel {
  return panel('\uD83D\uDCAC Autotalk Frequency', 'Select frequency', [
    actionRow([
      selectMenu('autotalk_freq_select', 'Frequency (1~5)', [
        { label: '1 — Min', value: '1' },
        { label: '2 — Low', value: '2' },
        { label: '3 — Normal', value: '3', default: true },
        { label: '4 — High', value: '4' },
        { label: '5 — Max', value: '5' },
      ]),
    ]),
    actionRow([
      button(2, '← Autotalk', 'bot_autotalk'),
      button(4, '\u2715', 'gui_close'),
    ]),
  ])
}

export function buildQuietHoursPanel(): InteractionPanel {
  return panel('\uD83D\uDD15 Quiet Hours', 'Select holiday country and press **Next**', [
    actionRow([
      selectMenu('quiet_holidays_select', 'Holiday Country (optional)', [
        { label: 'None', value: 'none' },
        { label: '\uD83C\uDDF0\uD83C\uDDF7 Korea', value: 'KR' },
        { label: '\uD83C\uDDEF\uD83C\uDDF5 Japan', value: 'JP' },
        { label: '\uD83C\uDDFA\uD83C\uDDF8 USA', value: 'US' },
        { label: '\uD83C\uDDE8\uD83C\uDDF3 China', value: 'CN' },
        { label: '\uD83C\uDDEC\uD83C\uDDE7 UK', value: 'GB' },
        { label: '\uD83C\uDDE9\uD83C\uDDEA Germany', value: 'DE' },
      ]),
    ]),
    actionRow([
      button(1, 'Next \u2192', 'quiet_set_next'),
      button(2, '← Quiet', 'bot_quiet'),
      button(4, '\u2715', 'gui_close'),
    ]),
  ])
}

export function buildActivityAddPanel(): InteractionPanel {
  return panel('\uD83D\uDCE1 Add Activity Channel', 'Select mode and press **Next**', [
    actionRow([
      selectMenu('activity_mode_select', 'Select Mode', [
        { label: 'Interactive \u2014 Participate', value: 'interactive' },
        { label: 'Monitor \u2014 Read-only', value: 'monitor' },
      ]),
    ]),
    actionRow([
      button(1, 'Next \u2192', 'activity_add_next'),
      button(2, '← Channels', 'bot_activity'),
      button(4, '\u2715', 'gui_close'),
    ]),
  ])
}
