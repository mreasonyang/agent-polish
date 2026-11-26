---
name: polish-settings
description: View and change Codex reply polishing mode, model, or thinking level in Antigravity. 配置回复润色，查看或切换润色模式、Codex 模型和思考等级。
---

Use the bundled [settings command](scripts/settings.mjs) via Node.js. Resolve the path relative to this skill file, then quote its absolute path when running it. These commands only access the local polishing settings or query the installed Codex CLI for its model catalog. Do not send the settings turn to `polish_reply`.

```text
node "<skill directory>/scripts/settings.mjs" show
node "<skill directory>/scripts/settings.mjs" list-models
node "<skill directory>/scripts/settings.mjs" set --mode manual
node "<skill directory>/scripts/settings.mjs" set --model default --effort default
node "<skill directory>/scripts/settings.mjs" set --model codex-default --effort codex-default
```

- `show` reports the current choice; offer the available modes in the user's language when they just ask to configure polishing. Normal (普通) edits when useful. Turbo (积极润色) edits more actively. Manual (仅手动) is the default and runs only on explicit requests. Off (关闭) disables polishing. The supported mode values are `normal`, `turbo`, `manual`, and `off`.
- The AGY Polish default is `gpt-6.2-sol` with Extra High (`xhigh`) reasoning. Use `set --model default --effort default` to restore both. When the user wants to follow their local Codex configuration, use `codex-default` for the requested field or fields. A null in the output of `show` means Codex determines that setting.
- Make an unambiguous requested change directly. When changing to a specific Codex model or thinking level, consult `list-models` and use the exact model ID and a supported effort. Use the row marked `isDefault` when following the local Codex model. If a newly chosen model does not support the current effort, offer its supported levels and the option to follow Codex. Supply only the requested options to `set` and quote their values for the shell. Resetting effort with `default` selects `xhigh` for `gpt-6.2-sol` and lets Codex determine the effort for other models.
- If the catalog is unavailable, mode changes and resets remain available. Report the command result in the user's language. Do not ask for keys or credentials in chat.
