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
const startTimeSeconds = Number(getArg('startTimeSeconds') ?? 0)
const initialSegmentNumber = Number(getArg('initialSegmentNumber') ?? 1)
const profile = process.env.FAKE_VLC_PROFILE ?? 'healthy'
const badEndSeconds = Number(process.env.FAKE_VLC_BAD_END_SECONDS ?? 12)

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
  await writeFile(join(outDir, 'segment-000.ts'), Buffer.from([0x47, 0x40, 0x00, 0x10]))
}

if (mode === 'hls-server') {
  let latestSegmentNumber = initialSegmentNumber
  await writeHlsWindow(outDir, latestSegmentNumber)
  console.log('FAKE_VLC_READY')
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))

  const shouldStall = profile === 'bad-sector-midplayback' && startTimeSeconds < badEndSeconds
  setInterval(() => {
    process.stdout.write('FAKE_VLC_HEARTBEAT\n')
  }, 1000)

  if (!shouldStall) {
    setInterval(() => {
      latestSegmentNumber += 1
      void writeHlsWindow(outDir, latestSegmentNumber)
    }, 1000)
  }
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

async function writeHlsWindow(outputDir: string, latestSegmentNumber: number): Promise<void> {
  const firstSegmentNumber = Math.max(initialSegmentNumber, latestSegmentNumber - 3)
  const segmentNumbers: number[] = []
  for (let segmentNumber = firstSegmentNumber; segmentNumber <= latestSegmentNumber; segmentNumber += 1) {
    segmentNumbers.push(segmentNumber)
  }

  for (const segmentNumber of segmentNumbers) {
    await writeFile(join(outputDir, formatSegmentName(segmentNumber)), Buffer.from([0x47, 0x40, 0x00, 0x10]))
  }

  const manifest = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${firstSegmentNumber}`,
    ...segmentNumbers.flatMap((segmentNumber) => ['#EXTINF:2,', formatSegmentName(segmentNumber)]),
    '',
  ].join('\n')
  await writeFile(join(outputDir, 'index.m3u8'), manifest, 'utf8')
}

function formatSegmentName(segmentNumber: number): string {
  return `segment-${String(segmentNumber).padStart(6, '0')}.ts`
}