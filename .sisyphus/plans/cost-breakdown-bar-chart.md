# 售价构成占比条形图改造

## TL;DR
> **Summary**: 将财务核心指标 Card 中的"成本结构占比"水平堆叠条形图，改为展示各项成本 + 净利润在售价中的占比条形图。
> **Deliverables**: 修改后的 `components/dashboard.tsx`（1 个文件变更）
> **Effort**: Quick
> **Parallel**: NO
> **Critical Path**: 单一任务，无依赖链条

## Context
### Original Request
"把财务核心指标中的成本结构占比条形图，改成各项成本、利润在售价中的占比条形图。"

### Current State
- 文件: `components/dashboard.tsx`
- `costSegments` useMemo (L525-536): 计算 6 项成本，百分比 = `(item.value / 成本总和) * 100`
- 堆叠条渲染 (L614-625): 纯 CSS 实现，`width` = `segment.percent`
- 图例 (L626-634): 色块 + 标签 + ¥金额
- 总成本汇总 (L635-638): 独立显示 `result.costs.total`
- 底部注释 (L639-641): "总成本已包含采购、物流、佣金、手续费、退损、广告等成本项。"
- `COST_COLORS` 常量 (L101): 死代码，未被使用

### Available Data
- `result.netProfit` — 净利润 (RMB)
- `result.costs.{purchase, domesticShipping, packaging, internationalShipping, commission, cpaCost, cpcCost, returnCost, withdrawalFee, paymentFee, total}` — 各项成本
- `input.targetPriceRMB` — 售价 (RMB)
- `result.costs.total + result.netProfit ≈ input.targetPriceRMB`

## Work Objectives
### Core Objective
将"成本占成本总和"的水平堆叠条，改为"各项成本 + 净利润占售价"的水平堆叠条。

### Deliverables
- 修改后的 `components/dashboard.tsx`

### Definition of Done
- `npm run build` 无错误
- 页面渲染后，堆叠条显示 7 段（6 项成本 + 1 段净利润），合计宽度 ≈ 100%
- 标题显示"售价构成占比"
- 汇总行显示售价/总成本/净利润三栏
- 底部注释更新为与售价构成匹配的描述
- 净利润为正时显示绿色段；净利润为负时，堆叠条不包含利润段，下方显示红色亏损提示

### Must Have
- 百分比计算分母改为 `input.targetPriceRMB`
- 添加净利润段 (`result.netProfit`)
- 更新标题、汇总行、注释文本
- 处理净利润为负的边界情况

### Must NOT Have
- 不修改图例标签文本（保持"采购成本"、"物流费用"等现有命名）
- 不修改其他图表（利润敏感性分析、定价矩阵不变）
- 不引入外部图表库
- 不修改 Card 外层结构

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- **Test decision**: Build verification only (视觉组件，无单独单元测试)
- **QA policy**: 验证构建通过 + 页面视觉检查
- **Evidence**: `.sisyphus/evidence/cost-breakdown-bar-chart.png`

## Execution Strategy
### Single Task
整个修改变更在一个任务中完成，无并行依赖。

## TODOs

