/**
 * Discord slash command definitions, registration, and handler logic.
 *
 * Commands are registered as guild commands (instant propagation).
 * All responses are ephemeral (visible only to the invoking user).
 */

import { REST, Routes, SlashCommandBuilder } from 'discord.js'
import type { ChatInputCommandInteraction, Client } from 'discord.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { PluginConfig } from '../backends/types.js'
import type { Scheduler } from './scheduler.js'
import { DATA_DIR } from './config.js'
import { handleBotCommand, handleProfileCommand } from './custom-commands.js'
import type { CommandContext } from './custom-commands.js'

// ── Constants ────────────────────────────────────────────────────────

const EMBED_COLOR = 0x5865F2 // Discord blurple

interface EmbedField { name: string; value: string; inline: boolean }

// ── i18n ─────────────────────────────────────────────────────────────

type Lang = 'en' | 'ko' | 'ja' | 'zh'

/** Cached config language override (read from config.json on first call) */
let configLangCache: Lang | null | undefined = undefined

function getConfigLang(): Lang | null {
  if (configLangCache !== undefined) return configLangCache
  try {
    const configPath = join(DATA_DIR, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const lang = config.language as string | undefined
    if (lang === 'en' || lang === 'ko' || lang === 'ja' || lang === 'zh') {
      configLangCache = lang
      return lang
    }
  } catch { /* ignore */ }
  configLangCache = null
  return null
}

function invalidateConfigLangCache(): void {
  configLangCache = undefined
}

function getLang(locale: string): Lang {
  const override = getConfigLang()
  if (override) return override
  if (locale === 'ko') return 'ko'
  if (locale === 'ja') return 'ja'
  if (locale.startsWith('zh')) return 'zh'
  return 'en'
}

const i18n: Record<string, Record<Lang, string>> = {
  // stop
  'stop.not_found': {
    en: 'Parent process not found.',
    ko: '부모 프로세스를 찾을 수 없습니다.',
    ja: '親プロセスが見つかりません。',
    zh: '找不到父进程。',
  },
  'stop.sent': {
    en: 'SIGINT sent (PID: {pid})',
    ko: 'SIGINT 전송 완료 (PID: {pid})',
    ja: 'SIGINT送信完了 (PID: {pid})',
    zh: '已发送SIGINT (PID: {pid})',
  },
  'stop.failed': {
    en: 'Failed to send SIGINT: {error}',
    ko: 'SIGINT 전송 실패: {error}',
    ja: 'SIGINT送信失敗: {error}',
    zh: '发送SIGINT失败: {error}',
  },
  // status
  'status.checking': {
    en: 'Checking status...',
    ko: '상태 확인 중...',
    ja: 'ステータス確認中...',
    zh: '正在检查状态...',
  },
  'status.started': {
    en: 'Started',
    ko: '시작 시간',
    ja: '開始時間',
    zh: '启动时间',
  },
  // config
  'config.loading': {
    en: 'Loading config...',
    ko: '설정 불러오는 중...',
    ja: '設定を読み込み中...',
    zh: '正在加载配置...',
  },
  // model
  'model.switched': {
    en: 'Model switch request: **{model}** (forwarded to session)',
    ko: '모델 전환 요청: **{model}** (세션에 전달됨)',
    ja: 'モデル切替リクエスト: **{model}** (セッションに転送済み)',
    zh: '模型切换请求: **{model}** (已转发到会话)',
  },
  // compact
  'compact.forwarded': {
    en: 'Compact request forwarded to session.',
    ko: '컨텍스트 압축 요청이 세션에 전달되었습니다.',
    ja: '圧縮リクエストをセッションに転送しました。',
    zh: '压缩请求已转发到会话。',
  },
  // clear
  'clear.forwarded': {
    en: 'Clear request forwarded to session.',
    ko: '대화 초기화 요청이 세션에 전달되었습니다.',
    ja: 'クリアリクエストをセッションに転送しました。',
    zh: '清除请求已转发到会话。',
  },
  // new
  'new.forwarded': {
    en: 'New session request forwarded to session.',
    ko: '새 세션 시작 요청이 세션에 전달되었습니다.',
    ja: '新しいセッションリクエストをセッションに転送しました。',
    zh: '新建会话请求已转发到会话。',
  },
  // resume
  'resume.forwarded': {
    en: 'Resume request forwarded to session.',
    ko: '세션 이어하기 요청이 세션에 전달되었습니다.',
    ja: 'セッション再開リクエストを転送しました。',
    zh: '恢复会话请求已转发到会话。',
  },
  // schedule
  'schedule.no_schedules': {
    en: 'No schedules registered.',
    ko: '등록된 스케줄이 없습니다.',
    ja: '登録済みスケジュールはありません。',
    zh: '没有已注册的计划。',
  },
  'schedule.name_required_remove': {
    en: 'Please specify a schedule name. (`/claude schedule remove [name]`)',
    ko: '스케줄 이름을 지정해주세요. (`/claude schedule remove [name]`)',
    ja: 'スケジュール名を指定してください。(`/claude schedule remove [name]`)',
    zh: '请指定计划名称。(`/claude schedule remove [name]`)',
  },
  'schedule.name_required_add': {
    en: 'Please specify a schedule name. (`/claude schedule add [name]`)',
    ko: '스케줄 이름을 지정해주세요. (`/claude schedule add [name]`)',
    ja: 'スケジュール名を指定してください。(`/claude schedule add [name]`)',
    zh: '请指定计划名称。(`/claude schedule add [name]`)',
  },
  'schedule.not_found': {
    en: 'Schedule "{name}" not found.',
    ko: '스케줄 "{name}"을 찾을 수 없습니다.',
    ja: 'スケジュール「{name}」が見つかりません。',
    zh: '找不到计划「{name}」。',
  },
  'schedule.removed': {
    en: 'Schedule "{name}" removed (effective from next tick).',
    ko: '스케줄 "{name}" 삭제 완료 (다음 틱부터 적용).',
    ja: 'スケジュール「{name}」を削除しました (次のティックから適用)。',
    zh: '计划「{name}」已删除 (下次执行时生效)。',
  },
  'schedule.remove_failed': {
    en: 'Remove failed: {error}',
    ko: '삭제 실패: {error}',
    ja: '削除失敗: {error}',
    zh: '删除失败: {error}',
  },
  'schedule.add_missing_options': {
    en: 'Missing required options. Usage: `/claude schedule add name:<name> time:<HH:MM> channel:<label> prompt:<text>`',
    ko: '필수 옵션이 누락되었습니다. 사용법: `/claude schedule add name:<이름> time:<HH:MM> channel:<채널> prompt:<텍스트>`',
    ja: '必須オプションが不足しています。使い方: `/claude schedule add name:<名前> time:<HH:MM> channel:<チャンネル> prompt:<テキスト>`',
    zh: '缺少必填选项。用法: `/claude schedule add name:<名称> time:<HH:MM> channel:<频道> prompt:<文本>`',
  },
  'schedule.already_exists': {
    en: 'Schedule "{name}" already exists.',
    ko: '스케줄 "{name}"이(가) 이미 존재합니다.',
    ja: 'スケジュール「{name}」は既に存在します。',
    zh: '计划「{name}」已存在。',
  },
  'schedule.added': {
    en: 'Schedule "{name}" added (time: {time}, channel: {channel}). Prompt saved to {name}.md.',
    ko: '스케줄 "{name}" 추가 완료 (시간: {time}, 채널: {channel}). 프롬프트가 {name}.md에 저장되었습니다.',
    ja: 'スケジュール「{name}」を追加しました (時間: {time}, チャンネル: {channel})。プロンプトを{name}.mdに保存しました。',
    zh: '计划「{name}」已添加 (时间: {time}, 频道: {channel})。提示已保存到{name}.md。',
  },
  'schedule.add_failed': {
    en: 'Add failed: {error}',
    ko: '추가 실패: {error}',
    ja: '追加失敗: {error}',
    zh: '添加失败: {error}',
  },
  'schedule.restarted': {
    en: 'Scheduler restarted.',
    ko: '스케줄러가 재시작되었습니다.',
    ja: 'スケジューラーを再起動しました。',
    zh: '调度器已重启。',
  },
  // doctor
  'doctor.config_exists': {
    en: '[PASS] Config file exists',
    ko: '[PASS] Config 파일 존재',
    ja: '[PASS] 設定ファイルあり',
    zh: '[PASS] 配置文件存在',
  },
  'doctor.config_missing': {
    en: '[FAIL] Config file missing',
    ko: '[FAIL] Config 파일 없음',
    ja: '[FAIL] 設定ファイルなし',
    zh: '[FAIL] 配置文件缺失',
  },
  'doctor.token_ok': {
    en: '[PASS] Bot token configured',
    ko: '[PASS] 봇 토큰 설정됨',
    ja: '[PASS] ボットトークン設定済み',
    zh: '[PASS] 机器人令牌已配置',
  },
  'doctor.token_missing': {
    en: '[FAIL] Bot token missing',
    ko: '[FAIL] 봇 토큰 없음',
    ja: '[FAIL] ボットトークンなし',
    zh: '[FAIL] 机器人令牌缺失',
  },
  'doctor.access_parse_failed': {
    en: '[WARN] access.json parse failed',
    ko: '[WARN] access.json 파싱 실패',
    ja: '[WARN] access.json解析失敗',
    zh: '[WARN] access.json解析失败',
  },
  'doctor.access_missing': {
    en: '[WARN] access.json missing -- configure with /claude2bot:access',
    ko: '[WARN] access.json 없음 -- /claude2bot:access 로 설정',
    ja: '[WARN] access.jsonなし -- /claude2bot:accessで設定',
    zh: '[WARN] access.json缺失 -- 使用/claude2bot:access配置',
  },
  'doctor.channels_not_set': {
    en: '[WARN] channelsConfig not set',
    ko: '[WARN] channelsConfig 미설정',
    ja: '[WARN] channelsConfig未設定',
    zh: '[WARN] channelsConfig未设置',
  },
  'doctor.voice_enabled': {
    en: '[INFO] Voice enabled',
    ko: '[INFO] Voice 활성화',
    ja: '[INFO] 音声有効',
    zh: '[INFO] 语音已启用',
  },
  // language
  'language.set': {
    en: 'Language set to English.',
    ko: '언어가 한국어로 설정되었습니다.',
    ja: '言語が日本語に設定されました。',
    zh: '语言已设置为中文。',
  },
  // access
  'access.title': {
    en: '**Access Control Status**',
    ko: '**접근 제어 상태**',
    ja: '**アクセス制御状態**',
    zh: '**访问控制状态**',
  },
  'access.dm_policy': {
    en: 'DM Policy: `{policy}`',
    ko: 'DM 정책: `{policy}`',
    ja: 'DMポリシー: `{policy}`',
    zh: 'DM策略: `{policy}`',
  },
  'access.allow_from': {
    en: 'Allowed Users: {count}',
    ko: '허용된 사용자: {count}명',
    ja: '許可ユーザー: {count}人',
    zh: '允许的用户: {count}人',
  },
  'access.channels': {
    en: 'Registered Channels: {count}',
    ko: '등록된 채널: {count}개',
    ja: '登録チャンネル: {count}個',
    zh: '已注册频道: {count}个',
  },
  'access.pending': {
    en: 'Pending Pairings: {count}',
    ko: '대기 중인 페어링: {count}개',
    ja: '保留中のペアリング: {count}件',
    zh: '待处理配对: {count}个',
  },
  'access.not_found': {
    en: 'access.json not found. Configure with `/claude2bot:access`.',
    ko: 'access.json을 찾을 수 없습니다. `/claude2bot:access`로 설정해주세요.',
    ja: 'access.jsonが見つかりません。`/claude2bot:access`で設定してください。',
    zh: '找不到access.json。请使用`/claude2bot:access`配置。',
  },
  'access.parse_failed': {
    en: 'Failed to parse access.json: {error}',
    ko: 'access.json 파싱 실패: {error}',
    ja: 'access.json解析失敗: {error}',
    zh: 'access.json解析失败: {error}',
  },
  // common
  'unknown_command': {
    en: 'Unknown command: {cmd}',
    ko: '알 수 없는 명령: {cmd}',
    ja: '不明なコマンド: {cmd}',
    zh: '未知命令: {cmd}',
  },
}

function t(key: string, locale: string, vars?: Record<string, string | number>): string {
  const lang = getLang(locale)
  let text = i18n[key]?.[lang] ?? i18n[key]?.en ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}

// ── Types ────────────────────────────────────────────────────────────

export type NotifyFn = (channelId: string, user: string, text: string) => void

export interface SlashCommandContext {
  config: PluginConfig
  scheduler: Scheduler
  /** Inject a command into the MCP session as a notification */
  notify: NotifyFn
  /** The MCP server's process (for stop command) */
  serverProcess: NodeJS.Process
}

// ── Command definitions ──────────────────────────────────────────────

function buildCommands(): SlashCommandBuilder {
  const claude = new SlashCommandBuilder()
    .setName('claude')
    .setDescription('Claude Code session control')
    .setDescriptionLocalizations({
      ko: 'Claude Code 세션 제어',
      ja: 'Claude Code セッション制御',
      'zh-CN': 'Claude Code 会话控制',
      'zh-TW': 'Claude Code 工作階段控制',
      'pt-BR': 'Controle de sessao Claude Code',
      'es-ES': 'Control de sesion Claude Code',
    })

  // /claude stop
  claude.addSubcommand(sub =>
    sub.setName('stop').setDescription('Stop current task')
      .setDescriptionLocalizations({
        ko: '현재 작업 중단',
        ja: '現在のタスクを停止',
        'zh-CN': '停止当前任务',
        'zh-TW': '停止目前任務',
        'pt-BR': 'Parar tarefa atual',
        'es-ES': 'Detener tarea actual',
      }),
  )

  // /claude status
  claude.addSubcommand(sub =>
    sub.setName('status').setDescription('Show session status')
      .setDescriptionLocalizations({
        ko: '세션 상태 확인',
        ja: 'セッション状態確認',
        'zh-CN': '查看会话状态',
        'zh-TW': '查看工作階段狀態',
        'pt-BR': 'Ver status da sessao',
        'es-ES': 'Ver estado de la sesion',
      }),
  )

  // /claude config
  claude.addSubcommand(sub =>
    sub.setName('config').setDescription('Show configuration')
      .setDescriptionLocalizations({
        ko: '설정 확인',
        ja: '設定確認',
        'zh-CN': '查看配置',
        'zh-TW': '查看設定',
        'pt-BR': 'Ver configuracao',
        'es-ES': 'Ver configuracion',
      }),
  )

  // /claude compact
  claude.addSubcommand(sub =>
    sub.setName('compact').setDescription('Compact conversation')
      .setDescriptionLocalizations({
        ko: '대화 압축',
        ja: '会話を圧縮',
        'zh-CN': '压缩对话',
        'zh-TW': '壓縮對話',
        'pt-BR': 'Compactar conversa',
        'es-ES': 'Compactar conversacion',
      }),
  )

  // /claude clear
  claude.addSubcommand(sub =>
    sub.setName('clear').setDescription('Clear conversation')
      .setDescriptionLocalizations({
        ko: '대화 초기화',
        ja: '会話をクリア',
        'zh-CN': '清除对话',
        'zh-TW': '清除對話',
        'pt-BR': 'Limpar conversa',
        'es-ES': 'Limpiar conversacion',
      }),
  )

  // /claude new
  claude.addSubcommand(sub =>
    sub.setName('new').setDescription('Start new session')
      .setDescriptionLocalizations({
        ko: '새 세션 시작',
        ja: '新しいセッションを開始',
        'zh-CN': '新建会话',
        'zh-TW': '新建工作階段',
        'pt-BR': 'Iniciar nova sessao',
        'es-ES': 'Iniciar nueva sesion',
      }),
  )

  // /claude model [name]
  claude.addSubcommand(sub =>
    sub
      .setName('model')
      .setDescription('Switch model')
      .setDescriptionLocalizations({
        ko: '모델 전환',
        ja: 'モデル切替',
        'zh-CN': '切换模型',
        'zh-TW': '切換模型',
        'pt-BR': 'Trocar modelo',
        'es-ES': 'Cambiar modelo',
      })
      .addStringOption(opt =>
        opt
          .setName('name')
          .setDescription('Model to switch to')
          .setDescriptionLocalizations({
            ko: '전환할 모델',
            ja: '切り替えるモデル',
            'zh-CN': '要切换的模型',
            'zh-TW': '要切換的模型',
            'pt-BR': 'Modelo para trocar',
            'es-ES': 'Modelo a cambiar',
          })
          .setRequired(true)
          .addChoices(
            { name: 'sonnet', value: 'sonnet' },
            { name: 'opus', value: 'opus' },
          ),
      ),
  )

  // /claude language [lang]
  claude.addSubcommand(sub =>
    sub
      .setName('language')
      .setDescription('Set display language')
      .setDescriptionLocalizations({
        ko: '표시 언어 설정',
        ja: '表示言語を設定',
        'zh-CN': '设置显示语言',
        'zh-TW': '設定顯示語言',
        'pt-BR': 'Definir idioma',
        'es-ES': 'Establecer idioma',
      })
      .addStringOption(opt => opt
        .setName('lang')
        .setDescription('Language')
        .setRequired(true)
        .addChoices(
          { name: 'English', value: 'en' },
          { name: '한국어', value: 'ko' },
          { name: '日本語', value: 'ja' },
          { name: '中文', value: 'zh' },
        )
      ),
  )

  // /claude resume
  claude.addSubcommand(sub =>
    sub.setName('resume').setDescription('Resume previous session')
      .setDescriptionLocalizations({
        ko: '이전 세션 이어하기',
        ja: '前のセッションを再開',
        'zh-CN': '恢复上一个会话',
        'zh-TW': '恢復上一個工作階段',
        'pt-BR': 'Retomar sessao anterior',
        'es-ES': 'Reanudar sesion anterior',
      }),
  )

  // /claude schedule [action]
  claude.addSubcommand(sub =>
    sub
      .setName('schedule')
      .setDescription('Manage schedules')
      .setDescriptionLocalizations({
        ko: '스케줄 관리',
        ja: 'スケジュール管理',
        'zh-CN': '管理计划任务',
        'zh-TW': '管理排程任務',
        'pt-BR': 'Gerenciar agendamentos',
        'es-ES': 'Gestionar programaciones',
      })
      .addStringOption(opt =>
        opt
          .setName('action')
          .setDescription('Action to perform')
          .setDescriptionLocalizations({
            ko: '수행할 작업',
            ja: '実行するアクション',
            'zh-CN': '要执行的操作',
            'zh-TW': '要執行的操作',
            'pt-BR': 'Acao a realizar',
            'es-ES': 'Accion a realizar',
          })
          .setRequired(true)
          .addChoices(
            { name: 'list', value: 'list' },
            { name: 'add', value: 'add' },
            { name: 'remove', value: 'remove' },
            { name: 'restart', value: 'restart' },
          ),
      )
      .addStringOption(opt =>
        opt
          .setName('name')
          .setDescription('Schedule name (required for add/remove)')
          .setDescriptionLocalizations({
            ko: '스케줄 이름 (add/remove 시 필수)',
            ja: 'スケジュール名 (add/remove時必須)',
            'zh-CN': '计划名称 (add/remove时必填)',
            'zh-TW': '排程名稱 (add/remove時必填)',
            'pt-BR': 'Nome do agendamento (obrigatorio para add/remove)',
            'es-ES': 'Nombre de programacion (requerido para add/remove)',
          })
          .setRequired(false),
      )
      .addStringOption(opt =>
        opt
          .setName('time')
          .setDescription('Time in HH:MM format (required for add)')
          .setDescriptionLocalizations({
            ko: 'HH:MM 형식 시간 (add 시 필수)',
            ja: 'HH:MM形式の時間 (add時必須)',
            'zh-CN': 'HH:MM格式时间 (add时必填)',
            'zh-TW': 'HH:MM格式時間 (add時必填)',
            'pt-BR': 'Horario no formato HH:MM (obrigatorio para add)',
            'es-ES': 'Hora en formato HH:MM (requerido para add)',
          })
          .setRequired(false),
      )
      .addStringOption(opt =>
        opt
          .setName('channel')
          .setDescription('Target channel label (required for add)')
          .setDescriptionLocalizations({
            ko: '대상 채널 라벨 (add 시 필수)',
            ja: '対象チャンネルラベル (add時必須)',
            'zh-CN': '目标频道标签 (add时必填)',
            'zh-TW': '目標頻道標籤 (add時必填)',
            'pt-BR': 'Rotulo do canal alvo (obrigatorio para add)',
            'es-ES': 'Etiqueta del canal destino (requerido para add)',
          })
          .setRequired(false),
      )
      .addStringOption(opt =>
        opt
          .setName('prompt')
          .setDescription('Prompt text for the schedule (required for add)')
          .setDescriptionLocalizations({
            ko: '스케줄 프롬프트 텍스트 (add 시 필수)',
            ja: 'スケジュールのプロンプト (add時必須)',
            'zh-CN': '计划任务的提示文本 (add时必填)',
            'zh-TW': '排程任務的提示文本 (add時必填)',
            'pt-BR': 'Texto do prompt do agendamento (obrigatorio para add)',
            'es-ES': 'Texto del prompt de programacion (requerido para add)',
          })
          .setRequired(false),
      )
      .addStringOption(opt =>
        opt
          .setName('mode')
          .setDescription('Schedule mode (default: interactive)')
          .setDescriptionLocalizations({
            ko: '스케줄 모드 (기본: interactive)',
            ja: 'スケジュールモード (デフォルト: interactive)',
            'zh-CN': '计划模式 (默认: interactive)',
            'zh-TW': '排程模式 (預設: interactive)',
            'pt-BR': 'Modo do agendamento (padrao: interactive)',
            'es-ES': 'Modo de programacion (predeterminado: interactive)',
          })
          .setRequired(false)
          .addChoices(
            { name: 'interactive', value: 'interactive' },
            { name: 'non-interactive', value: 'non-interactive' },
          ),
      ),
  )

  // /claude access
  claude.addSubcommand(sub =>
    sub.setName('access').setDescription('Show access control status')
      .setDescriptionLocalizations({
        ko: '접근 제어 상태 확인',
        ja: 'アクセス制御状態を表示',
        'zh-CN': '查看访问控制状态',
        'zh-TW': '查看存取控制狀態',
        'pt-BR': 'Mostrar controle de acesso',
        'es-ES': 'Mostrar control de acceso',
      }),
  )

  // /claude doctor
  claude.addSubcommand(sub =>
    sub.setName('doctor').setDescription('System diagnostics')
      .setDescriptionLocalizations({
        ko: '시스템 진단',
        ja: 'システム診断',
        'zh-CN': '系统诊断',
        'zh-TW': '系統診斷',
        'pt-BR': 'Diagnostico do sistema',
        'es-ES': 'Diagnostico del sistema',
      }),
  )

  // /claude help
  claude.addSubcommand(sub =>
    sub.setName('help').setDescription('Show available commands')
      .setDescriptionLocalizations({
        ko: '도움말',
        ja: 'ヘルプ',
        'zh-CN': '帮助',
        'zh-TW': '說明',
        'pt-BR': 'Mostrar comandos disponiveis',
        'es-ES': 'Mostrar comandos disponibles',
      }),
  )

  // /claude bot (subcommand group)
  claude.addSubcommandGroup(group =>
    group.setName('bot').setDescription('Bot settings')
      .setDescriptionLocalizations({
        ko: '봇 설정',
        ja: 'ボット設定',
        'zh-CN': '机器人设置',
        'zh-TW': '機器人設定',
      })
      .addSubcommand(sub =>
        sub.setName('status').setDescription('Bot status overview')
          .setDescriptionLocalizations({
            ko: '봇 상태 개요',
            ja: 'ボットステータス',
            'zh-CN': '机器人状态概览',
            'zh-TW': '機器人狀態概覽',
          }),
      )
      .addSubcommand(sub =>
        sub.setName('schedule').setDescription('Schedule management')
          .setDescriptionLocalizations({
            ko: '스케줄 관리',
            ja: 'スケジュール管理',
            'zh-CN': '计划管理',
            'zh-TW': '排程管理',
          }),
      )
      .addSubcommand(sub =>
        sub.setName('autotalk').setDescription('Autonomous chat settings')
          .setDescriptionLocalizations({
            ko: '자율 대화 설정',
            ja: '自律チャット設定',
            'zh-CN': '自主聊天设置',
            'zh-TW': '自主聊天設定',
          }),
      )
      .addSubcommand(sub =>
        sub.setName('quiet').setDescription('Do not disturb settings')
          .setDescriptionLocalizations({
            ko: '방해금지 설정',
            ja: 'おやすみモード設定',
            'zh-CN': '免打扰设置',
            'zh-TW': '勿擾設定',
          }),
      )
      .addSubcommand(sub =>
        sub.setName('activity').setDescription('Activity channels')
          .setDescriptionLocalizations({
            ko: '활동 채널 목록',
            ja: 'アクティビティチャンネル',
            'zh-CN': '活动频道',
            'zh-TW': '活動頻道',
          }),
      ),
  )

  // /claude profile
  claude.addSubcommand(sub =>
    sub.setName('profile').setDescription('User profile settings')
      .setDescriptionLocalizations({
        ko: '사용자 프로필 설정',
        ja: 'ユーザープロフィール設定',
        'zh-CN': '用户资料设置',
        'zh-TW': '使用者個人資料設定',
      }),
  )

  return claude
}

// ── Registration ─────────────────────────────────────────────────────

export async function registerSlashCommands(client: Client, token: string): Promise<void> {
  if (!client.user) return
  const rest = new REST({ version: '10' }).setToken(token)
  const commands = [buildCommands().toJSON()]

  // cache가 비어있으면 fetch 시도
  let guilds = client.guilds.cache
  if (guilds.size === 0) {
    process.stderr.write('claude2bot: guild cache empty, fetching...\n')
    try {
      const fetched = await client.guilds.fetch()
      guilds = fetched as any
    } catch (e) {
      process.stderr.write(`claude2bot: guild fetch failed: ${e}\n`)
    }
  }

  if (guilds.size === 0) {
    process.stderr.write('claude2bot: WARNING: no guilds found, slash commands not registered\n')
    return
  }

  // Register to all guilds the bot is in (guild commands propagate instantly)
  for (const guild of guilds.values()) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands },
      )
      process.stderr.write(`claude2bot: slash commands registered in guild ${(guild as any).name ?? guild.id}\n`)
    } catch (err) {
      process.stderr.write(`claude2bot: failed to register slash commands in ${(guild as any).name ?? guild.id}: ${err}\n`)
    }
  }
}

