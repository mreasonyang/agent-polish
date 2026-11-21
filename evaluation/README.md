# 离线验收统计

[English](README.en.md)

在完整源码的根目录运行以下命令。发行包附带中英文评测说明。统计脚本、示例数据和测试脚本需从完整源码获取。统计脚本使用 Node.js 内置模块，从 UTF-8 JSONL 读取每个样本的观测值，向标准输出写 JSON 汇总。示例中的五条记录、偏好票和延迟全部是合成数据。

```sh
node evaluation/report.mjs evaluation/example.jsonl
node --test tests/evaluation.test.mjs
```

## 采集和盲评

1. 取得使用授权并去除敏感信息。每条原始问题与草稿分配一个稳定的 `case_id`。同一个原稿及其变体使用同一 ID，划分时只进一个集合。脚本遇到重复 ID 会报行号并退出。
2. 独立标注原稿是否需要改写，再用校准集选择阈值。冻结插件配置、模型和仅提示对照的简洁提示，将这组配置用于全部盲评样本。每份报告对应一次冻结配置。
3. 记录宿主实际工具轨迹、选定的正文和原生最终消息。在整条消息中核对状态、来源标签、版本顺序和原稿。盲评只取实际显示的选定正文，去掉插件标签和状态。每条盲评样本用同一任务、同一 Codex 模型和上下文生成仅加简洁提示的对照答复。对采用改稿的样本，再与原稿配对比较。
4. 每对随机排列成 A/B。评分者只看到用户问题、必要上下文和两篇匿名答复，分别选 A、B 或平局。揭盲后合并 `plugin_side` 和 `pick`。由独立核事实的人对照原稿和交付文本标出严重事实反转，例如把「没跑测试」改为「测试通过」。脚本消费采集结果，数据提供者负责核实授权、分组和盲法。

## 一行记录的字段

| 字段 | 填写方式 |
| --- | --- |
| `case_id` | 本次采集中唯一的非空字符串 |
| `source`、`split` | `authorized_real` 或 `synthetic`，以及 `calibration` 或 `blind` |
| `needs_rewrite` | 人工判断原稿需要改写时为 `true` |
| `workflow_expected`、`workflow_ran` | 该回合是否应走插件，以及从宿主轨迹观察到是否实际运行。按约定跳过的回合可填 `false` |
| `triggered` | 判定触发外部改写时为 `true`，即使随后发生故障 |
| `outcome` | `original` 未触发改写并交付原稿，`adopted` 交付 Gemini 返回的完整正文（包括返回原文），`fallback` 工作流因故障未取得完整回复并交付原稿，`cancelled` 用户取消且本轮未交付 |
| `selected_text`、`final_text` | 前者取自选定的改稿或原稿，后者独立取自原生最终消息中对应的正文。双版本回复只取润色版正文，单版本回复取唯一正文。排除插件添加的标签和状态，保留正文自身的标点、空格和换行。取消时省略或填 `null` |
| `elapsed_ms` | 草稿就绪到原生最终消息显示的总毫秒数。缺测或取消填 `null` |
| `severe_fact_reversal` | 对已交付正文的人工结论。发现严重反转填 `true`，已检查且无反转填 `false`，未检查或取消填 `null` |
| `vs_original` | 盲评中采用改稿的记录填写一票。用 `{"plugin_side":"B","pick":"A"}` 表示改稿放在 B，评分者选了原稿。平局为 `"pick":"tie"` |
| `vs_prompt_only` | 所有已交付的盲评记录各填一票。插件一侧放 `final_text`，另一侧放仅提示对照。格式同上。缺失或不适用的票省略或填 `null` |

## 读报告

报告分别统计合成和真实数据。效果指标取自盲评集。统计项包含分子 `count`、分母 `total` 和 0～1 的 `rate`。分母为零时比例为 JSON `null`。取消单列计数。

| 指标 | 分母及算法 |
| --- | --- |
| `false_trigger`、`hit` | 盲评中应运行且已交付的回合，分别取人工判断清楚和需要改写的两组，各自计算触发比例。应该运行却漏调的回合也计入相应分母 |
| `adopted_preferred_to_original`、`preferred_to_prompt_only` | 各自有效偏好票中的插件胜率，平局计入分母。另列适用样本数 `eligible` 和平局数 `ties` |
| `severe_fact_reversal` | 已完成人工事实检查的交付结果中，发生严重反转的数量和比例 |
| `missed_workflow`、`verbatim_display`、`adopted_verbatim_display` | 应运行的已交付回合中漏调的比例。所有交付结果和采用改稿的结果各自单独计算逐字一致率，包括标点、空格和换行 |
| `fallback`、`latency` | 已运行工作流且已交付回合中的回退比例。所有已记录交付耗时按从小到大排序，P50/P95 取第 `ceil(p × n)` 项，单位毫秒 |

出现真实盲评严重反转标记 `blocked_severe_fact_reversal`。应用效果门槛要求至少 200 个已交付的真实样本，校准集和盲评集均有观测，误触发、命中和采用改稿偏好三个分母均大于零，适用的盲评票、事实检查和延迟记录齐全。缺少证据标记 `insufficient_evidence`。误触发率 ≤ 5%、命中率 ≥ 70%、采用改稿偏好率 ≥ 70% 时标记 `statistical_targets_met`，否则标记 `thresholds_not_met`。两组的实际样本量随报告给出，真机能力和宿主交付仍需独立验收。合成集固定标记 `demo_only`。
