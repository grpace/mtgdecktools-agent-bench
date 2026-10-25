/**
 * How to seat each harness: MCP config snippets (`bench seats`) and headless launch commands (`bench play`).
 *
 * Every seat `bench play` starts gets two private folders (docs/HARNESSES.md "How headless launch works"):
 *   work  an empty working directory outside any git repo, so no project instructions (CLAUDE.md, AGENTS.md,
 *         GEMINI.md) or repo files reach the seat;
 *   home  the harness's own config for this seat only (the mtg MCP server and nothing else), so your global
 *         config, global MCP servers, plugins and hooks don't load. The seat URL is written there, not put in argv.
 * and only the seat's MCP tools: shell, file and web tools are removed or denied as far as each harness allows
 * (`isolation` says how far, and the setup Confirmation repeats it). Flags were checked against each harness's docs
 * and `--help` on 2026-10-22. Any other MCP client is seated by hand (docs/HARNESSES.md).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NEUTRAL_SEAT_RE, neutralSeatName } from '../../packages/director/src/seat-names.js';
import { under } from './trust.js';
import { CONCRETE_EFFORTS, launchSpec, registry } from '../../packages/registry/src/index.js';

/** The seat's tools: v4 events offer get_set_context, older ones get_set_primer; allowing both is harmless. */
export const MCP_TOOLS = ['wait_for_decision', 'decide', 'get_view', 'get_card', 'get_game_log', 'get_set_context', 'get_set_primer', 'report_rules_issue'];

export interface Seat {
  name: string;
  url: string;
  harness?: string;
  model?: string;
  effort?: string;
  context_policy?: string;
  /** The model name to launch when it differs from the registry's launch string (SeatSpec.launchModel). */
  launch_model?: string;
}

/** The seat's private folders (see the header); placeholders in `--dry-run`. */
export interface LaunchCtx {
  home: string;
  work: string;
}

export interface Launch {
  cmd: string;
  args: string[];
  /** Env changes: string to set, null to unset. */
  env: Record<string, string | null>;
  /** Files to write inside the seat's working directory before launching (relative path → content). */
  files: Record<string, string>;
  /** Files to write inside the seat's private config folder (relative path → content). */
  homeFiles?: Record<string, string>;
  /** Sign-in files to link into the config folder (relative path → your file), when they exist. */
  links?: Record<string, string>;
  /** Pass the join prompt on stdin instead of as an argument. */
  stdinPrompt?: boolean;
}

export interface LaunchOpts {
  useApiKey?: boolean;
  /** Arguments that set the effort level (registry `launchSpec`; empty when the level is in the model string). */
  effortArgs?: string[];
  /** Path of the scripted random player (scripts/mcp-random-agent.mjs, or dist/random-agent.mjs in the package). */
  randomAgent?: string;
  /** The seat's folders (placeholders when not given: `--dry-run`, version checks). */
  ctx?: LaunchCtx;
}

export interface Isolation {
  /** full: no tool but the seat's MCP tools can run; partial: some built-in tools remain (`note` says which). */
  level: 'full' | 'partial';
  note: string;
}

export interface HarnessInfo {
  id: string;
  aliases: string[];
  label: string;
  /** How effort maps onto the harness, for docs and warnings. */
  effortNote: string;
  /** A test player, not an LLM: only for checking a setup end to end. */
  test?: boolean;
  /** How far `bench play` can shut the seat in (launchable harnesses). */
  isolation?: Isolation;
  /**
   * Launchable harnesses: whether `bench play` has started this harness for a real table (`tested`), or it is supported
   * from its documentation but has never run on a real install (`untested`). Said up front in `check` and `setup`.
   */
  support?: 'tested' | 'untested';
  /** Variables of yours its sign-in needs, on top of BASE_ENV_ALLOW (seatEnv). */
  envAllow?: EnvAllow;
  launch?: (seat: Seat, prompt: string, opts: LaunchOpts) => Launch;
  /** A one-message check without the game (bench setup's preflight): the same isolation as `launch`, no MCP server. */
  preflight?: (model: string | undefined, effortArgs: string[], prompt: string, opts: { useApiKey?: boolean; ctx?: LaunchCtx }) => Launch;
  snippet: (seat: Seat) => string;
}

const json = (o: unknown) => JSON.stringify(o, null, 2);
const PLACEHOLDER: LaunchCtx = { home: '<seat-config>', work: '<seat-dir>' };
const ctxOf = (o: { ctx?: LaunchCtx }) => o.ctx ?? PLACEHOLDER;
/** A TOML basic string (the URL is checked to plain characters before it gets here; this escapes anyway). */
const toml = (s: string) => JSON.stringify(s);

/** A variable name, or a pattern of names, a seat's environment may take from yours. */
export type EnvRule = string | RegExp;