// ── Handler ──────────────────────────────────────────────────────────

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  // Check for subcommand group first (e.g. /claude bot status)
  const group = interaction.options.getSubcommandGroup(false)
  if (group === 'bot') {
    return handleBotSub(interaction, ctx)
  }

  const sub = interaction.options.getSubcommand()

  switch (sub) {
    case 'stop':
      return handleStop(interaction, ctx)
    case 'status': {
      const memMB = Math.round(process.memoryUsage.rss() / 1024 / 1024)
      const uptimeMin = Math.round(process.uptime() / 60)
      const startTime = new Date(Date.now() - process.uptime() * 1000)
      const startStr = startTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
      const schedules = ctx.scheduler.getStatus()
      const activeSchedules = schedules.filter(s => s.running).length

      const fields: EmbedField[] = [
        { name: 'Backend', value: ctx.config.backend, inline: true },
        { name: 'PID', value: String(ctx.serverProcess.pid), inline: true },
        { name: 'Uptime', value: `${uptimeMin}m`, inline: true },
        { name: 'Memory', value: `${memMB}MB`, inline: true },
        { name: t('status.started', interaction.locale), value: startStr, inline: true },
        { name: 'Schedules', value: `${schedules.length} total, ${activeSchedules} running`, inline: true },
      ]

      try {
        const sessionPath = '/tmp/claude-session-data.json'
        if (existsSync(sessionPath)) {
          const data = JSON.parse(readFileSync(sessionPath, 'utf-8'))
          const model = data.model?.display_name ?? data.model?.id ?? 'unknown'
          fields.push({ name: 'Model', value: model, inline: true })

          const inTok = data.context_window?.total_input_tokens
          const outTok = data.context_window?.total_output_tokens
          if (inTok != null || outTok != null) {
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : `${n}`
            fields.push({ name: 'Tokens', value: `in ${fmt(inTok ?? 0)} / out ${fmt(outTok ?? 0)}`, inline: true })
          }

          const fiveH = data.rate_limits?.five_hour?.used_percentage
          const sevenD = data.rate_limits?.seven_day?.used_percentage
          if (fiveH != null || sevenD != null) {
            const parts: string[] = []
            if (fiveH != null) parts.push(`5h ${Math.round(fiveH)}%`)
            if (sevenD != null) parts.push(`7d ${Math.round(sevenD)}%`)
            fields.push({ name: 'Rate Limit', value: parts.join(' / '), inline: true })
          }

          const ctxPct = data.context_window?.used_percentage
          if (ctxPct != null) fields.push({ name: 'Context', value: `${Math.round(ctxPct)}%`, inline: true })
        }
      } catch { /* graceful fallback */ }

      await interaction.reply({ embeds: [{ title: '\u{1f4ca} Status', fields, color: EMBED_COLOR }], flags: 64 })
      return
    }
    case 'config': {
      const fields: EmbedField[] = [
        { name: 'Backend', value: ctx.config.backend, inline: true },
        { name: 'Channels', value: String(Object.keys(ctx.config.channelsConfig?.channels ?? {}).length), inline: true },
        { name: 'Voice', value: ctx.config.voice?.enabled ? 'Enabled' : 'Disabled', inline: true },
        { name: 'Proactive', value: ctx.config.proactive ? `freq ${ctx.config.proactive.frequency}` : 'Disabled', inline: true },
        { name: 'Interactive', value: String((ctx.config.interactive ?? []).length), inline: true },
        { name: 'Non-interactive', value: String((ctx.config.nonInteractive ?? []).length), inline: true },
      ]
      await interaction.reply({ embeds: [{ title: '\u{2699}\u{fe0f} Configuration', fields, color: EMBED_COLOR }], flags: 64 })
      return
    }
    case 'model':
      return handleModel(interaction, ctx)
    case 'compact':
      return handleCompact(interaction, ctx)
    case 'clear':
      return handleClear(interaction, ctx)
    case 'new':
      return handleNew(interaction, ctx)
    case 'language':
      return handleLanguage(interaction, ctx)
    case 'resume':
      return handleResume(interaction, ctx)
    case 'schedule':
      return handleSchedule(interaction, ctx)
    case 'access':
      return handleAccess(interaction, ctx)
    case 'doctor':
      return handleDoctor(interaction, ctx)
    case 'help':
      return handleHelp(interaction)
    case 'profile':
      return handleProfileSub(interaction, ctx)
    default:
      await interaction.reply({ content: t('unknown_command', interaction.locale, { cmd: sub }), flags: 64 })
  }
}

