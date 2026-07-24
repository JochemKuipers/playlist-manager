// ============== Constants ==============

const DURATION_TOLERANCE_MS = 5000; // 5 seconds tolerance for duration comparison
const API_BATCH_SIZE = 50; // Spotify API batch size limit

// ============== URI Helpers ==============

const LIKED_SONGS_PLAYLIST_IDS = new Set([
  // Desktop client sometimes exposes Liked Songs as this synthetic playlist.
  "37i9dQZF1F5p3rmiWPIYgZ",
]);

const OWNERSHIP_CACHE_TTL_MS = 15_000;

const ownedPlaylistUris = new Set<string>();
let ownershipCacheLoading: Promise<void> | null = null;
let ownershipCacheReady = false;
let ownershipFetchedAt = 0;

function ownershipCacheIsFresh(): boolean {
  return (
    ownershipCacheReady &&
    Date.now() - ownershipFetchedAt < OWNERSHIP_CACHE_TTL_MS
  );
}

type RootlistItem = {
  type?: string;
  uri?: string;
  isOwnedBySelf?: boolean;
  owner?: { username?: string; id?: string; uri?: string };
  items?: RootlistItem[];
};

function collectPlaylistsFromRootlist(items: RootlistItem[]): RootlistItem[] {
  const playlists: RootlistItem[] = [];
  for (const item of items ?? []) {
    if (!item) continue;
    if (item.type === "playlist" || item.type === "playlist_v2") {
      playlists.push(item);
      continue;
    }
    if (item.type === "folder" && Array.isArray(item.items)) {
      playlists.push(...collectPlaylistsFromRootlist(item.items));
    }
  }
  return playlists;
}

function isOwnedPlaylistForCurrentUser(
  playlist: RootlistItem,
  currentUser: string,
): boolean {
  if (playlist.isOwnedBySelf === true) return true;

  const owner = playlist.owner ?? {};
  const ownerUsername = String(owner.username ?? owner.id ?? "");
  const ownerUri = String(owner.uri ?? "");

  return (
    ownerUsername === currentUser || ownerUri === `spotify:user:${currentUser}`
  );
}

async function refreshOwnedPlaylistUris(force = false): Promise<void> {
  if (!force && ownershipCacheIsFresh()) return;
  if (ownershipCacheLoading) return ownershipCacheLoading;

  ownershipCacheLoading = (async () => {
    try {
      const currentUser = Spicetify.Platform.username;
      if (!currentUser) {
        ownershipCacheReady = true;
        ownershipFetchedAt = Date.now();
        return;
      }

      const rootlist = await Spicetify.Platform.RootlistAPI.getContents();
      const playlists = collectPlaylistsFromRootlist(rootlist?.items ?? []);

      ownedPlaylistUris.clear();
      for (const playlist of playlists) {
        if (
          playlist.uri &&
          isOwnedPlaylistForCurrentUser(playlist, currentUser)
        ) {
          ownedPlaylistUris.add(playlist.uri);
        }
      }
    } catch (error) {
      console.warn("[WARN] Failed to refresh owned playlist cache:", error);
    } finally {
      ownershipCacheReady = true;
      ownershipFetchedAt = Date.now();
      ownershipCacheLoading = null;
    }
  })();

  return ownershipCacheLoading;
}

function watchOwnedPlaylistChanges(): void {
  // ponytail: Platform event shapes vary by Spotify build; TTL covers the rest
  try {
    const rootlistApi = Spicetify.Platform?.RootlistAPI;
    const events =
      rootlistApi?.getEvents?.() ?? rootlistApi?._events ?? rootlistApi;
    const onUpdate = () => {
      void refreshOwnedPlaylistUris(true);
    };

    if (typeof events?.addListener === "function") {
      events.addListener("update", onUpdate);
      return;
    }
    if (typeof events?.on === "function") {
      events.on("update", onUpdate);
    }
  } catch (error) {
    console.warn("[WARN] Could not subscribe to rootlist updates:", error);
  }
}

