# DVD playback

Personal playback of one DVD title for one viewer.

## Language

**Title**: A playable sequence on a DVD, with its own duration and audio/subtitle choices.

**Playback session**: One selection of a disc, title, and track choices, lasting until it is stopped or replaced.

**Title time**: A position measured from the beginning of the DVD title, independent of a seek or recovery restart.

**Slot**: A fixed-duration interval of title time, containing generated media or a bad-sector placeholder.

**Playback region**: The contiguous run of available slots beginning at the viewer's most recent seek target.

**Generated range**: A contiguous interval of readable title content already produced for playback.

**Bad-sector placeholder**: Substitute media occupying an unreadable slot without shortening title time.

**Runway**: An estimate of playable time remaining before the viewer needs more content. Fresh playback feedback measures the contiguous buffer ahead of the playhead; a download estimate is the conservative fallback.

**Recovery epoch**: A run of media production whose timestamps share a common origin; a restart begins another epoch.

**HLS publication**: Making prepared playback content available through a manifest and its referenced media.

**Playback feedback**: A viewer report of title position, contiguous buffered content, playback rate and paused state, belonging to one Playback region.

**Recovery episode**: The ordered work of checking a suspected stall, collecting final content from a stopped producer, and deciding whether to retry a Slot or fill it.

**Mutation intent**: The current start, seek, track change, or stop request that is allowed to change a Playback session. A newer intent cancels any uncommitted work owned by an older one, including a start that has not yet become ready.

**Track change**: Replacing the audio or subtitle choice of a running Playback session; playback continues from the current Title time in a new Playback region.

**Active viewer**: The one player page that currently owns a Playback session. Another page opening the session stays passive — playing nothing and sending no Playback feedback — until its viewer confirms a takeover; the previous owner then becomes passive. An Active viewer that has sent no recent Playback feedback is gone, and a new page takes over without asking.
_Avoid_: client, tab, watcher

**Disc removal**: The disc leaving the drive, or being replaced by a different disc, while a Playback session depends on it. It ends the session; it is never treated as a bad sector.
_Avoid_: eject (the user action), disc error

**Drive busy**: The drive holds a disc but another program is preventing access to it.

**Resume point**: The Title time at which a Playback session ended because of Disc removal, offered when the same disc returns. Ordinary stops leave no Resume point.

**Disc identity**: The fingerprint that recognises a particular disc regardless of which drive holds it; the same disc always has the same identity and different discs never share one.
_Avoid_: disc ID derived from drive letter or title durations

**Unreadable stretch**: A run of consecutive bad-sector placeholders long enough that the viewer is asked whether to skip ahead, keep trying, or stop.

**Ended session**: A stopped Playback session that is still remembered, so its player page can say the stream ended rather than appear broken.

**Region manifest**: The immutable-identity HLS view for one Playback region. Its query-qualified URL is also the identity used to reject stale browser feedback and download evidence.
