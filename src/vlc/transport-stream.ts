const TS_PACKET_SIZE = 188
const VIDEO_STREAM_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x24])
const AUDIO_STREAM_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81])

interface PacketInfo {
  offset: number
  pid: number
  payloadUnitStart: boolean
  adaptationControl: number
  payloadOffset: number
}

interface ProgramEntry {
  programNumber: number
  pid: number
}

interface StreamEntry {
  streamType: number
  pid: number
  descriptors: Buffer
}

interface PatInfo {
  transportStreamId: number
  versionByte: number
  sectionNumber: number
  lastSectionNumber: number
  programs: ProgramEntry[]
}

interface PmtInfo {
  programNumber: number
  versionByte: number
  sectionNumber: number
  lastSectionNumber: number
  pcrPid: number
  programDescriptors: Buffer
  streams: StreamEntry[]
}

interface StreamNormalizationOptions {
  includeAudio?: boolean
}

export function normalizeHlsTransportStream(buffer: Buffer, options: StreamNormalizationOptions = {}): Buffer {
  const includeAudio = options.includeAudio ?? true

  if (buffer.length < TS_PACKET_SIZE || buffer.length % TS_PACKET_SIZE !== 0) {
    return buffer
  }

  const patSection = readPsiSection(buffer, 0)
  if (!patSection) {
    return buffer
  }

  const pat = parsePatSection(patSection)
  const program = pat.programs.find((entry) => entry.programNumber !== 0)
  if (!program) {
    return buffer
  }

  const pmtSection = readPsiSection(buffer, program.pid)
  if (!pmtSection) {
    return buffer
  }

  const pmt = parsePmtSection(pmtSection)
  const selectedVideo = pmt.streams.find((entry) => VIDEO_STREAM_TYPES.has(entry.streamType))
  const selectedAudio = pmt.streams.find((entry) => AUDIO_STREAM_TYPES.has(entry.streamType))

  if (!selectedVideo || (includeAudio && !selectedAudio)) {
    return buffer
  }

  const filteredStreams = [selectedVideo]
  if (includeAudio && selectedAudio) {
    filteredStreams.unshift(selectedAudio)
  }

  filteredStreams.sort((left, right) => left.pid - right.pid)

  const keepPids = new Set<number>(filteredStreams.map((entry) => entry.pid))
  const shouldRewrite = pmt.streams.length !== filteredStreams.length
    || pmt.streams.some((entry) => !keepPids.has(entry.pid))

  if (!shouldRewrite) {
    return buffer
  }

  const filteredPat = buildPatSection({
    transportStreamId: pat.transportStreamId,
    versionByte: pat.versionByte,
    sectionNumber: pat.sectionNumber,
    lastSectionNumber: pat.lastSectionNumber,
    programs: [{ programNumber: program.programNumber, pid: program.pid }],
  })
  const filteredPmt = buildPmtSection({
    programNumber: pmt.programNumber,
    versionByte: pmt.versionByte,
    sectionNumber: pmt.sectionNumber,
    lastSectionNumber: pmt.lastSectionNumber,
    pcrPid: selectedVideo.pid,
    programDescriptors: pmt.programDescriptors,
    streams: filteredStreams,
  })

  const counters = new Map<number, number>()
  const startedPids = new Set<number>()
  const packets: Buffer[] = [
    ...packetizePsiSection(0, filteredPat),
    ...packetizePsiSection(program.pid, filteredPmt),
  ]

  for (let offset = 0; offset + TS_PACKET_SIZE <= buffer.length; offset += TS_PACKET_SIZE) {
    const packetInfo = readPacketInfo(buffer, offset)
    if (!packetInfo || !keepPids.has(packetInfo.pid)) {
      continue
    }

    if (!startedPids.has(packetInfo.pid)) {
      if (!packetInfo.payloadUnitStart) {
        continue
      }

      startedPids.add(packetInfo.pid)
    }

    const packet = Buffer.from(buffer.subarray(offset, offset + TS_PACKET_SIZE))
    const continuity = counters.get(packetInfo.pid) ?? 0
    packet[3] = (packet[3] & 0xf0) | continuity
    packets.push(packet)

    if (packetInfo.adaptationControl === 1 || packetInfo.adaptationControl === 3) {
      counters.set(packetInfo.pid, (continuity + 1) & 0x0f)
    } else {
      counters.set(packetInfo.pid, continuity)
    }
  }

  return Buffer.concat(packets)
}

