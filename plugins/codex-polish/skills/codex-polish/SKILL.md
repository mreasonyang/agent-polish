---
name: codex-polish
description: Use Gemini when the user asks to polish, rewrite, or put an answer in plain English (“speak plainly”). 用户要求“说人话”“重写”“润色”答复时使用。Also retrieves the original draft of a polished answer locally.
---

# 用 Gemini 改写回复

用户主动要求润色时，用 `--trigger explicit` 按[回复润色流程](WORKFLOW.md)直接交给 Gemini 用 Turbo 改写，排版时沿用同一触发方式。单独发“说人话”“重写”“润色”或对应的英文口令，默认改刚收到的上一条答复；和新问题一起发时，改本轮即将给出的答案。把用户的这句要求作为本次编辑要求交给 Gemini。最终消息原样交付排版结果，用户指定的严格格式或只看正文要求优先。用户只想了解功能时直接回答，想改润色设置或保存提示词时使用设置技能。
