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

Run the command in your project directory. Interactive setup offers to install `agy` if needed and lets you choose a rewrite mode. With the built-in prompt, **Normal** (default) can keep a clear draft as written. **Turbo** asks Gemini to rewrite each eligible draft. With T3 Code, select the Codex backend and install the plugin on the machine running it. [Other installation options](docs/technical.en.md#installation-updates-and-uninstall)

- **Before trusting the hook:** Ask **“Why does a cache hit still take time? Use Turbo for this answer.”** Codex sends the draft to Gemini once, without attaching earlier exchanges.
- **Automatic mode (default):** Trust `UserPromptSubmit` in Codex **Settings → Hooks** (`/hooks` in the CLI) and start a **new chat**. Codex then runs the polishing workflow on ordinary questions and can include recent exchanges.

## Useful chat prompts

- **“Have Gemini rewrite your last answer in two sentences.”** One-time Turbo skips the OpenAI check and rewrites the answer you picked. You can also name an earlier answer in the same chat. The next ordinary question uses your project default.
- **“Only polish when I ask.”** Sets the project to manual. **“Make Turbo the default for this project”** changes how it rewrites. **“Only show the polished text”** hides the comparison for one reply.
- **Model and prompt:** Defaults to **Gemini 4 Hydrogen** (`gemini-4-hydrogen`). Say **“Choose a rewrite model”** for live account models, or **“Set this project’s polishing prompt to: Lead with the conclusion. Use short sentences.”** (`.codex/codex-polish.prompt.md`).

## Privacy and checks

If the draft or question contains a suspected credential, Codex Polish skips that rewrite. If you ask for JSON only, a single command, or a verbatim quote, you get the requested format without a polishing label.

- **OpenAI** receives the current question, draft and any custom prompt only when the optional Normal-mode style check runs. With no `OPENAI_API_KEY`, with the check off, or if it’s unavailable, eligible drafts go directly to Gemini. Turbo always skips the check.
- **Google** receives the selected draft, its original question, any custom prompt, and any directions you gave for this rewrite. With a trusted hook, the plugin includes up to two completed exchanges from before that answer by default. Set history to 0–10 exchanges or say **“Leave out history this time.”** The plugin keeps no draft log of its own.

## Maintenance

| Action | Command |
| --- | --- |
| Check setup | `npx @kyun.si/codex-polish@beta doctor` |
| Update | `npx @kyun.si/codex-polish@beta update` |
| Uninstall | `npx @kyun.si/codex-polish@beta uninstall` |

`doctor` checks local dependencies, project settings and hook trust. Ask **“Choose a rewrite model”** to check your Antigravity sign-in and see the available models. After an update, Codex may ask you to trust the hook again.

[Credentials Guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md) · [Technical Reference](docs/technical.en.md) · [Evaluation](evaluation/README.en.md) · [Contributing](CONTRIBUTING.en.md) · [Security](SECURITY.en.md) · [Changelog](CHANGELOG.md) · [Apache-2.0 License](LICENSE)
