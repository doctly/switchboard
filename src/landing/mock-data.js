const now = Date.now();
const mins = (n) => new Date(now - n * 60 * 1000).toISOString();
const hours = (n) => new Date(now - n * 60 * 60 * 1000).toISOString();
const days = (n) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

export const MOCK_ACTIVE_PTY_IDS = new Set(['sess-001', 'sess-004']);

export const MOCK_PROJECTS = [
  {
    projectPath: '/Users/demo/Projects/wooton-pad',
    sessions: [
      {
        sessionId: 'sess-001',
        name: 'Add landing page + interactive demo',
        aiTitle: 'GitHub Pages marketing site with Vue components',
        modified: mins(28),
        messageCount: 62,
        starred: false, archived: false, type: 'claude', slug: null,
      },
      {
        sessionId: 'sess-002',
        name: 'Fix session fork detection',
        aiTitle: 'Session transition JSONL matching logic',
        modified: days(2),
        messageCount: 38,
        starred: true, archived: false, type: 'claude', slug: null,
      },
      {
        sessionId: 'sess-003',
        name: 'OAuth integration refactor',
        aiTitle: 'Multi-account credential separation',
        modified: days(4),
        messageCount: 94,
        starred: false, archived: false, type: 'claude', slug: null,
      },
    ],
  },
  {
    projectPath: '/Users/demo/Projects/my-api',
    sessions: [
      {
        sessionId: 'sess-004',
        name: 'Add rate limiting middleware',
        aiTitle: 'Token bucket algorithm for Express.js routes',
        modified: mins(51),
        messageCount: 29,
        starred: false, archived: false, type: 'claude', slug: null,
      },
      {
        sessionId: 'sess-005',
        name: 'Database migration for v2',
        aiTitle: 'PostgreSQL schema migration with zero downtime',
        modified: hours(26),
        messageCount: 115,
        starred: false, archived: false, type: 'claude', slug: null,
      },
    ],
  },
  {
    projectPath: '/Users/demo/Projects/blog-redesign',
    sessions: [
      {
        sessionId: 'sess-006',
        name: 'Homepage hero section',
        aiTitle: 'Responsive hero with animated gradient background',
        modified: hours(2),
        messageCount: 47,
        starred: true, archived: false, type: 'claude', slug: null,
      },
      {
        sessionId: 'sess-007',
        name: 'Mobile navigation menu',
        aiTitle: 'Accessible hamburger menu with CSS animations',
        modified: days(2),
        messageCount: 33,
        starred: false, archived: false, type: 'claude', slug: null,
      },
    ],
  },
];

export const MOCK_ACCOUNTS = [
  { id: 'default', name: 'Personal', configDir: '~/.claude (default)' },
  { id: 'work', name: 'Work', configDir: '~/.claude-work' },
];

export const MOCK_USAGE = {
  default: { session: 42, weekAll: 68, sessionResetIn: '3h', weekAllResetIn: '2d' },
  work: { session: 15, weekAll: 31, sessionResetIn: '4h', weekAllResetIn: '5d' },
};

export const MOCK_PLANS = [
  {
    filename: 'implement-rate-limiting.md',
    title: 'Implement rate limiting middleware',
    modified: hours(3),
  },
  {
    filename: 'database-migration-plan.md',
    title: 'Zero-downtime PostgreSQL migration',
    modified: days(1),
  },
];

export const MOCK_MEMORIES = {
  global: {
    files: [
      {
        filename: 'CLAUDE.md',
        filePath: '/Users/demo/.claude/CLAUDE.md',
        displayPath: '~/.claude/CLAUDE.md',
        modified: days(3),
      },
    ],
  },
  projects: [
    {
      folder: '/Users/demo/Projects/my-api',
      shortName: 'my-api',
      projectPath: '/Users/demo/Projects/my-api',
      files: [
        {
          filename: 'CLAUDE.md',
          filePath: '/Users/demo/Projects/my-api/CLAUDE.md',
          displayPath: '~/Projects/my-api/CLAUDE.md',
          modified: hours(5),
        },
        {
          filename: 'memory.md',
          filePath: '/Users/demo/Projects/my-api/.claude/memory.md',
          displayPath: '~/Projects/my-api/.claude/memory.md',
          modified: days(1),
        },
      ],
    },
    {
      folder: '/Users/demo/Projects/wooton-pad',
      shortName: 'wooton-pad',
      projectPath: '/Users/demo/Projects/wooton-pad',
      files: [
        {
          filename: 'CLAUDE.md',
          filePath: '/Users/demo/Projects/wooton-pad/CLAUDE.md',
          displayPath: '~/Projects/wooton-pad/CLAUDE.md',
          modified: hours(2),
        },
      ],
    },
  ],
};

