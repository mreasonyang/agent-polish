---
name: polish-settings
description: View and change Codex reply polishing mode, model, or thinking level in Antigravity. 配置回复润色，查看或切换润色模式、Codex 模型和思考等级。
---

Use the bundled [settings command](scripts/settings.mjs) via Node.js. Resolve the path relative to this skill file, then quote its absolute path when running it. These commands only access the local polishing settings or query the installed Codex CLI for its model catalog. Do not send the settings turn to `polish_reply`.

```text
node "<skill directory>/scripts/settings.mjs" show
node "<skill directory>/scripts/settings.mjs" list-models
node "<skill directory>/scripts/settings.mjs" set --mode normal
node "<skill directory>/scripts/settings.mjs" set --model default --effort default
```

- `show` reports the current choice; offer the available modes in the user's language when they just ask to configure polishing. Normal (普通) edits when useful. Turbo (积极润色) edits more actively. Only when asked (仅手动) runs only on explicit requests. Off (关闭) disables polishing. The supported mode values are `normal`, `turbo`, `manual`, and `off`.
- Make an unambiguous requested change directly. When changing to a specific Codex model or thinking level, consult `list-models`; use the exact model ID and an effort supported by that model. Use the row marked `isDefault` when the saved model is null. If changing models would make the saved thinking level invalid, ask which supported level to use or whether to follow the selected model's default. An explicitly requested reset to the default model or effort uses `default` for that flag. Supply only requested options to `set`. Quote values for the shell and only use model IDs and efforts from the catalog or the literal `default`.
- If the catalog is unavailable, mode changes and resets remain available. Report the result of the command in the user's language. A null model or effort follows Codex's default for the polishing subprocess. Do not ask for keys or credentials in chat.
