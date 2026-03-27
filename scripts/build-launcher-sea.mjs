#!/usr/bin/env node

import { mkdirSync, copyFileSync, existsSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { join, resolve } from 'path'
import { execFileSync } from 'child_process'
import { platform } from 'os'

import { fileURLToPath } from 'url'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const distDir = join(root, 'dist')
const bundlePath = join(distDir, 'launcher.cjs')
const blobPath = join(distDir, 'launcher.blob')
const seaConfigPath = join(distDir, 'sea-config.json')
const weztermConfigPath = join(root, 'launcher-wezterm.lua')
const distWeztermConfigPath = join(distDir, 'launcher-wezterm.lua')
const targetBinary =
  platform() === 'win32'
    ? join(distDir, 'claude2bot-launcher.exe')
    : join(distDir, 'claude2bot-launcher')

if (!existsSync(bundlePath)) {
  throw new Error(`Bundle not found: ${bundlePath}. Run build:launcher:bundle first.`)
}

mkdirSync(distDir, { recursive: true })

const seaConfig = {
  main: bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}

writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2) + '\n')
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' })

rmSync(targetBinary, { force: true })
copyFileSync(process.execPath, targetBinary)
chmodSync(targetBinary, 0o755)

if (platform() === 'darwin') {
  try { execFileSync('codesign', ['--remove-signature', targetBinary], { stdio: 'ignore' }) } catch {}
}

const npxCmd = platform() === 'win32' ? 'npx.cmd' : 'npx'
execFileSync(npxCmd, [
  '--yes',
  'postject@1.0.0-alpha.6',
  targetBinary,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(platform() === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
], { stdio: 'inherit' })

copyFileSync(weztermConfigPath, distWeztermConfigPath)

process.stdout.write(`${targetBinary}\n`)
