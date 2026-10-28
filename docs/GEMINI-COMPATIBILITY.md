# ChatGPT / Gemini 兼容性调查与验收

日期：2026-10-28。版本：`3.3.2-seekinward.20261028`。分支：`seekinward`。

本次直接修改已有本地修复项目，起点为 `e73dabd`；该提交包含此前 ChatGPT 新版 DOM 适配。开始时工作区干净，没有覆盖用户未提交改动。保留上游 MIT 协议及署名，没有安装额外软件、依赖或用户脚本。

## 1. 架构与注入方式

这是原生 JavaScript / CSS 的 Manifest V3 Chrome 扩展，无 npm 依赖、无编译步骤、无后台服务。`extension/` 可直接加载。

- `manifest.json`：各站点注入入口和匹配范围。
- `content-chatgpt.js` / `styles-chatgpt.css`：ChatGPT 消息解析、时间轴、滚动定位、路由和 DOM 监听；`chatgpt-initial-jump-utils.js` 提供滚动辅助算法，`fiber-bridge-chatgpt.js` 为上游保留的 MAIN world 只读桥接。
- `content-gemini.js` / `styles-gemini.css`：已有完整 Gemini 时间轴实现，包含消息采集、标星、主题、滚动及 SPA 管理。类名虽然仍叫 `GeminiTimelineScaffold`，实际已有导航功能。
- `popup.html` / `popup.js`：通过 `chrome.storage.local` 控制总开关和各平台开关。
- DeepSeek 原有文件保留，本分支不注入、不验收。

各站点已经分文件隔离，因此继续复用现有组件与管理器，没有另造通用框架，也未引入大量平台条件。Gemini 的 marker 数据包含 `id`、`el`、位置和标星状态，供既有导航渲染及点击定位使用。

ChatGPT 能工作的原因是上一版已同时识别 `[data-turn-id]`、`[data-turn-key]`，从用户气泡提取摘要并定位，不把整个问答容器当作提问。

## 2. 根因与实际 DOM 证据

### 2.1 Gemini 没有被注入

原本地清单仅包含 ChatGPT 的两个域名。即使仓库里有 Gemini 脚本、弹窗中 Gemini 开关开启，Chrome 也不会执行它。修复前真实 Gemini 页面有 5 个用户气泡，时间轴数量为 0。

