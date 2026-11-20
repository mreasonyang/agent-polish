# Security

[简体中文](SECURITY.md) · [README](README.en.md) · [Technical reference](docs/technical.en.md)

## Report a vulnerability privately

Please [report vulnerabilities privately on GitHub](https://github.com/mreasonyang/codex-polish/security/advisories/new). The maintainer can follow up with you in the report.

Include the plugin version, steps to reproduce the issue, what you expected, and what happened. Add relevant details such as your operating system, the versions of Node.js, Codex CLI, and `agy`, or the status of a project setting or hook. Use a fictional exchange and made-up values in your example. Remove keys, tokens, authorization headers, and private conversation text.

## Control what the plugin sends

Turbo uses only Gemini through `agy acp`, even with an OpenAI key. When the optional style check runs in normal mode, OpenAI receives only the current question and draft as written (including code, paths, and links) and any custom polishing prompt. Google receives these items when Gemini rewrites, along with the recent exchanges allowed by the project’s history setting. The default is up to 2 exchanges, configurable from 0 to 10 with a total limit of 16 KiB of history text. The plugin skips incomplete exchanges and those containing attachments or possible credentials. A possible credential in the current question, draft, or custom prompt causes the plugin to skip the turn before sharing that material. The plugin checks Gemini’s reply locally.

- To stop future rewrite requests in the current project, set `.codex/codex-polish.mode` to `off`.
- To leave history out of Gemini rewrites, set `.codex/codex-polish.history-turns` to `0`. To omit it for a single rewrite, say “Leave out history this time.”
- To turn off the OpenAI style check, set `.codex/codex-polish.decisions` to `off`.

If a key or token may have been exposed, revoke it with the provider and replace it wherever it is configured.
