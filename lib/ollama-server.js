#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const readline = require('node:readline');

const TOKEN = process.env.MCP_WORKSPACE_OLLAMA_TOKEN || '';
const OLLAMA_BASE = 'http://127.0.0.1:11434';
const TOOLS = [
  {
    name: 'ollama_list_models',
    description: 'List models available from the home PC Ollama service. Requires the configured access token.',
    inputSchema: { type: 'object', properties: { accessToken: { type: 'string', minLength: 32 } }, required: ['accessToken'], additionalProperties: false },
  },
  {
    name: 'ollama_chat',
    description: 'Run a non-streaming chat completion on the home PC Ollama service. Requires the configured access token.',
    inputSchema: {
      type: 'object',
      properties: {
        accessToken: { type: 'string', minLength: 32 },
        model: { type: 'string', minLength: 1, maxLength: 128 },
        messages: { type: 'array', minItems: 1, maxItems: 32, items: {
          type: 'object', properties: {
            role: { type: 'string', enum: ['system', 'user', 'assistant'] },
            content: { type: 'string', maxLength: 32000 },
          }, required: ['role', 'content'], additionalProperties: false,
        } },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
      },
      required: ['accessToken', 'model', 'messages'], additionalProperties: false,
    },
  },
];

function response(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function rpcError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}
function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}
function validToken(candidate) {
  if (!TOKEN || typeof candidate !== 'string') return false;
  const expected = Buffer.from(TOKEN);
  const supplied = Buffer.from(candidate);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}
async function ollama(path, body, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_BASE}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}: ${text.slice(0, 1000)}`);
    try { return JSON.parse(text); } catch { throw new Error('Ollama returned invalid JSON'); }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Ollama request timed out');
    if (error.cause?.code === 'ECONNREFUSED' || error.message.includes('fetch failed')) {
      throw new Error('Cannot reach Ollama at 127.0.0.1:11434. Check that Ollama is running on the home PC.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function callTool(name, args) {
  if (!validToken(args?.accessToken)) return toolResult('Invalid or missing Ollama access token.', true);
  if (name === 'ollama_list_models') {
    const data = await ollama('/api/tags', null, 15000);
    const models = Array.isArray(data.models) ? data.models.map(model => ({ name: model.name, size: model.size })) : [];
    return toolResult(JSON.stringify(models));
  }
  if (name === 'ollama_chat') {
    if (typeof args.model !== 'string' || !args.model.trim() || !Array.isArray(args.messages) || !args.messages.length) {
      return toolResult('Provide a model name and at least one chat message.', true);
    }
    const messages = args.messages.map(message => {
      if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
        throw new Error('Each message must have a system, user, or assistant role and string content.');
      }
      return { role: message.role, content: message.content };
    });
    const body = { model: args.model.trim(), messages, stream: false };
    if (typeof args.temperature === 'number') body.options = { temperature: args.temperature };
    const data = await ollama('/api/chat', body);
    const content = data?.message?.content;
    if (typeof content !== 'string') throw new Error('Ollama response did not contain message content.');
    return toolResult(JSON.stringify({ model: data.model || args.model, response: content, done: Boolean(data.done) }));
  }
  return toolResult(`Unknown tool: ${name}`, true);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'notifications/initialized' || message.method?.startsWith('notifications/')) return;
  if (message.method === 'initialize') {
    response(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'ollama-home-inference', version: '1.0.0' },
    });
  } else if (message.method === 'ping') {
    response(message.id, {});
  } else if (message.method === 'tools/list') {
    response(message.id, { tools: TOOLS });
  } else if (message.method === 'tools/call') {
    callTool(message.params?.name, message.params?.arguments || {})
      .then(result => response(message.id, result))
      .catch(error => response(message.id, toolResult(error.message || 'Ollama request failed.', true)));
  } else if (message.id !== undefined) {
    rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
});
