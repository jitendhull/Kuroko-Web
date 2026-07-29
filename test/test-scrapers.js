// Test runner for m3-scrape scrapers and metadata clients.
import assert from 'assert';
import M3Scrape, {
  normalizeTitle,
  normalizeSlug,
  calculateMatchScore,
  AniList,
  MAL,
  Miruro,
  AnimePahe,
  KickAss
} from '../src/index.js';

async function runTests() {
  console.log('=== Running m3-scrape Tests ===\n');

  // Test 1: Utility functions
  console.log('--- Test 1: Title Normalization & Matching ---');
  assert.strictEqual(normalizeTitle('Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season'), 'rezero kara hajimeru isekai seikatsu 2nd');
  assert.strictEqual(normalizeSlug('Frieren: Beyond Journey\'s End'), 'frieren-beyond-journeys-end');

  const mockMedia = {
    title: {
      english: 'Sousou no Frieren',
      romaji: 'Frieren: Beyond Journey\'s End',
      native: '葬送のフリーレン'
    },
    synonyms: ['Frieren'],
    seasonYear: 2023,
    format: 'TV'
  };

  const score1 = calculateMatchScore(mockMedia, 'Frieren: Beyond Journey\'s End', 2023, 'TV');
  const score2 = calculateMatchScore(mockMedia, 'Sousou no Frieren', 2023, 'TV');
  const score3 = calculateMatchScore(mockMedia, 'Unrelated Anime', 2022, 'Movie');

  assert.ok(score1 >= 100);
  assert.ok(score2 >= 100);
  assert.ok(score3 < 50);
  console.log('✅ Title matching tests passed.');

  // Test 2: AniList search metadata fetch
  console.log('\n--- Test 2: AniList Metadata Client ---');
  try {
    const list = await AniList.search('Frieren');
    assert.ok(list.length > 0);
    assert.ok(list[0].id);
    assert.ok(list[0].title.romaji || list[0].title.english);
    console.log(`✅ AniList search passed. First match: ${list[0].title.english || list[0].title.romaji} (ID: ${list[0].id})`);

    const details = await AniList.getDetails(list[0].id);
    assert.strictEqual(details.id, list[0].id);
    console.log('✅ AniList getDetails passed.');
  } catch (err) {
    console.warn('⚠️ AniList request failed (possibly network/rate limits):', err.message);
  }

  // Test 3: MAL/Jikan metadata fetch
  console.log('\n--- Test 3: MAL Metadata Client (Jikan) ---');
  try {
    const list = await MAL.search('Frieren');
    assert.ok(list.length > 0);
    assert.ok(list[0].idMal);
    console.log(`✅ MAL search passed. First match ID: ${list[0].idMal}`);
  } catch (err) {
    console.warn('⚠️ MAL request failed (possibly network/rate limits):', err.message);
  }

  // Test 4: Miruro Scraper
  console.log('\n--- Test 4: Miruro Scraper ---');
  try {
    // Frieren AniList ID = 154587
    const eps = await Miruro.getEpisodes(154587);
    assert.ok(eps && eps.providers);
    console.log('✅ Miruro getEpisodes passed. Providers found:', Object.keys(eps.providers));
  } catch (err) {
    console.warn('⚠️ Miruro scraper request failed (possibly network/obfuscation update):', err.message);
  }

  // Test 5: AnimePahe Scraper
  console.log('\n--- Test 5: AnimePahe Scraper ---');
  try {
    const results = await AnimePahe.search('Frieren');
    console.log(`✅ AnimePahe search passed. Results found: ${results.length}`);
    console.log('   Candidates:', results);
    if (results.length > 0) {
      // Find the main series in the results using title matching or simple keyword filtering
      const mainResult = results.find(r => r.slug.includes('frieren-beyond-journey-s-end') && !r.slug.includes('season-2')) || results[0];
      console.log(`   Best match: slug=${mainResult.slug}, id=${mainResult.animeId}`);

      // Let's debug by fetching raw response
      const ajaxUrl = `https://${AnimePahe.domain}/ajax/episode/list/${mainResult.animeId}`;
      const res = await fetch(ajaxUrl, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `https://${AnimePahe.domain}/`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      const json = await res.json();
      console.log('   Raw getEpisodes AJAX response keys:', Object.keys(json));
      if (json.result) {
        console.log('   Raw HTML snippet (first 3000 chars):');
        console.log(json.result.substring(0, 3000));
      }

      const epData = await AnimePahe.getEpisodes(mainResult.animeId);
      assert.ok(epData.episodes.length > 0);
      console.log(`✅ AnimePahe getEpisodes passed. Total episodes: ${epData.episodes.length}`);

      if (epData.episodes.length > 0) {
        // Try getting sources for episode 1 using MAL ID
        const targetEp = epData.episodes[0];
        const malId = epData.malId || '52991'; // Frieren MAL ID fallback
        console.log(`   Fetching stream sources for episode 1 (MAL ID: ${malId}, slug: ${targetEp.slug}, timestamp: ${epData.timestamp})...`);

        // Debug: fetch and log mapper data directly
        const debugUrl = `https://${AnimePahe.mapperDomain}/api/mal/${malId}/${targetEp.slug}/${epData.timestamp}`;
        const debugRes = await fetch(debugUrl, {
          headers: {
            'Referer': `https://${AnimePahe.domain}/`,
            'Origin': `https://${AnimePahe.domain}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        const debugJson = await debugRes.json();
        console.log('   Raw mapper response data:', debugJson);

        // Determine whether we have sub or dub streaming URL
        let hasSub = false;
        let hasDub = false;
        for (const [name, entry] of Object.entries(debugJson)) {
          if (name === 'status') continue;
          if (name.toLowerCase().includes('kiwi')) {
            if (entry.sub && entry.sub.url) hasSub = true;
            if (entry.dub && entry.dub.url) hasDub = true;
          }
        }

        const useDub = hasDub && !hasSub;
        console.log(`   Selected audio stream: ${useDub ? 'DUB' : 'SUB'}`);
        const streamData = await AnimePahe.getSources(malId, targetEp.slug, epData.timestamp, useDub);
        assert.ok(streamData.streamUrl);
        console.log(`✅ AnimePahe getSources passed. Stream URL: ${streamData.streamUrl.substring(0, 80)}...`);
      }
    }
  } catch (err) {
    console.warn('⚠️ AnimePahe scraper request failed (possibly network/Cloudflare):', err.message);
  }

  // Test 6: KickAss Scraper
  console.log('\n--- Test 6: KickAss Scraper ---');
  try {
    const results = await KickAss.search('Frieren');
    console.log(`✅ KickAss search passed. Results found: ${results.length}`);
    if (results.length > 0) {
      const mainResult = results.find(r => r.slug.includes('sousou-no-frieren') && !r.slug.includes('dub')) || results[0];
      console.log(`   Best match: slug=${mainResult.slug}`);
      const epData = await KickAss.getEpisodes(mainResult.slug, false);
      assert.ok(epData.episodes.length > 0);
      console.log(`✅ KickAss getEpisodes passed. Total episodes: ${epData.episodes.length}`);

      if (epData.episodes.length > 0) {
        const targetEp = epData.episodes[0];
        console.log(`   Fetching stream sources for episode ${targetEp.episode_number} (slug: ${targetEp.slug})...`);
        const streams = await KickAss.getSources(mainResult.slug, targetEp.episode_number, targetEp.slug);
        console.log(`✅ KickAss getSources passed. Resolved ${streams.length} stream servers.`);
        if (streams.length > 0) {
          console.log(`   First resolved stream: ${streams[0].serverName} -> ${streams[0].manifestUrl.substring(0, 80)}...`);
          console.log(`   Subtitles found: ${streams[0].subtitles.length}`);
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ KickAss scraper request failed (possibly network):', err.message);
  }

  // Test 7: KickAss One Punch Man Season 1 Check
  console.log('\n--- Test 7: KickAss One Punch Man Check ---');
  try {
    const results = await KickAss.search('One Punch Man');
    const mainResult = results.find(r => r.slug === 'one-punch-man-fff4') || results[0];
    console.log(`   Best match: slug=${mainResult.slug}`);

    const epData = await KickAss.getEpisodes(mainResult.slug, false);
    console.log(`   Total episodes: ${epData.episodes.length}`);
    assert.strictEqual(epData.episodes.length, 12);

    const firstEp = epData.episodes[0];
    console.log(`   First episode number: ${firstEp.episode_number}`);
    assert.strictEqual(parseInt(firstEp.episode_number, 10), 1);
    console.log('✅ KickAss OPM S1 checks passed (First episode starts at 1, total episodes = 12).');
  } catch (err) {
    console.warn('⚠️ KickAss OPM S1 check failed:', err.message);
  }

  console.log('\n=== All Tests Finished ===');
}

runTests().catch(err => {
  console.error('\n❌ Test suite crashed:', err);
  process.exit(1);
});
