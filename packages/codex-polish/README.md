# Codex Polish

Use Gemini to polish Codex replies. The rewrite appears in the same conversation.

## Setup

Install Node.js 22.16 or later and the Codex CLI with plugin support. Gemini rewrites use the Antigravity CLI (`agy`) and your Antigravity sign-in. The setup wizard can help install `agy`. [Codex CLI guide](https://developers.openai.com/codex/cli/)

```sh
npx @kyun.si/codex-polish@beta setup
```

In Windows PowerShell, use `npx.cmd` in place of `npx`.

Choose when Gemini should edit your replies. For automatic polishing, trust `UserPromptSubmit` in Codex’s `/hooks` menu, then start a new chat. To try a manual edit, ask Codex to polish its last reply. Add `--advanced` to `setup` to choose a Gemini model and thinking level, or say **“Set up Codex Polish”** to change your settings in chat.

Gemini receives the draft and its question for a full reply rewrite. A trusted hook can include recent exchanges from the same chat. If you enable the optional OpenAI Decisions check in Normal mode, OpenAI evaluates the draft before Gemini rewrites it.

## Maintenance

```sh
npx @kyun.si/codex-polish@beta doctor
npx @kyun.si/codex-polish@beta update
npx @kyun.si/codex-polish@beta uninstall
```

`update` keeps your Codex Polish settings. `uninstall` removes them, including any custom prompt and OpenAI API key saved by the plugin.

[Agent Polish source and documentation](https://github.com/mreasonyang/agent-polish) · [Apache-2.0 License](LICENSE)
