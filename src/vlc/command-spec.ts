export interface CommandSpecInput {
  executable: string
  args: string[]
  timeoutMs: number
  label: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface CommandSpec extends CommandSpecInput {
  shell: false
  windowsHide: true
}

export function createCommandSpec(input: CommandSpecInput): CommandSpec {
  return {
    ...input,
    shell: false,
    windowsHide: true,
  }
}