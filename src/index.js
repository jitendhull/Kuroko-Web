// Scraper Script for Client-Side Anime Streaming
// Exposes AniList/MAL metadata and scrapers for Miruro, AnimePahe, and KickAss.

let customFetch = null;

/**
 * Configure a custom fetch implementation (e.g. GM_xmlhttpRequest or Axios wrapper).
 * @param {Function} fetchFn - Custom fetch implementation
 */
export function setFetch(fetchFn) {
  customFetch = fetchFn;
}

/**
 * Perform an HTTP request using the configured or global fetch client.
 */
export async function httpFetch(url, options = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ...(options.headers || {})
  };

  const fetchFn = options.fetch || customFetch || globalThis.fetch;
  if (!fetchFn) {
    throw new Error('No fetch implementation found. Pass a custom fetch function.');
  }

  // Handle GM_xmlhttpRequest if detected or forced
  if (fetchFn.name === 'GM_xmlhttpRequest' || options.useGM) {
    return new Promise((resolve, reject) => {
      fetchFn({
        method: options.method || 'GET',
        url: url,
        headers: headers,
        data: options.body,
        onload: (res) => {
          resolve({
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            statusText: res.statusText,
            text: async () => res.responseText,
            json: async () => JSON.parse(res.responseText),
            headers: {
              get: (name) => {
                const h = res.responseHeaders || '';
                const match = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(h);
                return match ? match[1].trim() : null;
              }
            }
          });
        },
        onerror: reject,
        ontimeout: () => reject(new Error('Timeout'))
      });
    });
  }

  const response = await fetchFn(url, {
    method: options.method || 'GET',
    headers: headers,
    body: options.body,
    redirect: 'follow'
  });

  return response;
}

/**
 * Normalize titles for similarity comparison.
 */
export function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(the|a|an|season|part|cour)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize slugs for site matching.
 */
