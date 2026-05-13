export type DiscState =
  | 'no_drive'
  | 'empty'
  | 'disc_detected'
  | 'catalog_loading'
  | 'catalog_ready'
  | 'catalog_error'
  | 'disc_removed'

export interface TrackOption {
  id: number
  label: string
}

export interface DiscTitle {
  id: string
  titleNumber: number
  label: string
  durationSeconds: number
  likelyMainFeature: boolean
  thumbnailUrl: string
  audioTracks: TrackOption[]
  subtitleTracks: TrackOption[]
}

export interface DiscSummary {
  discId: string
  drive: string
  titles: DiscTitle[]
}

export interface CatalogSnapshot {
  state: DiscState
  disc: DiscSummary | null
  error?: {
    message: string
    detail?: string
  }
}

export interface RawDiscTitle {
  titleNumber: number
  durationSeconds: number
  audioTracks: TrackOption[]
  subtitleTracks: TrackOption[]
}

export interface RawDiscScan {
  discId: string
  drive: string
  titles: RawDiscTitle[]
}