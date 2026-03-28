// api/mcp.js — WorldKeeper MCP Server (Streamable HTTP / jsonrpc 2.0)
// Claude.ai custom connector compatible

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  async function upstashGet(userId) {
    const key = `worldkeeper:${userId}`;
    const r = await fetch(`${UPSTASH_URL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', key]),
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : { worlds: [] };
  }

  async function upstashSet(userId, data) {
    const key = `worldkeeper:${userId}`;
    await fetch(`${UPSTASH_URL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, JSON.stringify(data)]),
    });
  }

  function uid() { return Math.random().toString(36).slice(2, 9); }

  const TOOLS = [
    {
      name: 'get_worlds',
      description: 'List all WorldKeeper fiction worlds with couple names and doc counts.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'Your WorldKeeper user ID (from the Claude Session button in the app)' }
        },
        required: ['user_id']
      }
    },
    {
      name: 'get_world_context',
      description: 'Get full context for a world — all couples and all tagged docs with links. Use before writing to brief yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'Your WorldKeeper user ID' },
          world_name: { type: 'string', description: 'Name of the world (partial match ok)' }
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
          couple_name: { type: 'string', description: 'Name of the couple (partial match ok)' }
        },
        required: ['user_id', 'world_name', 'couple_name']
      }
    },
    {
      name: 'add_doc',
      description: 'Save a new doc to WorldKeeper. Use this when you create a Google Doc during a session.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'Your WorldKeeper user ID' },
          world_name: { type: 'string', description: 'World to add the doc to' },
          couple_name: { type: 'string', description: 'Couple name, or "lore" for world lore' },
          doc_title: { type: 'string', description: 'Document title' },
          doc_url: { type: 'string', description: 'Google Doc URL' },
          doc_type: { type: 'string', enum: ['scene', 'lore', 'ref', 'oneshot', 'other'] }
        },
        required: ['user_id', 'world_name', 'doc_title', 'doc_url', 'doc_type']
      }
    }
  ];

  async function runTool(name, params) {
    const { user_id } = params;
    if (!user_id) return { error: 'user_id is required' };

    const data = await upstashGet(user_id);
    const worlds = data.worlds || [];

    if (name === 'get_worlds') {
      if (!worlds.length) return { text: 'No worlds found. Create one at worldkeeper.vercel.app' };
      const lines = worlds.map(w => {
        const couples = (w.couples || []).map(c => c.name).join(', ') || 'none';
        const docs = (w.docs || []).length;
        return `${w.emoji || '🌍'} **${w.name}** — ${docs} docs | couples: ${couples}`;
      });
      return { text: `Found ${worlds.length} world(s):\n\n${lines.join('\n')}` };
    }

    if (name === 'get_world_context') {
      const world = worlds.find(w => w.name.toLowerCase().includes(params.world_name.toLowerCase()));
      if (!world) return { text: `No world found matching "${params.world_name}"` };
      const loreDocs = (world.docs || []).filter(d => d.section === 'lore');
      const lines = [`# ${world.emoji || '🌍'} ${world.name}`, ``, `## 📜 World Lore (${loreDocs.length} docs)`,
        ...loreDocs.map(d => `- [${d.title}](${d.url}) — ${d.type}`), ``];
      (world.couples || []).forEach(c => {
        const coupleDocs = (world.docs || []).filter(d => d.coupleId === c.id);
        lines.push(`## 💑 ${c.name} (${coupleDocs.length} docs)`);
        coupleDocs.forEach(d => lines.push(`- [${d.title}](${d.url}) — ${d.type}`));
        lines.push('');
      });
      return { text: lines.join('\n') };
    }

    if (name === 'get_couple_docs') {
      const world = worlds.find(w => w.name.toLowerCase().includes(params.world_name.toLowerCase()));
      if (!world) return { text: `No world found matching "${params.world_name}"` };
      const couple = (world.couples || []).find(c => c.name.toLowerCase().includes(params.couple_name.toLowerCase()));
      if (!couple) return { text: `No couple found matching "${params.couple_name}"` };
      const docs = (world.docs || []).filter(d => d.coupleId === couple.id);
      if (!docs.length) return { text: `No docs tagged to ${couple.name} yet.` };
      const lines = [`## 💑 ${couple.name} — ${world.name}`, ''];
      docs.forEach(d => lines.push(`- **[${d.title}](${d.url})** — ${d.type} — added ${d.addedAt}`));
      return { text: lines.join('\n') };
    }

    if (name === 'add_doc') {
      const world = worlds.find(w => w.name.toLowerCase().includes(params.world_name.toLowerCase()));
      if (!world) return { text: `No world found matching "${params.world_name}"` };
      let coupleId = null, section = 'lore';
      if (params.couple_name && params.couple_name.toLowerCase() !== 'lore') {
        const couple = (world.couples || []).find(c => c.name.toLowerCase().includes(params.couple_name.toLowerCase()));
        if (couple) { coupleId = couple.id; section = 'couple'; }
      }
      if (!world.docs) world.docs = [];
      world.docs.push({
        id: uid(), title: params.doc_title, url: params.doc_url,
        type: params.doc_type, section, coupleId,
        addedAt: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      });
      await upstashSet(user_id, data);
      return { text: `✓ "${params.doc_title}" saved to ${world.name}${coupleId ? ` → ${params.couple_name}` : ' → World Lore'}` };
    }

    return { error: `Unknown tool: ${name}` };
  }

  // Claude.ai probes with GET first — must respond with server info
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      name: 'WorldKeeper',
      version: '1.0.0',
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} }
    });
  }

  if (req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');

    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    const { jsonrpc, id, method, params } = body;

    const reply = (result) => res.status(200).json({ jsonrpc: '2.0', id, result });
    const err = (code, message) => res.status(200).json({ jsonrpc: '2.0', id, error: { code, message } });

    try {
      if (method === 'initialize') {
        return reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'WorldKeeper', version: '1.0.0' }
        });
      }
      if (method === 'notifications/initialized') return res.status(200).end();
      if (method === 'ping') return reply({});
      if (method === 'tools/list') return reply({ tools: TOOLS });
      if (method === 'tools/call') {
        const { name, arguments: args } = params;
        const result = await runTool(name, args || {});
        return reply({
          content: [{ type: 'text', text: result.text || result.error || 'Done' }],
          isError: !!result.error
        });
      }
      return err(-32601, `Method not found: ${method}`);
    } catch (e) {
      console.error('MCP error:', e);
      return err(-32603, 'Internal error');
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