function readPacketInfo(buffer: Buffer, offset: number): PacketInfo | null {
  if (buffer[offset] !== 0x47) {
    return null
  }

  const pid = ((buffer[offset + 1] & 0x1f) << 8) | buffer[offset + 2]
  const payloadUnitStart = (buffer[offset + 1] & 0x40) !== 0
  const adaptationControl = (buffer[offset + 3] >> 4) & 0x03

  if (adaptationControl === 0 || adaptationControl === 2) {
    return {
      offset,
      pid,
      payloadUnitStart,
      adaptationControl,
      payloadOffset: offset + TS_PACKET_SIZE,
    }
  }

  let payloadOffset = offset + 4
  if (adaptationControl === 3) {
    payloadOffset += 1 + buffer[offset + 4]
  }

  if (payloadOffset > offset + TS_PACKET_SIZE) {
    payloadOffset = offset + TS_PACKET_SIZE
  }

  return {
    offset,
    pid,
    payloadUnitStart,
    adaptationControl,
    payloadOffset,
  }
}

function readPsiSection(buffer: Buffer, targetPid: number): Buffer | null {
  const chunks: number[] = []
  let expectedLength: number | null = null
  let collecting = false

  for (let offset = 0; offset + TS_PACKET_SIZE <= buffer.length; offset += TS_PACKET_SIZE) {
    const packetInfo = readPacketInfo(buffer, offset)
    if (!packetInfo || packetInfo.pid !== targetPid) {
      continue
    }

    if (packetInfo.adaptationControl !== 1 && packetInfo.adaptationControl !== 3) {
      continue
    }

    let cursor = packetInfo.payloadOffset
    if (cursor >= offset + TS_PACKET_SIZE) {
      continue
    }

    if (packetInfo.payloadUnitStart) {
      const pointerField = buffer[cursor]
      cursor += 1 + pointerField
      collecting = true
      expectedLength = null
      chunks.length = 0
    }

    if (!collecting || cursor >= offset + TS_PACKET_SIZE) {
      continue
    }

    for (; cursor < offset + TS_PACKET_SIZE; cursor += 1) {
      chunks.push(buffer[cursor])
      if (expectedLength === null && chunks.length >= 3) {
        expectedLength = 3 + (((chunks[1] & 0x0f) << 8) | chunks[2])
      }

      if (expectedLength !== null && chunks.length >= expectedLength) {
        return Buffer.from(chunks.slice(0, expectedLength))
      }
    }
  }

  return null
}

function parsePatSection(section: Buffer): PatInfo {
  const transportStreamId = (section[3] << 8) | section[4]
  const versionByte = section[5]
  const sectionNumber = section[6]
  const lastSectionNumber = section[7]
  const programs: ProgramEntry[] = []

  for (let cursor = 8; cursor + 4 <= section.length - 4; cursor += 4) {
    programs.push({
      programNumber: (section[cursor] << 8) | section[cursor + 1],
      pid: ((section[cursor + 2] & 0x1f) << 8) | section[cursor + 3],
    })
  }

  return {
    transportStreamId,
    versionByte,
    sectionNumber,
    lastSectionNumber,
    programs,
  }
}

function parsePmtSection(section: Buffer): PmtInfo {
  const programNumber = (section[3] << 8) | section[4]
  const versionByte = section[5]
  const sectionNumber = section[6]
  const lastSectionNumber = section[7]
  const pcrPid = ((section[8] & 0x1f) << 8) | section[9]
  const programInfoLength = ((section[10] & 0x0f) << 8) | section[11]
  const programDescriptors = Buffer.from(section.subarray(12, 12 + programInfoLength))
  const streams: StreamEntry[] = []

  for (let cursor = 12 + programInfoLength; cursor + 5 <= section.length - 4;) {
    const esInfoLength = ((section[cursor + 3] & 0x0f) << 8) | section[cursor + 4]
    streams.push({
      streamType: section[cursor],
      pid: ((section[cursor + 1] & 0x1f) << 8) | section[cursor + 2],
      descriptors: Buffer.from(section.subarray(cursor + 5, cursor + 5 + esInfoLength)),
    })
    cursor += 5 + esInfoLength
  }

  return {
    programNumber,
    versionByte,
    sectionNumber,
    lastSectionNumber,
    pcrPid,
    programDescriptors,
    streams,
  }
}

