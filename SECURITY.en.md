# Security

[简体中文](SECURITY.md) · [README](README.md) · [Technical reference](docs/technical.en.md)

## Report a vulnerability privately

Please [report vulnerabilities privately on GitHub](https://github.com/mreasonyang/codex-polish/security/advisories/new). The maintainer can follow up with you in the report.

Include the plugin version, steps to reproduce the issue, what you expected, and what happened. Add relevant details such as your operating system, the versions of Node.js, Codex CLI, and `agy`, or the status of a project setting or hook. Use a fictional exchange and made-up values in your example. Remove keys, tokens, authorization headers, and private conversation text.

## Control what the plugin sends

The plugin sends the selected content as written, including any keys or tokens in the submitted question, draft, history, or editing instructions.

When the automatic hook runs the optional style check in Normal mode, OpenAI receives only the current question and draft as written (including code, paths, and links) and any custom polishing prompt. Requests to polish or rewrite a reply always use Turbo. These requests and automatic Turbo rewrites skip OpenAI and call Gemini through `agy acp`. For a whole reply, Google receives the original question and draft, any custom project prompt, and any editing directions you give. Optional history comes from before the original answer, including when you ask for another rewrite. The default is up to 2 exchanges, configurable from 0 to 10. Only complete text exchanges are included. Once Gemini returns a complete reply, the plugin formats it locally for display.

- To polish a selection, select or quote the passage. Gemini receives the passage with the active project or built-in prompt and any editing directions you give. The surrounding message and chat history stay local. Say “Only send this passage to Gemini” to share just the selected text with the built-in Turbo prompt. Any separate directions and the project prompt also stay local.
- To stop future rewrite requests in the current project, set `.codex/codex-polish.mode` to `off`.
- To omit additional exchanges, set `.codex/codex-polish.history-turns` to `0` or say “Leave out history this time.” You can still request a rewrite of an earlier answer. The trusted hook stores the transcript location and turn locally. For repeat rewrites, the local cache records the source type, turn references and a fingerprint of the displayed reply. It stores no draft text.
- To turn off the OpenAI style check, set `.codex/codex-polish.decisions` to `off`.

If a key or token may have been exposed, revoke it with the provider and replace it wherever it is configured.
