import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const thumbnailPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP+2mS2WQAAAABJRU5ErkJggg==',
  'base64',
)

function getArg(name: string): string | undefined {
  return process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
}

const mode = getArg('mode') ?? 'noop'
const outDir = getArg('outDir') ?? '.cache/fake-vlc'
const delayMs = Number(getArg('delayMs') ?? 0)
const exitCode = Number(getArg('exitCode') ?? 0)
const stderrMessage = getArg('stderr')
const drive = getArg('drive') ?? 'D:'
const profile = process.env.FAKE_VLC_PROFILE ?? 'healthy'

const scanPayload = {
  discId: 'fake-disc-001',
  drive,
  titles: [
    {
      titleNumber: 1,
      durationSeconds: 5400,
      audioTracks: [
        { id: 1, label: 'English 5.1' },
        { id: 2, label: 'Commentary' },
      ],
      subtitleTracks: [{ id: 1, label: 'English' }],
    },
    {
      titleNumber: 2,
      durationSeconds: 660,
      audioTracks: [{ id: 1, label: 'English Stereo' }],
      subtitleTracks: [],
    },
    {
      titleNumber: 3,
      durationSeconds: 120,
      audioTracks: [{ id: 1, label: 'English Stereo' }],
      subtitleTracks: [],
    },
  ],
}

if (delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

await mkdir(outDir, { recursive: true })

if (profile === 'scratched-scan' && mode === 'scan') {
  console.error('Scratched disc read error prevented DVD scan metadata from being extracted.')
  process.exit(exitCode || 2)
}

if (profile === 'scratched-playback' && mode === 'hls-server') {
  console.error('Scratched disc read error prevented a playable HLS stream from being produced.')
  process.exit(exitCode || 3)
}

if (mode === 'scan') {
  console.log(JSON.stringify(scanPayload))
  process.exit(exitCode)
}

if (mode === 'hls') {
  await writeFile(join(outDir, 'index.m3u8'), '#EXTM3U\n#EXTINF:2,\nsegment-000.ts\n', 'utf8')
  await writeFile(join(outDir, 'segment-000.ts'), 'FAKE_TS_SEGMENT', 'utf8')
}

if (mode === 'hls-server') {
  await writeFile(join(outDir, 'index.m3u8'), '#EXTM3U\n#EXTINF:2,\nsegment-000001.ts\n', 'utf8')
  await writeFile(join(outDir, 'segment-000001.ts'), 'FAKE_TS_SEGMENT', 'utf8')
  console.log('FAKE_VLC_READY')
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
  setInterval(() => {
    process.stdout.write('FAKE_VLC_HEARTBEAT\n')
  }, 1000)
}

if (mode === 'thumbnail') {
  await writeFile(join(outDir, 'thumbnail.jpg'), thumbnailPng)
}

if (stderrMessage) {
  console.error(stderrMessage)
}

if (mode !== 'hls-server') {
  console.log('FAKE_VLC_DONE')
  process.exit(exitCode)
}