function isLikedSongsUri(uri?: string): boolean {
  if (!uri) return false;
  if (uri === "spotify:collection:tracks") return true;
  if (uri.includes("collection/tracks")) return true;

  let uriObj: ReturnType<typeof Spicetify.URI.fromString> | null = null;
  try {
    uriObj = Spicetify.URI.fromString(uri);
  } catch {
    return false;
  }

  const type = uriObj?.type;

  if (type === Spicetify.URI.Type.COLLECTION || type === "collection") {
    return uriObj?.category === "tracks";
  }

  if (
    (type === Spicetify.URI.Type.PLAYLIST_V2 ||
      type === "playlist-v2" ||
      type === Spicetify.URI.Type.PLAYLIST ||
      type === "playlist") &&
    uriObj?.id
  ) {
    return LIKED_SONGS_PLAYLIST_IDS.has(uriObj.id);
  }

  return false;
}

function shouldAddToPlaylist(
  uris: string[],
  _uids?: string[],
  contextUri?: string,
): boolean {
  const targetUri = contextUri ?? uris?.[0];
  if (!targetUri) return false;
  if (isLikedSongsUri(targetUri)) return false;
  if (!Spicetify.URI.isPlaylistV1OrV2(targetUri)) return false;

  if (!ownershipCacheIsFresh()) {
    void refreshOwnedPlaylistUris();
  }

  // Optimistic while warming/refreshing; actions re-check ownership.
  if (!ownershipCacheReady || !ownershipCacheIsFresh()) return true;
  return ownedPlaylistUris.has(targetUri);
}

async function ensureOwnedPlaylist(playlistUri: string): Promise<boolean> {
  if (!ownershipCacheIsFresh()) {
    await refreshOwnedPlaylistUris();
  }
  return ownedPlaylistUris.has(playlistUri);
}

function shouldAddToLikedSongs(
  uris: string[],
  _uids?: string[],
  contextUri?: string,
): boolean {
  // Spotify context payloads are inconsistent across surfaces; check all candidates.
  if (isLikedSongsUri(contextUri)) return true;
  for (const uri of uris ?? []) {
    if (isLikedSongsUri(uri)) return true;
  }
  return false;
}

function getPlaylistUri(uris: string[]): string | null {
  if (!uris || uris.length === 0) return null;
  return uris[0];
}

