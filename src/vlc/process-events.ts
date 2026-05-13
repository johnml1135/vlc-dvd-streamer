export interface ExitShape {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface NormalizedExit extends ExitShape {
  ok: boolean
}

export function normalizeExit(exit: ExitShape): NormalizedExit {
  return {
    ok: exit.code === 0,
    code: exit.code,
    signal: exit.signal,
  }
}