// Real research sources: arXiv papers, GitHub repositories, Hacker News-linked web articles,
// and (with YOUTUBE_API_KEY) YouTube videos. Every base URL can be overridden for testing.

const MAX_TEXT = 40000; // characters kept from one document; longer ones are marked as truncated

const env = (k, d) => process.env[k] || d;
const BASE = {
  arxiv: () => env('ARXIV_URL', 'https://export.arxiv.org'),
  github: () => env('GITHUB_API_URL', 'https://api.github.com'),
  hn: () => env('HN_API_URL', 'https://hn.algolia.com'),
  youtube: () => env('YOUTUBE_API_URL', 'https://www.googleapis.com'),
};

async function get(url, headers = {}, as = 'json') {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'jarvis-trade-brain/0.1', ...headers }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`cannot reach ${new URL(url).host}: ${e.cause?.code || e.message}`);
  }
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return as === 'json' ? res.json() : res.text();
}

const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[truncated: document is ${s.length.toLocaleString('en')} characters]` : s);
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export function htmlToText(html) {
  return decode(html
    .replace(/<(script|style|nav|footer|header|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export const searchers = {
  async arxiv(query) {
    const q = query.split(/\s+/).map((w) => `all:${encodeURIComponent(w)}`).join('+AND+');
    const xml = await get(`${BASE.arxiv()}/api/query?search_query=${q}&start=0&max_results=8&sortBy=relevance`, {}, 'text');
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
      const tag = (t) => decode((e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [, ''])[1].replace(/\s+/g, ' ').trim());
      const title = tag('title');
      return { kind: 'arxiv', url: tag('id'), title, text: `${title}\n\n${tag('summary')}`, published: Date.parse(tag('published')) || null, size: tag('summary').split(/\s+/).length };
    });
  },

  async github(query) {
    const auth = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
    const body = await get(`${BASE.github()}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=8`, { Accept: 'application/vnd.github+json', ...auth });
    return body.items.map((r) => ({
      kind: 'github', url: r.html_url, title: r.full_name, repo: r.full_name,
      text: `${r.full_name}\n\n${r.description || ''}`, published: Date.parse(r.pushed_at) || null, stars: r.stargazers_count,
    }));
  },

  async web(query) {
    const body = await get(`${BASE.hn()}/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`);
    return body.hits.filter((h) => h.url).map((h) => ({
      kind: 'web', url: h.url, title: h.title, text: h.title, published: (h.created_at_i || 0) * 1000 || null, points: h.points,
    }));
  },

  async youtube(query) {
    const key = process.env.YOUTUBE_API_KEY;
    const body = await get(`${BASE.youtube()}/youtube/v3/search?part=snippet&type=video&maxResults=6&q=${encodeURIComponent(query)}&key=${key}`);
    return body.items.map((v) => ({
      kind: 'youtube', url: `https://www.youtube.com/watch?v=${v.id.videoId}`, title: decode(v.snippet.title),
      text: `${decode(v.snippet.title)}\n\n${decode(v.snippet.description || '')}`, published: Date.parse(v.snippet.publishedAt) || null, channel: v.snippet.channelTitle,
    }));
  },
};

// Which source kinds can be searched with the current configuration.
export function availableKinds() {
  return ['arxiv', 'github', 'web', ...(process.env.YOUTUBE_API_KEY ? ['youtube'] : [])];
}

// Fetches the full text a source points to (README for repos, article body for web links).
// arXiv abstracts and YouTube descriptions arrive complete with the search result.
export async function readSource(src) {
  if (src.kind === 'github') {
    const auth = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
    try {
      const readme = await get(`${BASE.github()}/repos/${src.repo}/readme`, { Accept: 'application/vnd.github.raw', ...auth }, 'text');
      return clip(`${src.text}\n\n${readme}`);
    } catch (e) {
      if (/returned 404/.test(e.message)) return src.text;
      throw e;
    }
  }
  if (src.kind === 'web') return clip(`${src.title}\n\n${htmlToText(await get(src.url, { Accept: 'text/html' }, 'text'))}`);
  return clip(src.text);
}
