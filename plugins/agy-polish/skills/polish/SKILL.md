---
name: polish
description: Explicitly polish an Antigravity reply with Codex. Use /polish or when explicitly asked to polish this or a previous reply, with optional editing instructions or a selected passage. 润色这条或上一条回复，可指定改法或只选一段。单独发送「说人话」时，把上一条回复改成大白话。
---

Use the current-turn Codex Polish mode from the plugin hook. Respect the plugin rule about sharing, cancellation, and exact-format responses.

In Off mode, or if the current mode is unavailable, never invoke Codex or the `polish_reply` MCP tool. For a polish-only request, copy just the supplied source text or the complete referenced reply verbatim. Preserve leading and trailing whitespace, line breaks, Markdown, and code. Do not apply any editing directions yourself or add an introduction, status message, or wrapping. For `/polish` with a new question or task, answer normally and send that answer directly. If no text or reply can be identified for a polish-only request, ask which one the user means.

In any other mode, use the agy-polish `polish_reply` MCP tool with `trigger: "explicit"` once.

With a new question, answer it fully and use your complete unsent final reply as `draft`. If the user asks to polish a previous reply or just enters `/polish`, use the referenced reply in full as `draft` and supply its original question when available. If the user gives only text to polish, use that exact text as the draft. Do not guess a missing reply or question. Use an empty `question` if the draft is available but its original question is missing. Ask which reply or passage only when you cannot resolve the reference.

Put additional edit directions in `rewrite_request`. For a standalone “说人话”, pass the previous assistant reply unchanged as `draft` and the user's exact request as `rewrite_request`. For a selected passage, supply its exact text as `selection` and keep the whole reply in `draft`; the tool returns the entire reply with only that passage replaced. If the selection occurs more than once, use enough surrounding text to identify the intended passage without editing neighboring text, or ask the user to identify it. Do not automatically enrich any of these fields with chat history.

Return the full text from the tool as the final reply verbatim. If the tool is unavailable or fails, use the exact draft. Do not run automatic polishing on this turn as well.
