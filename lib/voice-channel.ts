/**
 * Voice channel support — join, listen, speak
 *
 * Flow: user speaks → whisper STT → Claude → edge-tts → play back
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
  type AudioPlayer,
  EndBehaviorType,
} from '@discordjs/voice'
import { spawn } from 'child_process'
import { appendFileSync, createWriteStream, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pipeline } from 'stream'
import { promisify } from 'util'
import prism from 'prism-media'

const pipelineAsync = promisify(pipeline)

const VOICE_TMP = join(tmpdir(), 'claude2bot-voice')
mkdirSync(VOICE_TMP, { recursive: true })

const VOICE_LOG = join(VOICE_TMP, 'voice.log')
function vlog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { process.stderr.write(line) } catch {}
  try { appendFileSync(VOICE_LOG, line) } catch {}
}

// VAD: silence threshold
const SILENCE_THRESHOLD = 500 // ms of silence to consider end of speech
const MAX_RECORDING = 30_000 // max 30s per utterance

export type VoiceInjectFn = (text: string) => void
export type VoiceResponseFn = () => Promise<string | null>

export class VoiceSession {
  private connection: VoiceConnection | null = null
  private player: AudioPlayer | null = null
  private recording = false
  private onInject: VoiceInjectFn | null = null
  private whisperCmd: string
  private ttsCmd: string

  constructor(
    private guildId: string,
    private channelId: string,
    private adapterCreator: any,
    options?: { whisperCmd?: string; ttsCmd?: string },
  ) {
    this.whisperCmd = options?.whisperCmd ?? 'whisper-cpp'
    this.ttsCmd = options?.ttsCmd ?? 'edge-tts'
  }

  setInjectHandler(fn: VoiceInjectFn): void {
    this.onInject = fn
  }

  async join(): Promise<void> {
    this.connection = joinVoiceChannel({
      channelId: this.channelId,
      guildId: this.guildId,
      adapterCreator: this.adapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: false,
    } as any)

    this.player = createAudioPlayer()
    this.connection.subscribe(this.player)

    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000)

    vlog(` joined ${this.channelId} (daveEncryption: false)\n`)

    this.startListening()
  }

  leave(): void {
    this.recording = false
    if (this.connection) {
      this.connection.destroy()
      this.connection = null
    }
    this.player = null
    vlog(' left channel\n')
  }

  isConnected(): boolean {
    return this.connection?.state.status === VoiceConnectionStatus.Ready
  }

  private startListening(): void {
    if (!this.connection) return

    const receiver = this.connection.receiver

    vlog(' listening started\n')
    receiver.speaking.on('start', (userId) => {
      vlog(` speaking start — ${userId}\n`)
      if (this.recording) return
      this.recordUser(userId)
    })
    receiver.speaking.on('end', (userId) => {
      vlog(` speaking end — ${userId}\n`)
    })
  }

  private async recordUser(userId: string): Promise<void> {
    if (!this.connection || this.recording) return
    this.recording = true

    const receiver = this.connection.receiver
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_THRESHOLD },
    })

    const pcmFile = join(VOICE_TMP, `${userId}-${Date.now()}.pcm`)
    const wavFile = pcmFile.replace('.pcm', '.wav')

    try {
      // Opus → PCM
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 })
      const writeStream = createWriteStream(pcmFile)

      // Timeout guard
      const timeout = setTimeout(() => {
        opusStream.destroy()
      }, MAX_RECORDING)

      await pipelineAsync(opusStream, decoder, writeStream)
      clearTimeout(timeout)

      // PCM → WAV (ffmpeg)
      await new Promise<void>((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          '-y', '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', pcmFile, wavFile,
        ], { stdio: 'ignore' })
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)))
      })

      // WAV → Text (whisper)
      const text = await this.stt(wavFile)
      if (text && text.trim().length > 1) {
        vlog(` STT: "${text.trim()}"\n`)
        if (this.onInject) this.onInject(text.trim())
      }
    } catch (err) {
      vlog(` record error: ${err}\n`)
    } finally {
      this.recording = false
      try { unlinkSync(pcmFile) } catch {}
      try { unlinkSync(wavFile) } catch {}
    }
  }

  private async stt(wavPath: string): Promise<string> {
    return new Promise((resolve) => {
      // Try whisper-cpp first, fallback to whisper
      const cmd = existsSync('/opt/homebrew/bin/whisper-cpp') ? '/opt/homebrew/bin/whisper-cpp' : this.whisperCmd
      const args = [
        '-m', '/opt/homebrew/share/whisper-cpp/models/ggml-large-v3-turbo.bin',
        '-l', 'auto',
        '-nt',
        '-f', wavPath,
      ]
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      proc.stdout.on('data', d => { out += d.toString() })
      proc.on('close', () => resolve(out.trim()))
      proc.on('error', () => resolve(''))
    })
  }

  async speak(text: string): Promise<void> {
    if (!this.player || !this.connection) return

    const mp3File = join(VOICE_TMP, `tts-${Date.now()}.mp3`)

    try {
      // edge-tts → mp3
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('edge-tts', [
          '--voice', 'ko-KR-SunHiNeural',
          '--text', text,
          '--write-media', mp3File,
        ], { stdio: 'ignore' })
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`edge-tts exit ${code}`)))
        proc.on('error', reject)
      })

      // Play
      const resource = createAudioResource(mp3File)
      this.player.play(resource)
      await entersState(this.player, AudioPlayerStatus.Idle, 60_000)
    } catch (err) {
      vlog(` TTS error: ${err}\n`)
    } finally {
      try { unlinkSync(mp3File) } catch {}
    }
  }
}
