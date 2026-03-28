// api/mcp.js — WorldKeeper MCP Server
// Uses @modelcontextprotocol/sdk for claude.ai connector compatibility

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function upstashGet(userId) {
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['GET', `worldkeeper:${userId}`]),
  });
  const d = await r.json();
  return d.result ? JSON.parse(d.result) : { worlds: [] };
}

async function upstashSet(userId, data) {
  await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', `worldkeeper:${userId}`, JSON.stringify(data)]),
  });
}

function uid() { return Math.random().toString(36).slice(2, 9); }

function createServer() {
  const server = new McpServer({
    name: 'WorldKeeper',
    version: '1.0.0',
  });

  server.tool(
    'get_worlds',
    'List all WorldKeeper fiction worlds with couple names and doc counts.',
    { user_id: z.string().describe('Your WorldKeeper user ID') },
    async ({ user_id }) => {
      const data = await upstashGet(user_id);
      const worlds = data.worlds || [];
      if (!worlds.length) return { content: [{ type: 'text', text: 'No worlds found. Create one at worldkeeper.vercel.app' }] };
      const lines = worlds.map(w => {
        const couples = (w.couples || []).map(c => c.name).join(', ') || 'none';
        const docs = (w.docs || []).length;
        return `${w.emoji || '🌍'} **${w.name}** — ${docs} docs | couples: ${couples}`;
      });
      return { content: [{ type: 'text', text: `Found ${worlds.length} world(s):\n\n${lines.join('\n')}` }] };
    }
  );

  server.tool(
    'get_world_context',
    'Get full context for a world — all couples and all tagged docs with links.',
    {
      user_id: z.string().describe('Your WorldKeeper user ID'),
      world_name: z.string().describe('Name of the world (partial match ok)'),
    },
    async ({ user_id, world_name }) => {
      const data = await upstashGet(user_id);
      const world = (data.worlds || []).find(w => w.name.toLowerCase().includes(world_name.toLowerCase()));
      if (!world) return { content: [{ type: 'text', text: `No world found matching "${world_name}"` }] };
      const loreDocs = (world.docs || []).filter(d => d.section === 'lore');
      const lines = [`# ${world.emoji || '🌍'} ${world.name}`, '', `## 📜 World Lore (${loreDocs.length} docs)`,
        ...loreDocs.map(d => `- [${d.title}](${d.url}) — ${d.type}`), ''];
      (world.couples || []).forEach(c => {
        const coupleDocs = (world.docs || []).filter(d => d.coupleId === c.id);
        lines.push(`## 💑 ${c.name} (${coupleDocs.length} docs)`);
        coupleDocs.forEach(d => lines.push(`- [${d.title}](${d.url}) — ${d.type}`));
        lines.push('');
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'get_couple_docs',
    'Get all docs tagged to a specific couple in a world.',
    {
      user_id: z.string().describe('Your WorldKeeper user ID'),
      world_name: z.string().describe('Name of the world'),
      couple_name: z.string().describe('Name of the couple (partial match ok)'),
    },
    async ({ user_id, world_name, couple_name }) => {
      const data = await upstashGet(user_id);
      const world = (data.worlds || []).find(w => w.name.toLowerCase().includes(world_name.toLowerCase()));
      if (!world) return { content: [{ type: 'text', text: `No world found matching "${world_name}"` }] };
      const couple = (world.couples || []).find(c => c.name.toLowerCase().includes(couple_name.toLowerCase()));
      if (!couple) return { content: [{ type: 'text', text: `No couple found matching "${couple_name}"` }] };
      const docs = (world.docs || []).filter(d => d.coupleId === couple.id);
      if (!docs.length) return { content: [{ type: 'text', text: `No docs tagged to ${couple.name} yet.` }] };
      const lines = [`## 💑 ${couple.name} — ${world.name}`, ''];
      docs.forEach(d => lines.push(`- **[${d.title}](${d.url})** — ${d.type} — added ${d.addedAt}`));
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'add_doc',
    'Save a new doc to WorldKeeper.',
    {
      user_id: z.string().describe('Your WorldKeeper user ID'),
      world_name: z.string().describe('World to add the doc to'),
      couple_name: z.string().optional().describe('Couple name, or omit for world lore'),
      doc_title: z.string().describe('Document title'),
      doc_url: z.string().describe('Google Doc URL'),
      doc_type: z.enum(['scene', 'lore', 'ref', 'oneshot', 'other']),
    },
    async ({ user_id, world_name, couple_name, doc_title, doc_url, doc_type }) => {
      const data = await upstashGet(user_id);
      const world = (data.worlds || []).find(w => w.name.toLowerCase().includes(world_name.toLowerCase()));
      if (!world) return { content: [{ type: 'text', text: `No world found matching "${world_name}"` }] };
      let coupleId = null, section = 'lore';
      if (couple_name && couple_name.toLowerCase() !== 'lore') {
        const couple = (world.couples || []).find(c => c.name.toLowerCase().includes(couple_name.toLowerCase()));
        if (couple) { coupleId = couple.id; section = 'couple'; }
      }
      if (!world.docs) world.docs = [];
      world.docs.push({
        id: uid(), title: doc_title, url: doc_url,
        type: doc_type, section, coupleId,
        addedAt: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      });
      await upstashSet(user_id, data);
      return { content: [{ type: 'text', text: `✓ "${doc_title}" saved to ${world.name}${coupleId ? ` → ${couple_name}` : ' → World Lore'}` }] };
    }
  );

  return server;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => { transport.close(); server.close(); });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP handler error:', e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
