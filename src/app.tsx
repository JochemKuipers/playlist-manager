// ============== Constants ==============

const DURATION_TOLERANCE_MS = 5000; // 5 seconds tolerance for duration comparison
const API_BATCH_SIZE = 50; // Spotify API batch size limit

// ============== URI Helpers ==============

function shouldAddToPlaylist(uris: string[]): boolean {
  if (!uris || uris.length === 0) return false;
  return Spicetify.URI.isPlaylistV1OrV2(uris[0]);
}

function shouldAddToLikedSongs(uris: string[]): boolean {
  if (!uris || uris.length === 0) return false;

  const uriObj = Spicetify.URI.fromString(uris[0]);
  const type = uriObj?.type;

  // Only show on the Liked Songs collection itself (spotify:collection:tracks)
  if (type === Spicetify.URI.Type.COLLECTION || type === "collection") {
    return uriObj?.category === "tracks";
  }

  return false;
}

function getPlaylistUri(uris: string[]): string | null {
  if (!uris || uris.length === 0) return null;
  return uris[0];
}

function getPlaylistIdFromUri(uri: string): string | null {
  const match = uri.match(/playlist[\/:]([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

function getArtistIdFromUri(uri: string): string | null {
  return uri.split(':').pop() ?? null;
}

// ============== Track Name Normalization ==============

function normalizeTrackName(name: string): string {
  let normalized = name.toLowerCase().trim();

  // Remove text in parentheses/brackets (e.g., "(Remastered)", "[Live]")
  normalized = normalized.replace(/\s*[\(\[].*?[\)\]]/g, "");

  // Remove common suffixes like " - remaster", " - live", etc.
  normalized = normalized.replace(
    /\s*-\s*(remaster(ed)?(\s*\d{2,4})?|live|mono|stereo|single version|radio edit).*$/i,
    ""
  );

  // Collapse multiple spaces
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

function makeTrackKey(name: string, durationMs: number | undefined): string {
  const normalizedName = normalizeTrackName(name);
  const safeDuration = typeof durationMs === "number" && !isNaN(durationMs) ? durationMs : 0;
  const durationBucket = Math.round(safeDuration / DURATION_TOLERANCE_MS);
  return `${normalizedName}::${durationBucket}`;
}

function isDurationWithinRange(duration1: number, duration2: number): boolean {
  return Math.abs(duration1 - duration2) <= DURATION_TOLERANCE_MS;
}

// ============== Types ==============

type PlaylistTrack = {
  uri: string;
  name: string;
  durationMs: number;
  artists: string[];
  isLocal: boolean;
  isExplicit: boolean;
  albumImageUrl?: string;
  index: number;
};

type DuplicateGroup = {
  tracks: PlaylistTrack[];
  displayName: string;
  displayArtist: string;
  displayImage?: string;
};

type ArtistAlbum = {
  id: string;
  name: string;
  date: string;
  albumType: string;
};

type ArtistTrack = {
  id: string;
  name: string;
  uri: string;
  albumId: string;
  albumName: string;
  trackNumber: number;
  durationMs: number;
};

// ============== Duplicate Detection ==============

function findDuplicates(tracks: PlaylistTrack[]): DuplicateGroup[] {
  if (!tracks || tracks.length === 0) return [];

  // Group tracks by normalized name (case-insensitive)
  const tracksByNormalizedName = new Map<string, PlaylistTrack[]>();

  for (const track of tracks) {
    const normalizedName = normalizeTrackName(track.name);
    const existing = tracksByNormalizedName.get(normalizedName) || [];
    existing.push(track);
    tracksByNormalizedName.set(normalizedName, existing);
  }

  // Filter to groups with more than one track
  const duplicatesGrouped: DuplicateGroup[] = [];
  for (const [, groupTracks] of tracksByNormalizedName) {
    if (groupTracks.length > 1) {
      duplicatesGrouped.push({
        tracks: groupTracks,
        displayName: groupTracks[0].name,
        displayArtist: groupTracks[0].artists.join(", "),
        displayImage: groupTracks[0].albumImageUrl,
      });
    }
  }

  // Then, filter for exact duplicates with same artists and similar duration
  return findExactDuplicates(duplicatesGrouped);
}

function findExactDuplicates(duplicatesGrouped: DuplicateGroup[]): DuplicateGroup[] {
  const result: DuplicateGroup[] = [];

  for (const group of duplicatesGrouped) {
    // Group by artists (case-insensitive)
    const tracksByArtists = new Map<string, PlaylistTrack[]>();

    for (const track of group.tracks) {
      const artistKey = track.artists.map(a => a.toLowerCase()).sort().join(",");
      const existing = tracksByArtists.get(artistKey) || [];
      existing.push(track);
      tracksByArtists.set(artistKey, existing);
    }

    // For each artist group, check duration similarity
    for (const [, artistTracks] of tracksByArtists) {
      if (artistTracks.length <= 1) continue;

      // Group by similar duration
      const durationGroups: PlaylistTrack[][] = [];

      for (const track of artistTracks) {
        let added = false;

        for (const durationGroup of durationGroups) {
          if (isDurationWithinRange(track.durationMs, durationGroup[0].durationMs)) {
            durationGroup.push(track);
            added = true;
            break;
          }
        }

        if (!added) {
          durationGroups.push([track]);
        }
      }

      // Add groups with multiple tracks to results
      for (const durationGroup of durationGroups) {
        if (durationGroup.length > 1) {
          result.push({
            tracks: durationGroup,
            displayName: durationGroup[0].name,
            displayArtist: durationGroup[0].artists.join(", "),
            displayImage: durationGroup[0].albumImageUrl,
          });
        }
      }
    }
  }

  return result;
}

function getTrackToKeepIndex(group: DuplicateGroup): number {
  // Default to first track (lowest playlist index due to sorting)
  let indexToKeep = 0;

  const hasLocalTracks = group.tracks.some(t => t.isLocal);
  const hasSpotifyTracks = group.tracks.some(t => !t.isLocal);

  // Prioritize Spotify tracks over local files
  if (hasLocalTracks && hasSpotifyTracks) {
    const spotifyIndex = group.tracks.findIndex(t => !t.isLocal);
    if (spotifyIndex !== -1) {
      indexToKeep = spotifyIndex;
    }
  }

  // Check for explicit tracks among Spotify tracks only
  // (local tracks don't have reliable explicit information)
  const spotifyTracks = group.tracks.filter(t => !t.isLocal);

  if (spotifyTracks.length > 0) {
    const hasExplicitTracks = spotifyTracks.some(t => t.isExplicit);
    const allTracksExplicit = spotifyTracks.every(t => t.isExplicit);

    // Prioritize explicit tracks if there's a mix
    if (hasExplicitTracks && !allTracksExplicit) {
      const explicitIndex = group.tracks.findIndex(t => !t.isLocal && t.isExplicit);
      if (explicitIndex !== -1) {
        indexToKeep = explicitIndex;
      }
    }
  }

  return indexToKeep;
}

// ============== API Functions ==============
async function fetchPlaylistTracks(uri: string): Promise<PlaylistTrack[]> {
  const res = await Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${uri}`, {
    limit: 9999999,
  });
  const filtered = res.items.filter((track: { isPlayable: any; }) => track.isPlayable);

  return filtered.map((track: any, index: number) => ({
    uri: track.uri,
    name: track.name,
    durationMs: track.duration_ms,
    artists: track.artists.map((a: any) => a.name).filter(Boolean),
    isLocal: track.uri.startsWith("spotify:local:"),
    isExplicit: track.is_explicit,
    albumImageUrl: track.album?.images?.[0]?.url,
    index,
  }));
}


async function getPlaylistData(playlistUri: string): Promise<any | null> {
  try {
    // Try Platform API first - should have metadata
    const metadata = await Spicetify.Platform.PlaylistAPI.getMetadata(playlistUri);
    if (metadata?.name) {
      return metadata;
    }
  } catch (error) {
    console.log("[INFO] Platform metadata API not available, trying alternatives:", error);
  }
}

async function fetchAllLikedSongsTracks(): Promise<PlaylistTrack[]> {
  const result: PlaylistTrack[] = [];

  try {
    const res = await Spicetify.CosmosAsync.get(
      "sp://core-collection/unstable/@/list/tracks/all?responseFormat=protobufJson"
    );

    if (!res?.item) {
      return result;
    }

    let trackIndex = 0;
    for (const item of res.item) {
      const trackMeta = item?.trackMetadata;
      if (!trackMeta) {
        trackIndex++;
        continue;
      }

      const uri = trackMeta.link;
      const name = trackMeta.name;
      const durationMs = trackMeta.length ?? 0;
      const artists = (trackMeta.artist ?? []).map((a: any) => a.name).filter(Boolean);
      const isLocal = uri?.startsWith("spotify:local:") ?? false;
      const isExplicit = trackMeta.isExplicit ?? false;
      const albumImageUrl = trackMeta.album?.image?.[0]?.fileUri;
      const isPlayable = trackMeta.playable ?? true;

      if (uri && name && isPlayable) {
        result.push({
          uri,
          name,
          durationMs,
          artists,
          isLocal,
          isExplicit,
          albumImageUrl,
          index: trackIndex,
        });
      }
      trackIndex++;
    }
  } catch (error) {
    console.error("[ERROR] Failed to fetch Liked Songs:", error);
  }

  return result;
}

async function removeTracksFromLikedSongs(trackUris: string[]): Promise<void> {
  // Use the LibraryAPI to remove tracks from Liked Songs
  for (let i = 0; i < trackUris.length; i += API_BATCH_SIZE) {
    const batch = trackUris.slice(i, i + API_BATCH_SIZE);

    try {
      // Use Spicetify's Platform LibraryAPI to unlike tracks
      await Spicetify.Platform.LibraryAPI.remove({ uris: batch });
    } catch (error) {
      console.error("[ERROR] Failed to remove tracks from Liked Songs:", error);
    }
  }
}

async function addTracksToPlaylist(playlistId: string, trackUris: string[]): Promise<void> {
  const playlistUri = `spotify:playlist:${playlistId}`;

  try {
    // Use Platform.PlaylistAPI for faster adding (handles batching internally)
    await Spicetify.Platform.PlaylistAPI.add(playlistUri, trackUris, { after: "end" });
    Spicetify.showNotification(`Adding ${trackUris.length} tracks…`);
  } catch (error) {
    console.error("[ERROR] Platform API failed:", error);
  }
}

async function removeTracksFromPlaylist(
  playlistId: string,
  tracksToRemove: { uri: string; positions: number[] }[]
): Promise<void> {
  const playlistUri = `spotify:playlist:${playlistId}`;

  try {
    // Use Platform.PlaylistAPI for faster removal
    // Convert to format expected by PlaylistAPI.remove
    const uidsToRemove = tracksToRemove.map(item => ({
      uri: item.uri,
      uid: item.positions[0].toString() // Use position as uid
    }));

    await Spicetify.Platform.PlaylistAPI.remove(playlistUri, uidsToRemove);
  } catch (error) {
    console.error("[ERROR] Platform API failed:", error);
  }
}

// ============== Main Actions ==============

async function cleanPlaylist(uris: string[]): Promise<void> {
  const playlistUri = getPlaylistUri(uris);
  if (!playlistUri) {
    console.error("[ERROR] No playlist URI found");
    Spicetify.showNotification("No playlist selected", true);
    return;
  }

  try {
    Spicetify.showNotification("Scanning playlist for duplicates…");

    const tracks = await fetchPlaylistTracks(playlistUri);

    if (tracks.length === 0) {
      Spicetify.showNotification("Playlist is empty", true);
      return;
    }

    const duplicateGroups = findDuplicates(tracks);

    if (duplicateGroups.length === 0) {
      Spicetify.showNotification("No duplicates found!");
      return;
    }

    // Collect tracks to remove (keep the best track from each group)
    const tracksToRemove: { uri: string; positions: number[] }[] = [];

    for (const group of duplicateGroups) {
      // Sort by playlist position to prefer keeping earlier tracks
      group.tracks.sort((a, b) => a.index - b.index);

      const keepIndex = getTrackToKeepIndex(group);
      const keptTrack = group.tracks[keepIndex];

      console.log(
        `[Duplicate] Keeping "${keptTrack.name}" ` +
        `(${keptTrack.isExplicit ? "explicit" : "clean"}, ` +
        `${keptTrack.isLocal ? "local" : "spotify"}), ` +
        `removing ${group.tracks.length - 1} duplicate(s)`
      );

      // Mark all other tracks for removal
      for (let i = 0; i < group.tracks.length; i++) {
        if (i !== keepIndex) {
          tracksToRemove.push({
            uri: group.tracks[i].uri,
            positions: [group.tracks[i].index],
          });
        }
      }
    }

    if (tracksToRemove.length === 0) {
      Spicetify.showNotification("No duplicates to remove!");
      return;
    }

    Spicetify.showNotification(`Found ${tracksToRemove.length} duplicate(s), removing…`);

    const playlistId = getPlaylistIdFromUri(playlistUri);
    if (!playlistId) {
      Spicetify.showNotification("Invalid playlist URI", true);
      return;
    }

    await removeTracksFromPlaylist(playlistId, tracksToRemove);

    Spicetify.showNotification(`Removed ${tracksToRemove.length} duplicate(s) from playlist!`);
  } catch (error) {
    console.error("[ERROR] Error cleaning playlist:", error);
    Spicetify.showNotification("Failed to clean playlist", true);
  }
}

async function cleanLikedSongs(): Promise<void> {
  try {
    Spicetify.showNotification("Scanning Liked Songs for duplicates…");

    const tracks = await fetchAllLikedSongsTracks();

    if (tracks.length === 0) {
      Spicetify.showNotification("Liked Songs is empty", true);
      return;
    }

    const duplicateGroups = findDuplicates(tracks);

    if (duplicateGroups.length === 0) {
      Spicetify.showNotification("No duplicates found in Liked Songs!");
      return;
    }

    // Collect track URIs to remove (keep the best track from each group)
    const trackUrisToRemove: string[] = [];

    for (const group of duplicateGroups) {
      // Sort by position to prefer keeping earlier tracks
      group.tracks.sort((a, b) => a.index - b.index);

      const keepIndex = getTrackToKeepIndex(group);
      const keptTrack = group.tracks[keepIndex];

      console.log(
        `[Duplicate] Keeping "${keptTrack.name}" ` +
        `(${keptTrack.isExplicit ? "explicit" : "clean"}, ` +
        `${keptTrack.isLocal ? "local" : "spotify"}), ` +
        `removing ${group.tracks.length - 1} duplicate(s)`
      );

      // Mark all other tracks for removal
      for (let i = 0; i < group.tracks.length; i++) {
        if (i !== keepIndex) {
          trackUrisToRemove.push(group.tracks[i].uri);
        }
      }
    }

    if (trackUrisToRemove.length === 0) {
      Spicetify.showNotification("No duplicates to remove!");
      return;
    }

    Spicetify.showNotification(`Found ${trackUrisToRemove.length} duplicate(s), removing…`);

    await removeTracksFromLikedSongs(trackUrisToRemove);

    Spicetify.showNotification(`Removed ${trackUrisToRemove.length} duplicate(s) from Liked Songs!`);
  } catch (error) {
    console.error("[ERROR] Error cleaning Liked Songs:", error);
    Spicetify.showNotification("Failed to clean Liked Songs", true);
  }
}

// ============== Artist Discovery ==============

function parseArtistsFromTitle(title: string): string[] {
  return title
    .split(" / ")
    .map(name => name.trim())
    .filter(name => name.length > 0);
}

async function searchArtist(artistName: string): Promise<string | null> {
  try {
    const result = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=10`
    );

    if (result?.artists?.items?.length > 0) {
      const normalizedQuery = artistName.trim().toLowerCase();

      // Try to find exact match first
      const exactMatch = result.artists.items.find(
        (artist: any) => artist.name.trim().toLowerCase() === normalizedQuery
      );

      return exactMatch?.uri ?? result.artists.items[0].uri;
    }
  } catch (error) {
    console.error(`[ERROR] Failed to search for artist: ${artistName}`, error);
  }

  return null;
}

async function getArtistDiscography(
  artistId: string,
): Promise<ArtistAlbum[]> {
  const discog: ArtistAlbum[] = [];
  const seenAlbumIds = new Set<string>();
  let offset = 0;
  let hasNextPage = true;
  const artistAlbumQuery = Spicetify.GraphQL.Definitions.queryArtistDiscographyAll;


  while (hasNextPage) {
    try {
      const response = await Spicetify.GraphQL.Request(artistAlbumQuery, {
        uri: `spotify:artist:${artistId}`,
        offset,
        limit: 50,
      });

      const items = response?.data?.artistUnion?.discography?.all?.items;
      if (!items || items.length === 0) break;

      for (const item of items) {
        const releases = item.releases?.items || [];
        for (const release of releases) {
          if (!seenAlbumIds.has(release.id)) {
            discog.push({
              id: release.id,
              name: release.name,
              date: release.date?.isoString || release.date?.year?.toString() || "",
              albumType: release.type || "album",
            });
            seenAlbumIds.add(release.id);
          }
        }
      }

      offset += 50;
      hasNextPage = items.length === 50;
    } catch (error) {
      console.error("[ERROR] GraphQL failed:", error);
      break;
    }
  }

  discog.sort((a, b) => a.date.localeCompare(b.date));
  return discog;
}

async function getTracksFromDiscography(discography: ArtistAlbum[]): Promise<ArtistTrack[]> {
  const tracks: ArtistTrack[] = [];
  const seenTrackIds = new Set<string>();

  for (const album of discography) {
    let offset = 0;
    const limit = 50;

    while (true) {
      const res = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/albums/${album.id}/tracks?limit=${limit}&offset=${offset}`,
      );

      const items = res?.items ?? [];
      if (items.length === 0) break;

      for (const t of items) {
        if (seenTrackIds.has(t.id)) continue;
        seenTrackIds.add(t.id);

        tracks.push({
          id: t.id,
          name: t.name,
          uri: t.uri,
          albumId: album.id,
          albumName: album.name,
          trackNumber: t.track_number,
          durationMs: t.duration_ms,
        });
      }

      if (!res.next) break;
      offset += limit;
    }
  }

  return tracks;
}

async function getArtistTracks(artistUri: string): Promise<ArtistTrack[]> {
  const artistId = getArtistIdFromUri(artistUri);
  if (!artistId) {
    console.error("[ERROR] Invalid artist URI");
    return [];
  }

  try {
    const discography = await getArtistDiscography(artistId);
    return await getTracksFromDiscography(discography);
  } catch (error) {
    console.error("[ERROR] Failed to fetch artist tracks:", error);
    return [];
  }
}

async function updatePlaylist(uris: string[]): Promise<void> {
  const playlistUri = getPlaylistUri(uris);
  if (!playlistUri) {
    console.error("[ERROR] No playlist URI found");
    Spicetify.showNotification("No playlist selected", true);
    return;
  }

  try {
    Spicetify.showNotification("Updating playlist… fetching playlist data");

    const playlist = await getPlaylistData(playlistUri);
    if (!playlist) {
      Spicetify.showNotification("Failed to fetch playlist data", true);
      return;
    }

    const playlistName = playlist.name || playlist.displayName || "";

    const artistNames = parseArtistsFromTitle(playlistName);

    if (artistNames.length === 0) {
      Spicetify.showNotification("No artists found in playlist title", true);
      return;
    }

    Spicetify.showNotification(`Found ${artistNames.length} artist(s)… searching on Spotify`);

    // Search for artists
    const artistUris: string[] = [];
    for (const artistName of artistNames) {
      const artistUri = await searchArtist(artistName);
      if (artistUri) {
        artistUris.push(artistUri);
      } else {
        console.warn(`[WARN] Could not find artist: ${artistName}`);
      }
    }

    if (artistUris.length === 0) {
      Spicetify.showNotification("Could not find any artists", true);
      return;
    }

    Spicetify.showNotification(`Found ${artistUris.length} artist profile(s)… loading discographies`);

    // Fetch all artist tracks
    const allArtistTracks: ArtistTrack[] = [];
    for (let i = 0; i < artistUris.length; i++) {
      Spicetify.showNotification(`Fetching tracks for artist ${i + 1}/${artistUris.length}…`);
      const tracks = await getArtistTracks(artistUris[i]);
      allArtistTracks.push(...tracks);
    }

    Spicetify.showNotification(`Fetched ${allArtistTracks.length} artist track(s)… reading playlist tracks`);

    // Get existing tracks
    const existingTracks = await fetchPlaylistTracks(playlistUri);

    Spicetify.showNotification(`Loaded ${existingTracks.length} existing playlist track(s)… comparing`);

    // Build lookup sets for existing tracks
    const existingTrackUris = new Set(existingTracks.map(t => t.uri));
    const existingTrackKeys = new Set(existingTracks.map(t => makeTrackKey(t.name, t.durationMs)));

    // Filter out tracks already in playlist
    const newTrackUris: string[] = [];
    const seenArtistTrackKeys = new Set<string>();

    for (const track of allArtistTracks) {
      if (!track.uri) continue;

      // Skip exact URI duplicates
      if (existingTrackUris.has(track.uri)) continue;

      // Build smart key based on normalized name + duration bucket
      const key = makeTrackKey(track.name, track.durationMs);

      // Skip if playlist already has an equivalent track or we've queued it
      if (existingTrackKeys.has(key) || seenArtistTrackKeys.has(key)) continue;

      seenArtistTrackKeys.add(key);
      newTrackUris.push(track.uri);
    }

    if (newTrackUris.length === 0) {
      Spicetify.showNotification("No new tracks to add – playlist already up to date");
      return;
    }

    const playlistId = getPlaylistIdFromUri(playlistUri);
    if (!playlistId) {
      Spicetify.showNotification("Invalid playlist URI", true);
      return;
    }

    await addTracksToPlaylist(playlistId, newTrackUris);

    Spicetify.showNotification(`Added ${newTrackUris.length} tracks to the playlist!`);
  } catch (error) {
    console.error("[ERROR] Error updating playlist:", error);
    Spicetify.showNotification("Failed to update playlist", true);
  }
}

// ============== Entry Point ==============

async function main(): Promise<void> {
  // Wait for Spicetify to be ready
  while (!Spicetify?.showNotification) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Register context menu items
  const cleanPlaylistItem = new Spicetify.ContextMenu.Item(
    "Clean Playlist",
    cleanPlaylist,
    shouldAddToPlaylist,
    "playlist"
  );

  const updatePlaylistItem = new Spicetify.ContextMenu.Item(
    "Update Playlist",
    updatePlaylist,
    shouldAddToPlaylist,
    "playlist"
  );

  const cleanLikedSongsItem = new Spicetify.ContextMenu.Item(
    "Clean Liked Songs",
    cleanLikedSongs,
    shouldAddToLikedSongs,
    "heart-active"
  );

  cleanPlaylistItem.register();
  updatePlaylistItem.register();
  cleanLikedSongsItem.register();
}

export default main;