/**
 * What every seat's environment takes from yours (CLI-5): the basics a CLI needs to run (paths, locale, terminal, temp
 * folders, the XDG folders where sign-ins and data live, the session bus a keyring sign-in uses), proxy and CA settings,
 * and the Windows basics. Nothing else: not the bench's own tokens, not the variables of the session that runs `bench`
 * (a coding agent's CLAUDE_EFFORT, CLAUDE_CODE_SESSION_ID or messaging socket would reach the seat's harness, which
 * reads some of them), not other tools' tokens. A harness adds the variables its sign-in needs (`envAllow`).
 */
export const BASE_ENV_ALLOW: readonly EnvRule[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'USERNAME', 'SHELL', 'LANG', 'LANGUAGE', /^LC_[A-Z_]+$/, 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  /^(HTTP|HTTPS|NO|ALL)_PROXY$/i, 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  /^(SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMDATA|HOMEDRIVE|HOMEPATH)$/i,
];

/** Variables a harness's sign-in needs: always, and with `--use-api-key` only (API keys and provider switches). */
export interface EnvAllow {
  always?: EnvRule[];
  apiKey?: EnvRule[];
}

const allowed = (k: string, rules: readonly EnvRule[]) => rules.some((r) => (typeof r === 'string' ? r === k : r.test(k)));

/**
 * The environment a seat's harness runs with: only the allowlisted variables of yours (BASE_ENV_ALLOW and the harness's
 * `envAllow`; its API-key variables only with `--use-api-key`), then the launch's own changes (string to set, null to
 * unset). `harness` is the harness id; without one only the base list passes.
 */
export function seatEnv(base: NodeJS.ProcessEnv, changes: Record<string, string | null>, opts: { harness?: string; useApiKey?: boolean } = {}): NodeJS.ProcessEnv {
  const extra = harnessFor(opts.harness)?.envAllow;
  const rules = [...BASE_ENV_ALLOW, ...(extra?.always ?? []), ...(opts.useApiKey ? extra?.apiKey ?? [] : [])];
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v != null && allowed(k, rules)) out[k] = v;
  for (const [k, v] of Object.entries(changes)) if (v == null) delete out[k]; else out[k] = v;
  return out;
}

/** A seat's private folders: `<tmp>/mtgdt-seat-<name>-XXXX/{work,config}` (0700). Remove `root` when done. */
export function seatDirs(name: string): LaunchCtx & { root: string } {
  const root = mkdtempSync(join(tmpdir(), `mtgdt-seat-${name.replace(/[^\w.-]/g, '_')}-`));
  const ctx = { root, work: join(root, 'work'), home: join(root, 'config') };
  mkdirSync(ctx.work, { mode: 0o700 });
  mkdirSync(ctx.home, { mode: 0o700 });
  return ctx;
}

/** Write a launch's files (work), config (home) and sign-in links (where your files exist) into the seat's folders. */
export function prepareSeat(l: Launch, ctx: LaunchCtx): void {
  for (const [root, files] of [[ctx.work, l.files], [ctx.home, l.homeFiles ?? {}]] as const) {
    for (const [f, c] of Object.entries(files)) {
      const p = under(root, f);
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, c, { mode: 0o600 });
    }
  }
  for (const [f, target] of Object.entries(l.links ?? {})) {
    if (!existsSync(target)) continue;
    const p = under(ctx.home, f);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    symlinkSync(target, p);
  }
}

/**
 * After a session: a harness that refreshed its sign-in by replacing a linked file (write and rename) left the new
 * credentials in the seat's folder. Copy them back, so your own login doesn't keep a used-up refresh token.
 */
export function finishSeat(l: Launch, ctx: LaunchCtx): void {
  for (const [f, target] of Object.entries(l.links ?? {})) {
    try {
      const p = under(ctx.home, f);
      if (!existsSync(p) || lstatSync(p).isSymbolicLink() || !existsSync(target)) continue;
      if (statSync(p).mtimeMs > statSync(target).mtimeMs) copyFileSync(p, target);
    } catch {
      // best effort: the harness asks you to sign in again at worst
    }
  }
}

export const removeSeatDirs = (root: string) => rmSync(root, { recursive: true, force: true });

/** Claude Code's project folder for a working directory: <config>/projects/<the path with every other character as "-">. */
export const claudeProjectDir = (work: string, env = process.env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));

/**
 * After a session: remove the project folder a harness made for the seat's temp working directory (Claude Code keeps
 * one per directory in ~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects). saveEffortRecord already removes it when
 * it found the session record; this also covers a session stopped before it wrote one (a signal, a crash).
 */
export function removeHarnessProject(harness: string, work: string): void {
  if (harness !== 'claude-code' || !/mtgdt-/.test(work)) return;
  const dir = claudeProjectDir(work);
  if (dir.includes('mtgdt-')) rmSync(dir, { recursive: true, force: true });
}

