import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const thumbnailPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP+2mS2WQAAAABJRU5ErkJggg==', 'base64')
const helpPath = fileURLToPath(new URL('./vlc/vlc-help-3.0.23.txt', import.meta.url))
const knownOptions = parseKnownOptions(await readFile(helpPath, 'utf8'))
const valueOptions = new Set([
  'aout', 'audio-language', 'audio-track', 'intf', 'run-time', 'scene-format', 'scene-path',
  'scene-prefix', 'sout', 'sout-x264-keyint', 'sout-x264-min-keyint', 'sout-x264-preset', 'sout-x264-scenecut',
  'start-time', 'sub-language', 'sub-track', 'verbose', 'vout',
])
const parsed = parseVlcArgs(args, knownOptions, valueOptions)
const profile = process.env.FAKE_VLC_PROFILE ?? 'healthy'
const source = parsed.positionals.find((arg) => arg !== 'vlc://quit')
const sout = parsed.options.get('sout') ?? ''
const argvFile = process.env.FAKE_VLC_ARGV_FILE
const cwdFile = process.env.FAKE_VLC_CWD_FILE

if (argvFile) await writeFile(argvFile, JSON.stringify(args), 'utf8')
if (cwdFile) await writeFile(cwdFile, process.cwd(), 'utf8')

if (profile === 'hang-silent' && sout.includes('access=livehttp')) {
  setInterval(() => undefined, 1000)
} else if (profile === 'drive-busy' && source?.startsWith('dvd://')) {
  console.error(`main input error: cannot open ${source ?? 'DVD source'}`)
  process.exit(3)
} else if (parsed.options.has('play-and-exit') && !sout) {
  if (profile === 'scratched-scan') {
    console.error('Scratched disc read error prevented DVD scan metadata from being extracted.')
    process.exit(2)
  }
  console.log(JSON.stringify(scanPayload(source ?? 'dvd:///D:/')))
  process.exit(0)
} else if (sout.includes('access=file')) {
  const sourcePath = source
  const destinationPath = readAttribute(sout, 'dst')
  if (!sourcePath || !destinationPath) {
    console.error("vlc: unknown option or missing mandatory argument '--sout'")
    process.exit(2)
  }
  await mkdir(dirname(destinationPath), { recursive: true })
  await copyFile(sourcePath, destinationPath)
  console.log('FAKE_VLC_DONE')
} else if (sout.includes('access=livehttp')) {
  if (profile === 'scratched-playback') {
    console.error('Scratched disc read error prevented a playable HLS stream from being produced.')
    process.exit(3)
  }

  const indexPath = readAttribute(sout, 'index')
  const destinationPattern = readAttribute(sout, 'dst')
  if (!indexPath || !destinationPattern) {
    console.error("vlc: unknown option or missing mandatory argument '--sout'")
    process.exit(2)
  }

  const outputDir = dirname(indexPath)
  const initialSegmentNumber = Number(parsed.options.get('sout-livehttp-initial-segment-number') ?? 1)
  const startTimeSeconds = Number(parsed.options.get('start-time') ?? 0)
  const badEndSeconds = Number(process.env.FAKE_VLC_BAD_END_SECONDS ?? 12)
  const shouldStall = profile === 'bad-sector-midplayback' && startTimeSeconds < badEndSeconds
  const slowStartMs = profile === 'slow-start' ? Number(process.env.FAKE_VLC_START_DELAY_MS ?? 1000) : 0
  const maxSegments = Number(process.env.FAKE_VLC_SEGMENTS ?? (profile === 'dies-midstream' || profile === 'eject-midstream' ? 3 : 0))
  const stallAfter = Number(process.env.FAKE_VLC_STALL_AFTER_SEGMENTS ?? 2)
  const stallMs = Number(process.env.FAKE_VLC_STALL_MS ?? 1500)
  const bytes = await readFile(fileURLToPath(new URL('../../assets/placeholder.ts', import.meta.url)))
  let latestSegmentNumber = initialSegmentNumber - 1
  let producedSegments = 0
  let paused = false
  let interval: NodeJS.Timeout | undefined
  let resumeTimer: NodeJS.Timeout | undefined

  const writeNext = async () => {
    latestSegmentNumber += 1
    producedSegments += 1
    await writeHlsWindow(outputDir, latestSegmentNumber, initialSegmentNumber, bytes)

    if (profile === 'dies-midstream' && maxSegments > 0 && producedSegments >= maxSegments) {
      console.error('VLC exited after a simulated midstream failure.')
      process.exit(3)
    }
    if (profile === 'eject-midstream' && maxSegments > 0 && producedSegments >= maxSegments) {
      if (interval) clearInterval(interval)
      console.error('dvdnav error: disc disappeared while reading the title.')
      interval = setInterval(() => undefined, 1000)
    }
    if (profile === 'stall-then-resume' && !paused && producedSegments >= stallAfter) {
      paused = true
      if (interval) clearInterval(interval)
      resumeTimer = setTimeout(() => {
        paused = false
        interval = setInterval(() => void writeNext(), 1000)
      }, stallMs)
    }
  }

  const begin = async () => {
    await writeNext()
    if (shouldStall) return
    interval = setInterval(() => void writeNext(), 1000)
  }

  const delayTimer = setTimeout(() => void begin(), slowStartMs)
  process.on('SIGTERM', () => {
    clearTimeout(delayTimer)
    if (interval) clearInterval(interval)
    if (resumeTimer) clearTimeout(resumeTimer)
    process.exit(0)
  })
  process.on('SIGINT', () => process.exit(0))
  console.log('FAKE_VLC_READY')
} else if (parsed.options.has('scene-path')) {
  const sceneDir = parsed.options.get('scene-path')!
  const prefix = parsed.options.get('scene-prefix') ?? 'scene'
  await mkdir(sceneDir, { recursive: true })
  await writeFile(join(sceneDir, `${prefix}.jpg`), thumbnailPng)
  console.log('FAKE_VLC_DONE')
} else {
  if (profile === 'scratched-playback' && source?.startsWith('dvd://')) {
    console.error('Scratched disc read error prevented a playable HLS stream from being produced.')
    process.exit(3)
  }
  console.log('FAKE_VLC_DONE')
}