function buildPatSection(input: PatInfo): Buffer {
  const sectionLength = 9 + (input.programs.length * 4)
  const section = Buffer.alloc(3 + sectionLength)
  section[0] = 0x00
  section[1] = 0xb0 | ((sectionLength >> 8) & 0x0f)
  section[2] = sectionLength & 0xff
  section[3] = (input.transportStreamId >> 8) & 0xff
  section[4] = input.transportStreamId & 0xff
  section[5] = input.versionByte
  section[6] = input.sectionNumber
  section[7] = input.lastSectionNumber

  let cursor = 8
  for (const program of input.programs) {
    section[cursor] = (program.programNumber >> 8) & 0xff
    section[cursor + 1] = program.programNumber & 0xff
    section[cursor + 2] = 0xe0 | ((program.pid >> 8) & 0x1f)
    section[cursor + 3] = program.pid & 0xff
    cursor += 4
  }

  writeCrc32(section)
  return section
}

function buildPmtSection(input: PmtInfo): Buffer {
  const streamBytes = input.streams.reduce((total, stream) => total + 5 + stream.descriptors.length, 0)
  const sectionLength = 13 + input.programDescriptors.length + streamBytes
  const section = Buffer.alloc(3 + sectionLength)
  section[0] = 0x02
  section[1] = 0xb0 | ((sectionLength >> 8) & 0x0f)
  section[2] = sectionLength & 0xff
  section[3] = (input.programNumber >> 8) & 0xff
  section[4] = input.programNumber & 0xff
  section[5] = input.versionByte
  section[6] = input.sectionNumber
  section[7] = input.lastSectionNumber
  section[8] = 0xe0 | ((input.pcrPid >> 8) & 0x1f)
  section[9] = input.pcrPid & 0xff
  section[10] = 0xf0 | ((input.programDescriptors.length >> 8) & 0x0f)
  section[11] = input.programDescriptors.length & 0xff
  input.programDescriptors.copy(section, 12)

  let cursor = 12 + input.programDescriptors.length
  for (const stream of input.streams) {
    section[cursor] = stream.streamType
    section[cursor + 1] = 0xe0 | ((stream.pid >> 8) & 0x1f)
    section[cursor + 2] = stream.pid & 0xff
    section[cursor + 3] = 0xf0 | ((stream.descriptors.length >> 8) & 0x0f)
    section[cursor + 4] = stream.descriptors.length & 0xff
    stream.descriptors.copy(section, cursor + 5)
    cursor += 5 + stream.descriptors.length
  }

  writeCrc32(section)
  return section
}

function packetizePsiSection(pid: number, section: Buffer): Buffer[] {
  const packets: Buffer[] = []
  let offset = 0
  let continuity = 0
  let firstPacket = true

  while (offset < section.length || firstPacket) {
    const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff)
    packet[0] = 0x47
    packet[1] = ((pid >> 8) & 0x1f) | (firstPacket ? 0x40 : 0x00)
    packet[2] = pid & 0xff
    packet[3] = 0x10 | (continuity & 0x0f)

    let cursor = 4
    if (firstPacket) {
      packet[cursor] = 0x00
      cursor += 1
    }

    const chunkLength = Math.min(section.length - offset, TS_PACKET_SIZE - cursor)
    if (chunkLength > 0) {
      section.copy(packet, cursor, offset, offset + chunkLength)
      offset += chunkLength
    }

    packets.push(packet)
    continuity = (continuity + 1) & 0x0f
    firstPacket = false
  }

  return packets
}

function writeCrc32(section: Buffer): void {
  const crc = mpeg2Crc32(section.subarray(0, section.length - 4))
  section.writeUInt32BE(crc >>> 0, section.length - 4)
}

function mpeg2Crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const value of buffer) {
    crc ^= value << 24
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80000000) !== 0
        ? ((crc << 1) ^ 0x04c11db7) >>> 0
        : (crc << 1) >>> 0
    }
  }

  return crc >>> 0
}