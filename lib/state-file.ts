import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export type StatusState = {
  channelId?: string
  userMessageId?: string
  emoji?: string
  transcriptPath?: string
  lastFileSize?: number
  sentCount?: number
  lastSentHash?: string
  lastSentTime?: number
  sessionIdle?: boolean
  [key: string]: unknown
}

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

export function removeFileIfExists(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeTextFile(filePath: string, value: string): void {
  ensureDir(dirname(filePath))
  writeFileSync(filePath, value)
}

export function writeJsonFile(filePath: string, value: unknown): void {
  writeTextFile(filePath, JSON.stringify(value))
}

export class JsonStateFile<T extends Record<string, unknown>> {
  constructor(
    private readonly filePath: string,
    private readonly fallback: T,
  ) {}

  read(): T {
    return readJsonFile(this.filePath, this.fallback)
  }

  write(value: T): T {
    writeJsonFile(this.filePath, value)
    return value
  }

  ensure(): void {
    writeJsonFile(this.filePath, this.read())
  }

  update(mutator: (draft: T) => void): T {
    const draft = this.read()
    mutator(draft)
    return this.write(draft)
  }
}
