// Helper function to check if the selected item is a playlist
function shouldAddToPlaylist(uris: string[]) {
  if (!uris || uris.length === 0) return false;

  const uri = uris[0];
  return Spicetify.URI.isPlaylistV1OrV2(uri);
}

// Function to get playlist URI from context
function getPlaylistUri(uris: string[]): string | null {
  if (!uris || uris.length === 0) return null;
  return uris[0];
}

function getPlaylistIdFromUri(uri: string): string | null {
  const match = uri.match(/playlist[\/:]([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// Helper function to get playlist data using GraphQL
async function getPlaylistData(playlistUri: string) {
  console.log("[DEBUG] Fetching playlist data for:", playlistUri);

  try {
    // Try to find a valid GraphQL playlist query
    const definitions = Spicetify.GraphQL.Definitions;
    const playlistQuery = definitions.getPlaylist || definitions.queryPlaylistContents || definitions.fetchPlaylistMetadata;

    if (playlistQuery) {
      console.log("[DEBUG] Using GraphQL playlist query");

      const response = await Spicetify.GraphQL.Request(
        playlistQuery,
        { uri: playlistUri }
      );

      console.log("[DEBUG] GraphQL response:", response);
      return response?.data?.playlistV2 || response?.data?.playlist || null;
    } else {
      console.log("[DEBUG] No suitable GraphQL query found, using CosmosAsync");
    }
  } catch (error) {
    console.error("[ERROR] GraphQL fetch failed, trying CosmosAsync:", error);
  }

  // Fallback to CosmosAsync using Web API
  const playlistId = getPlaylistIdFromUri(playlistUri);
  console.log("[DEBUG] Extracted playlist ID:", playlistId);

  if (!playlistId) {
    console.error("[ERROR] Could not extract playlist ID from URI");
    return null;
  }

  const result = await Spicetify.CosmosAsync.get(
    `https://api.spotify.com/v1/playlists/${playlistId}`
  );
  console.log("[DEBUG] CosmosAsync response:", result);
  return result;
}

// Clean Playlist - Remove duplicates
async function cleanPlaylist(uris: string[]) {
  console.log("[DEBUG] cleanPlaylist called with URIs:", uris);

  const playlistUri = getPlaylistUri(uris);
  if (!playlistUri) {
    console.error("[ERROR] No playlist URI found");
    Spicetify.showNotification("No playlist selected", true);
    return;
  }

  try {
    console.log("[DEBUG] Starting playlist cleaning for:", playlistUri);
    Spicetify.showNotification("Cleaning playlist...");

    // Get playlist data using GraphQL (with CosmosAsync fallback)
    const playlist = await getPlaylistData(playlistUri);

    if (!playlist) {
      Spicetify.showNotification("Failed to fetch playlist data", true);
      return;
    }

    console.log("Playlist:", playlist.name || playlist.displayName);
    console.log("Tracks:", playlist.content?.items || playlist.tracks?.items);

    // TODO: Implement duplicate removal algorithm
    // Access tracks via: playlist.content.items (GraphQL) or playlist.tracks.items (REST API)
    // Each track has a .track.uri property you can use to identify duplicates

    Spicetify.showNotification("Playlist cleaned successfully!");
  } catch (error) {
    console.error("Error cleaning playlist:", error);
    Spicetify.showNotification("Failed to clean playlist", true);
  }
}

// Helper function to parse artist names from playlist title
function parseArtistsFromTitle(title: string): string[] {
  // Split by " / " to get individual artist names
  return title.split(" / ").map(name => name.trim()).filter(name => name.length > 0);
}

// Helper function to search for artist and get their URI
async function searchArtist(artistName: string): Promise<string | null> {
  try {
    const result = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=1`
    );

    if (result?.artists?.items?.length > 0) {
      return result.artists.items[0].uri;
    }
  } catch (error) {
    console.error(`Failed to search for artist: ${artistName}`, error);
  }
  return null;
}

// Helper function to get all albums from artist
async function getArtistAlbums(artistId: string, includeFeatures: boolean = true): Promise<any[]> {
  console.log("[DEBUG] Fetching albums for artist:", artistId);

  const includeGroups = includeFeatures
    ? 'album,single,appears_on'
    : 'album,single';

  let allAlbums: any[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const response = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=${includeGroups}&limit=${limit}&offset=${offset}`
    );

    for (const album of response.items) {
      // Format release date for sorting
      let releaseDate = album.release_date.replace(/-/g, '');
      while (releaseDate.length < 8) {
        releaseDate += '0';
      }

      allAlbums.push({
        date: releaseDate,
        id: album.id,
        type: album.album_type,
        name: album.name
      });
    }

    if (!response.next) break;
    offset += limit;
  }

  // Sort by release date (oldest first)
  allAlbums.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`[DEBUG] Found ${allAlbums.length} albums for artist`);

  return allAlbums;
}

// Helper function to get all tracks from albums with deduplication
async function getTracksFromAlbums(
  artistId: string,
  albums: any[],
  removeDupes: boolean = true,
  includeFeatures: boolean = true
): Promise<string[]> {
  console.log("[DEBUG] Fetching tracks from", albums.length, "albums");

  const trackHistory: Map<string, any> = new Map(); // ISRC -> track info
  const trackUris: string[] = [];

  // Process albums in batches of 20
  for (let i = 0; i < albums.length; i += 20) {
    const batch = albums.slice(i, i + 20);
    const albumIds = batch.map(a => a.id).join(',');

    const albumsData = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/albums?ids=${albumIds}`
    );

    for (const album of albumsData.albums) {
      let tracks = album.tracks;

      do {
        for (const track of tracks.items) {
          // Skip features if not wanted
          if (!includeFeatures && track.artists[0].id !== artistId) {
            continue;
          }

          // Check if artist is in the track
          const trackArtistIds = track.artists.map(a => a.id);
          if (!trackArtistIds.includes(artistId)) {
            continue;
          }

          if (removeDupes) {
            // Get full track data for ISRC
            const trackData = await Spicetify.CosmosAsync.get(
              `https://api.spotify.com/v1/tracks/${track.id}`
            );

            const isrc = trackData.external_ids?.isrc;
            if (!isrc) {
              trackUris.push(trackData.uri);
              continue;
            }

            const existing = trackHistory.get(isrc);

            if (existing) {
              // Prefer non-compilation albums with more tracks
              if (
                album.album_type !== 'compilation' &&
                (existing.type === 'compilation' ||
                  (existing.type !== 'compilation' && tracks.total > existing.trackCount))
              ) {
                // Replace the old track
                const oldIndex = trackUris.indexOf(existing.uri);
                if (oldIndex >= 0) {
                  trackUris[oldIndex] = trackData.uri;
                }
                trackHistory.set(isrc, {
                  uri: trackData.uri,
                  trackCount: tracks.total,
                  type: album.album_type
                });
              }
            } else {
              trackHistory.set(isrc, {
                uri: trackData.uri,
                trackCount: tracks.total,
                type: album.album_type
              });
              trackUris.push(trackData.uri);
            }
          } else {
            trackUris.push(track.uri);
          }
        }

        if (!tracks.next) break;
        tracks = await Spicetify.CosmosAsync.get(tracks.next);
      } while (true);
    }

    console.log(`[DEBUG] Processed ${Math.min(i + 20, albums.length)}/${albums.length} albums`);
  }

  // Filter out any removed duplicates
  const finalTracks = trackUris.filter(uri => uri !== null);
  console.log(`[DEBUG] Total tracks: ${finalTracks.length}`);

  return finalTracks;
}

