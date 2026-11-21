# Security

[简体中文](SECURITY.md) · [README](README.md) · [Technical reference](docs/technical.en.md)

## Report a vulnerability privately

Please [report vulnerabilities privately on GitHub](https://github.com/mreasonyang/codex-polish/security/advisories/new). The maintainer can follow up with you in the report.

Include the plugin version, steps to reproduce the issue, what you expected, and what happened. Add relevant details such as your operating system, the versions of Node.js, Codex CLI, and `agy`, or the status of a project setting or hook. Use a fictional exchange and made-up values in your example. Remove keys, tokens, authorization headers, and private conversation text.

## Control what the plugin sends

When the optional style check runs in Normal mode, OpenAI receives only the current question and draft as written (including code, paths, and links) and any custom polishing prompt. Turbo, including a one-time Turbo request, skips OpenAI and calls Gemini through `agy acp`. Google receives the selected reply’s question and draft, any custom project prompt, and any directions you give for that Turbo rewrite. Optional history comes from before the selected reply. The default is up to 2 exchanges, configurable from 0 to 10. The plugin skips incomplete exchanges and those containing attachments or possible credentials. A possible credential in the rewrite material causes the plugin to skip the turn before sharing it. Once Gemini returns a complete reply, the plugin formats it locally for display.

- To stop future rewrite requests in the current project, set `.codex/codex-polish.mode` to `off`.
- To omit additional exchanges, set `.codex/codex-polish.history-turns` to `0` or say “Leave out history this time.” You can still request a rewrite of an earlier answer. The trusted hook stores the transcript location and turn locally so the plugin can retrieve that question and reply.
- To turn off the OpenAI style check, set `.codex/codex-polish.decisions` to `off`.

If a key or token may have been exposed, revoke it with the provider and replace it wherever it is configured.