export function normalizeSlug(slug) {
  return (slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Compare media metadata to matched site result.
 */
export function calculateMatchScore(media, itemTitleOrSlug, itemYear, itemType) {
  // Normalize item slug (strip trailing hash like -c6fbj or -cp7ym)
  const slug = itemTitleOrSlug.toLowerCase()
    .replace(/-[a-z0-9]{4,6}$/, '') // strip trailing hash
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const titles = [
    media.title.english,
    media.title.romaji,
    media.title.native,
    ...(media.synonyms || [])
  ].filter(Boolean);

  let bestScore = 0;
  const spinoffWords = ['mini', 'marumaru', 'special', 'specials', 'ova', 'movie', 'recap', 'picture', 'drama'];

  for (const t of titles) {
    // Primary slug
    const keywordSlug = t.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    // Alternate slug with expanded apostrophe
    const keywordSlugAlt = t.toLowerCase()
      .replace(/[‘’'′`´‵]/g, '-')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const slugs = [keywordSlug, keywordSlugAlt];

    for (const kwSlug of slugs) {
      if (!kwSlug || !slug) continue;
      let score = 0;

      if (slug === kwSlug) {
        score = 1000;
      } else if (slug.startsWith(kwSlug + '-') || slug.startsWith(kwSlug)) {
        const extraLength = slug.length - kwSlug.length;
        score = 900 - (extraLength * 3);
        if (score < 500) score = 500;
      } else if (kwSlug.startsWith(slug + '-') || kwSlug.startsWith(slug)) {
        const extraLength = kwSlug.length - slug.length;
        score = 700 - (extraLength * 2);
        if (score < 400) score = 400;
      } else if (slug.split('-').join(' ').includes(kwSlug.split('-').join(' '))) {
        score = 300;
      } else {
        const kwWords = kwSlug.split('-');
        const slugWords = slug.split('-');
        let matchedWords = 0;
        for (const w of kwWords) {
          if (w.length >= 3 && slugWords.includes(w)) matchedWords++;
        }
        if (kwWords.length > 0 && matchedWords > 0) {
          score = Math.round(200 * (matchedWords / kwWords.length));
        }
      }

      // Spinoff penalties
      if (score >= 500 && score < 900) {
        const slugWords = slug.split('-');
        for (const sw of spinoffWords) {
          if (slugWords.includes(sw)) {
            score -= 200;
            break;
          }
        }
        // Season mismatches
        if (!kwSlug.includes('season') && slug.includes('season-')) {
          score -= 100;
        }
      }

      bestScore = Math.max(bestScore, score);
    }
  }

  // Format and Year bonus can be added on top
  if (media.seasonYear && itemYear && parseInt(media.seasonYear, 10) === parseInt(itemYear, 10)) {
    bestScore += 8;
  }
  if (media.format && itemType) {
    const fmt = media.format.toLowerCase();
    const typ = itemType.toLowerCase();
    if ((fmt === 'tv' && typ === 'tv') || (fmt === 'movie' && typ === 'movie')) {
      bestScore += 4;
    }
  }

  return bestScore;
}

// Decompress base64url gzip strings
async function gunzip(base64Data) {
  let b64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binaryString = atob(b64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

// Encode Miruro secure API path
function encodePipeRequest(path, query) {
  const req = { path, method: 'GET', query: query || {}, body: null, version: '0.2.0' };
  const jsonStr = JSON.stringify(req);
  return btoa(unescape(encodeURIComponent(jsonStr)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * AniList Metadata GraphQL client
 */
export const AniList = {
  async search(query, fetchOptions = {}) {
    const graphqlQuery = `
      query ($search: String, $page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          media(sort: SEARCH_MATCH, isAdult: false, type: ANIME, search: $search) {
            id
            idMal
            title {
              romaji
              english
              native
            }
            coverImage {
              large
              medium
            }
            bannerImage
            status
            episodes
            description
            seasonYear
            season
            synonyms
            format
          }
        }
      }
    `;

    const res = await httpFetch('https://graphql.anilist.co/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: { search: query, page: 1, perPage: 10 }
      }),
      ...fetchOptions
    });

    const json = await res.json();
    return json?.data?.Page?.media || [];
  },

  async getDetails(id, fetchOptions = {}) {
    const graphqlQuery = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          idMal
          title {
            romaji
            english
            native
          }
          coverImage {
            large
            medium
          }
          bannerImage
          status
          episodes
          description
          seasonYear
          season
          synonyms
          format
        }
      }
    `;

    const res = await httpFetch('https://graphql.anilist.co/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: { id: parseInt(id, 10) }
      }),
      ...fetchOptions
    });

    const json = await res.json();
    return json?.data?.Media || null;
  }
};

/**
 * MyAnimeList Client (Jikan Fallback)
 */
export const MAL = {
  async search(query, fetchOptions = {}) {
    const res = await httpFetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=10`, fetchOptions);
    const json = await res.json();
    if (!json || !json.data) return [];

    return json.data.map(item => ({
      idMal: item.mal_id,
      title: {
        romaji: item.title,
        english: item.title_english,
        native: item.title_japanese
      },
      coverImage: {
        large: item.images?.jpg?.large_image_url,
        medium: item.images?.jpg?.image_url
      },
      status: item.status === 'Currently Airing' ? 'RELEASING' : 'FINISHED',
      episodes: item.episodes,
      description: item.synopsis,
      seasonYear: item.year,
      season: item.season ? item.season.toUpperCase() : null,
      synonyms: item.titles ? item.titles.map(t => t.title) : [],
      format: item.type
    }));
  },

  async getDetails(id, fetchOptions = {}) {
    const res = await httpFetch(`https://api.jikan.moe/v4/anime/${id}`, fetchOptions);
    const json = await res.json();
    const item = json?.data;
    if (!item) return null;

    return {
      idMal: item.mal_id,
      title: {
        romaji: item.title,
        english: item.title_english,
        native: item.title_japanese
      },
      coverImage: {
        large: item.images?.jpg?.large_image_url,
        medium: item.images?.jpg?.image_url
      },
      status: item.status === 'Currently Airing' ? 'RELEASING' : 'FINISHED',
      episodes: item.episodes,
      description: item.synopsis,
      seasonYear: item.year,
      season: item.season ? item.season.toUpperCase() : null,
      synonyms: item.titles ? item.titles.map(t => t.title) : [],
      format: item.type
    };
  }
};

/**
 * Miruro Scraper Module
 */
export const Miruro = {
  domain: 'miruro.tv',

  async getEpisodes(anilistId, fetchOptions = {}) {
    const e = encodePipeRequest('episodes', { anilistId: String(anilistId) });
    const url = `https://www.${this.domain}/api/secure/pipe?e=${e}`;

    const res = await httpFetch(url, {
      headers: {
        'Referer': `https://www.${this.domain}/`,
        'Origin': `https://www.${this.domain}`
      },
      ...fetchOptions
    });

    const isObfuscated = !!res.headers.get('x-obfuscated');
    const text = await res.text();

    let data;
    if (isObfuscated) {
      const decoded = await gunzip(text);
      data = JSON.parse(decoded);
    } else {
      data = JSON.parse(text);
    }
    return data;
  },

  async getSources(episodeId, provider, category = 'sub', fetchOptions = {}) {
    const e = encodePipeRequest('sources', {
      episodeId,
      provider,
      category
    });
    const url = `https://www.${this.domain}/api/secure/pipe?e=${e}`;

    const res = await httpFetch(url, {
      headers: {
        'Referer': `https://www.${this.domain}/`,
        'Origin': `https://www.${this.domain}`
      },
      ...fetchOptions
    });

    const isObfuscated = !!res.headers.get('x-obfuscated');
    const text = await res.text();

    let data;
    if (isObfuscated) {
      const decoded = await gunzip(text);
      data = JSON.parse(decoded);
    } else {
      data = JSON.parse(text);
    }
    return data;
  }
};

/**
 * AnimePahe / Kiwi Scraper Module
 */
export const AnimePahe = {
  domain: 'anikototv.to',
  mapperDomain: 'mapper.nekostream.site',

  async search(query, fetchOptions = {}) {
    const url = `https://${this.domain}/filter?keyword=${encodeURIComponent(query)}`;
    const res = await httpFetch(url, {
      headers: { 'Referer': `https://${this.domain}/` },
      ...fetchOptions
    });
    const html = await res.text();

    const results = [];
    const regex = /class="ani poster tip"[^>]*data-tip="(\d+)"[^>]*>\s*<a[^>]*href="[^"]*\/watch\/([^/"]+)/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      results.push({ animeId: match[1], slug: match[2] });
    }

    if (results.length === 0) {
      const regex2 = /data-tip="(\d+)"[\s\S]{0,500}?href="[^"]*\/watch\/([^/"]+)/g;
      while ((match = regex2.exec(html)) !== null) {
        results.push({ animeId: match[1], slug: match[2] });
      }
    }
    return results;
  },

  async getEpisodes(animeId, fetchOptions = {}) {
    const url = `https://${this.domain}/ajax/episode/list/${animeId}`;
    const res = await httpFetch(url, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://${this.domain}/`
      },
      ...fetchOptions
    });

    const json = await res.json();
    if (json.status !== 200 || !json.result) {
      throw new Error(json.message || 'Failed to get episode list');
    }

    const html = json.result;
    const episodes = [];
    const aTags = html.match(/<a[^>]+>/g) || [];
    for (const a of aTags) {
      if (!a.includes('data-ids')) continue;
      const idsMatch = a.match(/data-ids="([^"]+)"/);
      const numMatch = a.match(/data-num="([^"]+)"/);
      const slugMatch = a.match(/data-slug="([^"]+)"/);
      if (idsMatch) {
        episodes.push({
          dataIds: idsMatch[1],
          num: numMatch ? numMatch[1] : (episodes.length + 1) + '',
          slug: slugMatch ? slugMatch[1] : (episodes.length + 1) + ''
        });
      }
    }

    const malMatch = html.match(/data-mal="([^"]+)"/);
    const tsMatch = html.match(/data-timestamp="([^"]+)"/);
    const malId = malMatch ? malMatch[1] : null;
    const timestamp = tsMatch ? tsMatch[1] : null;

    return { episodes, malId, timestamp };
  },

  async getSources(malId, epSlug, timestamp, isDub = false, fetchOptions = {}) {
    if (!malId || !epSlug || !timestamp) {
      throw new Error('Missing malId, epSlug, or timestamp');
    }

    const mapperUrl = `https://${this.mapperDomain}/api/mal/${malId}/${epSlug}/${timestamp}`;
    const mapperRes = await httpFetch(mapperUrl, {
      headers: {
        'Referer': `https://${this.domain}/`,
        'Origin': `https://${this.domain}`
      },
      ...fetchOptions
    });

    const mapperData = await mapperRes.json();
    let streamInfo = null;
    for (const [name, entry] of Object.entries(mapperData)) {
      if (name === 'status') continue;
      if (name.toLowerCase().includes('kiwi')) {
        const info = isDub ? entry.dub : entry.sub;
        if (info && info.url) {
          streamInfo = info;
          break;
        }
      }
    }

    if (!streamInfo || !streamInfo.url) {
      throw new Error(`Kiwi ${isDub ? 'dub' : 'sub'} stream URL not found`);
    }

    const serverUrl = `https://${this.domain}/ajax/server?get=${encodeURIComponent(streamInfo.url)}`;
    const serverRes = await httpFetch(serverUrl, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://${this.domain}/`
      },
      ...fetchOptions
    });

    const serverJson = await serverRes.json();
    const embedUrl = serverJson?.result?.url;
    if (!embedUrl) {
      throw new Error('Failed to resolve server embed URL');
    }

    const hashMatch = embedUrl.split('#')[1];
    if (!hashMatch) {
      throw new Error('Hash fragment not found in embed URL');
    }

    const streamUrl = atob(hashMatch.split('?')[0]);
    return {
      streamUrl,
      referer: 'https://kwik.cx/',
      download: streamInfo.download || null
    };
  }
};

