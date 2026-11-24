# Security

[简体中文](SECURITY.md) · [README](README.md) · [Technical reference](docs/technical.en.md)

## Report a vulnerability privately

Please [report vulnerabilities privately on GitHub](https://github.com/mreasonyang/agent-polish/security/advisories/new). The maintainer can follow up with you in the report.

Include the plugin version, steps to reproduce the issue, what you expected, and what happened. Add relevant details such as your operating system, the versions of Node.js, Codex CLI, and `agy`, or the status of a plugin setting or hook. Use a fictional exchange and made-up values in your example. Remove keys, tokens, authorization headers, and private conversation text.

## Using Codex inside Antigravity

In Normal and Turbo modes, Antigravity’s `polish_reply` tool sends the current question, draft and editing directions to the model provider configured in your local Codex CLI. A selection sends the selected passage and applicable editing directions. The plugin does not attach other turns. Antigravity’s own conversation records may include the tool input and result. Choose **Only when asked** in Antigravity, or choose **Off** to stop both automatic and requested edits for this direction.

Each edit uses a temporary Codex profile to isolate your global instructions, skills, plugins and MCP servers. The local Codex CLI reads the saved sign-in. When the editor needs to use the system credential store, the plugin passes the credentials for the request in process memory. It cleans up the temporary directory after the edit.

## Control what Gemini editing in Codex sends

The plugin sends the selected content as written, including any keys or tokens in the submitted question, draft, history, or editing instructions.

When the automatic hook runs the optional style check in Normal mode, OpenAI receives only the current question and draft as written (including code, paths, and links) and any custom polishing prompt. Requests to polish or rewrite a reply always use Turbo. These requests and automatic Turbo rewrites skip OpenAI and call Gemini through `agy acp`. For a whole reply, Google receives the original question and draft, any custom profile prompt, and any editing directions you give. Optional history comes from earlier exchanges in the same chat, before the original answer, including when you ask for another rewrite. The default is up to 2 exchanges, configurable from 0 to 10. Only complete text exchanges are included. Once Gemini returns a complete reply, the plugin formats it locally for display.

- To polish a selection, select or quote the passage. Gemini receives the passage with the profile’s custom prompt or the built-in Turbo prompt and any editing directions you give. The surrounding message and chat history stay local. Say “Only send this passage to Gemini” to share just the selected text with the built-in Turbo prompt. Any separate directions and the profile prompt also stay local.
- Say “Turn off polishing” to stop automatic and requested rewrites in every chat using this Codex profile.
- Say “Set history to 0 exchanges” to omit earlier exchanges by default, or “Leave out history this time” for one rewrite. You can still request a rewrite of an earlier answer. The trusted hook stores the transcript location and turn locally. For repeat rewrites, the local cache records the source type, turn references and a fingerprint of the displayed reply. It stores no draft text.
- Say “Use only Gemini for rewrites” to turn off the OpenAI style check across this profile.

Gemini runs alone by default. The optional OpenAI Decisions API check uses the key entered at the installer’s hidden terminal prompt. The installer saves it in `$CODEX_HOME/codex-polish/credentials/openai.key` for this Codex profile. Remove the local copy through `npx @kyun.si/codex-polish@beta openai` (`npx.cmd` in Windows PowerShell) or by uninstalling. The plugin ignores `OPENAI_API_KEY`. [Credentials guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md#optional-openai-decisions-api)

If a key or token may have been exposed, revoke it with the provider and replace it wherever it is configured.
