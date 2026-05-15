import { describe, expect, it } from 'vitest'
import { normalizeHlsTransportStream } from '../../../src/vlc/transport-stream.js'

const TS_PACKET_SIZE = 188
const PMT_PID = 100
const AUDIO_PID = 200
const VIDEO_PID = 300
const SUBTITLE_PID = 400

describe('normalizeHlsTransportStream', () => {
  it('returns non-packetized buffers unchanged', () => {
    const input = Buffer.from([0x47, 0x40, 0x00])

    expect(normalizeHlsTransportStream(input)).toBe(input)
  })

  it('filters the program map and media packets to one audio and one video stream', () => {
    const input = buildTransportStream([
      { streamType: 0x0f, pid: AUDIO_PID },
      { streamType: 0x1b, pid: VIDEO_PID },
      { streamType: 0x06, pid: SUBTITLE_PID },
    ], [
      mediaPacket(AUDIO_PID, true, 12, 0xaa),
      mediaPacket(SUBTITLE_PID, true, 3, 0xcc),
      mediaPacket(VIDEO_PID, false, 7, 0xee),
      mediaPacket(VIDEO_PID, true, 8, 0xbb),
      mediaPacket(VIDEO_PID, false, 2, 0xbd),
    ])

    const normalized = normalizeHlsTransportStream(input)

    expect(normalized).not.toBe(input)
    expect(packetPids(normalized)).toEqual([0, PMT_PID, AUDIO_PID, VIDEO_PID, VIDEO_PID])
    expect(parsePmtStreams(readPsiSection(normalized, PMT_PID))).toEqual([
      { streamType: 0x0f, pid: AUDIO_PID },
      { streamType: 0x1b, pid: VIDEO_PID },
    ])
    expect(packetContinuityCounters(normalized, VIDEO_PID)).toEqual([0, 1])
  })

  it('can normalize to video-only output for embedded browser playback', () => {
    const input = buildTransportStream([
      { streamType: 0x0f, pid: AUDIO_PID },
      { streamType: 0x1b, pid: VIDEO_PID },
    ], [
      mediaPacket(AUDIO_PID, true, 1, 0xaa),
      mediaPacket(VIDEO_PID, true, 2, 0xbb),
    ])

    const normalized = normalizeHlsTransportStream(input, { includeAudio: false })

    expect(packetPids(normalized)).toEqual([0, PMT_PID, VIDEO_PID])
    expect(parsePmtStreams(readPsiSection(normalized, PMT_PID))).toEqual([
      { streamType: 0x1b, pid: VIDEO_PID },
    ])
  })

  it('leaves streams unchanged when required audio is missing', () => {
    const input = buildTransportStream([
      { streamType: 0x1b, pid: VIDEO_PID },
      { streamType: 0x06, pid: SUBTITLE_PID },
    ], [
      mediaPacket(VIDEO_PID, true, 1, 0xbb),
      mediaPacket(SUBTITLE_PID, true, 2, 0xcc),
    ])

    expect(normalizeHlsTransportStream(input)).toBe(input)
  })
})

interface TestStreamEntry {
  streamType: number
  pid: number
}

function buildTransportStream(streams: TestStreamEntry[], mediaPackets: Buffer[]): Buffer {
  return Buffer.concat([
    psiPacket(0, patSection(PMT_PID)),
    psiPacket(PMT_PID, pmtSection(streams)),
    ...mediaPackets,
  ])
}

function patSection(pmtPid: number): Buffer {
  const sectionLength = 13
  const section = Buffer.alloc(3 + sectionLength)
  section[0] = 0x00
  section[1] = 0xb0 | ((sectionLength >> 8) & 0x0f)
  section[2] = sectionLength & 0xff
  section[3] = 0x00
  section[4] = 0x01
  section[5] = 0xc1
  section[6] = 0x00
  section[7] = 0x00
  section[8] = 0x00
  section[9] = 0x01
  section[10] = 0xe0 | ((pmtPid >> 8) & 0x1f)
  section[11] = pmtPid & 0xff
  return section
}

