function shouldAddToPlaylist(uris: string[]) {
  if (!uris || uris.length === 0) return false;

  const uri = uris[0];
  return Spicetify.URI.isPlaylistV1OrV2(uri);
}

function getPlaylistUri(uris: string[]): string | null {
  if (!uris || uris.length === 0) return null;
  return uris[0];
}

function getPlaylistIdFromUri(uri: string): string | null {
  const match = uri.match(/playlist[\/:]([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

function normalizeTrackName(name: string): string {
  let normalized = name.toLowerCase().trim();

  // Remove text in parentheses/brackets (e.g., " - 2006 Remaster", "(Remastered)")
  normalized = normalized.replace(/\s*[\(\[].*?[\)\]]/g, "");

  // Remove common suffixes like " - remaster", " - live", etc.
  normalized = normalized.replace(/\s*-\s*(remaster(ed)?(\s*\d{2,4})?|live|mono|stereo|single version).*$/i, "");

  // Collapse multiple spaces
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

// Build a "track key" using normalized name and coarse duration buckets,
function makeTrackKey(name: string, durationMs: number | undefined): string {
  const normalizedName = normalizeTrackName(name);
  const safeDuration = typeof durationMs === "number" && !isNaN(durationMs) ? durationMs : 0;

  // Bucket duration in ~3 second windows to allow small timing differences
  const durationBucket = Math.round(safeDuration / 3000);

  return `${normalizedName}::${durationBucket}`;
}

type PlaylistTrackInfo = {
  uri: string;
  name: string;
  durationMs: number;
};

async function fetchAllPlaylistTracks(playlistId: string): Promise<PlaylistTrackInfo[]> {
  const result: PlaylistTrackInfo[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const page = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}`
    );

    const items = page?.items ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      const trackObj =
        item?.track ||
        item?.playable ||
        item?.contextTrack ||
        item;

      const uri =
        item?.uri ||
        trackObj?.uri ||
        item?.trackUri;

      const name = trackObj?.name;
      const durationMs =
        trackObj?.duration_ms ??
        trackObj?.duration?.totalMilliseconds ??
        0;

      if (uri && name) {
        result.push({ uri, name, durationMs });
      }
    }

    if (!page.next) break;
    offset += limit;
  }

  return result;
}

async function getPlaylistData(playlistUri: string) {

  const playlistId = getPlaylistIdFromUri(playlistUri);

  if (!playlistId) {
    return null;
  }

  const result = await Spicetify.CosmosAsync.get(
    `https://api.spotify.com/v1/playlists/${playlistId}`
  );
  return result;
}

// Clean Playlist - Remove duplicates
async function cleanPlaylist(uris: string[]) {

  const playlistUri = getPlaylistUri(uris);
  if (!playlistUri) {
    console.error("[ERROR] No playlist URI found");
    Spicetify.showNotification("No playlist selected", true);
    return;
  }

  try {
    Spicetify.showNotification("Cleaning playlist...");

    const playlist = await getPlaylistData(playlistUri);

    if (!playlist) {
      Spicetify.showNotification("Failed to fetch playlist data", true);
      return;
    }


    Spicetify.showNotification("Playlist cleaned successfully!");
  } catch (error) {
    console.error("Error cleaning playlist:", error);
    Spicetify.showNotification("Failed to clean playlist", true);
  }
}

function parseArtistsFromTitle(title: string): string[] {
  return title.split(" / ").map(name => name.trim()).filter(name => name.length > 0);
}

async function searchArtist(artistName: string): Promise<string | null> {
  try {
    const searchLimit = 10;
    const result = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=${searchLimit}`
    );


    if (result?.artists?.items?.length > 0) {
      const normalizedQuery = artistName.trim().toLowerCase();
      const matchingArtist = result.artists.items.find(
        (artist: any) => artist.name.trim().toLowerCase() === normalizedQuery
      );
      if (matchingArtist) {
        return matchingArtist.uri;
      }
      return result.artists.items[0].uri;
    }
  } catch (error) {
    console.error(`Failed to search for artist: ${artistName}`, error);
  }
  return null;
}

async function getArtistDiscography(artistId: string): Promise<any[]> {

  const artistAlbumQuery = Spicetify.GraphQL.Definitions.queryArtistDiscographyAll;

  if (!artistAlbumQuery) {
    const includeGroups = 'album,single,appears_on';
    let discog: any[] = [];
    let offset = 0;
    const limit = 50;

    while (true) {
      const response = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=${includeGroups}&limit=${limit}&offset=${offset}`
      );

      for (const album of response.items) {
        let releaseDate = album.release_date.replace(/-/g, '');
        while (releaseDate.length < 8) {
          releaseDate += '0';
        }

        discog.push({
          id: album.id,
          name: album.name,
          date: releaseDate,
          album_type: album.album_type
        });
      }

      if (!response.next) break;
      offset += limit;
    }

    discog.sort((a, b) => a.date.localeCompare(b.date));
    return discog;
  }

  const discog: any[] = [];
  let hasNextPage = true;
  let offset = 0;
  const seenAlbumIds: Set<string> = new Set();

  while (hasNextPage) {
    const variables: any = {
      uri: `spotify:artist:${artistId}`,
      offset: offset,
      limit: 50
    };

    try {
      const response = await Spicetify.GraphQL.Request(artistAlbumQuery, variables);

      const items = response?.data?.artistUnion?.discography?.all?.items;
      if (!items || items.length === 0) break;

      for (const item of items) {
        const releases = item.releases?.items || [];
        for (const release of releases) {
          if (!seenAlbumIds.has(release.id)) {
            discog.push({
              id: release.id,
              name: release.name,
              date: release.date?.isoString || release.date?.year?.toString() || '',
              album_type: release.type || 'album'
            });
            seenAlbumIds.add(release.id);
          }
        }
      }

      offset += 50;
      hasNextPage = items.length === 50;
    } catch (error) {
      console.error("[ERROR] GraphQL failed, trying REST API:", error);
    }
  }

  discog.sort((a, b) => a.date.localeCompare(b.date));

  return discog;
}

type ArtistTrack = {
  id: string;
  name: string;
  uri: string;
  albumId: string;
  albumName: string;
  trackNumber: number;
  durationMs: number;
};

async function getTracksFromDiscography(
  discography: { id: string; name: string }[],
): Promise<ArtistTrack[]> {
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

async function getArtistTracks(
  artistUri: string,
): Promise<ArtistTrack[]> {

  const artistId = artistUri.split(':').pop();
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

async function updatePlaylist(uris: string[]) {

  const playlistUri = getPlaylistUri(uris);
  if (!playlistUri) {
    console.error("[ERROR] No playlist URI found");
    Spicetify.showNotification("No playlist selected", true);
    return;
  }

  try {
    Spicetify.showNotification("Updating playlist...");

    const playlist = await getPlaylistData(playlistUri);

    if (!playlist) {
      Spicetify.showNotification("Failed to fetch playlist data", true);
      return;
    }

    const playlistName = playlist.name || playlist.displayName;

    const artistNames = parseArtistsFromTitle(playlistName);

    if (artistNames.length === 0) {
      Spicetify.showNotification("No artists found in playlist title", true);
      return;
    }

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

    const allArtistTracks: ArtistTrack[] = [];
    for (const artistUri of artistUris) {
      const tracks = await getArtistTracks(artistUri);
      allArtistTracks.push(...tracks);
    }


    // Get existing tracks (URIs + names + durations) from playlist.
    const playlistId = getPlaylistIdFromUri(playlistUri);
    if (!playlistId) {
      console.error("[ERROR] Could not extract playlist ID from URI for reading existing tracks");
      Spicetify.showNotification("Failed to read playlist tracks – invalid playlist URI", true);
      return;
    }

    let existingTracks: PlaylistTrackInfo[] = [];
    try {
      existingTracks = await fetchAllPlaylistTracks(playlistId);
    } catch (err) {
      console.error("[ERROR] Failed to fetch full playlist tracks:", err);
      Spicetify.showNotification("Failed to read playlist tracks", true);
      return
    }

    const existingTrackUris = new Set<string>(existingTracks.map(t => t.uri));
    const existingTrackKeys = new Set<string>(
      existingTracks.map(t => makeTrackKey(t.name, t.durationMs)),
    );

    // 2. Filter out tracks already in playlist (by URI or by smart key)
    const newTrackUris: string[] = [];
    const seenArtistTrackKeys = new Set<string>();

    for (const track of allArtistTracks) {
      const uri = track.uri;
      if (!uri) continue;

      // Skip exact URI duplicates
      if (existingTrackUris.has(uri)) continue;

      // Build smart key based on normalized name + duration bucket,
      // mirroring the matching approach from SpotifyPlaylistUpdater
      const key = makeTrackKey(track.name, track.durationMs);

      // Skip if playlist already has an equivalent track or we've queued it already
      if (existingTrackKeys.has(key)) continue;
      if (seenArtistTrackKeys.has(key)) continue;

      seenArtistTrackKeys.add(key);
      newTrackUris.push(uri);
    }

    if (newTrackUris.length === 0) {
      Spicetify.showNotification("No new tracks to add – playlist already up to date");
      return;
    }

    // 3. Add missing tracks to playlist using CosmosAsync POST
    const chunkSize = 100;
    for (let i = 0; i < newTrackUris.length; i += chunkSize) {
      const chunk = newTrackUris.slice(i, i + chunkSize);
      try {
        await Spicetify.CosmosAsync.post(
          `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
          { uris: chunk },
        );
      } catch (error) {
        console.error("[ERROR] Failed to add tracks chunk to playlist:", error);
      }
    }

    Spicetify.showNotification(`Added ${newTrackUris.length} tracks to the playlist!`);
  } catch (error) {
    console.error("Error updating playlist:", error);
    Spicetify.showNotification("Failed to update playlist", true);
  }
}

async function main() {

  while (!Spicetify?.showNotification) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

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

  cleanPlaylistItem.register();
  updatePlaylistItem.register();

  Spicetify.showNotification("Playlist Manager loaded!");
}

export default main;
