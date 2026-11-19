# Security

[简体中文](SECURITY.md) · [README](README.en.md) · [Technical reference](docs/technical.en.md)

## Report a vulnerability privately

Please [report vulnerabilities privately on GitHub](https://github.com/mreasonyang/codex-polish/security/advisories/new). The maintainer can follow up with you in the report.

Include the plugin version, steps to reproduce the issue, what you expected, and what happened. Add relevant details such as your operating system, the versions of Node.js, Codex CLI, and `agy`, or the status of a project setting or hook. Use a fictional exchange and placeholder values in your example. Remove keys, tokens, authorization headers, and private conversation text.

## Control what the plugin sends

- To stop future rewrite requests in the current project, set `.codex/codex-polish.mode` to `off`.
- To keep rewriting but send only the current turn to Google, set `.codex/codex-polish.history-turns` to `0`.
- To turn off the plugin’s OpenAI checks, set `.codex/codex-polish.decisions` to `off`.

If a key or token may have been exposed, revoke it with the provider and replace it wherever it is configured.
