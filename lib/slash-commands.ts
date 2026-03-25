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

  return claude
}

// ── Registration ─────────────────────────────────────────────────────

export async function registerSlashCommands(client: Client, token: string): Promise<void> {
  if (!client.user) return
  const rest = new REST({ version: '10' }).setToken(token)
  const commands = [buildCommands().toJSON()]

  // Register to all guilds the bot is in (guild commands propagate instantly)
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands },
      )
      process.stderr.write(`claude2bot: slash commands registered in guild ${guild.name}\n`)
    } catch (err) {
      process.stderr.write(`claude2bot: failed to register slash commands in ${guild.name}: ${err}\n`)
    }
  }
}

// ── Handler ──────────────────────────────────────────────────────────

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
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
      const lines = [
        `**Status**`,
        `Backend: ${ctx.config.backend}`,
        `PID: ${ctx.serverProcess.pid}`,
        `${t('status.started', interaction.locale)}: ${startStr}`,
        `Uptime: ${uptimeMin}m`,
        `Memory: ${memMB}MB`,
        `Schedules: ${schedules.length} total, ${activeSchedules} running`,
      ]

      // Claude session data from statusLine
      try {
        const sessionPath = '/tmp/claude-session-data.json'
        if (existsSync(sessionPath)) {
          const raw = readFileSync(sessionPath, 'utf-8')
          const data = JSON.parse(raw)

          const model = data.model?.display_name ?? data.model?.id ?? 'unknown'
          lines.push('', `**Claude Session**`)
          lines.push(`Model: ${model}`)

          const inTok = data.context_window?.total_input_tokens
          const outTok = data.context_window?.total_output_tokens
          if (inTok != null || outTok != null) {
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : `${n}`
            lines.push(`Tokens: in ${fmt(inTok ?? 0)} / out ${fmt(outTok ?? 0)}`)
          }

          const fiveH = data.rate_limits?.five_hour?.used_percentage
          const sevenD = data.rate_limits?.seven_day?.used_percentage
          if (fiveH != null || sevenD != null) {
            const parts: string[] = []
            if (fiveH != null) parts.push(`5h ${Math.round(fiveH)}%`)
            if (sevenD != null) parts.push(`7d ${Math.round(sevenD)}%`)
            lines.push(`Rate limit: ${parts.join(' / ')}`)
          }

          const ctxPct = data.context_window?.used_percentage
          if (ctxPct != null) lines.push(`Context: ${Math.round(ctxPct)}%`)
        }
      } catch { /* graceful fallback — show basic info only */ }

      await interaction.reply({ content: lines.join('\n'), flags: 64 })
      return
    }
    case 'config': {
      const lines = [
        `**Configuration**`,
        `Backend: ${ctx.config.backend}`,
        `Channels: ${Object.keys(ctx.config.channelsConfig?.channels ?? {}).length}`,
        `Voice: ${ctx.config.voice?.enabled ? 'enabled' : 'disabled'}`,
        `Proactive: ${ctx.config.proactive ? `freq ${ctx.config.proactive.frequency}` : 'disabled'}`,
        `Interactive schedules: ${(ctx.config.interactive ?? []).length}`,
        `Non-interactive schedules: ${(ctx.config.nonInteractive ?? []).length}`,
      ]
      await interaction.reply({ content: lines.join('\n'), flags: 64 })
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
    default:
      await interaction.reply({ content: t('unknown_command', interaction.locale, { cmd: sub }), flags: 64 })
  }
}

// ── Individual command handlers ──────────────────────────────────────

