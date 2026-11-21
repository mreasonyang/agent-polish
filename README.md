# Codex Polish

**English** | [简体中文](docs/README.zh-CN.md)

Codex Polish lets Gemini rewrite a Codex reply so it’s easier to read. Codex sends its draft through Antigravity (`agy acp`) and shows the rewrite in chat. In clients that support folding, you can expand the original underneath. Here’s an example translated from a Chinese test run.

**Polished by Gemini**

The export button is fixed and passed local tests. It still needs to be checked in production.

<details>
<summary>View original GPT draft</summary>

Regarding progress with the export button fix, let me explain the actual situation. The export button has now been fixed, local tests have passed, and production verification has not yet been done.

</details>

If Gemini returns the original wording, you see it once. If the rewrite fails, you get the draft and a short explanation.

## Quick start

Requires **macOS or Linux**, **Node.js 22.16+**, a [Codex CLI](https://developers.openai.com/codex/cli/) with plugin support, and `agy` 1.2.1+. No API key is needed—it reuses your Antigravity sign-in.

```sh
npx @kyun.si/codex-polish@beta setup
```

Run the command in your project directory. Interactive setup offers to install `agy` if needed and lets you choose how automatic polishing works. With the built-in prompt, **Normal** (default) can keep a clear draft as written. **Turbo** asks Gemini to rewrite each draft. With T3 Code, select the Codex backend and install the plugin on the machine running it. [Other installation options](docs/technical.en.md#installation-updates-and-uninstall)

- **Before trusting the hook:** Ask **“Why does a cache hit still take time? Polish the answer.”** Asking for a polish uses Turbo. Gemini receives the draft without earlier exchanges.
- **Automatic mode (default):** Trust `UserPromptSubmit` in Codex **Settings → Hooks** (`/hooks` in the CLI) and start a **new chat**. Codex then runs the polishing workflow on ordinary questions and can include recent exchanges.

## Useful chat prompts

- **“Have Gemini rewrite your last answer in two sentences.”** You can name an earlier answer in the same chat. Asking to rewrite the original again uses the question that first prompted it. If Codex can’t identify the original, it asks you to point it out or quote it. A request to polish or rewrite skips the OpenAI check even when automatic polishing is set to Normal.
- **“Only polish when I ask.”** Sets the project to manual. **“Make Turbo the default for this project”** sets Turbo for automatic polishing. **“Only show the polished text”** hides the comparison for one reply.
- **Model and prompt:** Defaults to **Gemini 4 Hydrogen** (`gemini-4-hydrogen`). Say **“Choose a rewrite model”** for live account models, or **“Set this project’s polishing prompt to: Rewrite the draft to lead with the conclusion and use short sentences.”** (`.codex/codex-polish.prompt.md`). When a project prompt is used, it replaces the entire built-in editing prompt in both Normal and Turbo modes.

## What gets sent

Codex Polish sends the selected text as written, including any keys or tokens it contains. Say **“Skip polishing this time”** to keep this reply out of the polishing workflow. If you ask for JSON only, a single command, or a verbatim quote, Codex delivers that format directly.

- **OpenAI** receives the current question, draft and any custom prompt only when automatic polishing runs the optional Normal-mode style check. With no `OPENAI_API_KEY`, with the check off, or if it’s unavailable, drafts go directly to Gemini. Turbo always skips the check.
- **Google** receives the original question and draft when you polish a whole reply, along with any custom project prompt and directions for this edit. A trusted hook can include up to two earlier exchanges by default. Set history to 0–10 exchanges or say **“Leave out history this time.”**
- **Selected passages:** Saying **“Rewrite this passage in two sentences”** sends the passage, your editing direction, and the active project or built-in Turbo prompt. Saying **“Only send this passage to Gemini”** sends just the passage with the built-in Turbo prompt and keeps any extra directions and your project prompt local. Neither sends the surrounding question or chat history.
- **Follow-up passage edits:** Asking to shorten that last edited passage again sends the displayed version you chose with your new direction and active prompt, while the original question and chat history stay local. The plugin keeps no draft log of its own.

## Maintenance

| Action | Command |
| --- | --- |
| Check setup | `npx @kyun.si/codex-polish@beta doctor` |
| Update | `npx @kyun.si/codex-polish@beta update` |
| Uninstall | `npx @kyun.si/codex-polish@beta uninstall` |

`doctor` checks local dependencies, project settings and hook trust. Ask **“Choose a rewrite model”** to check your Antigravity sign-in and see the available models. After an update, Codex may ask you to trust the hook again.

[Credentials Guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md) · [Technical Reference](docs/technical.en.md) · [Evaluation](evaluation/README.en.md) · [Contributing](CONTRIBUTING.en.md) · [Security](SECURITY.en.md) · [Changelog](CHANGELOG.md) · [Apache-2.0 License](LICENSE)
