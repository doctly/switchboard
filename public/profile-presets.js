// profile-presets.js — built-in profile templates for common Claude Code
// backends. Selecting a preset opens the profile editor pre-filled with the
// template's name + env vars; the user fills the system env-var that holds
// their auth token (e.g. DEEPSEEK_API_KEY) and saves.
//
// Auth tokens are intentionally referenced as "$XXX_API_KEY" rather than
// hard-coded — that way these presets can be checked into a repo without
// leaking secrets, and each user just sets the corresponding env var on
// their host (setx on Windows, ~/.zshrc on mac/linux, etc.).
//
// Sources (verified against official provider docs, 2026):
//   - DeepSeek: https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
//   - Z.ai (GLM): https://docs.z.ai/scenario-example/develop-tools/claude
//   - OpenRouter: https://openrouter.ai/docs/guides/coding-agents/claude-code-integration

(function () {
  const PROFILE_PRESETS = [
    {
      key: 'anthropic',
      name: 'Anthropic (Claude Code default)',
      summary: 'Pass-through profile — uses Anthropic with $ANTHROPIC_API_KEY from your host env.',
      env: {
        // Empty values are explicitly cleared at spawn — we don't want a
        // stale BASE_URL from a previous profile leaking through. The auth
        // token is read from the user's standard env var name.
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_AUTH_TOKEN: '$ANTHROPIC_API_KEY',
      },
      tokenEnvHint: 'ANTHROPIC_API_KEY',
    },
    {
      key: 'deepseek',
      name: 'DeepSeek',
      summary: "DeepSeek's Anthropic-compatible endpoint. Set DEEPSEEK_API_KEY on your host.",
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: '$DEEPSEEK_API_KEY',
        ANTHROPIC_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
        CLAUDE_CODE_EFFORT_LEVEL: 'max',
      },
      tokenEnvHint: 'DEEPSEEK_API_KEY',
    },
    {
      key: 'glm',
      name: 'GLM (Z.ai)',
      summary: 'Z.ai GLM-5.x via Anthropic-compatible endpoint. Set ZAI_API_KEY on your host.',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: '$ZAI_API_KEY',
        // Long timeout — GLM's reasoning mode can take a while.
        API_TIMEOUT_MS: '3000000',
        // Z.ai docs recommend leaving model mapping to the server, but we
        // include the defaults explicitly so behaviour is reproducible.
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
      },
      tokenEnvHint: 'ZAI_API_KEY',
    },
    {
      key: 'openrouter',
      name: 'OpenRouter',
      summary: 'OpenRouter\'s Anthropic skin — failover across providers. Set OPENROUTER_API_KEY on your host.',
      env: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_AUTH_TOKEN: '$OPENROUTER_API_KEY',
        // OpenRouter docs explicitly require ANTHROPIC_API_KEY to be empty
        // (not unset) to prevent the SDK preferring it over AUTH_TOKEN.
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-4.7',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-4.6',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4.5',
        CLAUDE_CODE_SUBAGENT_MODEL: 'anthropic/claude-opus-4.7',
      },
      tokenEnvHint: 'OPENROUTER_API_KEY',
    },
  ];

  window.PROFILE_PRESETS = PROFILE_PRESETS;
})();