const helpCache = new Map<string, string>();
/** Whether `cmd --help` mentions a flag (for flags newer versions added; cached). */
function supports(cmd: string, flag: string): boolean {
  if (!helpCache.has(cmd)) {
    const r = spawnSync(cmd, ['--help'], { encoding: 'utf8', timeout: 15_000 });
    helpCache.set(cmd, r.error ? '' : `${r.stdout ?? ''}${r.stderr ?? ''}`);
  }
  return helpCache.get(cmd)!.includes(flag);
}

// --- Claude Code ---------------------------------------------------------------------------------------------
// --tools '' removes every built-in tool; --strict-mcp-config with an --mcp-config file loads only the seat's server;
// --restricted (2.1.300+) ignores your user, project and local settings (hooks, plugins, permissions);
// CLAUDE_CODE_DISABLE_CLAUDE_MDS keeps your global CLAUDE.md out. The session file is kept: it is the only place
// Claude Code logs the effort level (bench play copies it as session-<seat>.jsonl; preflight.ts saveEffortRecord).
const claudeIsolation = (cmd: string): string[] => (supports(cmd, '--restricted') ? ['--restricted'] : []);
const claudeEnv = (useApiKey?: boolean): Record<string, string | null> => ({
  ...(useApiKey ? {} : { ANTHROPIC_API_KEY: null }), // seats run on your Claude login unless you opt into an API key
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
});

// --- Codex CLI -----------------------------------------------------------------------------------------------
// An isolated CODEX_HOME holds only this config (your ~/.codex/config.toml and its MCP servers don't load) and a link
// to your sign-in (auth.json). The shell, web search, image and agent tools are switched off; apply_patch can't be,
// but the read-only sandbox refuses its writes. `default_tools_approval_mode` lets the mtg tools run under exec's
// "never ask" policy. Sessions (the rollout file effort detection reads) go to <home>/codex/sessions.
const codexHomeOf = (env = process.env) => env.CODEX_HOME || join(homedir(), '.codex');
function codexConfig(url?: string): string {
  return [
    'web_search = "disabled"',
    'project_doc_max_bytes = 0',
    '',
    '[features]',
    ...['shell_tool', 'view_image', 'image_generation', 'multi_agent', 'apps', 'plugins', 'tool_suggest', 'memories'].map((f) => `${f} = false`),
    ...(url ? ['', '[mcp_servers.mtg]', `url = ${toml(url)}`, 'default_tools_approval_mode = "approve"', 'tool_timeout_sec = 120', 'startup_timeout_sec = 30'] : []),
    '',
  ].join('\n');
}

// --- Gemini CLI ----------------------------------------------------------------------------------------------
// GEMINI_CLI_HOME moves ~/.gemini to the seat's folder (your settings, extensions and MCP servers don't load); the
// sign-in files are linked and your auth choice copied. No --approval-mode yolo: the mtg server is trusted, anything
// else that asks for approval is refused in headless mode, and the read-only built-ins are excluded by name.
const GEMINI_EXCLUDE = [
  'run_shell_command', 'write_file', 'replace', 'edit', 'read_file', 'read_many_files', 'glob', 'search_file_content', 'grep', 'list_directory', 'ls',
  'web_fetch', 'google_web_search', 'save_memory', 'write_todos', 'codebase_investigator', 'delegate_to_agent', 'activate_skill',
];
const geminiDirOf = (env = process.env) => join(env.GEMINI_CLI_HOME || homedir(), '.gemini');
function geminiAuth(): Record<string, unknown> {
  try {
    const u = JSON.parse(readFileSync(join(geminiDirOf(), 'settings.json'), 'utf8'));
    return {
      ...(u?.security?.auth ? { security: { auth: u.security.auth } } : {}),
      ...(typeof u?.selectedAuthType === 'string' ? { selectedAuthType: u.selectedAuthType } : {}),
    };
  } catch {
    return {};
  }
}
function geminiSettings(url?: string): string {
  return json({
    ...geminiAuth(),
    ...(url ? { mcpServers: { mtg: { httpUrl: url, trust: true, timeout: 120_000 } }, mcp: { allowed: ['mtg'] } } : {}),
    tools: { exclude: GEMINI_EXCLUDE },
  });
}
const geminiLinks = (): Record<string, string> => Object.fromEntries(['oauth_creds.json', 'google_accounts.json', 'installation_id']
  .map((f) => [`gemini/.gemini/${f}`, join(geminiDirOf(), f)]));

