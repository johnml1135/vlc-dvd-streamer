[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()]
  [string]$Mrl = 'dvd:///F:/#1',

  [ValidateNotNullOrEmpty()]
  [string]$VlcDir = 'C:\Program Files\VideoLAN\VLC',

  [ValidateRange(1, 30)]
  [int]$WaitSeconds = 4
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $VlcDir)) {
  throw "VLC directory '$VlcDir' was not found."
}

$env:PATH = "$VlcDir;$env:PATH"

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

[StructLayout(LayoutKind.Sequential)]
public struct libvlc_track_description_t
{
    public int i_id;
    public IntPtr psz_name;
    public IntPtr p_next;
}

[StructLayout(LayoutKind.Sequential)]
public struct libvlc_media_track_t
{
  public UInt32 i_codec;
  public UInt32 i_original_fourcc;
  public int i_id;
  public int i_type;
  public int i_profile;
  public int i_level;
  public IntPtr typed_data;
  public UInt32 i_bitrate;
  public IntPtr psz_language;
  public IntPtr psz_description;
}

  [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
  public delegate void libvlc_callback_t(IntPtr p_event, IntPtr p_data);

  public static class LibVlcEventSink
  {
    public static int Playing;
    public static int EsAdded;
    public static int EsSelected;
    public static int EncounteredError;
    public static int EndReached;
    public static int TimeChanged;
    public static int LastEventType;

    public static void Reset()
    {
      Playing = 0;
      EsAdded = 0;
      EsSelected = 0;
      EncounteredError = 0;
      EndReached = 0;
      TimeChanged = 0;
      LastEventType = 0;
    }

    public static void Callback(IntPtr p_event, IntPtr p_data)
    {
      int eventType = Marshal.ReadInt32(p_event);
      LastEventType = eventType;

      switch (eventType)
      {
        case 0x104:
          Interlocked.Increment(ref Playing);
          break;
        case 0x109:
          Interlocked.Increment(ref EndReached);
          break;
        case 0x10a:
          Interlocked.Increment(ref EncounteredError);
          break;
        case 0x10b:
          Interlocked.Increment(ref TimeChanged);
          break;
        case 0x114:
          Interlocked.Increment(ref EsAdded);
          break;
        case 0x116:
          Interlocked.Increment(ref EsSelected);
          break;
      }
    }
  }

public static class LibVlcNative
{
    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr libvlc_new(int argc, string[] argv);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern void libvlc_release(IntPtr instance);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr libvlc_media_new_location(IntPtr instance, [MarshalAs(UnmanagedType.LPStr)] string mrl);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern void libvlc_media_release(IntPtr media);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern void libvlc_media_add_option(IntPtr media, [MarshalAs(UnmanagedType.LPStr)] string option);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern uint libvlc_media_tracks_get(IntPtr media, out IntPtr tracks);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern void libvlc_media_tracks_release(IntPtr tracks, uint count);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr libvlc_media_player_new_from_media(IntPtr media);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern void libvlc_media_player_release(IntPtr player);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int libvlc_media_player_play(IntPtr player);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern void libvlc_media_player_stop(IntPtr player);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int libvlc_media_player_get_state(IntPtr player);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern long libvlc_media_player_get_time(IntPtr player);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int libvlc_media_player_get_title(IntPtr player);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int libvlc_media_player_get_title_count(IntPtr player);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int libvlc_media_player_is_playing(IntPtr player);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr libvlc_media_player_event_manager(IntPtr player);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int libvlc_event_attach(IntPtr eventManager, int eventType, libvlc_callback_t callback, IntPtr userData);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern void libvlc_event_detach(IntPtr eventManager, int eventType, libvlc_callback_t callback, IntPtr userData);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr libvlc_audio_get_track_description(IntPtr player);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern int libvlc_audio_set_volume(IntPtr player, int volume);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr libvlc_video_get_spu_description(IntPtr player);

    [DllImport("libvlc", CallingConvention = CallingConvention.Cdecl)]
    public static extern void libvlc_track_description_list_release(IntPtr list);
}
'@

function Get-TrackList {
  param([IntPtr]$Head)

  $items = @()
  $cursor = $Head
  while ($cursor -ne [IntPtr]::Zero) {
    $item = [Runtime.InteropServices.Marshal]::PtrToStructure($cursor, [type][libvlc_track_description_t])
    $items += [pscustomobject]@{
      id = $item.i_id
      name = if ($item.psz_name -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::PtrToStringAnsi($item.psz_name)
      } else {
        $null
      }
    }
    $cursor = $item.p_next
  }

  return $items
}

function Get-MediaTrackList {
  param(
    [IntPtr]$Tracks,
    [uint32]$Count
  )

  $items = @()
  for ($index = 0; $index -lt $Count; $index++) {
    $trackPtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($Tracks, $index * [IntPtr]::Size)
    if ($trackPtr -eq [IntPtr]::Zero) {
      continue
    }

    $track = [Runtime.InteropServices.Marshal]::PtrToStructure($trackPtr, [type][libvlc_media_track_t])
    $items += [pscustomobject]@{
      id = $track.i_id
      type = $track.i_type
      language = if ($track.psz_language -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::PtrToStringAnsi($track.psz_language)
      } else {
        $null
      }
      description = if ($track.psz_description -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::PtrToStringAnsi($track.psz_description)
      } else {
        $null
      }
    }
  }

  return $items
}

function Read-TrackDescriptions {
  param([IntPtr]$Player)

  $audioHead = [LibVlcNative]::libvlc_audio_get_track_description($Player)
  $subtitleHead = [LibVlcNative]::libvlc_video_get_spu_description($Player)

  try {
    return [pscustomobject]@{
      audio = @(Get-TrackList -Head $audioHead)
      subtitles = @(Get-TrackList -Head $subtitleHead)
    }
  } finally {
    if ($audioHead -ne [IntPtr]::Zero) {
      [LibVlcNative]::libvlc_track_description_list_release($audioHead)
    }

    if ($subtitleHead -ne [IntPtr]::Zero) {
      [LibVlcNative]::libvlc_track_description_list_release($subtitleHead)
    }
  }
}

$argv = @(
  '--ignore-config'
  '--no-video-title-show'
  '--vout=dummy'
)

$instance = [LibVlcNative]::libvlc_new($argv.Length, $argv)
if ($instance -eq [IntPtr]::Zero) {
  throw 'libvlc_new failed.'
}

$media = [LibVlcNative]::libvlc_media_new_location($instance, $Mrl)
if ($media -eq [IntPtr]::Zero) {
  throw "libvlc_media_new_location failed for '$Mrl'."
}

[LibVlcNative]::libvlc_media_add_option($media, ':audio-language=any')
[LibVlcNative]::libvlc_media_add_option($media, ':sub-language=any')
[LibVlcNative]::libvlc_media_add_option($media, ':dvdnav-menu=false')

$player = [LibVlcNative]::libvlc_media_player_new_from_media($media)
if ($player -eq [IntPtr]::Zero) {
  throw 'libvlc_media_player_new_from_media failed.'
}

$eventTypes = @(0x104, 0x109, 0x10a, 0x10b, 0x114, 0x116)
$callback = [System.Delegate]::CreateDelegate([type][libvlc_callback_t], [LibVlcEventSink], 'Callback')
$eventManager = [LibVlcNative]::libvlc_media_player_event_manager($player)
$mediaTracks = [IntPtr]::Zero
$mediaTrackCount = [uint32]0

try {
  [LibVlcEventSink]::Reset()

  foreach ($eventType in $eventTypes) {
    $attachResult = [LibVlcNative]::libvlc_event_attach($eventManager, $eventType, $callback, [IntPtr]::Zero)
    if ($attachResult -ne 0) {
      throw "libvlc_event_attach failed for event type $eventType with code $attachResult."
    }
  }

  $playResult = [LibVlcNative]::libvlc_media_player_play($player)
  if ($playResult -ne 0) {
    throw "libvlc_media_player_play failed with code $playResult."
  }

  $volumeResult = [LibVlcNative]::libvlc_audio_set_volume($player, 0)
  if ($volumeResult -ne 0) {
    throw "libvlc_audio_set_volume failed with code $volumeResult."
  }

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $trackDescriptions = [pscustomobject]@{ audio = @(); subtitles = @() }
  do {
    $trackDescriptions = Read-TrackDescriptions -Player $player
    $state = [LibVlcNative]::libvlc_media_player_get_state($player)
    $time = [LibVlcNative]::libvlc_media_player_get_time($player)

    if (($trackDescriptions.audio.Count -gt 0 -or $trackDescriptions.subtitles.Count -gt 0) -and ([LibVlcEventSink]::EsAdded -gt 0 -or [LibVlcEventSink]::EsSelected -gt 0 -or $time -gt 0)) {
      break
    }

    if ([LibVlcEventSink]::EncounteredError -gt 0 -or [LibVlcEventSink]::EndReached -gt 0) {
      break
    }

    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)

  try {
    $mediaTrackCount = [LibVlcNative]::libvlc_media_tracks_get($media, [ref]$mediaTracks)
  } catch {
    $mediaTracks = [IntPtr]::Zero
    $mediaTrackCount = 0
  }

  [pscustomobject]@{
    mrl = $Mrl
    state = [LibVlcNative]::libvlc_media_player_get_state($player)
    isPlaying = [LibVlcNative]::libvlc_media_player_is_playing($player)
    time = [LibVlcNative]::libvlc_media_player_get_time($player)
    title = [LibVlcNative]::libvlc_media_player_get_title($player)
    titleCount = [LibVlcNative]::libvlc_media_player_get_title_count($player)
    events = [pscustomobject]@{
      playing = [LibVlcEventSink]::Playing
      esAdded = [LibVlcEventSink]::EsAdded
      esSelected = [LibVlcEventSink]::EsSelected
      timeChanged = [LibVlcEventSink]::TimeChanged
      encounteredError = [LibVlcEventSink]::EncounteredError
      endReached = [LibVlcEventSink]::EndReached
      lastEventType = [LibVlcEventSink]::LastEventType
    }
    mediaTracks = @(Get-MediaTrackList -Tracks $mediaTracks -Count $mediaTrackCount)
    audio = $trackDescriptions.audio
    subtitles = $trackDescriptions.subtitles
  } | ConvertTo-Json -Depth 6
} finally {
  foreach ($eventType in $eventTypes) {
    [LibVlcNative]::libvlc_event_detach($eventManager, $eventType, $callback, [IntPtr]::Zero)
  }

  if ($mediaTracks -ne [IntPtr]::Zero -and $mediaTrackCount -gt 0) {
    [LibVlcNative]::libvlc_media_tracks_release($mediaTracks, $mediaTrackCount)
  }

  if ($player -ne [IntPtr]::Zero) {
    [LibVlcNative]::libvlc_media_player_stop($player)
    [LibVlcNative]::libvlc_media_player_release($player)
  }

  if ($media -ne [IntPtr]::Zero) {
    [LibVlcNative]::libvlc_media_release($media)
  }

  if ($instance -ne [IntPtr]::Zero) {
    [LibVlcNative]::libvlc_release($instance)
  }
}