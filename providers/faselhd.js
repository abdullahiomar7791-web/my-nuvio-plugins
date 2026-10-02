const axios = require('axios');
const cheerio = require('cheerio');

class FaselHD {
  constructor() {
    this.id = 'nuvio-faselhd';
    this.name = 'FaselHD';
    
    // قائمة النطاقات الاحتياطية لتجاوز الحجب
    this.domains = [
      'https://web.faselhd.stream',
      'https://www.faselhd.ac',
      'https://www.faselhd.pro',
      'https://www.faselhd.club'
    ];
    this.baseUrl = this.domains[0];

    // ترويسات محاكاة المتصفح الحقيقي
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ar,en-US;q=0.7,en;q=0.3',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1'
    };
  }

  /**
   * فحص واختيار النطاق النشط تلقائياً
   */
  async getActiveBaseUrl() {
    for (const domain of this.domains) {
      try {
        const res = await axios.get(domain, {
          headers: this.defaultHeaders,
          timeout: 4000,
          maxRedirects: 5
        });
        if (res.status === 200) {
          this.baseUrl = domain;
          return domain;
        }
      } catch (e) {
        continue;
      }
    }
    return this.baseUrl;
  }

  /**
   * إزالة تشفير Dean Edwards Packer الخاص بمشغل الفيديو
   */
  unpackJS(packedCode) {
    try {
      if (!packedCode.includes('eval(function(p,a,c,k,e,d)')) return packedCode;
      
      const p = packedCode.match(/}\s*\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*)'\.split/);
      if (!p) return packedCode;

      let payload = p[1];
      let rad = parseInt(p[2]);
      let count = parseInt(p[3]);
      let syms = p[4].split('|');

      function e(c) {
        return (c < rad ? '' : e(parseInt(c / rad))) + ((c = c % rad) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
      }

      while (count--) {
        if (syms[count]) {
          payload = payload.replace(new RegExp('\\b' + e(count) + '\\b', 'g'), syms[count]);
        }
      }
      return payload;
    } catch (err) {
      return packedCode;
    }
  }

  /**
   * البحث عن الأفلام والمسلسلات
   */
  async search(query) {
    try {
      const activeUrl = await this.getActiveBaseUrl();
      const searchUrl = `${activeUrl}/?s=${encodeURIComponent(query)}`;
      
      const response = await axios.get(searchUrl, {
        headers: {
          ...this.defaultHeaders,
          'Referer': `${activeUrl}/`
        },
        timeout: 8000
      });

      const $ = cheerio.load(response.data);
      const results = [];

      $('.postDiv, .col-xl-2, .movieBox').each((_, element) => {
        const linkElem = $(element).find('a').first();
        const url = linkElem.attr('href');
        const title = $(element).find('.postMaster h3, .postMaster div, .title, .h3').text().trim();
        const poster = $(element).find('img').attr('data-src') || $(element).find('img').attr('src');

        if (url && title) {
          const isTV = title.includes('مسلسل') || title.includes('برنامج') || title.includes('أنمي') || url.includes('/series/') || url.includes('/tv/');
          results.push({
            id: url,
            title: title,
            poster: poster ? (poster.startsWith('//') ? `https:${poster}` : poster) : null,
            type: isTV ? 'tv' : 'movie'
          });
        }
      });

      return results;
    } catch (error) {
      console.error(`[FaselHD] Search Error:`, error.message);
      return [];
    }
  }

  /**
   * التصفح داخل المسلسل للحصول على رابط الحلقة الدقيق
   */
  async getEpisodeUrl(seriesUrl, seasonNumber = 1, episodeNumber = 1) {
    try {
      const response = await axios.get(seriesUrl, {
        headers: { ...this.defaultHeaders, 'Referer': this.baseUrl },
        timeout: 8000
      });
      
      let $ = cheerio.load(response.data);

      // 1. العثور على رابط الموسم المطلوب
      let seasonUrl = seriesUrl;
      $('#seasonsList a, .seasonsList a').each((_, el) => {
        const text = $(el).text();
        if (text.includes(`الموسم ${seasonNumber}`) || text.includes(`موسم ${seasonNumber}`)) {
          seasonUrl = $(el).attr('href');
        }
      });

      if (seasonUrl !== seriesUrl) {
        const seasonRes = await axios.get(seasonUrl, {
          headers: { ...this.defaultHeaders, 'Referer': seriesUrl },
          timeout: 8000
        });
        $ = cheerio.load(seasonRes.data);
      }

      // 2. العثور على رابط الحلقة
      let episodeUrl = null;
      $('#episodesList a, .episodesList a').each((_, el) => {
        const text = $(el).text();
        if (text.includes(`الحلقة ${episodeNumber}`) || text.includes(`حلقة ${episodeNumber}`)) {
          episodeUrl = $(el).attr('href');
        }
      });

      return episodeUrl || seasonUrl;
    } catch (error) {
      console.error(`[FaselHD] Episode fetch error:`, error.message);
      return seriesUrl;
    }
  }

  /**
   * قراءة وتفكيك ملف master.m3u8 واستخراج الجودات
   */
  async parseMasterPlaylist(masterUrl, playerUrl) {
    const streams = [];
    try {
      const res = await axios.get(masterUrl, {
        headers: {
          ...this.defaultHeaders,
          'Referer': playerUrl,
          'Origin': new URL(playerUrl).origin
        },
        timeout: 6000
      });

      const lines = res.data.split('\n');
      let currentResolution = 'Auto';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF')) {
          const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
          if (resMatch) {
            const height = resMatch[1].split('x')[1];
            currentResolution = `${height}p`;
          }
          const streamUri = lines[i + 1]?.trim();
          if (streamUri && !streamUri.startsWith('#')) {
            const absoluteUri = streamUri.startsWith('http') 
              ? streamUri 
              : new URL(streamUri, masterUrl).href;

            streams.push({
              name: 'FaselHD',
              title: `FaselHD - ${currentResolution}`,
              url: absoluteUri,
              quality: currentResolution,
              format: 'm3u8',
              headers: {
                'User-Agent': this.defaultHeaders['User-Agent'],
                'Referer': playerUrl,
                'Origin': new URL(playerUrl).origin
              }
            });
          }
        }
      }
    } catch (err) {
      streams.push({
        name: 'FaselHD',
        title: 'FaselHD - Auto Stream',
        url: masterUrl,
        quality: 'Auto',
        format: 'm3u8',
        headers: {
          'User-Agent': this.defaultHeaders['User-Agent'],
          'Referer': playerUrl
        }
      });
    }
    return streams;
  }

  /**
   * جلب روابط البث المباشر والترجمات
   */
  async getStreams(mediaUrl, type = 'movie', extra = {}) {
    try {
      await this.getActiveBaseUrl();
      let targetUrl = mediaUrl;

      if (type === 'tv' && extra.season && extra.episode) {
        targetUrl = await this.getEpisodeUrl(mediaUrl, extra.season, extra.episode);
      }

      const pageRes = await axios.get(targetUrl, {
        headers: { ...this.defaultHeaders, 'Referer': this.baseUrl },
        timeout: 8000
      });

      const $ = cheerio.load(pageRes.data);

      // 1. البحث عن إطار المشغل الخارجي (Iframe)
      let iframeSrc = $('#player_iframe, iframe[src*="player"], .embed-player iframe').attr('src');
      if (!iframeSrc) {
        const scriptMatch = pageRes.data.match(/src=["'](https?:\/\/[^"']*(?:player|embed)[^"']*)["']/i);
        if (scriptMatch) iframeSrc = scriptMatch[1];
      }

      if (!iframeSrc) return [];

      const playerUrl = iframeSrc.startsWith('//') ? `https:${iframeSrc}` : iframeSrc;

      // 2. طلب كود المشغل وتمرير الترويسات للحماية
      const playerRes = await axios.get(playerUrl, {
        headers: {
          ...this.defaultHeaders,
          'Referer': targetUrl,
          'Origin': new URL(targetUrl).origin
        },
        timeout: 8000
      });

      let playerHtml = playerRes.data;

      // فك التشفير إذا كان الكود محزوماً
      if (playerHtml.includes('eval(function(p,a,c,k,e,d)')) {
        playerHtml = this.unpackJS(playerHtml);
      }

      const streams = [];
      const subtitles = [];

      // 3. استخراج ملفات الترجمة (.vtt / .srt)
      const subMatches = playerHtml.match(/["']?kind["']?\s*:\s*["']captions["']\s*,\s*["']?file["']?\s*:\s*["']([^"']+\.(?:vtt|srt)[^"']*)["']/g) ||
                         playerHtml.match(/https?:\/\/[^"']+\.(?:vtt|srt)[^\s"']*/g);

      if (subMatches) {
        subMatches.forEach(sub => {
          const cleanSub = sub.replace(/.*file"\s*:\s*"/, '').replace('"', '').trim();
          if (cleanSub.startsWith('http')) {
            subtitles.push({
              lang: 'ar',
              label: 'Arabic',
              url: cleanSub
            });
          }
        });
      }

      // 4. استخراج روابط البث .m3u8
      const m3u8Matches = playerHtml.match(/file"\s*:\s*"([^"]+\.m3u8[^"]*)"/g) ||
                          playerHtml.match(/https?:\/\/[^"']+\.m3u8[^\s"']*/g);

      if (m3u8Matches) {
        const rawUrls = [...new Set(m3u8Matches.map(m => m.replace(/file"\s*:\s*"/, '').replace('"', '').trim()))];

        for (const streamUrl of rawUrls) {
          if (streamUrl.includes('master.m3u8') || streamUrl.includes('playlist.m3u8')) {
            const parsedStreams = await this.parseMasterPlaylist(streamUrl, playerUrl);
            parsedStreams.forEach(s => {
              if (subtitles.length > 0) s.subtitles = subtitles;
              streams.push(s);
            });
          } else {
            let quality = 'Auto';
            if (streamUrl.includes('1080')) quality = '1080p';
            else if (streamUrl.includes('720')) quality = '720p';
            else if (streamUrl.includes('480')) quality = '480p';
            else if (streamUrl.includes('360')) quality = '360p';

            streams.push({
              name: 'FaselHD',
              title: `FaselHD - ${quality}`,
              url: streamUrl,
              quality: quality,
              format: 'm3u8',
              subtitles: subtitles.length > 0 ? subtitles : undefined,
              headers: {
                'User-Agent': this.defaultHeaders['User-Agent'],
                'Referer': playerUrl,
                'Origin': new URL(playerUrl).origin
              }
            });
          }
        }
      }

      return streams;
    } catch (error) {
      console.error(`[FaselHD] Stream Extraction Error:`, error.message);
      return [];
    }
  }
}

module.exports = FaselHD;
