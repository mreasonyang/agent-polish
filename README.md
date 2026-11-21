# Codex Polish

**English** | [简体中文](docs/README.zh-CN.md)

[Install on Windows](#windows-powershell) · [Install on macOS or Linux](#macos-and-linux)

Codex Polish lets Gemini rewrite a Codex reply so it’s easier to read. Codex sends its draft through Antigravity (`agy acp`) and shows the rewrite in chat. In clients that support folding, you can expand the original underneath. Here’s an example translated from a Chinese test run.

**Polished by Gemini**

The export button is fixed and passed local tests. It still needs to be checked in production.

<details>
<summary>View original GPT draft</summary>

Regarding progress with the export button fix, let me explain the actual situation. The export button has now been fixed, local tests have passed, and production verification has not yet been done.

</details>

If Gemini returns the original wording, you see it once. If the rewrite fails, you get the draft and a short explanation.

## Quick start

Requires **Windows, macOS, or Linux**, **Node.js 22.16+**, a [Codex CLI](https://developers.openai.com/codex/cli/) with plugin support, and `agy` 1.2.1+. No API key is needed—it reuses your Antigravity sign-in.

### Windows (PowerShell)

Open PowerShell on the machine running Codex and run this command from any folder.

```powershell
npx.cmd @kyun.si/codex-polish@beta setup
```

### macOS and Linux

Open a terminal on the machine running Codex and run this command from any folder.

```sh
npx @kyun.si/codex-polish@beta setup
```

### Finish setup

For T3 Code, select the Codex backend.

Use **↑ / ↓** and **Enter** to choose a rewrite mode and Gemini model. Setup offers to install `agy` before model selection if needed. The npm release `0.0.1-beta.8` saves those choices in the selected project.

To set defaults for all projects in this Codex profile, run `node scripts/install.mjs setup` from the current source checkout. You can override either default in a project. Rerunning setup skips saved choices. [Other installation options](docs/technical.en.md#installation-updates-and-uninstall)

- **Before trusting the hook:** Ask **“Why does a cache hit still take time? Polish the answer.”** Asking for a polish uses Turbo. Gemini receives the draft without earlier exchanges.
- **Automatic mode (default):** Trust `UserPromptSubmit` in Codex **Settings → Hooks** (`/hooks` in the CLI) and start a **new chat**. Codex then runs the polishing workflow on ordinary questions and can include recent exchanges.

### Optional OpenAI check (unreleased)

On first interactive setup from source, choosing Normal offers an OpenAI style check. Press **Enter** to skip it and use Gemini alone. If you opt in, OpenAI receives your current question, draft and any custom polishing prompt. Create a key in the OpenAI project that will pay for the checks and enter it at the hidden terminal prompt. The key is saved for this Codex profile. Turbo always goes directly to Gemini. [OpenAI API keys](https://platform.openai.com/api-keys)

To add, replace or remove the key later, run `node scripts/install.mjs openai` from the checkout. The published `0.0.1-beta.8` still uses `OPENAI_API_KEY`. The source version ignores that variable. [Credentials guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md#optional-openai-style-check)

## Useful chat prompts

- **“Have Gemini rewrite your last answer in two sentences.”** You can name an earlier answer in the same chat. Asking to rewrite the original again uses the question that first prompted it. If Codex can’t identify the original, it asks you to point it out or quote it. A request to polish or rewrite skips the OpenAI check even when automatic polishing is set to Normal.
- **“Only polish when I ask.”** Sets the project to manual. **“Make Turbo the default for this project”** sets Turbo for automatic polishing. **“Only show the polished text”** hides the comparison for one reply.
- **“Choose a rewrite model.”** Shows models available to your Antigravity account. The built-in default is **Gemini 4 Hydrogen** (`gemini-4-hydrogen`).
- **“Set my polishing prompt to: Lead with the conclusion and use short sentences.”** In the current source version, one custom prompt applies to every project in your Codex profile. It replaces the built-in editing instructions for Normal and Turbo. Say **“Restore the default polishing prompt”** to delete the saved text.

## What gets sent

Codex Polish sends the selected text as written, including any keys or tokens it contains. Say **“Skip polishing this time”** to keep this reply out of the polishing workflow. If you ask for JSON only, a single command, or a verbatim quote, Codex delivers that format directly.

- **OpenAI** receives the current question, draft and any custom prompt only when automatic polishing runs the optional Normal-mode style check. If the check is off or unavailable, drafts go directly to Gemini.
- **Google** receives the original question and draft when you polish a whole reply, along with any custom profile prompt and directions for this edit. A trusted hook can include up to two earlier exchanges by default. Set history to 0–10 exchanges or say **“Leave out history this time.”**
- **Selected passages:** Saying **“Rewrite this passage in two sentences”** sends the passage, your editing direction, and the profile’s custom prompt or the built-in Turbo prompt. Saying **“Only send this passage to Gemini”** sends just the passage with the built-in Turbo prompt and keeps any extra directions and your profile prompt local. Neither sends the surrounding question or chat history.
- **Follow-up passage edits:** Asking to shorten that last edited passage again sends the displayed version you chose with your new direction and active prompt, while the original question and chat history stay local. The plugin keeps no draft log of its own.

## Maintenance

| Action | Command |
| --- | --- |
| Check setup | `npx @kyun.si/codex-polish@beta doctor` |
| Update | `npx @kyun.si/codex-polish@beta update` |
| Uninstall | `npx @kyun.si/codex-polish@beta uninstall` |

In Windows PowerShell, use `npx.cmd` to run `doctor`, `update`, and `uninstall`. `doctor` checks local dependencies, project settings and hook trust. Ask **“Choose a rewrite model”** to check your Antigravity sign-in and see the available models. After an update, Codex may ask you to trust the hook again.

The current source uninstaller deletes this profile’s saved rewrite mode, model, custom prompt and OpenAI key, and cleans up recorded project settings. [Uninstall details](docs/technical.en.md#installation-updates-and-uninstall)

[Credentials Guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md) · [Technical Reference](docs/technical.en.md) · [Evaluation](evaluation/README.en.md) · [Contributing](CONTRIBUTING.en.md) · [Security](SECURITY.en.md) · [Changelog](CHANGELOG.md) · [Apache-2.0 License](LICENSE)