async function handleStop(
  interaction: ChatInputCommandInteraction,
  _ctx: SlashCommandContext,
): Promise<void> {
  const flagFile = join(tmpdir(), 'claude2bot-stop.flag')
  writeFileSync(flagFile, String(Date.now()))
  await interaction.reply({ content: t('stop.sent', interaction.locale, { pid: process.pid }), flags: 64 })
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
    content: t('model.switched', interaction.locale, { model }),
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
  await interaction.reply({ content: t('compact.forwarded', interaction.locale), flags: 64 })
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
  await interaction.reply({ content: t('clear.forwarded', interaction.locale), flags: 64 })
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
  await interaction.reply({ content: t('new.forwarded', interaction.locale), flags: 64 })
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
  await interaction.reply({ content: t('resume.forwarded', interaction.locale), flags: 64 })
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
    await interaction.reply({ content: t('language.set', lang), flags: 64 })
  } catch (err) {
    await interaction.reply({
      content: `Failed: ${err instanceof Error ? err.message : String(err)}`,
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
    await interaction.reply({ content: t('access.not_found', locale), flags: 64 })
    return
  }

  try {
    const access = JSON.parse(readFileSync(accessPath, 'utf8'))
    const dmPolicy = access.dmPolicy ?? 'deny'
    const userCount = (access.allowFrom ?? []).length
    const chCount = Object.keys(access.channels ?? {}).length
    const pendingCount = (access.pendingPairings ?? []).length

    const lines = [
      t('access.title', locale),
      t('access.dm_policy', locale, { policy: dmPolicy }),
      t('access.allow_from', locale, { count: userCount }),
      t('access.channels', locale, { count: chCount }),
      t('access.pending', locale, { count: pendingCount }),
    ]
    await interaction.reply({ content: lines.join('\n'), flags: 64 })
  } catch (err) {
    await interaction.reply({
      content: t('access.parse_failed', locale, { error: err instanceof Error ? err.message : String(err) }),
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
        await interaction.reply({ content: t('schedule.no_schedules', interaction.locale), flags: 64 })
        return
      }
      const lines = statuses.map(s => {
        const state = s.running ? ' **[RUNNING]**' : ''
        const last = s.lastFired ? ` | last: ${s.lastFired}` : ''
        return `\`${s.name}\` — ${s.time} ${s.days} (${s.type})${state}${last}`
      })
      await interaction.reply({ content: lines.join('\n'), flags: 64 })
      return
    }

    case 'remove': {
      if (!name) {
        await interaction.reply({ content: t('schedule.name_required_remove', interaction.locale), flags: 64 })
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
          await interaction.reply({ content: t('schedule.not_found', interaction.locale, { name }), flags: 64 })
          return
        }
        const { writeFileSync } = await import('fs')
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
        await interaction.reply({ content: t('schedule.removed', interaction.locale, { name }), flags: 64 })
      } catch (err) {
        await interaction.reply({
          content: t('schedule.remove_failed', interaction.locale, { error: err instanceof Error ? err.message : String(err) }),
          flags: 64,
        })
      }
      return
    }

    case 'add': {
      if (!name) {
        await interaction.reply({ content: t('schedule.name_required_add', interaction.locale), flags: 64 })
        return
      }
      const time = interaction.options.getString('time')
      const channel = interaction.options.getString('channel')
      const prompt = interaction.options.getString('prompt')
      if (!time || !channel || !prompt) {
        await interaction.reply({
          content: t('schedule.add_missing_options', interaction.locale),
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
        // Check both arrays for duplicate name
        const existsI = (config.interactive ?? []).find(s => s.name === name)
        const existsN = (config.nonInteractive ?? []).find(s => s.name === name)
        if (existsI || existsN) {
          await interaction.reply({ content: t('schedule.already_exists', interaction.locale, { name }), flags: 64 })
          return
        }
        targetArr.push({ name, time, channel, enabled: true })
        const { writeFileSync } = await import('fs')
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
        // Write prompt file
        const promptsDir = ctx.config.promptsDir ?? join(DATA_DIR, 'prompts')
        const promptPath = join(promptsDir, `${name}.md`)
        writeFileSync(promptPath, prompt + '\n', 'utf8')
        await interaction.reply({
          content: t('schedule.added', interaction.locale, { name, time, channel }),
          flags: 64,
        })
      } catch (err) {
        await interaction.reply({
          content: t('schedule.add_failed', interaction.locale, { error: err instanceof Error ? err.message : String(err) }),
          flags: 64,
        })
      }
      return
    }

    case 'restart': {
      ctx.scheduler.restart()
      await interaction.reply({ content: t('schedule.restarted', interaction.locale), flags: 64 })
      return
    }
  }
}

async function handleDoctor(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const locale = interaction.locale
  const lines: string[] = []

  // 1. Config
  const configPath = join(DATA_DIR, 'config.json')
  if (existsSync(configPath)) {
    lines.push(t('doctor.config_exists', locale))
  } else {
    lines.push(t('doctor.config_missing', locale))
  }

  // 2. Bot token
  const hasToken =
    (ctx.config.backend === 'discord' && ctx.config.discord?.token) ||
    (ctx.config.backend === 'telegram' && ctx.config.telegram?.token)
  lines.push(hasToken ? t('doctor.token_ok', locale) : t('doctor.token_missing', locale))

  // 3. Access control
  const stateDir = ctx.config.discord?.stateDir ?? join(DATA_DIR, 'discord')
  const accessPath = join(stateDir, 'access.json')
  if (existsSync(accessPath)) {
    try {
      const access = JSON.parse(readFileSync(accessPath, 'utf8'))
      const userCount = (access.allowFrom ?? []).length
      const chCount = Object.keys(access.channels ?? {}).length
      lines.push(`[PASS] Access: ${userCount} users, ${chCount} channels`)
    } catch {
      lines.push(t('doctor.access_parse_failed', locale))
    }
  } else {
    lines.push(t('doctor.access_missing', locale))
  }

  // 4. Schedules
  const statuses = ctx.scheduler.getStatus()
  lines.push(`[INFO] ${statuses.length} schedules registered`)

  // Check prompt files
  const promptsDir = ctx.config.promptsDir ?? join(DATA_DIR, 'prompts')
  for (const s of statuses) {
    if (s.type === 'proactive') continue
    const promptFile = join(promptsDir, `${s.name}.md`)
    if (!existsSync(promptFile)) {
      lines.push(`[WARN] Prompt missing: ${s.name}.md`)
    }
  }

  // 5. Channels
  if (ctx.config.channelsConfig) {
    const chCount = Object.keys(ctx.config.channelsConfig.channels).length
    lines.push(`[PASS] ${chCount} channels configured`)
  } else {
    lines.push(t('doctor.channels_not_set', locale))
  }

  // 6. Voice
  if (ctx.config.voice?.enabled) {
    lines.push(t('doctor.voice_enabled', locale))
  }

  // 7. Process health
  lines.push(`[INFO] PID ${process.pid}, uptime ${Math.floor(process.uptime() / 60)}m`)

  await interaction.reply({ content: '```\n' + lines.join('\n') + '\n```', flags: 64 })
}

// ── Help (locale-aware) ──────────────────────────────────────────────

const HELP_EN = [
  '**Claude Bot Help**',
  '',
  '**Chat** -- Send a message in the channel and Claude will respond. Task progress is shown in real time.',
  '**Voice** -- Send a voice message and it will be automatically transcribed.',
  '**Permissions** -- When a tool runs, [Approve] [Session Approve] [Deny] buttons appear.',
  '**Schedules** -- Tasks run automatically at set times. Interactive schedules run within the current session, non-interactive ones run in a separate session, and proactive ones let Claude start conversations on its own.',
  '',
  '**Commands**',
  '`/claude stop` -- Stop current task immediately',
  '`/claude status` -- Check model, tokens, session status',
  '`/claude config` -- View current configuration',
  '`/claude model [sonnet|opus]` -- Switch AI model',
  '`/claude language [en|ko|ja|zh]` -- Set display language',
  '`/claude compact` -- Compact conversation (free up context)',
  '`/claude clear` -- Clear conversation (keep session)',
  '`/claude new` -- Start new session',
  '`/claude resume` -- Resume previous session',
  '`/claude schedule list` -- List registered schedules',
  '`/claude schedule add` -- Add new schedule',
  '`/claude schedule remove` -- Remove schedule',
  '`/claude access` -- Show access control status',
  '`/claude doctor` -- System diagnostics (connections, hooks, config)',
].join('\n')

const HELP_KO = [
  '**Claude Bot 도움말**',
  '',
  '**대화** -- 채널에 메시지를 보내면 Claude가 응답합니다. 작업 진행 상황은 실시간으로 표시됩니다.',
  '**음성** -- 음성 메시지를 보내면 자동으로 텍스트 변환됩니다.',
  '**권한** -- 도구 실행 시 [승인] [세션승인] [거부] 버튼이 나타납니다.',
  '**스케줄** -- 정해진 시간에 자동으로 작업을 실행합니다. 대화형(interactive)은 현재 세션에서 진행되고, 비대화형(non-interactive)은 별도 세션에서 실행됩니다. 자율형(proactive)은 Claude가 먼저 대화를 시작합니다.',
  '',
  '**명령어**',
  '`/claude stop` -- 현재 작업 즉시 중단',
  '`/claude status` -- 모델, 토큰, 세션 상태 확인',
  '`/claude config` -- 현재 설정 확인',
  '`/claude model [sonnet|opus]` -- AI 모델 전환',
  '`/claude language [en|ko|ja|zh]` -- 표시 언어 설정',
  '`/claude compact` -- 대화 기록 압축 (컨텍스트 확보)',
  '`/claude clear` -- 대화 초기화 (세션 유지)',
  '`/claude new` -- 새 세션 시작',
  '`/claude resume` -- 이전 세션 이어하기',
  '`/claude schedule list` -- 등록된 스케줄 목록',
  '`/claude schedule add` -- 새 스케줄 추가',
  '`/claude schedule remove` -- 스케줄 삭제',
  '`/claude access` -- 접근 제어 상태 확인',
  '`/claude doctor` -- 시스템 진단 (연결, 훅, 설정 상태)',
].join('\n')

const HELP_JA = [
  '**Claude Bot ヘルプ**',
  '',
  '**チャット** -- チャンネルにメッセージを送るとClaudeが応答します。タスクの進行状況はリアルタイムで表示されます。',
  '**音声** -- 音声メッセージを送ると自動的にテキストに変換されます。',
  '**権限** -- ツール実行時に[承認] [セッション承認] [拒否]ボタンが表示されます。',
  '**スケジュール** -- 設定した時間に自動でタスクを実行します。対話型(interactive)は現在のセッションで進行し、非対話型(non-interactive)は別セッションで実行されます。自律型(proactive)はClaudeが自ら会話を開始します。',
  '',
  '**コマンド**',
  '`/claude stop` -- 現在のタスクを即座に停止',
  '`/claude status` -- モデル、トークン、セッション状態確認',
  '`/claude config` -- 現在の設定確認',
  '`/claude model [sonnet|opus]` -- AIモデル切替',
  '`/claude language [en|ko|ja|zh]` -- 表示言語を設定',
  '`/claude compact` -- 会話履歴を圧縮 (コンテキスト確保)',
  '`/claude clear` -- 会話をクリア (セッション維持)',
  '`/claude new` -- 新しいセッション開始',
  '`/claude resume` -- 前のセッションを再開',
  '`/claude schedule list` -- 登録済みスケジュール一覧',
  '`/claude schedule add` -- 新しいスケジュール追加',
  '`/claude schedule remove` -- スケジュール削除',
  '`/claude access` -- アクセス制御状態を表示',
  '`/claude doctor` -- システム診断 (接続、フック、設定状態)',
].join('\n')

const HELP_ZH = [
  '**Claude Bot 帮助**',
  '',
  '**聊天** -- 在频道发送消息，Claude会自动回复。任务进度实时显示。',
  '**语音** -- 发送语音消息会自动转换为文字。',
  '**权限** -- 工具执行时会显示[批准] [会话批准] [拒绝]按钮。',
  '**计划任务** -- 在设定时间自动执行任务。交互式(interactive)在当前会话中运行，非交互式(non-interactive)在独立会话中运行，主动式(proactive)由Claude主动发起对话。',
  '',
  '**命令**',
  '`/claude stop` -- 立即停止当前任务',
  '`/claude status` -- 查看模型、令牌、会话状态',
  '`/claude config` -- 查看当前配置',
  '`/claude model [sonnet|opus]` -- 切换AI模型',
  '`/claude language [en|ko|ja|zh]` -- 设置显示语言',
  '`/claude compact` -- 压缩对话记录 (释放上下文)',
  '`/claude clear` -- 清除对话 (保持会话)',
  '`/claude new` -- 开始新会话',
  '`/claude resume` -- 恢复上一个会话',
  '`/claude schedule list` -- 查看已注册的计划',
  '`/claude schedule add` -- 添加新计划',
  '`/claude schedule remove` -- 删除计划',
  '`/claude access` -- 查看访问控制状态',
  '`/claude doctor` -- 系统诊断 (连接、钩子、配置状态)',
].join('\n')

async function handleHelp(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const lang = getLang(interaction.locale)
  let content: string
  if (lang === 'ko') {
    content = HELP_KO
  } else if (lang === 'ja') {
    content = HELP_JA
  } else if (lang === 'zh') {
    content = HELP_ZH
  } else {
    content = HELP_EN
  }
  await interaction.reply({ content, flags: 64 })
}
