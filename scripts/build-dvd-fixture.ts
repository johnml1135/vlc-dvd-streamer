import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dvdStylerBin = 'C:/Program Files/DVDStyler/bin'

export interface DvdFixtureTools {
  ffmpeg: string
  dvdauthor: string
  spumux: string
  mplex: string
}

export function resolveFixtureTools(env: NodeJS.ProcessEnv = process.env): DvdFixtureTools {
  const dvdauthor = env.DVDAUTHOR_PATH ?? join(dvdStylerBin, 'dvdauthor.exe')
  return {
    ffmpeg: env.FFMPEG_PATH ?? join(dvdStylerBin, 'ffmpeg.exe'),
    dvdauthor,
    spumux: env.SPUMUX_PATH ?? join(dvdStylerBin, 'spumux.exe'),
    mplex: join(dirname(dvdauthor), 'mplex.exe'),
  }
}

export async function buildDvdFixture(root = process.cwd(), tools = resolveFixtureTools()): Promise<void> {
  for (const [name, path] of Object.entries(tools)) {
    if (!await fileExists(path)) throw new Error(`${name} executable was not found: ${path}`)
  }

  const scratchRoot = resolve(root, '.cache')
  await mkdir(scratchRoot, { recursive: true })
  const scratch = await mkdtemp(join(scratchRoot, 'dvd-fixture-build-'))
  const inputDir = join(scratch, 'input')
  const dvdDir = join(scratch, 'dvd')
  await mkdir(inputDir, { recursive: true })
  await mkdir(dvdDir, { recursive: true })

  try {
    const longTitle = await buildTitle(inputDir, tools, 1, 20, 440)
    const shortTitle = await buildTitle(inputDir, tools, 2, 6, 880)
    const titleOne = await addSubtitle(tools.spumux, longTitle, inputDir, 1, '1\n00:00:03,000 --> 00:00:05,000\nSynthetic DVD title one\n')
    const titleTwo = await addSubtitle(tools.spumux, shortTitle, inputDir, 2, '1\n00:00:01,000 --> 00:00:03,000\nSynthetic DVD title two\n')

    const dvdXml = join(inputDir, 'dvd.xml')
    const dvdXmlBody = `<dvdauthor dest="${xmlPath(dvdDir)}"><vmgm><menus><video format="ntsc" aspect="16:9"/><pgc><vob file="${xmlPath(titleOne)}"/></pgc></menus></vmgm><titleset><titles><video format="ntsc" aspect="16:9"/><audio lang="en"/><audio lang="fr"/><subpicture lang="en"/><pgc><vob file="${xmlPath(titleOne)}"/></pgc><pgc><vob file="${xmlPath(titleTwo)}"/></pgc></titles></titleset></dvdauthor>`
    await writeFile(dvdXml, dvdXmlBody, 'utf8')
    run(tools.dvdauthor, ['-x', dvdXml], scratch)

    const fixtureDir = resolve(root, 'test/fixtures/dvd')
    const fixtureVideoTs = join(fixtureDir, 'VIDEO_TS')
    await rm(fixtureVideoTs, { recursive: true, force: true })
    await mkdir(fixtureDir, { recursive: true })
    await cp(join(dvdDir, 'VIDEO_TS'), fixtureVideoTs, { recursive: true })

    const files = await Promise.all(['VIDEO_TS.IFO', 'VTS_01_0.IFO', 'VTS_01_1.VOB'].map(async (name) => ({
      name,
      size: (await stat(join(fixtureVideoTs, name))).size,
    })))
    console.log(JSON.stringify({ fixtureDir, files }, null, 2))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function buildTitle(inputDir: string, tools: DvdFixtureTools, titleNumber: number, durationSeconds: number, audioFrequency: number): Promise<string> {
  const base = `title-${titleNumber}`
  const videoPath = join(inputDir, `${base}.m2v`)
  const audioEnPath = join(inputDir, `${base}-audio-en.ac3`)
  const audioFrPath = join(inputDir, `${base}-audio-fr.ac3`)
  const muxedPath = join(inputDir, `${base}.mpg`)

  run(tools.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=720x480:rate=30000/1001',
    '-t', String(durationSeconds), '-an', '-c:v', 'mpeg2video', '-b:v', '650k', '-maxrate', '4000k', '-bufsize', '1835k',
    '-g', '15', '-aspect', '16:9', '-pix_fmt', 'yuv420p', '-f', 'mpeg2video', videoPath,
  ], inputDir)

  for (const [language, frequency] of [['en', audioFrequency], ['fr', audioFrequency * 2]] as const) {
    run(tools.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`,
      '-t', String(durationSeconds), '-c:a', 'ac3', '-b:a', '96k', '-ar', '48000', '-ac', '2', audioPath(language),
    ], inputDir)
    function audioPath(code: string): string { return code === 'en' ? audioEnPath : audioFrPath }
  }

  run(tools.mplex, ['-f', '8', '-o', muxedPath, videoPath, audioEnPath, audioFrPath], inputDir)
  return muxedPath
}

async function addSubtitle(spumux: string, inputPath: string, inputDir: string, titleNumber: number, subtitle: string): Promise<string> {
  const srtPath = join(inputDir, `title-${titleNumber}.srt`)
  const xmlPathname = join(inputDir, `title-${titleNumber}-spumux.xml`)
  const outputPath = join(inputDir, `title-${titleNumber}-subbed.mpg`)
  await writeFile(srtPath, subtitle, 'utf8')
  await writeFile(xmlPathname, `<subpictures format="NTSC"><stream><textsub filename="${xmlPath(srtPath)}" characterset="UTF-8" fontsize="28" font="C:/Windows/Fonts/arial.ttf" movie-fps="29.97" movie-width="720" movie-height="480"/></stream></subpictures>`, 'utf8')
  const result = spawnSync(spumux, [xmlPathname], { cwd: inputDir, input: await readFile(inputPath), encoding: 'buffer', maxBuffer: 80 * 1024 * 1024, windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${spumux} exited ${result.status}: ${result.stderr?.toString('utf8') ?? ''}`)
  await writeFile(outputPath, result.stdout ?? Buffer.alloc(0))
  return outputPath
}

function run(executable: string, args: string[], cwd: string): void {
  const result = spawnSync(executable, args, { cwd, encoding: 'buffer', maxBuffer: 80 * 1024 * 1024, windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${executable} exited ${result.status}: ${result.stderr?.toString('utf8') ?? ''}`)
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

function xmlPath(path: string): string {
  return path.replaceAll('\\', '/')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildDvdFixture()
}
