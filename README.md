# codeg-opencode-quota-widget

在 codeg 界面里常驻显示 **AI 订阅额度与用量**：opencode-go（5小时/周/月）、DeepSeek 余额、OpenRouter 余额，
外加本机 **CC Switch 网关**（请求/错误率/花费/上游健康度）与 **codeg 自身 token 用量**。
支持多供应商、多账号、燃烧率预测、已用/剩余切换、中英自适应。

![license](https://img.shields.io/badge/license-MIT-green)

支持平台：

| 平台 | 形态 | 安装方式 |
|---|---|---|
| Linux | codeg-server（systemd） | `sudo ./install.sh` |
| macOS | 浏览器模式：:3085 提供 codeg web UI（默认监听所有网卡，局域网可访问） | `./install.sh --browser` |
| macOS | 桌面版 codeg.app 窗口内注入（实验性） | `./install.sh --desktop-tweak` |

## 效果

- 会话输入框工具栏里一颗额度药丸：`⚡ 5h 73% · 周 48% · 月 74% | ● 1`（`● N` 为上游健康告警）
- 点药丸弹出详情：provider / 数据源 Tab、每窗口进度条 + 精确重置时间 + 倒计时 +
  **燃烧率与预计耗尽时间**（`↑9.9%/h · 约 7h 后耗尽`）、24h 曲线
- **CC Switch Tab**：今日/近1小时 请求·错误率·花费、上游健康列表、日/月限额进度、按模型分解
- **codeg 用量 Tab**：今日/近30天 token、按模型/按 agent 分解
- **quota.html 面板**：单文件免补丁页面——在 codeg 里用「HTML 预览」打开即可当插件用
  （浏览器模式下 `http://<host>:3085/quota.html` 也可直接访问）
- 多账号 Tab；告警覆盖：额度阈值 / 余额不足 / 预计耗尽 / 上游异常（带防轰炸）；中英自适应

## 支持的供应商与数据源

| 类型 | 来源 | 说明 |
|---|---|---|
| `opencode-go` | api/zen/go/v1/usage | 5小时/周/月 订阅窗口 |
| `deepseek` | api.deepseek.com/user/balance | ¥ 余额 + 消耗速率 |
| `openrouter` | openrouter.ai/api/v1/credits | $ 余额 |
| `cc-switch`（本地源） | `~/.cc-switch/cc-switch.db` 只读 | 网关请求/错误/花费/健康度/限额/per-model |
| `codeg-usage`（本地源） | codeg 本地 API（自动发现端口与 token） | codeg 内 token 用量与分解 |

## 原理

每个 key 型供应商一个适配器（`bin/_codeg_quota_providers.py`），统一产出**窗口**（百分比/金额/限额），
例如 opencode-go（与官网用量同源）：

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer sk-...
→ {"usage":{"rolling":{"percent":6,"resetsAt":"..."},"weekly":{...},"monthly":{...}}}
```

`percent` 为**已用**百分比，剩余 = `100 - percent`。前端不直接碰 Key：后台定时任务拉取后写
`opencode-quota.json`（账号/窗口）+ `opencode-quota-sources.json`（本地源），前端只读这两个文件
（桌面注入模式经本机 sidecar `:3081` 读取）。燃烧率由历史 jsonl 尾部样本现算。
上游抓取失败时保留上次成功数据并标注（不会退化成"—"）。

## 安装

### Linux（codeg-server + systemd）

```bash
git clone https://github.com/gyc0109/codeg-opencode-quota-widget.git
cd codeg-opencode-quota-widget
sudo ./install.sh
```

需求：systemd 的 codeg-server、Python3（仅标准库）。

### macOS（用户级，无需 sudo）

```bash
./install.sh                  # 基础：额度抓取 + 本机账号接口（launchd 常驻）
./install.sh --browser        # + 浏览器模式：把打补丁的 web UI 挂到本机 :3085
./install.sh --desktop-tweak  # + 桌面版注入：codeg.app 窗口内直接显示药丸（实验性，见下）
```

macOS 上安装内容：

- `~/.local/share/codeg-opencode-quota/`：脚本、前端母本、web 副本（浏览器模式）、备份
- `~/Library/LaunchAgents/app.codeg.opencode-quota.{updater,api,server,repair}.plist`
- `~/Library/Logs/codeg-opencode-quota/`：各服务日志
- 账号配置 `~/.config/opencode/quota-accounts.json`（自动从 `opencode.jsonc` 或 `~/.codeg/opencode-go-key` 导入）

#### 浏览器模式（`--browser`）

用独立 `codeg-server` 进程在 `:3085` 提供打补丁的 web UI（数据目录与桌面版共享）：

- 浏览器访问 `http://127.0.0.1:3085/`，首次在登录页填安装时打印的 token
- 端口默认 3085（可用 `CODEG_QUOTA_SERVER_PORT` 覆盖）——刻意错开 codeg 自带 web 服务的 3080，两者可共存
- 服务默认监听所有网卡（局域网可访问，codeg 自带 token 登录保护；静态文件不鉴权）
- codeg 升级后 repair agent 会自动刷新 web 副本（浏览器模式也会装这个 agent）
- 与桌面版可同时运行；不想要了：`./uninstall.sh` 或只删 server 相关 plist

#### 桌面注入模式（`--desktop-tweak`，实验性）

codeg 桌面版的 web UI 资源**内嵌在二进制里**，磁盘 web 目录注入无效，唯一可行路径是
dylib 注入（`WKWebView` userScript 注入前端脚本）：

- 安装时会给 codeg.app **ad-hoc 重签**（保留 hardened runtime，附加两个放行 entitlement）
- **副作用**：macOS 可能把 codeg 当"新 app"，重新弹窗询问文件夹/钥匙串权限——重新授权即可
- 需要**重启 codeg** 才生效；codeg 自动更新会整体替换 bundle，repair agent（launchd WatchPaths）会自动重新注入
- 回滚：`~/.local/share/codeg-opencode-quota/bin/codeg-opencode-quota-repair --remove`
  （有同版本官方备份时整体还原；否则剥离注入并重签，或重装官方包）

## 配置账号

配置文件 `~/.config/opencode/quota-accounts.json`（Linux root 为 `/root/.config/...`，权限 600，明文 Key，注意保管）。
新版为多供应商结构（旧版裸列表会自动兼容读取，首次写回时备份为 `.v1.bak`）：

```json
{
  "version": 2,
  "providers": [
    { "type": "opencode-go", "accounts": [ { "name": "主号", "apiKey": "sk-..." } ] },
    { "type": "deepseek",    "accounts": [ { "name": "DS",   "apiKey": "sk-..." } ] }
  ]
}
```

- 文件不存在或损坏时自动回退：`opencode.jsonc` 里的 `apiKey` → `~/.codeg/opencode-go-key`；
  文件存在时以文件为准（`[]` 就是"没有账号"，删除最后一个账号不会被回退复活）
- 也可以直接在网页详情浮层点 `＋` 添加（可选 provider；后端先校验 Key 有效性再写入，所有浏览器共享）
- 抓取节奏：opencode-go 60s、余额类 300s、cc-switch 60s、codeg 用量 300s

## 端口

- `:3085` macOS 浏览器模式的独立 server（Linux 服务端为本机 codeg 自带的 :3080）；额度数据可经 `:3081/quota.json` 读取
- `:3081` 账号管理接口（增删账号 + 额度数据只读转发）。macOS 仅监听 `127.0.0.1`；Linux 默认监听 `0.0.0.0`（可用 `OPENCODE_QUOTA_API_HOST` 收紧）。浏览器需能访问该端口，否则网页内添加账号会报网络错，改文件方式不受影响

## 数据流

```
updater(定时) ──写──> data 目录（规范） + web 静态根（存在时镜像，供同源 fetch）
前端 ── http(s) 页面 ──> 同源 /opencode-quota.json
     └─ 桌面壳(tauri://) ──> http://127.0.0.1:3081/quota.json（sidecar 转发）
```

## 文件结构

```
├── web/opencode-quota.js            # 前端：药丸 + 详情浮层（多 provider / 数据源 Tab / 燃烧率）
├── web/quota.html                   # 单文件面板（codeg「HTML 预览」免补丁插件 / 浏览器模式可访问）
├── bin/_codeg_quota_common.py       # 平台/路径/配置解析（含配置 v2 段落合并、codeg.db 只读）
├── bin/_codeg_quota_providers.py    # key 型供应商适配器（opencode-go / deepseek / openrouter）
├── bin/_codeg_quota_sources.py      # 本地数据源（cc-switch 网关 / codeg token 用量）
├── bin/codeg-opencode-quota-updater # 定时抓取：窗口 + 燃烧率 + 失败保留 + 历史
├── bin/codeg-opencode-quota-api     # sidecar：账号增删 + 数据端点（:3081）
├── bin/codeg-opencode-quota-patch   # 升级持久化：恢复 js/html + 递归重注（含原文备份）
├── bin/codeg-opencode-quota-repair  # macOS：codeg.app dylib 注入维护（备份/注入/还原）
├── systemd/                         # Linux 服务与 codeg ExecStartPre drop-in
├── launchd/                         # macOS LaunchAgent 模板（updater/api/server/repair）
├── tweak/                           # macOS 注入 dylib 源码 + 测试宿主
├── install.sh / uninstall.sh
```

`uninstall.sh` 会完整清理（含 html 注入、launchd/systemd 服务、codeg.app 还原），账号配置文件保留。

## 环境变量

| 变量 | 说明 |
|---|---|
| `OPENCODE_QUOTA_INTERVAL` | 抓取间隔秒数（默认 60；设置后统一覆盖各 provider 默认间隔） |
| `OPENCODE_QUOTA_API_PORT` / `OPENCODE_QUOTA_API_HOST` | 管理接口监听（默认 3081；host 默认 macOS=127.0.0.1，Linux=0.0.0.0） |
| `OPENCODE_QUOTA_ACCOUNTS` | 账号文件路径 |
| `CODEG_QUOTA_DATA_DIR` | 数据目录（json/历史/源数据） |
| `CODEG_QUOTA_WEB_ROOT` | 前端静态根（一般不用设，平台默认） |
| `CODEG_QUOTA_SERVER_PORT` | macOS 浏览器模式端口（默认 3085） |
| `CODEG_QUOTA_CCSWITCH_DB` | cc-switch 数据库路径（默认 `~/.cc-switch/cc-switch.db`） |
| `CODEG_DB` | codeg 主数据库路径（默认按平台探测） |
| `CODEG_STATIC_DIR` | codeg web 静态目录（Linux 服务端模式用） |

## 隐私

- Key 只存在本机 600 文件和服务端内存；前端拿到的只有百分比和重置时间，列表接口仅返回 Key 前 10 位脱敏
- 能进你 codeg 网页的人理论上能调管理接口（与 codeg 同权），请自行保护好 codeg 访问 token
- `:3081` 管理接口：配置了 `CODEG_TOKEN` 时全部接口要求 token；未配置时（macOS 桌面默认）
  只接受本机/桌面壳来源（Origin 白名单），任意网站无法跨源调用
- macOS 浏览器模式的静态文件（含额度百分比）不鉴权，与 Linux 行为一致；服务监听所有网卡，
  介意的话可用系统防火墙限制入站
- 桌面注入模式下 codeg 为 ad-hoc 签名（失去官方 Developer ID 身份）——这是注入的固有代价，
  `--remove` 会从官方备份整体还原

## License

MIT