// --- OpenCode ------------------------------------------------------------------------------------------------
// --standalone runs a private server that honors this environment (the shared background service ignores it).
// XDG_CONFIG_HOME points at the seat's folder (no global opencode.json: plugins, MCP servers, agents); OPENCODE_CONFIG
// is the seat's config, where every tool but mtg_* is denied. Sign-in (auth.json) and sessions stay in your data folder.
// OpenCode 2.x (checked on 2.1.2, 2026-10-23) exposes MCP tools only through Code Mode's `execute` tool, and adds a
// server's tools to the catalog after the session's first step: with `execute` denied a seat has no mtg tools at all
// (`codemode: false` on the server gives no direct tools either). So `execute` is allowed; inside it every tool call is
// checked against the same rules, and OpenCode's own Code Mode tools (worktrees, sessions, models) stay denied.
const OPENCODE_BUILTINS = ['bash', 'edit', 'write', 'read', 'grep', 'glob', 'list', 'patch', 'webfetch', 'websearch', 'task', 'todowrite', 'todoread', 'skill', 'codesearch', 'lsp'];
/**
 * OpenCode Zen's free models (`opencode/<id>-free`) answer 403 FreeTierError ("can only be used from within OpenCode")
 * to a request without OpenCode's `read` tool (checked on 2.1.2, 2026-10-23: `read` alone passes; bash, glob, task,
 * skill, todowrite or webfetch alone don't). Their seats keep `read`, confined to the seat's empty working directory:
 * `external_directory` is denied, so a read anywhere else is refused (not asked: an ask hangs a headless run).
 */
export const opencodeFreeModel = (model: string | undefined) => !!model && /^opencode\/[^#]+-free(?:#.*)?$/i.test(model.trim());
export function opencodeConfig(url?: string, model?: string): string {
  const keepRead = opencodeFreeModel(model);
  return json({
    $schema: 'https://opencode.ai/config.json',
    ...(url ? { mcp: { mtg: { type: 'remote', url, enabled: true, timeout: 120_000 } } } : {}),
    // OpenCode 2.x serves MCP tools through Code Mode: the model calls them inside `execute` (tools.mtg.<tool>), and
    // each call is still checked against these rules (mtg_<tool>), so OpenCode's own Code Mode tools stay denied.
    permission: { '*': 'deny', ...(keepRead ? { read: 'allow', external_directory: 'deny' } : {}), ...(url ? { execute: 'allow', 'mtg_*': 'allow' } : {}) },
    tools: Object.fromEntries(OPENCODE_BUILTINS.filter((t) => !(keepRead && t === 'read')).map((t) => [t, false])),
  });
}
const opencodeEnv = (c: LaunchCtx): Record<string, string | null> => ({
  XDG_CONFIG_HOME: join(c.home, 'config'), OPENCODE_CONFIG: join(c.home, 'opencode.json'), OPENCODE_CONFIG_CONTENT: null, OPENCODE_CONFIG_DIR: null,
  OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
});

// --- Cursor CLI ----------------------------------------------------------------------------------------------
// HOME points at the seat's folder, so only its ~/.cursor/mcp.json (the mtg server) loads, not your global servers,
// rules, hooks or ~/.claude settings; --approve-mcps then approves that one server. XDG_CONFIG_HOME stays yours: the
// sign-in lives in ~/.config/cursor/auth.json. Permissions deny shell, writes, reads and web fetch; no --force, so
// anything else that asks for approval is refused in headless mode.
const CURSOR_PERMISSIONS = { allow: ['Mcp(mtg:*)'], deny: ['Shell(*)', 'Write(**)', 'Read(**)', 'Write(/**)', 'Read(/**)', 'WebFetch(*)'] };
const cursorConfig = () => json({ version: 1, permissions: CURSOR_PERMISSIONS, approvalMode: 'allowlist', autoAcceptWebSearch: false });
const cursorEnv = (c: LaunchCtx): Record<string, string | null> => ({
  HOME: join(c.home, 'home'), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), CURSOR_CONFIG_DIR: join(c.home, 'home', '.cursor'),
});

