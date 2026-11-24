# AGY Polish

Use Codex to polish Antigravity replies. The rewrite appears in the same conversation.

## Setup

Install Node.js 22.16 or later, the Antigravity CLI with native plugin support and the Codex CLI. AGY Polish uses the model provider configured in Codex. If you use an OpenAI account, run `codex login` to sign in. [Antigravity CLI guide](https://antigravity.google/docs/cli) · [Codex CLI guide](https://developers.openai.com/codex/cli/)

```sh
npx @kyun.si/agy-polish@beta setup
```

In Windows PowerShell, use `npx.cmd` in place of `npx`.

Choose when Codex should edit your replies, then start a new `agy` chat. Try `/polish Rewrite the previous reply in two sentences.` If Antigravity asks for permission, allow the `polish_reply` tool. Add `--advanced` to `setup` to choose a mode, model and reasoning effort, or say **“Set up reply polishing”** to change them in chat.

For a full reply rewrite, your Codex provider receives the current draft, its question and your editing directions. For a selected passage, it receives just that passage and the relevant directions.

## Maintenance

```sh
npx @kyun.si/agy-polish@beta doctor
npx @kyun.si/agy-polish@beta update
npx @kyun.si/agy-polish@beta uninstall
```

AGY Polish keeps your mode and model settings when you update or uninstall the plugin.

[Agent Polish source and documentation](https://github.com/mreasonyang/agent-polish) · [Apache-2.0 License](LICENSE)