function getPlaylistIdFromUri(uri: string): string | null {
  const match = uri.match(/playlist[/:]([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

function getArtistIdFromUri(uri: string): string | null {
  return uri.split(":").pop() ?? null;
}

// ============== Track Name Normalization ==============

function normalizeTrackName(name: string): string {
  let normalized = name.toLowerCase().trim();

  // Remove text in parentheses/brackets (e.g., "(Remastered)", "[Live]")
  normalized = normalized.replace(/\s*[([].*?[)\]]/g, "");

  // Remove common suffixes like " - remaster", " - live", etc.
  normalized = normalized.replace(
    /\s*-\s*(remaster(ed)?(\s*\d{2,4})?|live|mono|stereo|single version|radio edit).*$/i,
    "",
  );

  // Collapse multiple spaces
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

function isDurationWithinRange(
  duration1: number | undefined,
  duration2: number | undefined,
): boolean {
  const d1 = Number.isFinite(duration1) ? Number(duration1) : null;
  const d2 = Number.isFinite(duration2) ? Number(duration2) : null;

  // Missing duration ⇒ no match (avoids deleting unrelated same-name tracks).
  if (d1 === null || d2 === null) return false;

  return Math.abs(d1 - d2) <= DURATION_TOLERANCE_MS;
}

function normalizeDuration(durationMs: number | undefined): number | null {
  if (typeof durationMs === "number" && !Number.isNaN(durationMs)) {
    return durationMs;
  }
  return null;
}

function hasDurationMatch(
  map: Map<string, Array<number | null>>,
  normalizedName: string,
  duration: number | null,
): boolean {
  const durations = map.get(normalizedName);
  if (!durations) return false;

  for (const existingDuration of durations) {
    if (existingDuration === null || duration === null) continue;
    if (Math.abs(existingDuration - duration) <= DURATION_TOLERANCE_MS)
      return true;
  }

  return false;
}

function addDurationEntry(
  map: Map<string, Array<number | null>>,
  normalizedName: string,
  duration: number | null,
): void {
  const durations = map.get(normalizedName) ?? [];
  durations.push(duration);
  map.set(normalizedName, durations);
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
  uid?: string;
  rowId?: string;
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

function findExactDuplicates(
  duplicatesGrouped: DuplicateGroup[],
): DuplicateGroup[] {
  const result: DuplicateGroup[] = [];

  for (const group of duplicatesGrouped) {
    // Group by artists (case-insensitive)
    const tracksByArtists = new Map<string, PlaylistTrack[]>();

    for (const track of group.tracks) {
      const artistKey = track.artists
        .map((a) => a.toLowerCase())
        .sort()
        .join(",");
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
          if (
            isDurationWithinRange(track.durationMs, durationGroup[0].durationMs)
          ) {
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

  const hasLocalTracks = group.tracks.some((t) => t.isLocal);
  const hasSpotifyTracks = group.tracks.some((t) => !t.isLocal);

  // Prioritize Spotify tracks over local files
  if (hasLocalTracks && hasSpotifyTracks) {
    const spotifyIndex = group.tracks.findIndex((t) => !t.isLocal);
    if (spotifyIndex !== -1) {
      indexToKeep = spotifyIndex;
    }
  }

  // Check for explicit tracks among Spotify tracks only
  // (local tracks don't have reliable explicit information)
  const spotifyTracks = group.tracks.filter((t) => !t.isLocal);

  if (spotifyTracks.length > 0) {
    const hasExplicitTracks = spotifyTracks.some((t) => t.isExplicit);
    const allTracksExplicit = spotifyTracks.every((t) => t.isExplicit);

    // Prioritize explicit tracks if there's a mix
    if (hasExplicitTracks && !allTracksExplicit) {
      const explicitIndex = group.tracks.findIndex(
        (t) => !t.isLocal && t.isExplicit,
      );
      if (explicitIndex !== -1) {
        indexToKeep = explicitIndex;
      }
    }
  }

  return indexToKeep;
}

// ============== API Functions ==============
async function fetchPlaylistTracks(uri: string): Promise<PlaylistTrack[]> {
  // Ensure we have a proper playlist URI format
  const playlistUri = uri.startsWith("spotify:playlist:")
    ? uri
    : `spotify:playlist:${uri}`;

  const res = await Spicetify.Platform.PlaylistAPI.getContents(playlistUri, {
    limit: -1,
  });
  type RawTrack = {
    isPlayable?: boolean;
    uri: string;
    name: string;
    duration_ms?: number;
    artists?: Array<{ name?: string }>;
    is_explicit?: boolean;
    album?: { images?: Array<{ url?: string }> };
    uid?: string;
    rowId?: string;
    rowid?: string;
  };

  const filtered = (res.items as RawTrack[]).filter(
    (track) => track.isPlayable,
  );

  return filtered.map((track, index) => ({
    uri: track.uri,
    name: track.name,
    durationMs: track.duration_ms ?? 0,
    artists: (track.artists ?? [])
      .map((a) => a.name)
      .filter((n): n is string => Boolean(n)),
    isLocal: track.uri.startsWith("spotify:local:"),
    isExplicit: track.is_explicit ?? false,
    albumImageUrl: track.album?.images?.[0]?.url,
    uid: track.uid ?? track.rowId ?? track.rowid,
    rowId: track.rowId ?? track.rowid,
    index,
  }));
}

async function getPlaylistData(
  playlistUri: string,
): Promise<{ name?: string; displayName?: string } | null> {
  try {
    const metadata =
      await Spicetify.Platform.PlaylistAPI.getMetadata(playlistUri);
    if (metadata?.name) {
      return metadata;
    }
  } catch (error) {
    console.log(
      "[INFO] Platform metadata API not available, trying alternatives:",
      error,
    );
  }
  return null;
}

async function fetchAllLikedSongsTracks(): Promise<PlaylistTrack[]> {
  const result: PlaylistTrack[] = [];

  try {
    const res = await Spicetify.CosmosAsync.get(
      "sp://core-collection/unstable/@/list/tracks/all?responseFormat=protobufJson",
    );

    if (!res?.item) {
      return result;
    }

    let trackIndex = 0;
    for (const item of res.item) {
      const trackMeta = item?.trackMetadata as
        | {
            link?: string;
            name?: string;
            length?: number;
            artist?: Array<{ name?: string }>;
            isExplicit?: boolean;
            album?: { image?: Array<{ fileUri?: string }> };
            playable?: boolean;
          }
        | undefined;
      if (!trackMeta) {
        trackIndex++;
        continue;
      }

      const uri = trackMeta.link;
      const name = trackMeta.name;
      const durationMs = trackMeta.length ?? 0;
      const artists = (trackMeta.artist ?? [])
        .map((a) => a.name)
        .filter((n): n is string => Boolean(n));
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

async function removeTracksFromLikedSongs(
  trackUris: string[],
): Promise<number> {
  let removedCount = 0;

  for (let i = 0; i < trackUris.length; i += API_BATCH_SIZE) {
    const batch = trackUris.slice(i, i + API_BATCH_SIZE);

    try {
      await Spicetify.Platform.LibraryAPI.remove({ uris: batch });
      removedCount += batch.length;
    } catch (error) {
      console.error("[ERROR] Failed to remove tracks from Liked Songs:", error);
    }
  }

  return removedCount;
}

async function addTracksToPlaylist(
  playlistId: string,
  trackUris: string[],
): Promise<boolean> {
  const playlistUri = `spotify:playlist:${playlistId}`;

  try {
    await Spicetify.Platform.PlaylistAPI.add(playlistUri, trackUris, {
      after: "end",
    });
    return true;
  } catch (error) {
    console.error("[ERROR] Platform API failed:", error);
    return false;
  }
}

async function removeTracksFromPlaylist(
  playlistId: string,
  tracksToRemove: {
    uri: string;
    uid?: string;
    rowId?: string;
    index?: number;
  }[],
): Promise<number> {
  const playlistUri = `spotify:playlist:${playlistId}`;

  try {
    // Resolve removable entries against a fresh playlist snapshot.
    // This avoids failing the entire request due to stale/invalid row IDs.
    const latestTracks = await fetchPlaylistTracks(playlistUri);
    const latestUidsByUri = new Map<string, string[]>();
    for (const track of latestTracks) {
      if (!track.uid) continue;
      const list = latestUidsByUri.get(track.uri) ?? [];
      list.push(track.uid);
      latestUidsByUri.set(track.uri, list);
    }

    const uidsToRemove: { uri: string; uid: string }[] = [];
    const seen = new Set<string>();

    for (const item of tracksToRemove) {
      const candidates = latestUidsByUri.get(item.uri);
      if (!candidates || candidates.length === 0) {
        console.warn(
          `[WARN] Skipping removal for ${item.uri} because no matching uid exists in latest playlist state`,
        );
        continue;
      }

      const nextUid = candidates.shift();
      if (!nextUid) continue;
      if (seen.has(nextUid)) continue;

      seen.add(nextUid);
      uidsToRemove.push({ uri: item.uri, uid: nextUid });
    }

    if (uidsToRemove.length === 0) {
      console.warn("[WARN] No removable items with valid uid");
      return 0;
    }

    let removedCount = 0;
    for (let i = 0; i < uidsToRemove.length; i += API_BATCH_SIZE) {
      const batch = uidsToRemove.slice(i, i + API_BATCH_SIZE);
      try {
        await Spicetify.Platform.PlaylistAPI.remove(playlistUri, batch);
        removedCount += batch.length;
      } catch (batchError) {
        console.warn(
          "[WARN] Batch remove failed, retrying individually:",
          batchError,
        );
        for (const item of batch) {
          try {
            await Spicetify.Platform.PlaylistAPI.remove(playlistUri, [item]);
            removedCount += 1;
          } catch (singleError) {
            console.warn(
              `[WARN] Failed to remove ${item.uri} (${item.uid})`,
              singleError,
            );
          }
        }
      }
    }

    return removedCount;
  } catch (error) {
    console.error("[ERROR] Platform API failed:", error);
    return 0;
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

  if (!(await ensureOwnedPlaylist(playlistUri))) {
    Spicetify.showNotification("You can only clean playlists you own", true);
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
    const tracksToRemove: {
      uri: string;
      uid?: string;
      rowId?: string;
      index?: number;
    }[] = [];

    for (const group of duplicateGroups) {
      // Sort by playlist position to prefer keeping earlier tracks
      group.tracks.sort((a, b) => a.index - b.index);

      const keepIndex = getTrackToKeepIndex(group);
      const keptTrack = group.tracks[keepIndex];

      console.log(
        `[Duplicate] Keeping "${keptTrack.name}" ` +
          `(${keptTrack.isExplicit ? "explicit" : "clean"}, ` +
          `${keptTrack.isLocal ? "local" : "spotify"}), ` +
          `removing ${group.tracks.length - 1} duplicate(s)`,
      );

      // Mark all other tracks for removal
      for (let i = 0; i < group.tracks.length; i++) {
        if (i !== keepIndex) {
          tracksToRemove.push({
            uri: group.tracks[i].uri,
            uid: group.tracks[i].uid,
            rowId: group.tracks[i].rowId,
            index: group.tracks[i].index,
          });
        }
      }
    }

    if (tracksToRemove.length === 0) {
      Spicetify.showNotification("No duplicates to remove!");
      return;
    }

    Spicetify.showNotification(
      `Found ${tracksToRemove.length} duplicate(s), removing…`,
    );

    const playlistId = getPlaylistIdFromUri(playlistUri);
    if (!playlistId) {
      Spicetify.showNotification("Invalid playlist URI", true);
      return;
    }

    const removedCount = await removeTracksFromPlaylist(
      playlistId,
      tracksToRemove,
    );
    if (removedCount === 0) {
      Spicetify.showNotification(
        "No duplicates were removed (possibly changed playlist state)",
        true,
      );
      return;
    }

    if (removedCount < tracksToRemove.length) {
      Spicetify.showNotification(
        `Removed ${removedCount}/${tracksToRemove.length} duplicate(s) from playlist`,
      );
      return;
    }

    Spicetify.showNotification(
      `Removed ${removedCount} duplicate(s) from playlist!`,
    );
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
          `removing ${group.tracks.length - 1} duplicate(s)`,
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

    Spicetify.showNotification(
      `Found ${trackUrisToRemove.length} duplicate(s), removing…`,
    );

    const removedCount = await removeTracksFromLikedSongs(trackUrisToRemove);
    if (removedCount === 0) {
      Spicetify.showNotification(
        "No duplicates were removed from Liked Songs",
        true,
      );
      return;
    }
    if (removedCount < trackUrisToRemove.length) {
      Spicetify.showNotification(
        `Removed ${removedCount}/${trackUrisToRemove.length} duplicate(s) from Liked Songs`,
      );
      return;
    }

    Spicetify.showNotification(
      `Removed ${removedCount} duplicate(s) from Liked Songs!`,
    );
  } catch (error) {
    console.error("[ERROR] Error cleaning Liked Songs:", error);
    Spicetify.showNotification("Failed to clean Liked Songs", true);
  }
}

// ============== Artist Discovery ==============

function parseArtistsFromTitle(title: string): string[] {
  return title
    .split(" / ")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

async function searchArtist(artistName: string): Promise<string | null> {
  const normalizedQuery = artistName.trim().toLowerCase();

  type ArtistHit = { profile?: { name?: string }; uri?: string };

  const pickUri = (items: unknown[]): string | null => {
    const candidates = items
      .map((item) => {
        const record = item as { data?: ArtistHit } & ArtistHit;
        return record?.data ?? record;
      })
      .filter(Boolean) as ArtistHit[];

    if (candidates.length === 0) return null;
    const exact = candidates.find(
      (artist) =>
        artist?.profile?.name?.trim?.().toLowerCase() === normalizedQuery,
    );
    return exact?.uri ?? candidates[0]?.uri ?? null;
  };

  // First, try searchArtists
  try {
    const def = Spicetify.GraphQL.Definitions.searchArtists;
    const response = await Spicetify.GraphQL.Request(def, {
      searchTerm: artistName,
      limit: 10,
      offset: 0,
    });

    const items =
      response?.data?.searchV2?.artists?.items ??
      response?.data?.search?.artists?.items ??
      [];

    const foundUri = pickUri(items);
    if (foundUri) return foundUri;
  } catch (error) {
    console.warn(
      `[WARN] GraphQL searchArtists failed for ${artistName}:`,
      error,
    );
  }

  // If searchArtists fails, try searchDesktop as a fallback
  try {
    const def = Spicetify.GraphQL.Definitions.searchDesktop;
    const response = await Spicetify.GraphQL.Request(def, {
      searchTerm: artistName,
      offset: 0,
      limit: 10,
      numberOfTopResults: 5,
      includeArtistHasConcertsField: false,
      includeAudiobooks: false,
      includeAuthors: false,
      includePreReleases: false,
    });

    const items =
      response?.data?.searchV2?.artists?.items ??
      response?.data?.search?.artists?.items ??
      [];

    const foundUri = pickUri(items);
    if (foundUri) return foundUri;
  } catch (error) {
    console.warn(
      `[WARN] GraphQL searchDesktop failed for ${artistName}:`,
      error,
    );
  }

  return null;
}

async function getArtistDiscography(artistId: string): Promise<ArtistAlbum[]> {
  const discog: ArtistAlbum[] = [];
  const seenAlbumIds = new Set<string>();
  let offset = 0;
  let hasNextPage = true;
  const artistAlbumQuery =
    Spicetify.GraphQL.Definitions.queryArtistDiscographyAll;

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
              date:
                release.date?.isoString || release.date?.year?.toString() || "",
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

async function getTracksFromDiscography(
  discography: ArtistAlbum[],
): Promise<ArtistTrack[]> {
  const tracks: ArtistTrack[] = [];
  const seenTrackIds = new Set<string>();

  type RawAlbumTrack = {
    duration?: { totalMilliseconds?: number };
    durationMs?: number;
    duration_ms?: number;
    uri?: string;
    name?: string;
    trackNumber?: number;
    track_number?: number;
  };

  const getDurationMs = (track: RawAlbumTrack): number | null => {
    const raw =
      track?.duration?.totalMilliseconds ??
      track?.durationMs ??
      track?.duration_ms;
    if (typeof raw === "number" && !Number.isNaN(raw) && raw > 0) return raw;
    return null;
  };

  for (const album of discography) {
    const queryAlbumTracks = Spicetify.GraphQL?.Definitions?.queryAlbumTracks;
    if (!queryAlbumTracks) continue;

    let offset = 0;
    let hasNextPage = true;

    while (hasNextPage) {
      try {
        const { data, errors } = await Spicetify.GraphQL.Request(
          queryAlbumTracks,
          {
            uri: `spotify:album:${album.id}`,
            offset,
            limit: 50,
          },
        );

        if (errors) {
          throw new Error(errors[0]?.message || "GraphQL error");
        }

        const items =
          data?.albumUnion?.tracksV2?.items ||
          data?.albumUnion?.tracks?.items ||
          [];
        if (!items.length) break;

        for (const item of items) {
          const track = (item.track || item) as RawAlbumTrack;

          const trackId = track.uri ? track.uri.split(":").pop() : null;
          if (!trackId || seenTrackIds.has(trackId)) continue;
          seenTrackIds.add(trackId);

          const durationMs = getDurationMs(track);
          if (!durationMs) {
            console.warn(
              `[WARN] Skipping track without duration: ${track.name} (${track.uri})`,
            );
            continue;
          }

          tracks.push({
            id: trackId,
            name: track.name ?? "",
            uri: track.uri ?? "",
            albumId: album.id,
            albumName: album.name,
            trackNumber: track.trackNumber || track.track_number || 0,
            durationMs,
          });
        }

        offset += items.length;
        hasNextPage = items.length === 50;
      } catch (error) {
        console.error(`[ERROR] GraphQL failed for album ${album.id}:`, error);
        break;
      }
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
    const tracks = await getTracksFromDiscography(discography);
    return tracks;
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

  if (!(await ensureOwnedPlaylist(playlistUri))) {
    Spicetify.showNotification("You can only update playlists you own", true);
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

    Spicetify.showNotification(
      `Found ${artistNames.length} artist(s)… searching on Spotify`,
    );

    const artistResults = await Promise.all(
      artistNames.map((name) => searchArtist(name)),
    );
    const artistUris = artistResults.filter((uri): uri is string =>
      Boolean(uri),
    );
    for (let i = 0; i < artistNames.length; i++) {
      if (!artistResults[i]) {
        console.warn(`[WARN] Could not find artist: ${artistNames[i]}`);
      }
    }

    if (artistUris.length === 0) {
      Spicetify.showNotification("Could not find any artists", true);
      return;
    }

    Spicetify.showNotification(
      `Found ${artistUris.length} artist profile(s)… loading discographies`,
    );

    const trackBatches = await Promise.all(
      artistUris.map((uri) => getArtistTracks(uri)),
    );
    const allArtistTracks = trackBatches.flat();

    Spicetify.showNotification(
      `Fetched ${allArtistTracks.length} artist track(s)… reading playlist tracks`,
    );

    // Get existing tracks
    const existingTracks = await fetchPlaylistTracks(playlistUri);

    Spicetify.showNotification(
      `Loaded ${existingTracks.length} existing playlist track(s)… comparing`,
    );

    // Build lookup sets for existing tracks
    const existingTrackUris = new Set(existingTracks.map((t) => t.uri));
    const existingTracksByName = new Map<string, Array<number | null>>();

    for (const track of existingTracks) {
      const normalizedName = normalizeTrackName(track.name);
      const duration = normalizeDuration(track.durationMs);
      addDurationEntry(existingTracksByName, normalizedName, duration);
    }

    // Filter out tracks already in playlist
    const newTrackUris: string[] = [];
    const pendingTracksByName = new Map<string, Array<number | null>>();

    for (const track of allArtistTracks) {
      if (!track.uri) continue;

      // Skip exact URI duplicates
      if (existingTrackUris.has(track.uri)) continue;

      const normalizedName = normalizeTrackName(track.name);
      const duration = normalizeDuration(track.durationMs);

      // Skip if playlist already has an equivalent track (name + duration tolerance)
      if (hasDurationMatch(existingTracksByName, normalizedName, duration))
        continue;

      // Skip if we already plan to add an equivalent track in this update
      if (hasDurationMatch(pendingTracksByName, normalizedName, duration))
        continue;

      addDurationEntry(pendingTracksByName, normalizedName, duration);
      newTrackUris.push(track.uri);
    }

    if (newTrackUris.length === 0) {
      Spicetify.showNotification(
        "No new tracks to add – playlist already up to date",
      );
      return;
    }

    const playlistId = getPlaylistIdFromUri(playlistUri);
    if (!playlistId) {
      Spicetify.showNotification("Invalid playlist URI", true);
      return;
    }

    Spicetify.showNotification(`Adding ${newTrackUris.length} tracks…`);
    const added = await addTracksToPlaylist(playlistId, newTrackUris);
    if (!added) {
      Spicetify.showNotification("Failed to add tracks to playlist", true);
      return;
    }

    Spicetify.showNotification(
      `Added ${newTrackUris.length} tracks to the playlist!`,
    );
  } catch (error) {
    console.error("[ERROR] Error updating playlist:", error);
    Spicetify.showNotification("Failed to update playlist", true);
  }
}

// ============== Entry Point ==============

async function main(): Promise<void> {
  // Wait for Spicetify to be ready
  while (!Spicetify?.showNotification) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Warm ownership cache and keep it current.
  await refreshOwnedPlaylistUris(true);
  watchOwnedPlaylistChanges();

  // Register context menu items
  const cleanPlaylistItem = new Spicetify.ContextMenu.Item(
    "Clean Playlist",
    cleanPlaylist,
    shouldAddToPlaylist,
    "playlist",
  );

  const updatePlaylistItem = new Spicetify.ContextMenu.Item(
    "Update Playlist",
    updatePlaylist,
    shouldAddToPlaylist,
    "playlist",
  );

  const cleanLikedSongsItem = new Spicetify.ContextMenu.Item(
    "Clean Liked Songs",
    cleanLikedSongs,
    shouldAddToLikedSongs,
    "heart-active",
  );

  cleanPlaylistItem.register();
  updatePlaylistItem.register();
  cleanLikedSongsItem.register();
}

void main();