/**
 * KickAss Scraper Module
 */
export const KickAss = {
  domain: 'kaa.lt',

  async search(query, fetchOptions = {}) {
    const url = `https://${this.domain}/api/fsearch`;
    const res = await httpFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Referer': `https://${this.domain}/`
      },
      body: JSON.stringify({ query, page: 1 }),
      ...fetchOptions
    });
    const json = await res.json();
    return json?.result || [];
  },

  async getEpisodes(slug, isDub = false, fetchOptions = {}) {
    const showUrl = `https://${this.domain}/api/show/${slug}`;
    const showRes = await httpFetch(showUrl, {
      headers: { 'Referer': `https://${this.domain}/` },
      ...fetchOptions
    });
    const showInfo = await showRes.json();

    const lang = isDub ? 'en-US' : 'ja-JP';
    const epUrl = `https://${this.domain}/api/show/${slug}/episodes?ep=1&lang=${lang}&page=1`;
    const epRes = await httpFetch(epUrl, {
      headers: { 'Referer': `https://${this.domain}/` },
      ...fetchOptions
    });
    const epData = await epRes.json();
    return {
      info: showInfo,
      episodes: epData?.result || []
    };
  },

  async getSources(showSlug, episodeNumber, episodeSlug, fetchOptions = {}) {
    const url = `https://${this.domain}/api/show/${showSlug}/episode/ep-${episodeNumber}-${episodeSlug}`;
    const res = await httpFetch(url, {
      headers: { 'Referer': `https://${this.domain}/` },
      ...fetchOptions
    });
    const json = await res.json();
    const servers = json?.servers || [];

    const streams = [];
    for (const server of servers) {
      if (!server.src) continue;
      try {
        const streamData = await this.extractEmbed(server.src, server.name, fetchOptions);
        if (streamData) {
          streams.push(streamData);
        }
      } catch (err) {
        console.warn(`Failed to extract KickAss server ${server.name}:`, err.message);
      }
    }
    return streams;
  },

  async extractEmbed(embedUrl, serverName, fetchOptions = {}) {
    const res = await httpFetch(embedUrl, {
      headers: {
        'Referer': `https://${this.domain}/`,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      ...fetchOptions
    });
    const html = await res.text();

    const decoded = html
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");

    let manifestUrl = null;
    const propMatch = decoded.match(/"manifest":\[0,"((?:https?:)?\/\/[^"]+\.m3u8[^"]*)"\]/);
    if (propMatch) {
      manifestUrl = propMatch[1];
    } else {
      const absMatch = decoded.match(/https?:\/\/[^"'\s\],]+\.m3u8[^"'\s\],]*/);
      if (absMatch) manifestUrl = absMatch[0];
    }

    if (manifestUrl) {
      if (manifestUrl.startsWith('https:///')) {
        manifestUrl = 'https://' + manifestUrl.substring(9);
      } else if (manifestUrl.startsWith('//')) {
        manifestUrl = 'https:' + manifestUrl;
      }
    }

    if (!manifestUrl) return null;

    const subtitles = [];
    const seen = new Set();
    const pattern = /"language":\[0,"([^"]+)"\],"name":\[0,"([^"]+)"\],"src":\[0,"([^"]+\.(?:vtt|srt))"\]/g;
    let m;
    while ((m = pattern.exec(decoded)) !== null) {
      if (m[3].includes('preview-')) continue;
      let src = m[3];
      if (src.startsWith('https:///')) src = 'https://' + src.substring(9);
      else if (src.startsWith('//')) src = 'https:' + src;

      if (!seen.has(src)) {
        seen.add(src);
        subtitles.push({ src, name: m[2], language: m[1] });
      }
    }

    if (subtitles.length === 0) {
      const matches = decoded.match(/(?:https?:)?\/\/?\/?[^"'\s\],]+\.(?:vtt|srt)/g) || [];
      for (let src of matches) {
        if (src.includes('preview-')) continue;
        if (src.startsWith('https:///')) src = 'https://' + src.substring(9);
        else if (src.startsWith('//')) src = 'https:' + src;

        if (!seen.has(src)) {
          seen.add(src);
          subtitles.push({ src, name: 'English', language: 'en' });
        }
      }
    }

    return {
      serverName,
      manifestUrl,
      subtitles
    };
  }
};

const M3Scrape = {
  setFetch,
  httpFetch,
  normalizeTitle,
  normalizeSlug,
  calculateMatchScore,
  metadata: {
    AniList,
    MAL
  },
  scrapers: {
    Miruro,
    AnimePahe,
    KickAss
  }
};

if (typeof window !== 'undefined') {
  window.M3Scrape = M3Scrape;
}

export default M3Scrape;
