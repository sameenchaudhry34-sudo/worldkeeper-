// api/data.js — secure Upstash middleware
// All reads/writes to Upstash go through here so the token never hits the browser

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ error: 'Upstash not configured' });
  }

  // Each user gets their own key based on their Google sub (user ID)
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No auth' });
  const userId = authHeader.replace('Bearer ', '').trim();
  if (!userId) return res.status(401).json({ error: 'Invalid auth' });

  const key = `worldkeeper:${userId}`;

  async function upstash(command, ...args) {
    const body = [command, ...args];
    const r = await fetch(`${UPSTASH_URL}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    return data.result;
  }

  try {
    if (req.method === 'GET') {
      const raw = await upstash('GET', key);
      const data = raw ? JSON.parse(raw) : { worlds: [] };
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      await upstash('SET', key, JSON.stringify(body));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Upstash error:', err);
    return res.status(500).json({ error: 'Storage error' });
  }
}
