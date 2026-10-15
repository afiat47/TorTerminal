'use strict';
// "Claude Code" connection mode. Like the VS Code extension, it runs the local
// Claude Code (through the Claude Agent SDK, which bundles it) and so uses your
// existing Claude Code login. Claude Code's own tools are switched off; it only
// gets TorTerminal's terminal tools, which still go through browser approval.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const store = require('./store');

const WORKDIR = path.join(store.DATA_DIR, 'claude-code');
fs.mkdirSync(WORKDIR, { recursive: true });
const ENV = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'torterminal/1.0.0' };

const CC_MODELS = [
  { id: '', name: 'Claude Code default' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
];

let sdkPromise = null;
const loadSdk = () => (sdkPromise = sdkPromise || import('@anthropic-ai/claude-agent-sdk'));

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} timed out`)), ms))]);

async function* idlePrompt() {
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// Login status (reads account info only, spends no tokens)
// ---------------------------------------------------------------------------

let statusCache = null;
async function ccStatus(force = false) {
  if (!force && statusCache && Date.now() - statusCache.at < 5 * 60000) return statusCache.value;
  let value;
  try {
    const { query } = await loadSdk();
    const q = query({ prompt: idlePrompt(), options: { tools: [], settingSources: [], persistSession: false, cwd: WORKDIR, env: ENV } });
    try {
      const info = await withTimeout(q.accountInfo(), 30000, 'Starting Claude Code');
      const signedIn = !!(info.email || info.subscriptionType || (info.apiKeySource && info.apiKeySource !== 'none') || (info.tokenSource && info.tokenSource !== 'none'));
      value = signedIn
        ? { connected: true, source: 'Claude Code login', account: info.email || '', plan: info.subscriptionType || info.apiKeySource || '' }
        : { connected: false, error: 'Claude Code is not signed in. Open Claude Code (in VS Code or by running "claude" in a terminal) and use /login, then click "Check again".' };
    } finally {
      q.close();
    }
  } catch (e) {
    value = { connected: false, error: 'Could not start Claude Code: ' + e.message };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// Tools: JSON-schema definitions (shared with API mode) -> SDK MCP tools
// ---------------------------------------------------------------------------

function zodShape(schema) {
  const shape = {};
  const required = new Set(schema.required || []);
  for (const [key, p] of Object.entries(schema.properties || {})) {
    let t = p.enum ? z.enum(p.enum) : p.type === 'integer' ? z.number().int() : z.string();
    if (p.description) t = t.describe(p.description);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

const ASSISTANT_ERRORS = {
  authentication_failed: 'Claude Code is not signed in (or the login expired). Run /login in Claude Code.',
  oauth_org_not_allowed: 'Your organization does not allow this login to be used here.',
  billing_error: 'Billing problem on the Claude account.',
  rate_limit: 'You have hit your Claude usage limit. Try again later.',
  overloaded: 'Claude is overloaded right now. Try again shortly.',
  model_not_found: 'That model is not available on your Claude plan. Pick another model.',
};

/**
 * Run one user turn through Claude Code.
 * @param ctx { conv, text, cfg, systemPrompt, tools, emit(m), callTool(block) }
 */
async function runTurn({ conv, text, cfg, systemPrompt, tools, emit, callTool }) {
  const { query, createSdkMcpServer, tool } = await loadSdk();

  const server = createSdkMcpServer({
    name: 'torterminal',
    version: '1.0.0',
    tools: tools.map((def) =>
      tool(def.name, def.description, zodShape(def.input_schema), async (args) => {
        const block = { id: 'cc_' + crypto.randomUUID(), name: def.name, input: args };
        const r = await callTool(block);
        emit({ t: 'toolDone', id: block.id, content: r.content, isError: r.isError });
        return { content: [{ type: 'text', text: r.content || '(no output)' }], isError: !!r.isError };
      })
    ),
  });

  const allowed = tools.map((t) => `mcp__torterminal__${t.name}`);
  const abort = new AbortController();
  let stderr = '';
  const q = query({
    prompt: text,
    options: {
      systemPrompt,
      tools: [], // no Claude Code built-ins (Bash, file editing…) on the server machine
      mcpServers: { torterminal: server },
      allowedTools: allowed,
      canUseTool: async (name, input) =>
        allowed.includes(name) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only TorTerminal terminal tools are available here.' },
      settingSources: [], // don't load the user's coding settings, hooks or CLAUDE.md
      includePartialMessages: true,
      resume: conv.sessionId || undefined,
      model: cfg.ccModel || undefined,
      effort: cfg.effort,
      thinking: { type: 'adaptive', display: 'summarized' },
      maxTurns: 50,
      cwd: WORKDIR,
      env: ENV,
      abortController: abort,
      stderr: (d) => (stderr = (stderr + d).slice(-4000)),
    },
  });
  conv.cancel = () => {
    q.interrupt().catch(() => {});
    setTimeout(() => abort.abort(), 1500);
  };

  const streamed = new Set();
  let currentId = null;
  try {
    for await (const msg of q) {
      if (msg.session_id) conv.sessionId = msg.session_id;
      if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
        const ev = msg.event;
        if (ev.type === 'message_start') currentId = ev.message.id;
        else if (ev.type === 'content_block_start') emit({ t: 'block', kind: ev.content_block.type });
        else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') emit({ t: 'delta', text: ev.delta.text });
          else if (ev.delta.type === 'thinking_delta') emit({ t: 'thinking', text: ev.delta.thinking });
          if (currentId) streamed.add(currentId);
        }
      } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
        if (msg.error) emit({ t: 'error', msg: ASSISTANT_ERRORS[msg.error] || `Claude Code error: ${msg.error}` });
        // Only render here what partial streaming did not already show.
        if (!streamed.has(msg.message.id)) {
          for (const b of msg.message.content || []) {
            if (b.type === 'text' && b.text) emit({ t: 'block', kind: 'text' }), emit({ t: 'delta', text: b.text });
          }
        }
      } else if (msg.type === 'rate_limit_event') {
        const info = msg.rate_limit_info || {};
        const resets = info.resetsAt ? `, resets ${new Date(info.resetsAt * 1000).toLocaleString()}` : '';
        if (info.status === 'rejected') emit({ t: 'notice', msg: `You've reached your Claude usage limit${resets}.`, level: 'error' });
        else if (info.status === 'allowed_warning') emit({ t: 'notice', msg: `Approaching your Claude usage limit${resets}.` });
      } else if (msg.type === 'result') {
        const u = msg.usage || {};
        emit({ t: 'turn', model: Object.keys(msg.modelUsage || {})[0] || '', usage: { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 } });
        if (msg.subtype === 'error_max_turns') emit({ t: 'notice', msg: 'Stopped after 50 steps. Say "continue" to keep going.' });
        else if (msg.subtype !== 'success' && !conv.stopped) emit({ t: 'error', msg: `Claude Code stopped: ${(msg.errors && msg.errors.join('; ')) || msg.subtype}` });
      }
    }
  } catch (e) {
    if (!conv.stopped) throw new Error(`Claude Code: ${e.message}${stderr ? '\n' + stderr.trim().split('\n').slice(-3).join('\n') : ''}`);
  } finally {
    conv.cancel = null;
  }
}

module.exports = { ccStatus, runTurn, CC_MODELS };