// ── Individual command handlers ──────────────────────────────────────

async function handleStop(
  interaction: ChatInputCommandInteraction,
  _ctx: SlashCommandContext,
): Promise<void> {
  // 1. 플래그 파일 생성 (도구 호출 시 PreToolUse에서 잡힘)
  const flagFile = join(tmpdir(), 'claude2bot-stop.flag')
  writeFileSync(flagFile, String(Date.now()))

  // 2. SIGINT도 보냄 (thinking 중 즉시 중단 — Ctrl+C와 동일)
  const ppid = process.ppid
  if (ppid && ppid > 1) {
    try {
      process.kill(ppid, 'SIGINT')
    } catch {}
  }

  await interaction.reply({
    embeds: [{ title: '\u{1f6d1} Stop', description: t('stop.sent', interaction.locale, { pid: ppid || 0 }), color: 0xED4245 }],
    flags: 64,
  })
}

async function handleModel(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const model = interaction.options.getString('name', true)

  // Inject as a channel notification — the session will interpret /model command
  ctx.notify(
    interaction.channelId,
    `slash:${interaction.user.username}`,
    `/model ${model}`,
  )

  await interaction.reply({
    embeds: [{ title: '\u{1f916} Model', description: t('model.switched', interaction.locale, { model }), color: EMBED_COLOR }],
    flags: 64,
  })
}