- [ ] 1. 修改 costSegments 计算逻辑并更新渲染

  **What to do**:
  1. 在 `costSegments` useMemo 中（L525-536）:
     - 将百分比分母从 `total || 1`（成本总和）改为 `input.targetPriceRMB || 1`（售价）
     - 添加净利润段: `{ label: "净利润", value: Math.max(result.netProfit, 0), color: "#10B981" }`
     - 如果 `result.netProfit < 0`，不添加净利润段到 items（filter out 负利润）
     - 将 `input.targetPriceRMB` 和 `result.netProfit` 加入依赖数组
  2. 修改标题（L611）：`"成本结构占比"` → `"售价构成占比"`
  3. 修改副标题（L612）：保持售价显示在右侧 `售价：¥{input.targetPriceRMB.toFixed(2)}`
  4. 修改汇总行（L635-638）：从只显示"总成本"改为显示三列:
     ```
     <div class="...">
       <span>售价：<b>¥{input.targetPriceRMB.toFixed(2)}</b></span>
       <span class="mx-2 text-slate-300">|</span>
       <span>总成本：<b>¥{result.costs.total.toFixed(2)}</b></span>
       <span class="mx-2 text-slate-300">|</span>
       <span class={result.netProfit >= 0 ? "text-emerald-600" : "text-red-600"}>
         净利润：<b>¥{result.netProfit.toFixed(2)}</b>
       </span>
     </div>
     ```
  5. 如果 `result.netProfit < 0`，在汇总行下方添加红色亏损提示:
     ```
     <div class="mt-1 text-[11px] text-red-500 font-medium">
       ⚠ 当前售价低于总成本，亏损 ¥{Math.abs(result.netProfit).toFixed(2)}
     </div>
     ```
  6. 修改底部注释（L639-641）：`"总成本已包含..."` → `"各项成本及利润占售价的百分比。成本合计已包含采购、物流、佣金、手续费、退损、广告等。"`
  7. 删除 `COST_COLORS` 死代码常量（L101）
  8. 确保堆叠条渲染时，对 percent 做最小宽度保护（`Math.max(segment.percent, 4)`）— 已有此逻辑无需改动

  **Must NOT do**:
  - 不改动 `costSegments` 中除利润段外的现有成本项标签、颜色和聚合逻辑
  - 不改动图例（L626-634）的渲染结构

  **Recommended Agent Profile**:
  - Category: `quick` — 单文件、明确变更
  - Skills: `[]` — 无需特定技能
  - Omitted: N/A

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [] | Blocked By: []

  **References**:
  - Source: `components/dashboard.tsx` — 所有变更在该文件的 L101, L525-536, L611, L635-641
  - Data type: `lib/types.ts:CalculationResult.costs` + `result.netProfit` | `input.targetPriceRMB`
  - Bar render: `components/dashboard.tsx:L614-625` — CSS width 百分比布局

  **Acceptance Criteria**:
  - [ ] `npm run build` 成功，无 TypeScript/ESLint 错误
  - [ ] `npm run dev` 启动后，页面堆叠条显示净利润段（绿色 `#10B981`）
  - [ ] 当 `result.netProfit >= 0`，各段 percent 之和 ≈ 100%
  - [ ] 当 `result.netProfit < 0`，堆叠条不含利润段，下方显示红色亏损提示
  - [ ] 标题显示"售价构成占比"
  - [ ] 汇总行显示"售价 | 总成本 | 净利润"三列

  **QA Scenarios**:
  ```
  Scenario: 正利润渲染
    Tool: Bash
    Steps: npm run build
    Expected: exit code 0, 无错误
    Evidence: .sisyphus/evidence/cost-breakdown/build-success.txt

  Scenario: 页面视觉验证 - 正利润场景
    Tool: Playwright
    Steps: 启动 dev server; 导航到页面; 输入有效商品数据使净利润 > 0; 截图"核心财务指标"区域
    Expected: 堆叠条包含 7 段; 有绿色净利润段; 标题为"售价构成占比"
    Evidence: .sisyphus/evidence/cost-breakdown-bar-chart.png
  ```

  **Commit**: YES | Message: `feat: change cost structure bar to show costs+profit as % of selling price` | Files: `components/dashboard.tsx`

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review — unspecified-high
- [ ] F3. Real Manual QA — unspecified-high (+ playwright if UI)
- [ ] F4. Scope Fidelity Check — deep

## Commit Strategy
- 1 commit: `feat: change cost structure bar to show costs+profit as % of selling price`

## Success Criteria
- 部署后，核心财务指标 Card 中的堆叠条标题为"售价构成占比"
- 堆叠条显示 7 段（6 项成本 + 净利润），合计宽度 = 售价的 100%
- 正利润时显示绿色净利润段，负利润时显示红色亏损提示
- 汇总行清晰展示售价、总成本、净利润三项关键指标
