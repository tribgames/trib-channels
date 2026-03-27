import type { ProfileConfig } from '../backends/types.js'

export type PendingInteractionState = Record<string, string>

export type ModalFieldSpec = {
  id: string
  label: string
  required: boolean
  value?: string
}

export type ModalRequestSpec = {
  customId: string
  title: string
  fields: ModalFieldSpec[]
}

export type CommandInvocation = {
  target: 'bot' | 'profile'
  args: string[]
  params: Record<string, string>
}

export type ModalExecutionPlan = {
  commands: CommandInvocation[]
  followup?: CommandInvocation
}

function stateKey(userId: string, channelId: string): string {
  return `${userId}:${channelId}`
}

export class PendingInteractionStore {
  private readonly states = new Map<string, PendingInteractionState>()

  get(userId: string, channelId: string): PendingInteractionState {
    return { ...(this.states.get(stateKey(userId, channelId)) ?? {}) }
  }

  set(userId: string, channelId: string, state: PendingInteractionState): void {
    this.states.set(stateKey(userId, channelId), state)
  }

  patch(userId: string, channelId: string, update: Record<string, string>): PendingInteractionState {
    const next = { ...this.get(userId, channelId), ...update }
    this.set(userId, channelId, next)
    return next
  }

  delete(userId: string, channelId: string): void {
    this.states.delete(stateKey(userId, channelId))
  }

  rememberMessage(userId: string, channelId: string, messageId?: string): void {
    if (!messageId) return
    this.patch(userId, channelId, { _msgId: messageId })
  }
}

export function getPendingSelectUpdate(
  customId: string,
  values?: string[],
): Record<string, string> | null {
  const value = values?.[0]
  if (!value) return null

  const scheduleMatch = customId.match(/^sched_(add|edit)_(period|exec|mode)$/)
  if (scheduleMatch) {
    return { [scheduleMatch[2]]: value }
  }

  if (customId === 'quiet_holidays_select') {
    return { holidays: value }
  }

  if (customId === 'activity_mode_select') {
    return { activityMode: value }
  }

  return null
}

export function buildModalRequestSpec(
  customId: string,
  pending: PendingInteractionState,
  profile: ProfileConfig,
): ModalRequestSpec | null {
  switch (customId) {
    case 'sched_add_next': {
      const fields: ModalFieldSpec[] = [
        { id: 'name', label: 'Name', required: true },
        { id: 'time', label: 'Time (HH:MM / hourly / every5m)', required: true },
        { id: 'channel', label: 'Channel', required: false, value: 'general' },
      ]
      if (pending.exec?.includes('script')) {
        fields.push({ id: 'script', label: 'Script filename', required: true })
      }
      return {
        customId: 'modal_sched_add',
        title: 'Add Schedule',
        fields,
      }
    }
    case 'quiet_set_next':
      return {
        customId: 'modal_quiet',
        title: 'Quiet Hours',
        fields: [
          { id: 'schedule', label: 'Schedule quiet hours (e.g. 23:00-07:00)', required: false },
          { id: 'autotalk', label: 'Autotalk quiet hours (e.g. 23:00-09:00)', required: false },
        ],
      }
    case 'sched_edit_next': {
      const fields: ModalFieldSpec[] = [
        { id: 'time', label: 'Time (HH:MM / hourly / every5m)', required: false },
        { id: 'channel', label: 'Channel', required: false },
        { id: 'dnd', label: 'Quiet hours (e.g. 23:00-07:00, leave empty to disable)', required: false },
      ]
      if (pending.exec?.includes('script')) {
        fields.push({ id: 'script', label: 'Script filename', required: false })
      }
      return {
        customId: 'modal_sched_edit',
        title: `${pending.editName ?? 'Schedule'} Edit`,
        fields,
      }
    }
    case 'activity_add_next':
      return {
        customId: 'modal_activity_add',
        title: 'Add Activity Channel',
        fields: [
          { id: 'name', label: 'Channel Name', required: true },
          { id: 'id', label: 'Channel ID', required: true },
        ],
      }
    case 'profile_edit':
      return {
        customId: 'modal_profile_edit',
        title: 'Edit Profile',
        fields: [
          { id: 'name', label: 'Name', required: false, value: profile.name ?? '' },
          { id: 'role', label: 'Role', required: false, value: profile.role ?? '' },
          { id: 'lang', label: 'Language (ko / en / ja / zh)', required: false, value: profile.lang ?? '' },
          { id: 'tone', label: 'Tone', required: false, value: profile.tone ?? '' },
        ],
      }
    default:
      return null
  }
}

export function buildModalExecutionPlan(
  customId: string,
  pending: PendingInteractionState,
  fields: Record<string, string>,
): ModalExecutionPlan | null {
  switch (customId) {
    case 'modal_sched_add': {
      const params: Record<string, string> = {
        time: fields.time,
        channel: fields.channel || 'general',
        mode: pending.mode || 'non-interactive',
        period: pending.period || 'daily',
        exec: pending.exec || 'prompt',
      }
      if (fields.script) params.script = fields.script
      return {
        commands: [{ target: 'bot', args: ['schedule', 'add', fields.name], params }],
        followup: { target: 'bot', args: ['schedule', 'list'], params: {} },
      }
    }
    case 'modal_quiet': {
      const commands: CommandInvocation[] = []
      if (fields.schedule) commands.push({ target: 'bot', args: ['quiet', 'schedule', fields.schedule], params: {} })
      if (fields.autotalk) commands.push({ target: 'bot', args: ['quiet', 'autotalk', fields.autotalk], params: {} })
      if (pending.holidays && pending.holidays !== 'none') {
        commands.push({ target: 'bot', args: ['quiet', 'holidays', pending.holidays], params: {} })
      }
      return {
        commands,
        followup: { target: 'bot', args: ['quiet', 'list'], params: {} },
      }
    }
    case 'modal_sched_edit': {
      const name = pending.editName
      if (!name) return null
      const params: Record<string, string> = {}
      if (fields.time) params.time = fields.time
      if (fields.channel) params.channel = fields.channel
      if (pending.period) params.period = pending.period
      if (pending.exec) params.exec = pending.exec
      if (pending.mode) params.mode = pending.mode
      if (fields.script) params.script = fields.script

      const commands: CommandInvocation[] = [
        { target: 'bot', args: ['schedule', 'edit', name], params },
      ]
      if (fields.dnd) {
        commands.push({ target: 'bot', args: ['quiet', 'schedule', fields.dnd], params: {} })
      }
      return {
        commands,
        followup: { target: 'bot', args: ['schedule', 'detail', name], params: {} },
      }
    }
    case 'modal_activity_add':
      return {
        commands: [{
          target: 'bot',
          args: ['activity', 'add', fields.name],
          params: {
            id: fields.id,
            mode: pending.activityMode || 'interactive',
          },
        }],
        followup: { target: 'bot', args: ['activity', 'list'], params: {} },
      }
    case 'modal_profile_edit': {
      const params: Record<string, string> = {}
      if (fields.name) params.name = fields.name
      if (fields.role) params.role = fields.role
      if (fields.lang) params.lang = fields.lang
      if (fields.tone) params.tone = fields.tone
      return {
        commands: Object.keys(params).length > 0
          ? [{ target: 'profile', args: ['set'], params }]
          : [],
        followup: { target: 'bot', args: ['profile', 'list'], params: {} },
      }
    }
    default:
      return null
  }
}