function parseKnownOptions(help: string): Set<string> {
  const options = new Set<string>()
  for (const line of help.split(/\r?\n/)) {
    if (!/^\s{2,}(?:-[a-z],\s+)?--[a-z]/i.test(line)) continue
    for (const match of line.matchAll(/--(?:no-)?([a-z][a-z0-9-]*)/gi)) options.add(match[1]!.toLowerCase())
  }
  return options
}

function parseVlcArgs(argv: string[], known: Set<string>, takesValue: Set<string>): { options: Map<string, string>; positionals: string[] } {
  const options = new Map<string, string>()
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const equalsAt = token.indexOf('=')
    const rawName = token.slice(2, equalsAt === -1 ? undefined : equalsAt).toLowerCase()
    const name = rawName.startsWith('no-') ? rawName.slice(3) : rawName
    if (!known.has(name)) {
      console.error(`vlc: unknown option or missing mandatory argument '--${rawName}'`)
      process.exit(2)
    }
    if (equalsAt !== -1) {
      options.set(name, token.slice(equalsAt + 1))
    } else if (takesValue.has(name)) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        console.error(`vlc: unknown option or missing mandatory argument '--${rawName}'`)
        process.exit(2)
      }
      options.set(name, value)
      index += 1
    } else {
      options.set(name, rawName.startsWith('no-') ? 'false' : 'true')
    }
  }
  return { options, positionals }
}

function readAttribute(value: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[,{}])${name}=([^,}]+)`).exec(value)
  return match?.[1]
}

function scanPayload(drive: string) {
  const mrlPath = drive.startsWith('dvd:///') ? decodeURIComponent(drive.slice('dvd:///'.length).split('#')[0] ?? drive) : drive
  const scanDrive = /^[A-Za-z]:\/?$/.test(mrlPath) ? mrlPath.slice(0, 2).toUpperCase() : mrlPath.replaceAll('/', '\\').replace(/\\+$/, '')
  return {
    discId: 'fake-disc-001',
    drive: scanDrive,
    titles: [
      { titleNumber: 1, durationSeconds: 5400, audioTracks: [{ id: 1, label: 'English 5.1' }, { id: 2, label: 'Commentary' }], subtitleTracks: [{ id: 1, label: 'English' }] },
      { titleNumber: 2, durationSeconds: 660, audioTracks: [{ id: 1, label: 'English Stereo' }], subtitleTracks: [] },
      { titleNumber: 3, durationSeconds: 120, audioTracks: [{ id: 1, label: 'English Stereo' }], subtitleTracks: [] },
    ],
  }
}

async function writeHlsWindow(outputDir: string, latest: number, firstAllowed: number, segment: Buffer): Promise<void> {
  await mkdir(outputDir, { recursive: true })
  const first = Math.max(firstAllowed, latest - 3)
  const numbers: number[] = []
  for (let number = first; number <= latest; number += 1) numbers.push(number)
  for (const number of numbers) await writeFile(join(outputDir, formatSegmentName(number)), segment)
  await writeFile(join(outputDir, 'index.m3u8'), [
    '#EXTM3U', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${first}`,
    ...numbers.flatMap((number) => ['#EXTINF:2,', formatSegmentName(number)]), '',
  ].join('\n'), 'utf8')
}

function formatSegmentName(number: number): string {
  return `segment-${String(number).padStart(6, '0')}.ts`
}
