// api/mcp.js — WorldKeeper MCP Server
// Add this URL in Claude Settings → Connectors → Add custom connector

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  // ── MCP Discovery (GET /) ──
  // Claude hits this to learn what tools are available
  if (req.method === 'GET') {
    return res.status(200).json({
      name: 'WorldKeeper',
      description: 'Access your fiction worlds, couples, lore, and tagged Google Docs.',
      version: '1.0.0',
      tools: [
        {
          name: 'get_worlds',
          description: 'List all your fiction worlds with their couples and doc counts.',
          inputSchema: {
            type: 'object',
            properties: {
              user_id: { type: 'string', description: 'Your WorldKeeper user ID (Google sub)' }
            },
            required: ['user_id']
          }
        },
        {
          name: 'get_world_context',
          description: 'Get full context for a world — all couples, all tagged docs with links. Use this to brief yourself on a world before writing.',
          inputSchema: {
            type: 'object',
            properties: {
              user_id: { type: 'string', description: 'Your WorldKeeper user ID' },
              world_name: { type: 'string', description: 'Name of the world (partial match is fine)' }
            },
            required: ['user_id', 'world_name']
          }
        },
        {
          name: 'get_couple_docs',
          description: 'Get all docs tagged to a specific couple in a world.',
          inputSchema: {
            type: 'object',
            properties: {
              user_id: { type: 'string', description: 'Your WorldKeeper user ID' },
              world_name: { type: 'string', description: 'Name of the world' },
              couple_name: { type: 'string', description: 'Name of the couple (partial match is fine)' }
            },
            required: ['user_id', 'world_name', 'couple_name']
          }
        },
        {
          name: 'add_doc',
          description: 'Add a new doc to WorldKeeper — use this when you create a Google Doc during a session.',
          inputSchema: {
            type: 'object',
            properties: {
              user_id: { type: 'string', description: 'Your WorldKeeper user ID' },
              world_name: { type: 'string', description: 'Name of the world to add to' },
              couple_name: { type: 'string', description: 'Name of the couple (or "lore" for world lore)' },
              doc_title: { type: 'string', description: 'Title of the document' },
              doc_url: { type: 'string', description: 'Google Doc URL' },
              doc_type: { type: 'string', enum: ['scene', 'lore', 'ref', 'oneshot', 'other'], description: 'Type of document' }
            },
            required: ['user_id', 'world_name', 'doc_title', 'doc_url', 'doc_type']
          }
        }
      ]
    });
  }

  // ── Tool Execution (POST /) ──
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { tool, parameters } = body;

    if (!parameters?.user_id) {
      return res.status(400).json({ error: 'user_id is required in parameters' });
    }

    const key = `worldkeeper:${parameters.user_id}`;

    async function upstashGet() {
      const r = await fetch(`${UPSTASH_URL}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['GET', key]),
      });
      const d = await r.json();
      return d.result ? JSON.parse(d.result) : { worlds: [] };
    }

    async function upstashSet(data) {
      await fetch(`${UPSTASH_URL}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SET', key, JSON.stringify(data)]),
      });
    }

    function id() { return Math.random().toString(36).slice(2, 9); }

    try {
      const data = await upstashGet();
      const worlds = data.worlds || [];

      // ── get_worlds ──
      if (tool === 'get_worlds') {
        const summary = worlds.map(w => ({
          name: w.name,
          emoji: w.emoji || '🌍',
          couples: (w.couples || []).map(c => c.name),
          total_docs: (w.docs || []).length,
          lore_docs: (w.docs || []).filter(d => d.section === 'lore').length,
        }));
        return res.status(200).json({
          result: summary.length > 0
            ? `Found ${summary.length} world(s):\n\n` + summary.map(w =>
                `${w.emoji} **${w.name}** — ${w.total_docs} docs, couples: ${w.couples.join(', ') || 'none yet'}`
              ).join('\n')
            : 'No worlds found. Create one at worldkeeper.vercel.app'
        });
      }

      // ── get_world_context ──
      if (tool === 'get_world_context') {
        const world = worlds.find(w => w.name.toLowerCase().includes(parameters.world_name.toLowerCase()));
        if (!world) return res.status(200).json({ result: `No world found matching "${parameters.world_name}"` });

        const loreDocs = (world.docs || []).filter(d => d.section === 'lore');
        const lines = [
          `# ${world.emoji || '🌍'} ${world.name}`,
          ``,
          `## World Lore Docs (${loreDocs.length})`,
          ...loreDocs.map(d => `- [${d.title}](${d.url}) — ${d.type}`),
          ``
        ];

        (world.couples || []).forEach(c => {
          const coupleDocs = (world.docs || []).filter(d => d.coupleId === c.id);
          lines.push(`## 💑 ${c.name} (${coupleDocs.length} docs)`);
          coupleDocs.forEach(d => lines.push(`- [${d.title}](${d.url}) — ${d.type}`));
          lines.push('');
        });

        return res.status(200).json({ result: lines.join('\n') });
      }

      // ── get_couple_docs ──
      if (tool === 'get_couple_docs') {
        const world = worlds.find(w => w.name.toLowerCase().includes(parameters.world_name.toLowerCase()));
        if (!world) return res.status(200).json({ result: `No world found matching "${parameters.world_name}"` });

        const couple = (world.couples || []).find(c => c.name.toLowerCase().includes(parameters.couple_name.toLowerCase()));
        if (!couple) return res.status(200).json({ result: `No couple found matching "${parameters.couple_name}" in ${world.name}` });

        const docs = (world.docs || []).filter(d => d.coupleId === couple.id);
        if (docs.length === 0) return res.status(200).json({ result: `No docs tagged to ${couple.name} yet.` });

        const lines = [`## 💑 ${couple.name} — ${world.name}`, ''];
        docs.forEach(d => lines.push(`- **[${d.title}](${d.url})** — ${d.type} — added ${d.addedAt}`));

        return res.status(200).json({ result: lines.join('\n') });
      }

      // ── add_doc ──
      if (tool === 'add_doc') {
        const world = worlds.find(w => w.name.toLowerCase().includes(parameters.world_name.toLowerCase()));
        if (!world) return res.status(200).json({ result: `No world found matching "${parameters.world_name}"` });

        let coupleId = null;
        let section = 'lore';

        if (parameters.couple_name && parameters.couple_name.toLowerCase() !== 'lore') {
          const couple = (world.couples || []).find(c => c.name.toLowerCase().includes(parameters.couple_name.toLowerCase()));
          if (couple) { coupleId = couple.id; section = 'couple'; }
        }

        if (!world.docs) world.docs = [];
        world.docs.push({
          id: id(),
          title: parameters.doc_title,
          url: parameters.doc_url,
          type: parameters.doc_type,
          section,
          coupleId,
          addedAt: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        });

        await upstashSet(data);
        return res.status(200).json({ result: `✓ "${parameters.doc_title}" added to ${world.name}${coupleId ? ` → ${parameters.couple_name}` : ' → World Lore'}` });
      }

      return res.status(400).json({ error: `Unknown tool: ${tool}` });

    } catch (err) {
      console.error('MCP error:', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