async function handleCompact(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  ctx.notify(
    interaction.channelId,
    `slash:${interaction.user.username}`,
    'Please compact the conversation now.',
  )
  await interaction.reply({ embeds: [{ title: '\u{1f4e6} Compact', description: t('compact.forwarded', interaction.locale), color: EMBED_COLOR }], flags: 64 })
}

async function handleClear(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  ctx.notify(
    interaction.channelId,
    `slash:${interaction.user.username}`,
    'Please clear the conversation.',
  )
  await interaction.reply({ embeds: [{ title: '\u{1f9f9} Clear', description: t('clear.forwarded', interaction.locale), color: EMBED_COLOR }], flags: 64 })
}

async function handleNew(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  ctx.notify(
    interaction.channelId,
    `slash:${interaction.user.username}`,
    'Please start a new session.',
  )
  await interaction.reply({ embeds: [{ title: '\u{2728} New Session', description: t('new.forwarded', interaction.locale), color: EMBED_COLOR }], flags: 64 })
}

async function handleResume(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  ctx.notify(
    interaction.channelId,
    `slash:${interaction.user.username}`,
    'Please resume the previous session.',
  )
  await interaction.reply({ embeds: [{ title: '\u{25b6}\u{fe0f} Resume', description: t('resume.forwarded', interaction.locale), color: EMBED_COLOR }], flags: 64 })
}

