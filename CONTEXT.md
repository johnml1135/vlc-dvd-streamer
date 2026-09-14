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
