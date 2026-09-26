import { describe, expect, it } from 'vitest'
import { detectOpticalDrive, parseOpticalDrives, resolveDvdSource, selectOpticalDrive } from '../../../src/disc/optical-drive.js'

describe('parseOpticalDrives', () => {
  it('parses drive + media-loaded lines and ignores noise', () => {
    const output = ['F:\tTrue', 'G:\tFalse', '', 'not-a-drive', 'D:\ttrue'].join('\n')
    expect(parseOpticalDrives(output)).toEqual([
      { drive: 'F:', mediaLoaded: true },
      { drive: 'G:', mediaLoaded: false },
      { drive: 'D:', mediaLoaded: true },
    ])
  })
})

describe('selectOpticalDrive', () => {
  it('prefers a drive with media loaded', () => {
    expect(selectOpticalDrive([
      { drive: 'D:', mediaLoaded: false },
      { drive: 'F:', mediaLoaded: true },
    ])).toBe('F:')
  })

  it('falls back to the first present drive when none have media', () => {
    expect(selectOpticalDrive([
      { drive: 'E:', mediaLoaded: false },
      { drive: 'G:', mediaLoaded: false },
    ])).toBe('E:')
  })

  it('returns null when there are no optical drives', () => {
    expect(selectOpticalDrive([])).toBeNull()
  })
})

describe('detectOpticalDrive', () => {
  it('returns null on non-Windows platforms without invoking PowerShell', async () => {
    let called = false
    const result = await detectOpticalDrive({
      platform: 'linux',
      runPowerShell: async () => {
        called = true
        return ''
      },
    })

    expect(result).toBeNull()
    expect(called).toBe(false)
  })

  it('detects the loaded drive on Windows', async () => {
    const result = await detectOpticalDrive({
      platform: 'win32',
      runPowerShell: async () => 'F:\tTrue\n',
    })

    expect(result).toBe('F:')
  })

  it('returns null when detection throws', async () => {
    const result = await detectOpticalDrive({
      platform: 'win32',
      runPowerShell: async () => {
        throw new Error('powershell unavailable')
      },
    })

    expect(result).toBeNull()
  })

  // Exercises the real PowerShell spawn path. Runs only on Windows (incl. CI);
  // a box with no optical drive simply yields null.
  it.skipIf(process.platform !== 'win32')('detects via the real PowerShell path on Windows', async () => {
    const result = await detectOpticalDrive()
    expect(result === null || /^[A-Z]:$/.test(result)).toBe(true)
  })
})

describe('resolveDvdSource', () => {
  it('uses an explicit folder source without running optical drive detection', async () => {
    let detected = false
    const result = await resolveDvdSource('C:\\fixtures\\sample-disc', async () => {
      detected = true
      return 'F:'
    })

    expect(result).toEqual({ source: 'C:\\fixtures\\sample-disc', explicit: true, detected: false })
    expect(detected).toBe(false)
  })
})
