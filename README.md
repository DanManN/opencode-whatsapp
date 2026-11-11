# OpenCode WhatsApp Agent Plugin

Chat with your [OpenCode](https://opencode.ai) sessions and handle permissions/questions directly from WhatsApp.

## Features

- **Chat**: Send text messages to prompt your active OpenCode session, in any project (V2).
- **Approvals**: React to permission prompts with 👍 (once), ✅ (always), or 👎 (reject).
- **Questions**: Answer multi-choice or custom agent questions by replying with numbers or text (V1). On V2,
  WhatsApp sessions have the question tool turned off, so the agent asks in plain text, until OpenCode lets
  plugins answer forms ([#59655](https://github.com/anomalyco/opencode/pull/59655)).
- **Session & Model Management**: Switch sessions, list models, and check status using simple WhatsApp commands.

---

## Installation & Setup

1. **Add the plugin** to OpenCode:
   - **V2**: Add via git spec using `opencode plugin add https://github.com/DanManN/opencode-whatsapp.git#main` or place `src/index.ts` in `~/.config/opencode/plugins/whatsapp-agent.ts`.
   - **V1**: Supported natively via server plugin loading.

2. **Configure your API Key**:
   Get an API key from your WhatsApp Agent chat info, then supply it via:
   - Environment variable: `WHATSAPP_AGENT_API_KEY=your_key`
   - Key file (mode 600): `~/.config/opencode/whatsapp-agent.key`

3. **V2: keep projects loaded.** OpenCode unloads a project after 60 idle minutes, and the plugin stops with
   the last loaded project. Add to `~/.config/opencode/opencode.json`:
   ```json
   "experimental": { "location_idle_timeout": false }
   ```

---

## WhatsApp Commands

- Any text → Prompts your current session
- `/new [title]` → Start a new session (V2: in the `/cd` project)
- `/sessions` → List recent sessions (V2: across projects)
- `/use <n>` → Switch to session `n`
- `/cd [n | path]` → V2: list projects, or pick where new sessions go
- `/models [text]` → List available models
- `/model [n | provider/model]` → Show or switch model
- `/stop` → Abort running turn
- `/status` → Show status & pending approvals
- `/skip` → Skip active question