// --- Antigravity (by hand) -----------------------------------------------------------------------------------
// A seat's own folder with the seat's server as a workspace plugin (`.agents/plugins/mtg/`): agy loads it for sessions
// started in that folder only. Plugin servers are always namespaced `<plugin>_<server>`, so the tools show as mtg_mtg.
/** A POSIX single-quoted shell word. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const ANTIGRAVITY_SEATS_DIR = '~/mtgdt-seats';
export function antigravityFiles(url: string): Record<string, string> {
  return {
    '.agents/plugins/mtg/plugin.json': JSON.stringify({ name: 'mtg' }),
    '.agents/plugins/mtg/mcp_config.json': JSON.stringify({ mcpServers: { mtg: { url } } }),
  };
}
function antigravitySnippet(s: Seat): string {
  const spec = s.model ? launchSpec('antigravity', s.model, s.effort ?? '') : undefined;
  const model = spec?.model ?? s.model ?? '<model>-<low|medium|high>';
  const dir = `${ANTIGRAVITY_SEATS_DIR}/${s.name.replace(/[^\w.-]/g, '_')}`;
  return [
    '# Antigravity CLI (agy): a folder of its own for this seat, outside any git repository, holding only its mtg server',
    `mkdir -p ${dir}/.agents/plugins/mtg && cd ${dir}`,
    ...Object.entries(antigravityFiles(s.url)).map(([f, c]) => `printf '%s\\n' ${sq(c)} > ${f}`),
    `agy --model ${sq(model)}`,
    '# trust the folder, then paste the join prompt (`bench prompt`); /mcp shows the server as mtg_mtg.',
    '# If agy asks to allow a tool: allow the mtg_mtg tools (for the session, if it offers that), refuse anything else.',
    '# T3 Code instead: no per-thread MCP setting yet; its Antigravity threads also get T3 Code\'s own tools (docs/HARNESSES.md).',
  ].join('\n');
}

export const HARNESSES: HarnessInfo[] = [
  {
    id: 'claude-code',
    support: 'tested',
    aliases: ['claude', 'claude-code', 'cc'],
    label: 'Claude Code',
    effortNote: '--effort <low|medium|high|xhigh|max>',
    isolation: { level: 'full', note: 'no built-in tools, only the mtg MCP server; your settings, hooks, plugins and CLAUDE.md files are left out' },
    // Your Claude login: the config folder it lives in, or a long-lived token from `claude setup-token`. With
    // --use-api-key: the API key, a gateway, or Bedrock / Vertex and their cloud credentials.
    envAllow: {
      always: ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'],
      apiKey: [
        'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID',
        'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', /^AWS_[A-Z0-9_]+$/, 'CLOUD_ML_REGION', /^VERTEX_REGION_[A-Z0-9_]+$/, 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
      ],
    },
    launch: (s, prompt, opts) => {
      const c = ctxOf(opts);
      return {
        cmd: 'claude',
        args: [
          '-p', prompt,
          ...(s.model ? ['--model', s.model] : []),
          ...(opts.effortArgs ?? []),
          '--mcp-config', join(c.home, 'mcp.json'), '--strict-mcp-config',
          ...claudeIsolation('claude'),
          '--tools', '',
          '--allowedTools', MCP_TOOLS.map((t) => `mcp__mtg__${t}`).join(' '),
          '--disallowedTools', 'Bash Read Write Edit Glob Grep WebFetch WebSearch Task Agent',
          '--output-format', 'stream-json', '--verbose',
        ],
        env: claudeEnv(opts.useApiKey),
        files: {},
        homeFiles: { 'mcp.json': json({ mcpServers: { mtg: { type: 'http', url: s.url } } }) },
      };
    },
    preflight: (model, effortArgs, prompt, opts) => ({
      cmd: 'claude',
      args: ['-p', prompt, ...(model ? ['--model', model] : []), ...effortArgs, ...claudeIsolation('claude'), '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--output-format', 'stream-json', '--verbose'],
      env: claudeEnv(opts.useApiKey),
      files: {},
    }),
    snippet: (s) => [
      `claude mcp add --transport http mtg ${s.url}`,
      `# or as --mcp-config JSON:`,
      JSON.stringify({ mcpServers: { mtg: { type: 'http', url: s.url } } }),
    ].join('\n'),
  },
  {
    id: 'codex',
    support: 'untested',
    aliases: ['codex', 'codex-cli'],
    label: 'Codex CLI',
    effortNote: '-c model_reasoning_effort=<minimal|low|medium|high>',
    isolation: {
      level: 'partial',
      note: "shell, web search and image tools are switched off in a private CODEX_HOME; apply_patch can't be switched off (the read-only sandbox refuses its writes)",
    },
    // The sign-in is the linked auth.json; an API key only with --use-api-key.
    envAllow: { apiKey: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'] },
    launch: (s, prompt, opts) => {
      const c = ctxOf(opts);
      return {
        cmd: 'codex',
        args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', ...(s.model ? ['-m', s.model] : []), ...(opts.effortArgs ?? []), prompt],
        env: { CODEX_HOME: join(c.home, 'codex') },
        files: {},
        homeFiles: { 'codex/config.toml': codexConfig(s.url) },
        links: { 'codex/auth.json': join(codexHomeOf(), 'auth.json') },
      };
    },
    preflight: (model, effortArgs, prompt, opts) => ({
      cmd: 'codex',
      args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', ...(model ? ['-m', model] : []), ...effortArgs, prompt],
      env: { CODEX_HOME: join(ctxOf(opts).home, 'codex') },
      files: {},
      homeFiles: { 'codex/config.toml': codexConfig() },
      links: { 'codex/auth.json': join(codexHomeOf(), 'auth.json') },
    }),
    snippet: (s) => [
      '# ~/.codex/config.toml (or pass each line with -c)',
      '[mcp_servers.mtg]',
      `url = "${s.url}"`,
      'tool_timeout_sec = 120',
    ].join('\n'),
  },
  {
    id: 'gemini-cli',
    support: 'untested',
    aliases: ['gemini', 'gemini-cli'],
    label: 'Gemini CLI',
    effortNote: 'no effort setting: the registry records its documented default',
    isolation: {
      level: 'partial',
      note: "file, shell and web tools are switched off by name in a private GEMINI_CLI_HOME, and anything that asks for approval is refused; a built-in tool a later Gemini CLI adds that needs no approval would still be there",
    },
    // A Google sign-in (linked oauth files) may need your Cloud project; an API key or Vertex only with --use-api-key
    // (a Gemini CLI whose auth choice is an API key needs the flag).
    envAllow: {
      always: ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_GCA'],
      apiKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'],
    },
    launch: (s, prompt, opts) => {
      const settings = geminiSettings(s.url);
      return {
        cmd: 'gemini',
        args: ['-p', prompt, ...(s.model ? ['-m', s.model] : []), '--output-format', 'stream-json', '--allowed-mcp-server-names', 'mtg', '-e', 'none'],
        env: { GEMINI_CLI_HOME: join(ctxOf(opts).home, 'gemini'), GEMINI_CLI_TRUST_WORKSPACE: 'true' },
        // Also in the working directory, for versions without GEMINI_CLI_HOME.
        files: { '.gemini/settings.json': settings },
        homeFiles: { 'gemini/.gemini/settings.json': settings },
        links: geminiLinks(),
      };
    },
    preflight: (model, _effortArgs, prompt, opts) => ({
      cmd: 'gemini',
      args: ['-p', prompt, ...(model ? ['-m', model] : []), '--output-format', 'stream-json', '-e', 'none'],
      env: { GEMINI_CLI_HOME: join(ctxOf(opts).home, 'gemini'), GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      files: {},
      homeFiles: { 'gemini/.gemini/settings.json': geminiSettings() },
      links: geminiLinks(),
    }),
    snippet: (s) => [
      '# .gemini/settings.json (project) or ~/.gemini/settings.json',
      json({ mcpServers: { mtg: { httpUrl: s.url, trust: true, timeout: 120000 } } }),
    ].join('\n'),
  },
  {
    id: 'opencode',
    support: 'tested',
    aliases: ['opencode'],
    label: 'OpenCode',
    // Effort is a model variant (`--model provider/model#variant`, `opencode run --help`); the registry's
    // `model_template` builds that string (launchSpec), so the model passed here already carries it.
    effortNote: 'model variant: --model provider/model#<level>',
    isolation: { level: 'full', note: 'every tool except the mtg tools is denied (OpenCode 2 calls them through its Code Mode tool, which reaches nothing else), with a private config folder (no global plugins or MCP servers); an OpenCode Zen free model keeps read, confined to the seat\'s empty folder (Zen refuses free requests without it)' },
    // Sign-ins are in your data folder (XDG_DATA_HOME passes); provider keys only with --use-api-key.
    envAllow: {
      apiKey: [
        'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY',
        'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'CEREBRAS_API_KEY',
      ],
    },
    launch: (s, prompt, opts) => ({
      cmd: 'opencode',
      args: ['run', '--standalone', '--format', 'json', ...(s.model ? ['--model', s.model] : []), prompt],
      env: opencodeEnv(ctxOf(opts)),
      files: {},
      homeFiles: { 'opencode.json': opencodeConfig(s.url, s.model), 'config/opencode/.keep': '' },
    }),
    preflight: (model, _effortArgs, prompt, opts) => ({
      cmd: 'opencode',
      args: ['run', '--standalone', '--format', 'json', ...(model ? ['--model', model] : []), prompt],
      env: opencodeEnv(ctxOf(opts)),
      files: {},
      homeFiles: { 'opencode.json': opencodeConfig(undefined, model), 'config/opencode/.keep': '' },
    }),
    snippet: (s) => [
      '# opencode.json (project) or ~/.config/opencode/opencode.json',
      json({ $schema: 'https://opencode.ai/config.json', mcp: { mtg: { type: 'remote', url: s.url, enabled: true } } }),
    ].join('\n'),
  },
  {
    id: 'cursor',
    support: 'tested',
    aliases: ['cursor', 'cursor-agent', 'cursor-cli'],
    label: 'Cursor CLI (cursor-agent)',
    effortNote: 'level in the model name (registry launch strings, `cursor-agent models`)',
    isolation: {
      level: 'partial',
      note: "shell, file and web-fetch tools are denied by permission rules in a private HOME with only the mtg server; Cursor can't remove its built-in tools, so they are refused when called rather than gone",
    },
    // The sign-in is in XDG_CONFIG_HOME (passes); an API key only with --use-api-key.
    envAllow: { apiKey: ['CURSOR_API_KEY'] },
    launch: (s, prompt, opts) => ({
      cmd: 'cursor-agent',
      args: [
        '-p', '--output-format', 'stream-json', '--approve-mcps', '--trust', '--workspace', '.',
        // The registry's launch string names the level (claude-opus-5-5-high), so the model passed here carries it.
        ...(s.model ? ['--model', s.model] : []),
        prompt,
      ],
      env: cursorEnv(ctxOf(opts)),
      files: { '.cursor/cli.json': json({ permissions: CURSOR_PERMISSIONS }) },
      homeFiles: { 'home/.cursor/mcp.json': json({ mcpServers: { mtg: { url: s.url } } }), 'home/.cursor/cli-config.json': cursorConfig() },
    }),
    preflight: (model, _effortArgs, prompt, opts) => ({
      cmd: 'cursor-agent',
      args: ['-p', '--output-format', 'stream-json', '--trust', '--workspace', '.', ...(model ? ['--model', model] : []), prompt],
      env: cursorEnv(ctxOf(opts)),
      files: { '.cursor/cli.json': json({ permissions: { allow: [], deny: CURSOR_PERMISSIONS.deny } }) },
      homeFiles: { 'home/.cursor/cli-config.json': cursorConfig() },
    }),
    snippet: (s) => ['# .cursor/mcp.json (project) or ~/.cursor/mcp.json', json({ mcpServers: { mtg: { url: s.url } } })].join('\n'),
  },
  {
    id: 'script',
    aliases: ['script', 'scripted', 'random', 'random-agent'],
    label: 'Scripted random player',
    effortNote: 'none',
    test: true,
    launch: (s, _prompt, opts) => ({
      cmd: process.execPath,
      args: [opts.randomAgent ?? 'scripts/mcp-random-agent.mjs', s.url],
      // A steady pace (AGENT_DELAY_MS, default 150 ms per decision) keeps eight scripted seats well inside the per-seat rate limit.
      env: { AGENT_RETRY_S: '400', AGENT_DELAY_MS: process.env.AGENT_DELAY_MS ?? '150' },
      files: {},
    }),
    snippet: (s) => `node scripts/mcp-random-agent.mjs ${s.url}`,
  },
  {
    // Seated by hand (no headless launch yet). The Antigravity CLI reads MCP servers only from its global config or
    // from plugins, and a workspace's `.agents/plugins/<name>/` is a plugin (checked on agy 1.4.5, 2026-10-23: the
    // server shows as `mtg_mtg` with the seat's tools). So each seat gets a folder of its own holding the seat's
    // server, and a session started there sees that seat only, without touching your global config.
    id: 'antigravity',
    aliases: ['antigravity', 'agy', 'google-antigravity', 'antigravity-cli'],
    label: 'Antigravity',
    effortNote: 'the level is part of the model id (gemini-4-argon-high); pick that model in agy',
    snippet: (s) => antigravitySnippet(s),
  },
  {
    id: 'generic',
    aliases: ['generic', 'other', 'manual', 't3', 't3-code'],
    label: 'Any MCP client (Streamable HTTP)',
    effortNote: 'record whatever your harness calls it',
    snippet: (s) => [
      `# Streamable HTTP MCP server named "mtg" (no auth header; the token is in the URL)`,
      `url: ${s.url}`,
    ].join('\n'),
  },
];

const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function harnessFor(name: string | undefined): HarnessInfo | undefined {
  const n = (name ?? '').toLowerCase();
  const sq = squash(n);
  return HARNESSES.find((h) => h.aliases.includes(n) || h.id === n || (sq && (h.aliases.some((a) => squash(a) === sq) || squash(h.label) === sq)));
}

/** Harnesses `bench play` can launch headless, in the order they're offered. */
export const LAUNCHABLE = HARNESSES.filter((h) => h.launch);

