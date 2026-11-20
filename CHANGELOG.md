# 更新记录 / Changelog

[中文使用说明](README.md) · [English README](README.en.md)

## 0.0.1-beta.2

- 项目没有指定润色模式时，普通提问也会自动触发润色。使用前，在 Codex 中信任插件的 `UserPromptSubmit` 钩子。已选“只在我要求时”或“关闭”的项目会沿用该选择。
- Projects without a saved mode now polish ordinary replies automatically once the `UserPromptSubmit` hook is trusted. Projects set to on-demand or off keep their preference.

## 0.0.1-beta.1

### 简体中文

- 通过 Antigravity 的 `agy` 调用 Gemini 润色 Codex 回复。在 macOS 和 Linux 上使用 Node.js 22.16 或更新版本运行插件，macOS 也支持双击安装。
- 默认按需润色。每个项目可以单独设置触发模式、Gemini 模型和插件界面语言。
- 在 Codex 中信任 `UserPromptSubmit` 钩子后，可以开启自动润色，也可以选择让 Gemini 参考最近几轮已完成的问答。
- 改写时用占位符保护代码、命令、路径、链接和数值。可选的 OpenAI 检查会先判断是否需要润色，再核对改稿是否保留原意。检查失败时交付原稿。

### English

- Polish Codex replies with Gemini through the Antigravity CLI (`agy`). Install with Node.js 22.16+ on macOS or Linux, or double-click the installer on macOS.
- Request a rewrite when you need one. Each project has its own settings for rewrite mode, Gemini model, and interface language.
- Trust the `UserPromptSubmit` hook in Codex to enable automatic rewrites or let Gemini use recent completed exchanges as context.
- Placeholders protect code, commands, paths, links, and numbers. Optional OpenAI checks decide whether a draft needs editing and whether the rewrite preserves its meaning. If a check fails, the plugin keeps the original.