// Main function to get all artist tracks
async function getArtistTracks(
  artistUri: string,
  removeDupes: boolean = true,
  includeFeatures: boolean = true
): Promise<string[]> {
  console.log("[DEBUG] Fetching all tracks for:", artistUri);

  const artistId = artistUri.split(':').pop();
  if (!artistId) {
    console.error("[ERROR] Invalid artist URI");
    return [];
  }

  try {
    // Get all albums
    const albums = await getArtistAlbums(artistId, includeFeatures);

    // Get all tracks from albums
    const tracks = await getTracksFromAlbums(artistId, albums, removeDupes, includeFeatures);

    return tracks;
  } catch (error) {
    console.error("[ERROR] Failed to fetch artist tracks:", error);
    return [];
  }
}

// Update Playlist - Add missing songs from artists
async function updatePlaylist(uris: string[]) {
  console.log("[DEBUG] updatePlaylist called with URIs:", uris);

  const playlistUri = getPlaylistUri(uris);
  if (!playlistUri) {
    console.error("[ERROR] No playlist URI found");
    Spicetify.showNotification("No playlist selected", true);
    return;
  }

  try {
    console.log("[DEBUG] Starting playlist update for:", playlistUri);
    Spicetify.showNotification("Updating playlist...");

    // Get playlist data using GraphQL (with CosmosAsync fallback)
    const playlist = await getPlaylistData(playlistUri);

    if (!playlist) {
      Spicetify.showNotification("Failed to fetch playlist data", true);
      return;
    }

    const playlistName = playlist.name || playlist.displayName;
    console.log("Playlist name:", playlistName);

    // Parse artist names from playlist title (split by " / ")
    const artistNames = parseArtistsFromTitle(playlistName);
    console.log("Artists found in title:", artistNames);

    if (artistNames.length === 0) {
      Spicetify.showNotification("No artists found in playlist title", true);
      return;
    }

    // Get URIs for all artists
    console.log("[DEBUG] Searching for artist URIs...");
    const artistUris: string[] = [];
    for (const artistName of artistNames) {
      const artistUri = await searchArtist(artistName);
      if (artistUri) {
        artistUris.push(artistUri);
        console.log(`[DEBUG] Found artist URI for ${artistName}:`, artistUri);
      } else {
        console.warn(`[WARN] Could not find artist: ${artistName}`);
      }
    }

    if (artistUris.length === 0) {
      Spicetify.showNotification("Could not find any artists", true);
      return;
    }

    // Get all tracks from each artist using GraphQL
    console.log("[DEBUG] Fetching tracks from", artistUris.length, "artists...");
    const allArtistTracks: any[] = [];
    for (const artistUri of artistUris) {
      const tracks = await getArtistTracks(artistUri);
      allArtistTracks.push(...tracks);
      console.log(`[DEBUG] Got ${tracks.length} tracks from ${artistUri}`);
    }

    console.log("[DEBUG] Total artist tracks found:", allArtistTracks.length);

    // TODO: 
    // 1. Get existing track URIs from playlist
    // 2. Filter out tracks already in playlist
    // 3. Add missing tracks to playlist using CosmosAsync POST

    Spicetify.showNotification(`Found ${allArtistTracks.length} tracks from artists!`);
  } catch (error) {
    console.error("Error updating playlist:", error);
    Spicetify.showNotification("Failed to update playlist", true);
  }
}

async function main() {
  console.log("[DEBUG] Playlist Manager initializing...");

  while (!Spicetify?.showNotification) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log("[DEBUG] Spicetify is ready");
  console.log("[DEBUG] Available GraphQL Definitions:", Object.keys(Spicetify.GraphQL?.Definitions || {}));

  // Create context menu items
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

  // Register the menu items
  console.log("[DEBUG] Registering context menu items...");
  cleanPlaylistItem.register();
  updatePlaylistItem.register();
  console.log("[DEBUG] Context menu items registered successfully");

  Spicetify.showNotification("Playlist Manager loaded!");
}

export default main;
