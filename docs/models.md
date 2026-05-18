# Live2D 模型调研

记录 2026-05-17。给 OpenMeido 选默认捆绑模型。

---

## 我们符合 Live2D 官方 sample 的免费分发条款吗？

**符合。**

适用条款：[Live2D Free Material License Agreement v1.6](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)（2026 年 2 月生效）。

允许人群：
- **General Users**（个人，含开源项目）
- **Small-Scale Enterprises**：年营收 < **¥10,000,000 JPY**（约 6.7 万美元 / 48 万人民币）

允许行为：**修改、嵌入应用、商用、再分发**。

义务：
1. 在 About 对话框 / README 之类的可见位置加 attribution：
   > This content uses sample data owned and copyrighted by Live2D Inc.
2. 仓库内附 `LICENSE-Live2D.md`（直接抄 [Open-LLM-VTuber 的版本](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/LICENSE-Live2D.md)）
3. 不能把"原始素材"作为独立资源单独再分发（即不能开个 GitHub 仓库专门转发 Live2D 模型——但作为应用 bundle 是 OK 的）

**前置先例**：Open-LLM-VTuber（MIT，3k+ stars）就在仓库里 ship 了 `mao_pro` 和 `shizuku`，社区认这种用法。

OpenMeido 远远在这个红线之下，可以放心用。

---

## 官方 sample 候选

下载入口：https://www.live2d.com/en/learn/sample/

| 模型 | 风格 | 表情数 | 文件大小 | 备注 |
|---|---|---|---|---|
| **Mao Pro** ⭐ | 现代二次元少女 | 8+ | ~6-10MB | Open-LLM-VTuber 用作 default，最像 AI kanojo |
| **Hiyori Momose** | 校服 | 6+ | ~4MB | Live2D 吉祥物，体积最小 |
| **Haru** | 围裙女仆风 ✨ | 中等 | - | 唯一沾边"maid"的，但偏可爱不性感 |
| **Niziiro Mao** | 休闲 | 5+ | - | 支持 Blend Shape |
| Shizuku | 绿裙 anime girl | - | - | ⚠️ 经典是 Cubism 2 (`.moc`)，需确认 sample 页有 Cubism 4 版本才能用 |

**全部排除以下**：
- Hatsune Miku（Crypton 单独条款，不让分发）
- Unity-chan（UCL 协议，单独管）
- Jin Natori / Tsumiki Harugasa（联名作品，限非商用，不让分发）

---

## 第三方付费模型（Booth / Nizima）

> 你说"我们可以花钱买"——这条**有个坑**：

**付费购买 ≠ 拿到分发权**。绝大多数 Booth / Nizima 模型默认条款是：
- ✅ 个人使用 OK（自己 VTube 直播、自己电脑桌面用）
- ❌ **不能再分发**（包括打包进 app 给别人用）

意味着即使我们付钱买一个完美的"meido"模型，也**不能 bundle 进 OpenMeido 让用户下载**——只能让用户自己买、自己塞进去。

### 三种处理思路

1. **官方 sample 当默认 + 让用户自带模型**（推荐）：仓库里捆 Mao Pro / Hiyori，UI 加 "Import Model" 按钮让用户选自己的 `.model3.json` 文件
2. **找 author 谈分发授权**：少数 Booth 卖家会标 "redistribution OK with credit" 或 "commercial license available"——付高价能买到。需要逐个甄别
3. **委托原创**：找 Live2D 画师定制一个 OpenMeido 专属 meido 模型，要求买断版权 + 完整分发权。成本估算：基础约 ¥100k–¥300k JPY（$700-2000），不算便宜但是一劳永逸

### 寻找带分发权的 Booth 模型

如果想走路线 2，关键词：

- Booth 搜索 https://booth.pm/en/items?q=Live2D%20メイド
- Booth 商业 license 标签：`商用利用可` / `再配布可`（要两个都有才行）
- Nizima Marketplace https://nizima.com/Marketplace/Search?keyword=メイド
- **VTube Studio 兼容模型 ≠ pixi-live2d-display 兼容**——前者支持额外的 `.vtube.json` 等元数据。pixi-live2d-display 只读 `.model3.json` + `.moc3`，多出来的文件不影响但也用不上

### 委托制作的渠道

- Skeb（日本画师外包平台）https://skeb.jp/
- Fiverr 也有 Live2D rigger，但日本画师质量稳定性更高
- Twitter 找标签 `#Live2D依頼`（Live2D 委托）

---

## 我的建议

**Spike 期间**继续用 haitu_vts（你已有，能跑就行）。

**MVP 之前**做这件事：把默认模型切到 **Mao Pro**，目录结构：

```
src/renderer/public/live2d-models/
  mao_pro/                       # bundled default
    mao_pro.model3.json
    ...
src/renderer/public/live2d-core/
  live2dcubismcore.min.js        # already vendored
LICENSE-Live2D.md                # repo root, attribution
```

UI 上：
- 默认加载 mao_pro
- Settings → "Live2D 模型" → 列出 `live2d-models/` 下所有 `.model3.json`
- 加个 "Import" 按钮，让用户选自己电脑上的模型文件夹（haitu / 自购 Booth 模型）

**远期**——如果 OpenMeido 火了 / 有商业化想法，再考虑委托一个 OpenMeido 专属 meido 模型作为 brand mascot。

---

## 关键链接

- 官方 sample 下载：https://www.live2d.com/en/learn/sample/
- Free Material License Agreement v1.6：https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html
- Sample Data 单独条款：https://www.live2d.com/eula/live2d-sample-model-terms_en.html
- Open-LLM-VTuber LICENSE-Live2D.md 模板：https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/LICENSE-Live2D.md
- Open-LLM-VTuber live2d-models 目录（参考结构）：https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/tree/main/live2d-models
- Booth Live2D メイド 搜索：https://booth.pm/en/items?q=Live2D%20メイド
- Nizima Marketplace：https://nizima.com/Marketplace/Search?keyword=メイド