function pmtSection(streams: TestStreamEntry[]): Buffer {
  const streamBytes = streams.length * 5
  const sectionLength = 13 + streamBytes
  const section = Buffer.alloc(3 + sectionLength)
  section[0] = 0x02
  section[1] = 0xb0 | ((sectionLength >> 8) & 0x0f)
  section[2] = sectionLength & 0xff
  section[3] = 0x00
  section[4] = 0x01
  section[5] = 0xc1
  section[6] = 0x00
  section[7] = 0x00
  section[8] = 0xe0 | ((VIDEO_PID >> 8) & 0x1f)
  section[9] = VIDEO_PID & 0xff
  section[10] = 0xf0
  section[11] = 0x00

  let cursor = 12
  for (const stream of streams) {
    section[cursor] = stream.streamType
    section[cursor + 1] = 0xe0 | ((stream.pid >> 8) & 0x1f)
    section[cursor + 2] = stream.pid & 0xff
    section[cursor + 3] = 0xf0
    section[cursor + 4] = 0x00
    cursor += 5
  }

  return section
}

function psiPacket(pid: number, section: Buffer): Buffer {
  const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff)
  packet[0] = 0x47
  packet[1] = ((pid >> 8) & 0x1f) | 0x40
  packet[2] = pid & 0xff
  packet[3] = 0x10
  packet[4] = 0x00
  section.copy(packet, 5)
  return packet
}

function mediaPacket(pid: number, payloadUnitStart: boolean, continuity: number, value: number): Buffer {
  const packet = Buffer.alloc(TS_PACKET_SIZE, value)
  packet[0] = 0x47
  packet[1] = ((pid >> 8) & 0x1f) | (payloadUnitStart ? 0x40 : 0x00)
  packet[2] = pid & 0xff
  packet[3] = 0x10 | (continuity & 0x0f)
  return packet
}

function packetPids(buffer: Buffer): number[] {
  const pids: number[] = []
  for (let offset = 0; offset + TS_PACKET_SIZE <= buffer.length; offset += TS_PACKET_SIZE) {
    pids.push(readPid(buffer, offset))
  }

  return pids
}

function packetContinuityCounters(buffer: Buffer, pid: number): number[] {
  const counters: number[] = []
  for (let offset = 0; offset + TS_PACKET_SIZE <= buffer.length; offset += TS_PACKET_SIZE) {
    if (readPid(buffer, offset) === pid) {
      counters.push(buffer[offset + 3] & 0x0f)
    }
  }

  return counters
}

function readPsiSection(buffer: Buffer, pid: number): Buffer {
  for (let offset = 0; offset + TS_PACKET_SIZE <= buffer.length; offset += TS_PACKET_SIZE) {
    if (readPid(buffer, offset) !== pid) {
      continue
    }

    const pointerField = buffer[offset + 4]
    const sectionStart = offset + 5 + pointerField
    const sectionLength = 3 + (((buffer[sectionStart + 1] & 0x0f) << 8) | buffer[sectionStart + 2])
    return Buffer.from(buffer.subarray(sectionStart, sectionStart + sectionLength))
  }

  throw new Error(`Could not find PSI section for PID ${pid}.`)
}

function parsePmtStreams(section: Buffer): TestStreamEntry[] {
  const programInfoLength = ((section[10] & 0x0f) << 8) | section[11]
  const streams: TestStreamEntry[] = []

  for (let cursor = 12 + programInfoLength; cursor + 5 <= section.length - 4;) {
    const esInfoLength = ((section[cursor + 3] & 0x0f) << 8) | section[cursor + 4]
    streams.push({
      streamType: section[cursor],
      pid: ((section[cursor + 1] & 0x1f) << 8) | section[cursor + 2],
    })
    cursor += 5 + esInfoLength
  }

  return streams
}

function readPid(buffer: Buffer, offset: number): number {
  return ((buffer[offset + 1] & 0x1f) << 8) | buffer[offset + 2]
}