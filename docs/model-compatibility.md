# Claude-Family Model Compatibility (Request Profiles)

Kode is **Kode-first** and works with many providers (Anthropic, OpenAI‑compatible gateways, and others). Some gateways (including Claude proxies and certain GLM/Minimax/Kimi endpoints that surface Claude-family models) enforce a specific **client fingerprint** (headers/UA/system prompt/tools) and may reject third‑party clients even when credentials are correct.

This document explains Kode’s _compatibility request profiles_ for Claude‑family models: when they are used, what they change, and how to troubleshoot.

## Goals

- Preserve Kode’s default behavior for normal providers.
- Add an **opt-in / fallback** path to handle “restricted client” providers for Claude‑family models.
- Keep the logic provider‑agnostic: no telemetry, no vendor‑only side channels, and no required environment variables.

## When Compatibility Profiles Apply

Kode only considers these profiles when the configured model name contains `claude` (case‑insensitive) and a request fails with a “restricted client” signal.

In the implementation this is represented by the internal error category `restricted_client_only`, which is derived from HTTP status + error text classification. Network/auth/billing failures do **not** advance to compatibility profiles. If auto‑detection is inconclusive, users can choose a strategy manually during model setup.

## Profile Levels

Kode implements a staged fallback plan (and also allows manual selection via model setup UI):

1. **Kode default**: Kode headers + Kode system prompt + full Kode built-in tools
2. **Compatibility headers**: compatibility headers/UA + Kode system prompt + full Kode built-in tools
3. **Compatibility headers + prompt**: compatibility headers/UA + compatibility system prompt + full Kode built-in tools
4. **Compatibility full**: compatibility headers/UA + compatibility system prompt + baseline built-in tools only
   - Kode keeps dynamically-mounted MCP tools (`mcp__*`) enabled in this mode.
   - Compatibility prompts intentionally omit Kode-specific prompt additions (such as Output Styles and permission summaries) to preserve a strict fingerprint.

Implementation entry points:

- Fallback plan + restricted-client classification: `packages/core/src/ai/llm/restrictedClientCompat.ts`
- Main query loop wiring (per-step headers/prompt/tools): `packages/core/src/ai/llm.ts`

## Connection Test (Tool-Use Verification)

Model setup includes a **real tool-use verification** step to detect “API responds but agent/tool use fails” cases.

Behavior (Anthropic `/v1/messages` and OpenAI-compatible endpoints):

- Force a `Write` tool call in the request (`tool_choice`).
- If a provider rejects the forced tool choice (HTTP 400 whose message names `tool_choice`, as thinking/reasoning modes do), retry the request once with `tool_choice` set to `auto`.
- Locally execute the returned tool call with Kode’s real `Write` tool implementation.
- Verify the file exists and content matches expected output.
- Retry network/timeout failures up to 3 times with incremental backoff (+5s each retry) and display progress in the UI.

Implementation:

- Anthropic test: `apps/cli/src/ui/components/ModelSelector/flow/actions/connectionTest/testAnthropicMessagesEndpoint.ts`
- OpenAI-compatible test: `apps/cli/src/ui/components/ModelSelector/flow/actions/connectionTest/testChatEndpoint.ts`
- UI progress rendering: `apps/cli/src/ui/components/ModelSelector/flow/screens/ConnectionTestScreen.tsx`

## Troubleshooting Guidance (User-Facing)

Common outcomes:

- **Auth/Billing errors**: fix API key, permissions, or balance; compatibility profiles will not help.
- **Network/Timeout**: the test retries automatically; check proxy/DNS/firewall if it continues failing.
- **Tool use unsupported**: the API replies, but the model/provider doesn’t reliably produce tool calls; switch to a stronger/newer model that supports tool use well.
- **Restricted client**: try a more aggressive request strategy (Compatibility headers → Compatibility headers + prompt → Compatibility full).

## Notes

- Compatibility profiles exist to maximize interoperability for Claude‑family models across diverse providers.
- Kode does not claim affiliation with any upstream client; these profiles are only used as a fallback/option to satisfy provider constraints.