export const MOCK_PROJECT_DETAIL = {
  '/Users/demo/Projects/my-api': {
    branch: 'feat/rate-limiting',
    totalAdded: 168,
    totalDeleted: 12,
    changedFiles: [
      { file: 'src/middleware/rate-limit.js', added: 89, deleted: 0 },
      { file: 'src/routes/api.js', added: 12, deleted: 3 },
      { file: 'test/rate-limit.test.js', added: 65, deleted: 0 },
      { file: 'package.json', added: 2, deleted: 1 },
    ],
    commits: [
      { hash: 'a3f8c21', message: 'feat: add token bucket rate limiter', author: 'demo', date: '2d ago' },
      { hash: 'b91e4f7', message: 'feat: add middleware scaffolding', author: 'demo', date: '3d ago' },
      { hash: 'c45d2a9', message: 'chore: initial Express setup', author: 'demo', date: '5d ago' },
      { hash: 'd73e1b4', message: 'docs: add README and contributing guide', author: 'demo', date: '6d ago' },
    ],
    containers: [
      { name: 'my-api-postgres-1', state: 'running', status: 'Up 2 hours' },
      { name: 'my-api-redis-1', state: 'running', status: 'Up 2 hours' },
    ],
    worktreePaths: [],
    readmePath: null,
  },
};

export const MOCK_PROJECT_INFO = {
  '/Users/demo/Projects/my-api': {
    branch: 'feat/rate-limiting',
    added: 47,
    deleted: 12,
    sizeMb: 2.4,
    containers: [
      { name: 'my-api-postgres-1', state: 'running', status: 'Up 2 hours' },
      { name: 'my-api-redis-1', state: 'running', status: 'Up 2 hours' },
      { name: 'my-api-app-1', state: 'running', status: 'Up 1 hour' },
    ],
  },
  '/Users/demo/Projects/wooton-pad': {
    branch: 'main',
    added: 128,
    deleted: 34,
    sizeMb: 8.1,
    containers: [],
  },
  '/Users/demo/Projects/blog-redesign': {
    branch: 'feat/homepage-hero',
    added: 22,
    deleted: 5,
    sizeMb: 0.8,
    containers: [],
  },
};

const AVATAR_PALETTE = ['#e05c3b', '#5b9dff', '#34d399', '#f0b429', '#b48cf2', '#f68b86', '#38bdf8', '#fb923c'];

export function getProjectAvatar(projectPath) {
  const name = (projectPath || '').split('/').filter(Boolean).pop() || '?';
  const initials = name.slice(0, 2).toUpperCase();
  let hash = 0;
  for (const ch of projectPath) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffff;
  const color = AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
  return { initials, color };
}

export const MOCK_TERMINAL_LINES = {
  'sess-001': [
    { t: 'cmd', v: '$ claude code' },
    { t: 'info', v: 'Claude Code 1.0.17' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Read src/vue/components/SidebarApp.vue' },
    { t: 'ok', v: '✓ Read src/vue/store.js' },
    { t: 'ok', v: '✓ Created src/landing/mock-data.js' },
    { t: 'ok', v: '✓ Created src/landing/LandingApp.vue' },
    { t: 'spin', v: 'Writing vite.landing.config.js' },
  ],
  'sess-004': [
    { t: 'cmd', v: '$ claude code' },
    { t: 'info', v: 'Claude Code 1.0.17' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Read src/middleware/auth.js' },
    { t: 'ok', v: '✓ Read package.json' },
    { t: 'ok', v: '✓ Created src/middleware/rate-limit.js' },
    { t: 'spin', v: 'Running test suite' },
  ],
  'sess-002': [
    { t: 'cmd', v: '$ claude code --fork' },
    { t: 'info', v: 'Claude Code 1.0.17' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Fixed fork detection in session-transitions.js' },
    { t: 'ok', v: '✓ Updated JSONL parent matching logic' },
    { t: 'ok', v: '✓ All 14 tests passed' },
    { t: 'done', v: '● Session ended · 38 messages' },
  ],
  'sess-003': [
    { t: 'cmd', v: '$ claude code' },
    { t: 'info', v: 'Claude Code 1.0.17' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Refactored auth credential handling' },
    { t: 'ok', v: '✓ Separated account config directories' },
    { t: 'ok', v: '✓ Updated shell-profiles.js' },
    { t: 'done', v: '● Session ended · 94 messages' },
  ],
  'sess-005': [
    { t: 'cmd', v: '$ claude code' },
    { t: 'info', v: 'Claude Code 1.0.17' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Created migration 0042_user_schema.sql' },
    { t: 'ok', v: '✓ Added backfill script for 50M rows' },
    { t: 'ok', v: '✓ Tested with pg_dump rollback' },
    { t: 'done', v: '● Session ended · 115 messages' },
  ],
  'sess-006': [
    { t: 'cmd', v: '$ claude code' },
    { t: 'info', v: 'Claude Code 1.0.17' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Designed hero layout with CSS Grid' },
    { t: 'ok', v: '✓ Added animated gradient background' },
    { t: 'ok', v: '✓ Responsive breakpoints for mobile' },
    { t: 'done', v: '● Session ended · 47 messages' },
  ],
  'sess-007': [
    { t: 'cmd', v: '$ claude code' },
    { t: 'info', v: 'Claude Code 1.0.17' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Built accessible hamburger menu' },
    { t: 'ok', v: '✓ Added focus-trap for keyboard nav' },
    { t: 'ok', v: '✓ CSS slide animation (no JS)' },
    { t: 'done', v: '● Session ended · 33 messages' },
  ],
};