async function handleLanguage(
  interaction: ChatInputCommandInteraction,
  _ctx: SlashCommandContext,
): Promise<void> {
  const lang = interaction.options.getString('lang', true) as Lang
  try {
    const configPath = join(DATA_DIR, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.language = lang
    const { writeFileSync } = await import('fs')
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
    invalidateConfigLangCache()
    await interaction.reply({ embeds: [{ title: '\u{1f310} Language', description: t('language.set', lang), color: EMBED_COLOR }], flags: 64 })
  } catch (err) {
    await interaction.reply({
      embeds: [{ title: '\u{1f310} Language', description: `Failed: ${err instanceof Error ? err.message : String(err)}`, color: 0xED4245 }],
      flags: 64,
    })
  }
}

async function handleAccess(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const locale = interaction.locale
  const stateDir = ctx.config.discord?.stateDir ?? join(DATA_DIR, 'discord')
  const accessPath = join(stateDir, 'access.json')

  if (!existsSync(accessPath)) {
    await interaction.reply({ embeds: [{ title: '\u{1f512} Access', description: t('access.not_found', locale), color: 0xFEE75C }], flags: 64 })
    return
  }

  try {
    const access = JSON.parse(readFileSync(accessPath, 'utf8'))
    const dmPolicy = access.dmPolicy ?? 'deny'
    const userCount = (access.allowFrom ?? []).length
    const chCount = Object.keys(access.channels ?? {}).length
    const pendingCount = (access.pendingPairings ?? []).length

    const fields: EmbedField[] = [
      { name: 'DM Policy', value: dmPolicy, inline: true },
      { name: 'Allowed Users', value: String(userCount), inline: true },
      { name: 'Channels', value: String(chCount), inline: true },
      { name: 'Pending', value: String(pendingCount), inline: true },
    ]
    await interaction.reply({ embeds: [{ title: '\u{1f512} Access', fields, color: EMBED_COLOR }], flags: 64 })
  } catch (err) {
    await interaction.reply({
      embeds: [{ title: '\u{1f512} Access', description: t('access.parse_failed', locale, { error: err instanceof Error ? err.message : String(err) }), color: 0xED4245 }],
      flags: 64,
    })
  }
}

async function handleSchedule(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const action = interaction.options.getString('action', true)
  const name = interaction.options.getString('name')

  switch (action) {
    case 'list': {
      const statuses = ctx.scheduler.getStatus()
      if (statuses.length === 0) {
        await interaction.reply({ embeds: [{ title: '\u{1f4c5} Schedule', description: t('schedule.no_schedules', interaction.locale), color: 0xFEE75C }], flags: 64 })
        return
      }
      const fields: EmbedField[] = statuses.map(s => {
        const state = s.running ? ' [RUNNING]' : ''
        const last = s.lastFired ? `\nLast: ${s.lastFired}` : ''
        return { name: `${s.name}${state}`, value: `${s.time} ${s.days} (${s.type})${last}`, inline: false }
      })
      await interaction.reply({ embeds: [{ title: '\u{1f4c5} Schedule', fields, color: EMBED_COLOR }], flags: 64 })
      return
    }

    case 'remove': {
      if (!name) {
        await interaction.reply({ embeds: [{ title: '\u{1f4c5} Schedule', description: t('schedule.name_required_remove', interaction.locale), color: 0xFEE75C }], flags: 64 })
        return
      }
      try {
        const configPath = join(DATA_DIR, 'config.json')
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as PluginConfig
        let found = false
        for (const key of ['nonInteractive', 'interactive'] as const) {
          const arr = config[key]
          if (!arr) continue
          const idx = arr.findIndex(s => s.name === name)
          if (idx >= 0) {
            arr.splice(idx, 1)
            found = true
            break
          }
        }
        if (!found) {
          await interaction.reply({ embeds: [{ title: '\u{1f4c5} Schedule', description: t('schedule.not_found', interaction.locale, { name }), color: 0xFEE75C }], flags: 64 })
          return
        }
        const { writeFileSync } = await import('fs')
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
        await interaction.reply({ embeds: [{ title: '\u{1f4c5} Schedule', description: t('schedule.removed', interaction.locale, { name }), color: 0x57F287 }], flags: 64 })
      } catch (err) {
        await interaction.reply({
          embeds: [{ title: '\u{1f4c5} Schedule', description: t('schedule.remove_failed', interaction.locale, { error: err instanceof Error ? err.message : String(err) }), color: 0xED4245 }],
          flags: 64,
        })
      }
      return
    }

    case 'add': {
      if (!name) {
        await interaction.reply({ embeds: [{ title: '\u{1f4c5} Schedule', description: t('schedule.name_required_add', interaction.locale), color: 0xFEE75C }], flags: 64 })
        return
      }
      const time = interaction.options.getString('time')
      const channel = interaction.options.getString('channel')
      const prompt = interaction.options.getString('prompt')
      if (!time || !channel || !prompt) {
        await interaction.reply({
          embeds: [{ title: '\u{1f4c5} Schedule', description: t('schedule.add_missing_options', interaction.locale), color: 0xFEE75C }],
          flags: 64,
        })
        return
      }
      const mode = interaction.options.getString('mode') || 'interactive'
      try {
        const configPath = join(DATA_DIR, 'config.json')
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as PluginConfig
        const targetKey = mode === 'non-interactive' ? 'nonInteractive' : 'interactive'
        if (!config[targetKey]) (config as any)[targetKey] = []
        const targetArr = (config as any)[targetKey] as Array<any>
        const existsI = (config.interactive ?? []).find(s => s.name === name)
        const existsN = (config.nonInteractive ?? []).find(s => s.name === name)
        if (existsI || existsN) {
          await interaction.reply({ embeds: [{ title: '\u{1f4c5} Schedule', description: t('schedule.already_exists', interaction.locale, { name }), color: 0xFEE75C }], flags: 64 })
          return
        }
        targetArr.push({ name, time, channel, enabled: true })
        const { writeFileSync } = await import('fs')
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
        const promptsDir = ctx.config.promptsDir ?? join(DATA_DIR, 'prompts')
        const promptPath = join(promptsDir, `${name}.md`)
        writeFileSync(promptPath, prompt + '\n', 'utf8')
        await interaction.reply({
          embeds: [{ title: '\u{1f4c5} Schedule', description: t('schedule.added', interaction.locale, { name, time, channel }), color: 0x57F287 }],
          flags: 64,
        })
      } catch (err) {
        await interaction.reply({
          embeds: [{ title: '\u{1f4c5} Schedule', description: t('schedule.add_failed', interaction.locale, { error: err instanceof Error ? err.message : String(err) }), color: 0xED4245 }],
          flags: 64,
        })
      }
      return
    }

    case 'restart': {
      ctx.scheduler.restart()
      await interaction.reply({ embeds: [{ title: '\u{1f4c5} Schedule', description: t('schedule.restarted', interaction.locale), color: 0x57F287 }], flags: 64 })
      return
    }
  }
}

async function handleDoctor(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const fields: EmbedField[] = []
  let allPass = true

  // 1. Config
  const configPath = join(DATA_DIR, 'config.json')
  const configOk = existsSync(configPath)
  fields.push({ name: 'Config', value: configOk ? '\u{2705} Found' : '\u{274c} Missing', inline: true })
  if (!configOk) allPass = false

  // 2. Bot token
  const hasToken =
    (ctx.config.backend === 'discord' && ctx.config.discord?.token) ||
    (ctx.config.backend === 'telegram' && ctx.config.telegram?.token)
  fields.push({ name: 'Token', value: hasToken ? '\u{2705} OK' : '\u{274c} Missing', inline: true })
  if (!hasToken) allPass = false

  // 3. Access control
  const stateDir = ctx.config.discord?.stateDir ?? join(DATA_DIR, 'discord')
  const accessPath = join(stateDir, 'access.json')
  if (existsSync(accessPath)) {
    try {
      const access = JSON.parse(readFileSync(accessPath, 'utf8'))
      const userCount = (access.allowFrom ?? []).length
      const chCount = Object.keys(access.channels ?? {}).length
      fields.push({ name: 'Access', value: `\u{2705} ${userCount} users, ${chCount} channels`, inline: true })
    } catch {
      fields.push({ name: 'Access', value: '\u{274c} Parse failed', inline: true })
      allPass = false
    }
  } else {
    fields.push({ name: 'Access', value: '\u{26a0}\u{fe0f} Not configured', inline: true })
  }

  // 4. Schedules
  const statuses = ctx.scheduler.getStatus()
  const promptsDir = ctx.config.promptsDir ?? join(DATA_DIR, 'prompts')
  const missingPrompts = statuses.filter(s => s.type !== 'proactive' && !existsSync(join(promptsDir, `${s.name}.md`)))
  let schedVal = `\u{2705} ${statuses.length} registered`
  if (missingPrompts.length > 0) {
    schedVal += `\n\u{26a0}\u{fe0f} Missing prompts: ${missingPrompts.map(s => s.name).join(', ')}`
  }
  fields.push({ name: 'Schedules', value: schedVal, inline: false })

  // 5. Channels
  if (ctx.config.channelsConfig) {
    const chCount = Object.keys(ctx.config.channelsConfig.channels).length
    fields.push({ name: 'Channels', value: `\u{2705} ${chCount} configured`, inline: true })
  } else {
    fields.push({ name: 'Channels', value: '\u{26a0}\u{fe0f} Not configured', inline: true })
  }

  // 6. Voice
  fields.push({ name: 'Voice', value: ctx.config.voice?.enabled ? '\u{2705} Enabled' : 'Disabled', inline: true })

  // 7. Process health
  fields.push({ name: 'Process', value: `PID ${process.pid}, uptime ${Math.floor(process.uptime() / 60)}m`, inline: true })

  await interaction.reply({
    embeds: [{ title: '\u{1fa7a} Doctor', fields, color: allPass ? 0x57F287 : 0xFEE75C }],
    flags: 64,
  })
}

// ── Help (locale-aware, embed) ───────────────────────────────────────

interface HelpData { features: string; commands: string }

const HELP_EN: HelpData = {
  features: [
    '**Chat** -- Send a message and Claude will respond. Progress shown in real time.',
    '**Voice** -- Send a voice message for automatic transcription.',
    '**Permissions** -- [Approve] [Session Approve] [Deny] buttons on tool use.',
    '**Schedules** -- Auto-tasks: interactive (current session), non-interactive (separate), proactive (Claude-initiated).',
  ].join('\n'),
  commands: [
    '`/claude stop` -- Stop current task',
    '`/claude status` -- Session status',
    '`/claude config` -- View config',
    '`/claude model` -- Switch model',
    '`/claude language` -- Set language',
    '`/claude compact` -- Compact conversation',
    '`/claude clear` -- Clear conversation',
    '`/claude new` -- New session',
    '`/claude resume` -- Resume session',
    '`/claude schedule` -- Manage schedules',
    '`/claude access` -- Access control',
    '`/claude doctor` -- System diagnostics',
    '`/claude bot` -- Bot settings',
    '`/claude profile` -- User profile',
  ].join('\n'),
}

const HELP_KO: HelpData = {
  features: [
    '**\uB300\uD654** -- \uCC44\uB110\uC5D0 \uBA54\uC2DC\uC9C0\uB97C \uBCF4\uB0B4\uBA74 Claude\uAC00 \uC751\uB2F5\uD569\uB2C8\uB2E4.',
    '**\uC74C\uC131** -- \uC74C\uC131 \uBA54\uC2DC\uC9C0\uB97C \uBCF4\uB0B4\uBA74 \uC790\uB3D9 \uBCC0\uD658\uB429\uB2C8\uB2E4.',
    '**\uAD8C\uD55C** -- \uB3C4\uAD6C \uC2E4\uD589 \uC2DC [\uC2B9\uC778] [\uC138\uC158\uC2B9\uC778] [\uAC70\uBD80] \uBC84\uD2BC\uC774 \uB098\uD0C0\uB0A9\uB2C8\uB2E4.',
    '**\uC2A4\uCF00\uC904** -- \uC815\uD574\uC9C4 \uC2DC\uAC04\uC5D0 \uC790\uB3D9 \uC2E4\uD589\uB429\uB2C8\uB2E4.',
  ].join('\n'),
  commands: [
    '`/claude stop` -- \uC791\uC5C5 \uC911\uB2E8',
    '`/claude status` -- \uC138\uC158 \uC0C1\uD0DC',
    '`/claude config` -- \uC124\uC815 \uD655\uC778',
    '`/claude model` -- \uBAA8\uB378 \uC804\uD658',
    '`/claude language` -- \uC5B8\uC5B4 \uC124\uC815',
    '`/claude compact` -- \uB300\uD654 \uC555\uCD95',
    '`/claude clear` -- \uB300\uD654 \uCD08\uAE30\uD654',
    '`/claude new` -- \uC0C8 \uC138\uC158',
    '`/claude resume` -- \uC138\uC158 \uC774\uC5B4\uD558\uAE30',
    '`/claude schedule` -- \uC2A4\uCF00\uC904 \uAD00\uB9AC',
    '`/claude access` -- \uC811\uADFC \uC81C\uC5B4',
    '`/claude doctor` -- \uC2DC\uC2A4\uD15C \uC9C4\uB2E8',
    '`/claude bot` -- \uBD07 \uC124\uC815',
    '`/claude profile` -- \uC0AC\uC6A9\uC790 \uD504\uB85C\uD544',
  ].join('\n'),
}

const HELP_JA: HelpData = {
  features: [
    '**\u30C1\u30E3\u30C3\u30C8** -- \u30E1\u30C3\u30BB\u30FC\u30B8\u3092\u9001\u308B\u3068Claude\u304C\u5FDC\u7B54\u3057\u307E\u3059\u3002',
    '**\u97F3\u58F0** -- \u97F3\u58F0\u30E1\u30C3\u30BB\u30FC\u30B8\u3092\u9001\u308B\u3068\u81EA\u52D5\u5909\u63DB\u3055\u308C\u307E\u3059\u3002',
    '**\u6A29\u9650** -- \u30C4\u30FC\u30EB\u5B9F\u884C\u6642\u306B[\u627F\u8A8D] [\u30BB\u30C3\u30B7\u30E7\u30F3\u627F\u8A8D] [\u62D2\u5426]\u30DC\u30BF\u30F3\u304C\u8868\u793A\u3055\u308C\u307E\u3059\u3002',
    '**\u30B9\u30B1\u30B8\u30E5\u30FC\u30EB** -- \u8A2D\u5B9A\u3057\u305F\u6642\u9593\u306B\u81EA\u52D5\u5B9F\u884C\u3057\u307E\u3059\u3002',
  ].join('\n'),
  commands: [
    '`/claude stop` -- \u30BF\u30B9\u30AF\u505C\u6B62',
    '`/claude status` -- \u30B9\u30C6\u30FC\u30BF\u30B9',
    '`/claude config` -- \u8A2D\u5B9A\u78BA\u8A8D',
    '`/claude model` -- \u30E2\u30C7\u30EB\u5207\u66FF',
    '`/claude language` -- \u8A00\u8A9E\u8A2D\u5B9A',
    '`/claude compact` -- \u4F1A\u8A71\u5727\u7E2E',
    '`/claude clear` -- \u4F1A\u8A71\u30AF\u30EA\u30A2',
    '`/claude new` -- \u65B0\u30BB\u30C3\u30B7\u30E7\u30F3',
    '`/claude resume` -- \u30BB\u30C3\u30B7\u30E7\u30F3\u518D\u958B',
    '`/claude schedule` -- \u30B9\u30B1\u30B8\u30E5\u30FC\u30EB\u7BA1\u7406',
    '`/claude access` -- \u30A2\u30AF\u30BB\u30B9\u5236\u5FA1',
    '`/claude doctor` -- \u30B7\u30B9\u30C6\u30E0\u8A3A\u65AD',
    '`/claude bot` -- \u30DC\u30C3\u30C8\u8A2D\u5B9A',
    '`/claude profile` -- \u30D7\u30ED\u30D5\u30A3\u30FC\u30EB',
  ].join('\n'),
}

const HELP_ZH: HelpData = {
  features: [
    '**\u804A\u5929** -- \u53D1\u9001\u6D88\u606F\uFF0CClaude\u4F1A\u81EA\u52A8\u56DE\u590D\u3002',
    '**\u8BED\u97F3** -- \u53D1\u9001\u8BED\u97F3\u6D88\u606F\u4F1A\u81EA\u52A8\u8F6C\u6362\u4E3A\u6587\u5B57\u3002',
    '**\u6743\u9650** -- \u5DE5\u5177\u6267\u884C\u65F6\u663E\u793A[\u6279\u51C6] [\u4F1A\u8BDD\u6279\u51C6] [\u62D2\u7EDD]\u6309\u94AE\u3002',
    '**\u8BA1\u5212\u4EFB\u52A1** -- \u5728\u8BBE\u5B9A\u65F6\u95F4\u81EA\u52A8\u6267\u884C\u3002',
  ].join('\n'),
  commands: [
    '`/claude stop` -- \u505C\u6B62\u4EFB\u52A1',
    '`/claude status` -- \u72B6\u6001',
    '`/claude config` -- \u914D\u7F6E',
    '`/claude model` -- \u5207\u6362\u6A21\u578B',
    '`/claude language` -- \u8BBE\u7F6E\u8BED\u8A00',
    '`/claude compact` -- \u538B\u7F29\u5BF9\u8BDD',
    '`/claude clear` -- \u6E05\u9664\u5BF9\u8BDD',
    '`/claude new` -- \u65B0\u4F1A\u8BDD',
    '`/claude resume` -- \u6062\u590D\u4F1A\u8BDD',
    '`/claude schedule` -- \u8BA1\u5212\u7BA1\u7406',
    '`/claude access` -- \u8BBF\u95EE\u63A7\u5236',
    '`/claude doctor` -- \u7CFB\u7EDF\u8BCA\u65AD',
    '`/claude bot` -- \u673A\u5668\u4EBA\u8BBE\u7F6E',
    '`/claude profile` -- \u7528\u6237\u8D44\u6599',
  ].join('\n'),
}

function getHelpData(lang: Lang): HelpData {
  if (lang === 'ko') return HELP_KO
  if (lang === 'ja') return HELP_JA
  if (lang === 'zh') return HELP_ZH
  return HELP_EN
}

async function handleHelp(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const help = getHelpData(getLang(interaction.locale))
  await interaction.reply({
    embeds: [{
      title: '\u{2753} Help',
      fields: [
        { name: 'Features', value: help.features, inline: false },
        { name: 'Commands', value: help.commands, inline: false },
      ],
      color: EMBED_COLOR,
    }],
    flags: 64,
  })
}

// ── /claude bot & /claude profile handlers ──────────────────────────

/** Convert Discord locale to CommandContext lang ('ko' | 'en') */
function getCmdLang(locale: string): 'ko' | 'en' {
  return getLang(locale) === 'ko' ? 'ko' : 'en'
}

/** Reply to interaction with CommandResult (text, embeds, components) */
async function replyWithResult(
  interaction: ChatInputCommandInteraction,
  result: { text?: string; embeds?: Record<string, unknown>[]; components?: Record<string, unknown>[] },
): Promise<void> {
  const payload: Record<string, unknown> = { flags: 64 }
  if (result.text) payload.content = result.text
  if (result.embeds?.length) payload.embeds = result.embeds
  if (result.components?.length) payload.components = result.components
  if (!result.text && !result.embeds?.length) payload.content = 'OK'
  await interaction.reply(payload as any)
}

async function handleBotSub(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const sub = interaction.options.getSubcommand(false) ?? 'status'
  const cmdCtx: CommandContext = {
    scheduler: ctx.scheduler,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    lang: getCmdLang(interaction.locale),
  }
  try {
    const result = await handleBotCommand(
      { cmd: 'bot', args: [sub], params: {} },
      cmdCtx,
    )
    await replyWithResult(interaction, result)
  } catch (err) {
    await interaction.reply({ content: `Error: ${err instanceof Error ? err.message : String(err)}`, flags: 64 })
  }
}

async function handleProfileSub(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const cmdCtx: CommandContext = {
    scheduler: ctx.scheduler,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    lang: getCmdLang(interaction.locale),
  }
  try {
    const result = handleProfileCommand(
      { cmd: 'profile', args: [], params: {} },
      cmdCtx,
    )
    await replyWithResult(interaction, result)
  } catch (err) {
    await interaction.reply({ content: `Error: ${err instanceof Error ? err.message : String(err)}`, flags: 64 })
  }
}