现在在 [manifest.json](../extension/manifest.json#L43) 增加 `https://gemini.google.com/*`，仅注入 Gemini 自己的脚本和样式，`run_at` 为 `document_idle`。API 权限仍只有 `storage`，没有新增 `host_permissions`、`<all_urls>` 或网络访问代码。ChatGPT 的注入配置保持原样，其未显式指定的 `run_at` 使用 Chrome 默认值。

### 2.2 消息与滚动容器不能靠猜测

在已登录的 Gemini 历史聊天中实际检查到：

```html
<infinite-scroller data-test-id="chat-history-container">
  <div class="conversation-container …" id="稳定的每轮ID">
    <user-query>
      … <div class="user-query-bubble-with-background">
        <div class="query-text">
          <h5 class="screen-reader-user-query-label">You said …</h5>
          <p class="query-text-line">…</p>
          …
        </div>
      </div>
    </user-query>
  </div>
</infinite-scroller>
```

现有气泡选择器实际仍然有效。`#chat-history` 包装层本身不滚动，实际滚动层是上述 `infinite-scroller`，原有滚动祖先判定可以识别，无需替换滚动算法。没有使用 Angular 生成的随机类名。

原逻辑只取第一条 `.query-text-line`，多行及列表内容会丢失。直接取父元素又会混入隐藏的无障碍摘要，实测导航出现 `You said` 和重复文本。现 [extractUserSummary](../extension/content-gemini.js#L580) 复制文本节点容器，移除隐藏 heading，再读取完整文本；不会修改 Gemini 原页面。实测首条摘要由包含隐藏文本的 1044 字符变为可见内容 934 字符，保留后续行和列表。

### 2.3 动态监听和生命周期缺口

以下问题通过源代码与先失败、后通过的回归用例确认；并非全部在网页中逐一触发故障：

- 单条消息时，最低公共祖先可能只是第一轮容器，观察不到后续同级消息。现在优先使用实际聊天历史容器：[findConversationRootFromFirst](../extension/content-gemini.js#L135)。
- 等待 DOM 的异步初始化不可取消；切换路由或关闭后仍可能继续初始化。现在使用 `AbortController` 取消等待和迟到初始化：[waitForElement](../extension/content-gemini.js#L71)。
- 销毁时部分主题、布局、交叉观察器和视口、提示框监听未清理。现在补齐清理，并取消滚动动画：[destroy](../extension/content-gemini.js#L471)。
- 内容监听未包含 `characterData`，纯文本节点更新可能遗漏。现在监听并沿用 250ms 防抖：[attachContentObserver](../extension/content-gemini.js#L526)。
- 优先使用实际 `.conversation-container[id]` 作为每轮稳定 ID，避免重复提问依赖文本哈希；保留旧 fallback：[rebuildMarkersPhase4](../extension/content-gemini.js#L629)。
- 空消息列表清空旧 marker，重建时重置虚拟范围；连续跳转取消上次 RAF，路由销毁后不再访问旧滚动节点：[scrollToMessage](../extension/content-gemini.js#L953)。

### 2.4 ChatGPT 回归发现的隐藏工作区

切换聊天后，ChatGPT 实际保留旧工作区，祖先内联样式为 `display: none !important`。原全局查询使旧聊天 2 条消息与当前聊天 4 条消息混为 6 个导航点，且公共祖先可能扩大到整个页面。

现增加 [isActiveTurn](../extension/content-chatgpt.js#L6)，在初始化、容器重绑定及用户消息采集中排除隐藏祖先，同时等待真正可用的消息出现，避免旧隐藏消息提前结束等待。保留虚拟化占位消息，不以“是否位于视口中”过滤。真实浏览器复测同页 `4 → 2 → 1` 条历史切换均只列当前聊天；新建聊天为 0 个时间轴。

## 3. 修改文件

| 文件 | 改动 |
| --- | --- |
| `extension/manifest.json` | Gemini 最小站点注入范围及版本更新 |
| `extension/content-gemini.js` | 完整摘要、原生 ID、历史容器、动态监听、销毁和滚动取消 |
| `extension/content-chatgpt.js` | 隐藏历史工作区隔离与等待有效消息 |
| `tests/gemini-compat.test.js` | 11 项 Gemini 回归检查 |
| `tests/chatgpt-dom-compat.test.js` | 原 7 项保留，新增 2 项隐藏工作区检查 |
| README、`LOCAL-FIX.md`、本报告 | 本分支安装说明和验收记录 |

样式、弹窗、上游滚动辅助算法、DeepSeek 文件没有修改。所有更改连同此前 ChatGPT 修复均随 `seekinward` 分支保存。

## 4. 测试结果

### 自动化检查

44 项通过：上游滚动辅助测试 24 项 + ChatGPT DOM 回归 9 项 + Gemini 回归 11 项。两份内容脚本 `node --check` 和 `git diff --check` 通过。对消息摘要、延迟 DOM、隐藏历史、清理和连续跳转的检查直接执行真实源码中的方法，但 DOM 替身不等同真实浏览器。

### Chrome 真实网页验证

使用当前用户已经登录的 Chrome，重新加载本地扩展并刷新专用测试标签页。测试消息只包含数字及“测试完成”，没有在原聊天里发消息或覆盖原草稿。表中“通过”只适用于观察到的场景。

| 场景 | ChatGPT | Gemini |
| --- | --- | --- |
| 扩展注入和导航面板 | 通过，单个面板 | 通过，单个面板 |
| 提取用户消息 | 通过，1 / 2 / 4 条历史 | 通过，5 条历史、完整多行且无隐藏摘要重复 |
| 点击导航定位 | 通过，点击首尾后目标进入可视区域 | 通过，首尾气泡到达历史区顶部附近 |
| 新建聊天 | 通过，旧面板移除 | 通过，旧面板移除 |
| SPA 切换历史 | 通过，旧隐藏聊天不再混入 | 通过，测试聊天与历史聊天切换后重建 |
| 发送消息与流式结束更新 | 通过，新聊天两次发送后 2 个导航点 | 通过，真实看到 Stop response，结束后 2 个导航点 |
| 长对话滚动 | 已验证已加载 4 轮的首尾；超长完整回复回归未验证，见下述限制 | 通过，实测约 17042px 高历史、668px 滚动视口，首尾跳转后 scrollTop 约 72 / 12784.5 |
| 重复导航 | 通过，当前会话数量匹配，无多面板 | 通过，5 个已加载气泡对应 5 个导航点，无多面板 |
| 原网页输入及聊天操作 | 输入、清空、发送、新建、切换通过；历史回复完整加载受限 | 输入、清空、发送、新建、切换通过 |
| 内容脚本错误日志 | 本轮未捕获该脚本错误 | 本轮未捕获该脚本错误 |

ChatGPT 测试期间部分历史回复显示 `This response couldn’t load`，侧边栏也出现 `Unable to load history`。关闭 ChatGPT 导航并刷新后仍出现相同提示；已恢复总开关、ChatGPT 和 Gemini 开启。这支持问题不由导航渲染触发，但未诊断其服务端或网络根因。首次两条新测试回复曾正常生成。不能据此宣称全部历史回复功能或超长完整回答回归已通过。

未验证：服务端分页的超大历史跨批次加载、极速连续切换压力、内存/性能基准、图片及附件在 Gemini 的独立覆盖、所有主题及窗口尺寸组合、编辑/重试分支、无痕模式和 Chrome 以外的浏览器。没有把单元测试通过当作这些项目通过。

## 5. 安装、开启及复测

当前已安装的是本地解压版，版本 `3.3.2-seekinward.20261028`，ID `focpcfbnjgocfapnjekgdcfblndgfccd`；加载目录仍是现有项目的 `extension/`。总开关、ChatGPT、Gemini 开启，DeepSeek 关闭。无痕、本地文件访问仍关闭；没有修改其他扩展或书签。

无需构建。以后更新源码后：

1. 打开 `chrome://extensions/`，找到“ChatGPT Conversation Timeline（本地修复）”，点重新加载按钮。
2. 刷新 ChatGPT、Gemini 标签页。已有页面不会自动换成新内容脚本。
3. 点击工具栏“会话时间轴”，控制总开关或各站点开关。
4. 打开一条已有消息的聊天，右侧出现时间轴；鼠标悬停看摘要，点击圆点定位对应用户提问，长按可标星。新建空聊天不显示时间轴，这是预期行为。导航按用户提问/轮次组织，不自动解析 AI 回复的章节标题。
5. 向上滚动加载更早历史，再确认导航更新。未加载到 DOM 的服务端消息不能直接索引。

如需从 fork 在另一台机器安装，请下载 **`seekinward` 分支**，开启 Chrome 扩展开发者模式，加载该分支的 `extension/`。不要同时启用此项目的商店版，避免两份脚本重复注入。

可选的代码检查需要 Node.js，仅开发验证需要，运行扩展不依赖 Node：

```sh
node tests/chatgpt-initial-jump-utils.test.js
node tests/chatgpt-dom-compat.test.js
node tests/gemini-compat.test.js
node --check extension/content-chatgpt.js
node --check extension/content-gemini.js
git diff --check
```

手工补测：在两站分别选超长聊天，向上加载至少两批历史，点击新出现的首尾圆点；连续发送两条消息并等待回复结束；切换聊天、返回；确认条目属于当前聊天且输入、自然滚动正常。ChatGPT 历史加载提示恢复后，优先补测完整长回复场景。图片、暗色主题与窄窗口可按同样步骤单独检查。

## 6. 后续扩展

未来适配 Claude、DeepSeek 时，可先沿用独立站点脚本，把“识别路由、查找历史根、提取用户消息、获取原生 ID、查找滚动容器”作为站点接口；确有多站重复修改需求时，再将 marker 渲染、标星、虚拟范围和滚动状态抽成共享模块。先通过真实 DOM 采样和跨站回归建立契约，本次没有开发新平台，也没有为架构整洁大规模重构。