/** Which harnesses have run real tables and which haven't yet, in one line (check, setup's seats question). */
export function harnessSupportLine(): string {
  const of = (x: 'tested' | 'untested') => LAUNCHABLE.filter((h) => !h.test && h.support === x).map((h) => registry.harnessDisplay(h.id));
  const tested = of('tested');
  const untested = of('untested');
  return `Tested on real tables: ${tested.join(', ')}.${untested.length ? ` Supported but untested (not yet run on a real install, so expect problems): ${untested.join(', ')}.` : ''}`;
}

/**
 * A harness name as typed ("Claude Code", "codex", "Gemini CLI", "T3 Code") → the id recorded for the seat:
 * a known harness's id, else a slug of the text (any MCP client can play; it is seated by hand).
 */
export function normalizeHarness(input: string): string {
  const h = harnessFor(input.trim());
  if (h && h.id !== 'generic') return h.id;
  return input.trim().toLowerCase().replace(/[^a-z0-9.:@+_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** Effort words a `--seat` spec may end with: every concrete level in the registry (including `ultra`), plus `default`, `off` and `unknown`. */
export const EFFORTS: string[] = [...CONCRETE_EFFORTS, 'default', 'off', 'unknown'];

export interface SeatSpec {
  name?: string;
  harness?: string;
  model?: string;
  effort?: string;
  /** The parts as typed ("Claude Code", "Claude Opus 5.5"): sent to the Director, which logs them next to the canonical ids. */
  declared?: { harness?: string; model?: string; effort?: string };
  /** "unknown": a hand-seated seat whose person doesn't know its effort setting (the registry records the harness default). */
  effortUnknown?: boolean;
  /** How the level is known: the CLI started the seat with it ("launch"), or a person declared it ("self-report"). */
  effortBasis?: 'launch' | 'self-report';
  /** The context policy `bench play` runs the seat with (rotation.ts): logged in event_start, set by --fresh-session. */
  contextPolicy?: 'fresh-per-match' | 'fresh-per-game';
  /**
   * The model name `bench play` launches when it isn't the registry's launch string: a name under the harness's own
   * model service (OpenCode Zen's `opencode/deepseek-v4.1-flash-free`), which counts as the canonical model but runs
   * as typed (a free variant is a different route from the paid one).
   */
  launchModel?: string;
  /** The level came from the model name (Antigravity's `gemini-4-argon-high`): no separate effort is needed. */
  effortFromName?: boolean;
}

/**
 * Parse a seat as typed: "[name=]harness/model[/effort]", spaces allowed around the slashes
 * ("Claude Code / claude-opus-5-5 / high"). A model id may itself contain slashes (OpenCode's
 * "anthropic/claude-sonnet-5-5"): the effort is the last part only when it is an effort word.
 */
export function parseSeatSpec(spec: string): SeatSpec {
  let rest = spec.trim();
  let name: string | undefined;
  const eq = rest.indexOf('=');
  if (eq > 0 && !rest.slice(0, eq).includes('/')) {
    name = rest.slice(0, eq).trim();
    rest = rest.slice(eq + 1);
  }
  const parts = rest.split('/').map((p) => p.trim()).filter(Boolean);
  const out: SeatSpec = {};
  if (name) out.name = name;
  if (!parts.length) return out;
  const rawHarness = parts.shift()!;
  out.harness = normalizeHarness(rawHarness);
  const rawEffort = parts.length >= 2 && EFFORTS.includes(parts[parts.length - 1]!.toLowerCase()) ? parts.pop()! : undefined;
  if (rawEffort?.toLowerCase() === 'unknown') out.effortUnknown = true;
  if (rawEffort) out.effort = rawEffort.toLowerCase();
  const rawModel = parts.length ? parts.join('/') : undefined;
  if (rawModel) out.model = rawModel.replace(/\s+/g, '-');
  out.declared = { harness: rawHarness, ...(rawModel ? { model: rawModel } : {}), ...(rawEffort ? { effort: rawEffort } : {}) };
  return out;
}

/**
 * Seats as typed, with optional counts: "4x Claude Code/claude-opus-5-5/high" or "Claude Code/claude-opus-5-5/high x4"
 * stand for four seats (a private table of 8 is often 4 models × 2). Commas separate several seats in one value.
 */
export function expandSeatSpecs(values: string[]): SeatSpec[] {
  const out: SeatSpec[] = [];
  for (const raw of values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)) {
    let text = raw;
    let n = 1;
    const pre = /^(\d+)\s*[x×*]\s+(.+)$/i.exec(text);
    const post = /^(.+?)\s+[x×*]\s*(\d+)$/i.exec(text);
    if (pre) [n, text] = [Number(pre[1]), pre[2]!];
    else if (post) [text, n] = [post[1]!, Number(post[2])];
    if (!(n >= 1 && n <= 8)) throw new Error(`"${raw}": a count from 1 to 8`);
    for (let i = 0; i < n; i++) out.push(parseSeatSpec(text));
  }
  return out;
}

/**
 * Seat names: neutral `seat-<hex>` at every table, like the lobby's (packages/director/src/seat-names.ts). They show
 * in logs, the spectator stream and the anonymous event status, so they never name the model: who plays each seat is
 * in its metadata. A given name is kept only if it is already neutral; `warn` hears about the others.
 */
export function seatNames(specs: SeatSpec[], warn: (m: string) => void = () => {}): string[] {
  const taken = new Set(specs.map((s) => s.name).filter((n): n is string => !!n && NEUTRAL_SEAT_RE.test(n)));
  return specs.map((s) => {
    if (s.name && NEUTRAL_SEAT_RE.test(s.name)) return s.name;
    const n = neutralSeatName(taken);
    if (s.name) warn(`seat "${s.name}" plays as ${n}: seat names are neutral at every table (the model is in the seat's metadata)`);
    return n;
  });
}

/** Whether a harness's CLI is installed here: its version line, or undefined. */
export function installedVersion(h: HarnessInfo): string | undefined {
  if (!h.launch) return undefined;
  if (h.id === 'script') return `node ${process.version}`;
  const cmd = h.launch({ name: 'x', url: 'http://x' }, '', {}).cmd;
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (r.error || r.status !== 0) return undefined;
  const line = (r.stdout || r.stderr || '').trim().split('\n')[0] || cmd;
  // "2.1.306 (Claude Code)", "opencode v2.1.2": just the version.
  return (line.match(/v?\d+(\.\d+)+[\w.+-]*/)?.[0] ?? line).replace(/^v(?=\d)/, '').slice(0, 40);
}
