# 网申自动填写助手（wangshen-autofill）

Manifest V3 浏览器扩展（Edge / Chrome 通用，原生 JavaScript、零构建链）。把简历信息一次性录入字段库后，在任意招聘网申页面上**短字段一键自动填、长文本点选填、开放题用 AI 起草**——全程数据只存本机，永不自动点提交。

![manifest](https://img.shields.io/badge/manifest-v3-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/runtime-browser%20only-orange)

## 功能

- **一键自动填充**：label 同义词匹配（60 组词库，覆盖互联网 + 央国企网申常见字段），得分 ≥ 阈值才填，已填字段高亮标记 + 复查清单
- **框架兼容**：绕过 React 受控组件的 value tracker，Vue/select/radio/checkbox/contenteditable 都能填
- **平台增强**：Moka（mokahr.com）、国聘（iguopin.com）定制识别；其余网站走通用启发式；手机号 +86 区号框、家庭成员表格、验证码控件自动避让
- **下拉框智能匹配**：`CET-4` ↔ `四级`、`共青团员` ↔ `团员`、`硕士` ↔ `研究生` 等同义写法自动对上
- **简历 PDF 导入**：pdf.js 本地抽文本 → 文本过少/乱码自动转 GLM 视觉模式（逐页）→ 提取结果先进入**人工校对界面**，勾选确认后才入库
- **开放题 AI 起草**：用档案里的自我介绍/项目/动机素材生成 ≤350 字草稿，保留最近 3 版历史，确认后才落表（需自备智谱 API Key）
- **多档案**：全字段模板 51 项（基本信息/教育/意向/政治面貌/家庭成员/四六级/奖惩…），有值就填、没值跳过；支持 JSON 备份导出/恢复
- **投递台账**：每次填充自动记录（公司/系统/URL/时间/数量），一键导出 UTF-8 BOM CSV（Excel 打开不乱码）
- **隐私遮挡**：手机号/身份证/薪资/家庭成员等敏感字段默认 `••••`，点眼睛可见
- **安全红线**：代码层面禁止点击任何「提交/发送/投递/确认」按钮，最后一步永远由你本人操作；验证码一律跳过并提示

## 安装（Edge，三步）

1. 下载本仓库（Code → Download ZIP 解压，或 `git clone`）
2. Edge 地址栏打开 `edge://extensions` → 打开「开发人员模式」→「加载解压缩的扩展」→ 选择本目录（`manifest.json` 所在层）
3. 固定工具栏图标；点侧边栏右上角 ⚙ 填入智谱 API Key（[open.bigmodel.cn](https://open.bigmodel.cn) 免费注册）

> Chrome 同理：`chrome://extensions` → 开发人员模式 → 加载已解压的扩展程序。

## 快速上手

1. **录入简历**：设置页 → 简历 PDF 导入 → 选 PDF → 开始提取 → 逐项校对 → 确认导入；或在侧边栏「字段库」直接手填
2. **填充**：打开网申页 → 浮条/侧边栏显示 `可自动填 N · 点选 M · 开放题 K` → 点「一键填充」→ 对照复查清单
3. **开放题**：点「✨起草」生成草稿（可换一版），改好后点「填入」
4. **台账**：投递完在「台账」页导出 CSV

## 数据与隐私

- 简历字段、档案、台账、草稿**全部只存在本机** `chrome.storage.local`，卸载扩展即彻底删除；插件没有服务器、没有统计埋点
- 唯一的对外请求是你**主动触发**的智谱 AI 调用（PDF 提取发简历文本、开放题起草发题目+素材），只发往 `open.bigmodel.cn`；不用 AI 功能则零联网请求
- 附件清单只登记文件名和备注，不读取文件本体
- 完整政策见 [store/PRIVACY.md](store/PRIVACY.md)

## 开发

零依赖、零构建：克隆即用。Node 仅用于跑验收脚本和打包。

```bash
node tools/verify.js          # 自动化验收 35 项（Edge 隔离 profile + CDP 驱动，跑完自动清理）
WSA_RESUME=D:\\path\\to\\resume.pdf node tools/verify.js   # 附加真实简历 PDF 本地解析测试
node tools/gen-icons.js       # 重新生成图标（含全透明自检）
node tools/package.js         # 打商店上传包 dist/wangshen-autofill-v<版本>.zip
python -m http.server         # 手动测试 test-pages/ 下的 mock 表单
```

验收覆盖：扩展加载、档案/模板/隐私遮挡、generic + React 受控组件 + Moka + 国聘四页检测与填充、家庭成员表格红线、Edge 重启后 storage 持久、扫描件视觉模式判定、校对导入链路、AI 无 key 错误路径、CSV BOM、"无提交类点击"静态检查等。

## 目录结构

```
manifest.json            MV3 清单
background.js            service worker：智谱 AI 代理、CSV 导出、数据种子
content/detector.js      平台识别 + 字段发现（label 归一化 + 同义词评分）
content/filler.js        填充执行（React 兼容赋值、同义选项匹配、高亮）
content/floatbar.js      页面右下角浮条（Shadow DOM）
sidepanel/               侧边栏：字段库 / 填充 / 台账 / 附件
options/                 设置页：API / 阈值 / PDF 导入校对 / 备份
data/templates.js        60 组同义词 + 全字段模板 + 档案工厂/升级
libs/pdfjs/              pdf.js 3.11.174（vendor，离线可用）
test-pages/              mock 表单（generic / react / moka / iguopin / fake-scan.pdf）
store/                   Edge 商店上架材料（步骤文案 + 隐私政策）
tools/                   图标生成 / 打包 / 自动化验收
```

## 路线图

- [ ] 更多 ATS 深度适配（北森、飞书招聘…欢迎提 issue 附站点）
- [ ] 商店上架（材料已备齐，见 store/）
- [ ] 字段库按站点记忆映射

## 致谢与许可边界

- [ritsth/job-autofill-extension](https://github.com/ritsth/job-autofill-extension)（MIT）：AI 答开放题的交互思路
- [1341524165/resume-autofill-ext](https://github.com/1341524165/resume-autofill-ext)（MIT）：国内 ATS 平台识别思路
- [23aaaa/jobfill](https://github.com/23aaaa/jobfill)：仅参考交互设计（无 License，未复制任何代码）
- [pdf.js](https://github.com/mozilla/pdf.js)（Apache-2.0）：已 vendor 至 `libs/pdfjs/`

本项目以 [MIT](LICENSE) 发布。欢迎使用、修改与二次发布；请勿将本工具用于任何需要代他人填写真实身份信息的场景。

## 免责声明

本工具只做表单填写辅助，不模拟登录、不处理验证码、不自动提交。使用本工具产生的一切投递行为由使用者本人负责。
