# codeg-opencode-quota-widget

在 **codeg-server** 网页里常驻显示 **opencode-go 订阅剩余额度**（5小时滚动 / 每周 / 每月），支持多账号、已用/剩余切换、中英自适应。

![license](https://img.shields.io/badge/license-MIT-green)

## 效果

- 会话输入框工具栏里，“＋ 添加命令”按钮左边多一颗额度药丸：`⚡ 5h 94% · 周 56% · 月 78%`
- 点药丸弹出详情：每周期进度条 + 已用/剩余% + 精确重置时间 + 倒计时
- 右键药丸折叠成 `⚡`，再点恢复；状态跨刷新保持
- 多账号 Tab 切换；`＋` 直接在网页里添加/删除账号 Key（写回服务器）
- 跟随 codeg 语言（中文/英文自动切换）

## 原理

调用 opencode-go 订阅接口（和 opencode 官网用量同源）：

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer sk-...
→ {"usage":{"rolling":{"percent":6,"resetsAt":"..."},"weekly":{...},"monthly":{...}}}
```

`percent` 为**已用**百分比，剩余 = `100 - percent`。前端不直接碰 Key：由服务器端定时任务拉取后写成静态 `opencode-quota.json`，前端只读该文件。

## 一键安装

```bash
git clone https://github.com/gyc0109/codeg-opencode-quota-widget.git
cd codeg-opencode-quota-widget
sudo ./install.sh
```

安装脚本会做：复制前端 JS 到 codeg 的 web 目录、注入全部页面、装两个 systemd 服务、生成账号配置模板。装完浏览器 `Ctrl+F5` 硬刷新即可。

需求：Linux + systemd 的 codeg-server（如官方 `install.sh` 装的），Python3（仅标准库，无第三方依赖）。

## 配置账号

配置文件 `/root/.config/opencode/quota-accounts.json`（权限 600，明文 Key，注意保管）：

```json
[
  { "name": "主号", "apiKey": "sk-..." },
  { "name": "小号", "apiKey": "sk-..." }
]
```

- 文件不存在时自动回退到 `~/.config/opencode/opencode.jsonc` 里的单个 Key
- 也可以直接在网页详情浮层点 `＋` 添加（后端会先校验 Key 有效性再写入，所有浏览器共享）
- 后台每 60 秒刷新一次：`OPENCODE_QUOTA_INTERVAL=60`

## 端口

- `:3080` codeg-server 本体（额度数据：`/opencode-quota.json`）
- `:3081` 账号管理接口（增删账号，需带 codeg token，前端自动处理）。浏览器需能访问该端口，否则网页内添加账号会报网络错，改文件方式不受影响

## 文件结构

```
├── web/opencode-quota.js            # 前端：药丸 + 详情浮层（中英自适应）
├── bin/codeg-opencode-quota-updater # 后端：定时拉取多账号用量 → opencode-quota.json
├── bin/codeg-opencode-quota-api     # 后端：账号增删接口（:3081，token 鉴权）
├── bin/codeg-opencode-quota-patch   # 升级持久化：恢复 JS + 重注 html（codeg 升级不丢）
├── systemd/                         # 两个 service + codeg 的 ExecStartPre drop-in
├── install.sh / uninstall.sh
```

`uninstall.sh` 会完整清理（含 html 注入标签），账号配置文件保留。

## 隐私

- Key 只存在服务器 `600` 文件和服务端内存；前端拿到的只有百分比和重置时间，列表接口仅返回 Key 前 10 位脱敏
- 能进你 codeg 网页的人理论上能调管理接口（与 codeg 同权），请自行保护好 codeg 访问 token

## License

MIT
