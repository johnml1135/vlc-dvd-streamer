import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import type { ServerLogEntry } from './server-log.js'

export interface FileLogSink {
  /** Pass to `ServerLog` as its sink to append every entry to the file. */
  sink: (line: string, entry: ServerLogEntry) => void
  /** Flush and close the underlying stream. */
  close: () => Promise<void>
  /** Absolute path the log is being written to. */
  path: string
}

/**
 * Appends formatted log lines to a file on disk so crashes (notably VLC
 * exiting/segfaulting mid-session, whose stderr is captured into the session
 * error detail) survive after the in-memory ring buffer rolls over and after
 * the process exits. The directory is created if needed; a banner marks each
 * process start so separate runs are distinguishable in a long-lived file.
 */
export function createFileLogSink(filePath: string): FileLogSink {
  mkdirSync(dirname(filePath), { recursive: true })

  const stream: WriteStream = createWriteStream(filePath, { flags: 'a' })
  stream.write(`\n=== Log opened ${new Date().toISOString()} (pid ${process.pid}) ===\n`)

  return {
    path: filePath,
    sink: (line) => {
      stream.write(`${line}\n`)
    },
    close: () => new Promise<void>((resolve) => {
      stream.end(() => resolve())
    }),
  }
}
