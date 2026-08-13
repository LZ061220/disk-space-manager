# 磁盘空间管家

一个面向 Windows 的本地磁盘空间可视化与谨慎清理工具。它可以浏览 C/D 盘目录占用、查看文件类型分布、识别有限的缓存候选，并通过 Windows 回收站处理用户明确确认的项目。

> [!WARNING]
> 当前 GitHub 测试版尚未进行 Authenticode 数字签名，Windows Defender SmartScreen 可能显示“未知发布者”或“Windows 已保护你的电脑”。请只从本仓库的 Releases 下载，并在运行前核对 Release 中提供的 SHA-256。正式稳定版计划使用可信代码签名证书。

## 安全设计

- 扫描本身只读；无权限、锁定和符号链接目录会跳过。
- 默认候选仅包括当前用户 Temp、Windows Temp、D3D 着色器缓存以及 Edge/Chrome 默认配置的缓存目录。
- 清理项目会送入 Windows 回收站，不进行永久删除。
- 白名单之外的项目必须经过二次确认；确认令牌只针对单一路径、只能使用一次并会短期失效。
- 磁盘根目录、Windows、Program Files、ProgramData、AppData、个人资料 Known Folders、OneDrive 和重定向个人目录不能强制清理。
- 本地 HTTP API 绑定 `127.0.0.1`，并要求随机会话令牌、同源请求和严格安全响应头。

任何能够移动文件的软件都无法替代备份。重要资料应先备份，再进行人工判断。

## 本地 AI 分析

可选的本地 AI 功能使用 llama.cpp 与 Qwen2.5 模型，只读取文件夹路径、文件名、扩展名、大小和目录统计，不读取文件内容，也不会将数据上传到互联网。模型不可用时会回退到本地规则分析。

模型和 llama.cpp 二进制体积较大，不存放在普通 Git 源码历史中。完整便携版通过 GitHub Releases 分发；第三方来源和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 从源码运行

要求：Windows 10/11、Node.js 22 或更新的 LTS 版本。

```powershell
npm ci
npm run desktop
```

如果没有放置 `ai/llama-server.exe` 和 `ai/models/*.gguf`，应用仍可运行，并自动使用规则分析。

浏览器验证版可运行：

```powershell
node disk-space-manager.js
```

然后打开控制台显示的本地地址。默认端口为 `8765`；若端口被占用，桌面版会自动选择空闲端口。

## 验证与构建

```powershell
npm run check
npm test
npm run build:dir
```

正式构建支持 electron-builder 的 Windows 代码签名配置。证书、私钥、密码和硬件令牌 PIN 不得写入源码或提交到 GitHub。没有签名凭据时生成的是未签名测试包。

## 隐私

- 扫描结果缓存在 `%LOCALAPPDATA%\DiskSpaceManager\scan-cache.json`。
- 缓存包含目录路径、目录大小和文件类型统计，不包含文件内容。
- 卸载或停止使用后，可以手动删除上述缓存目录。
- 应用不会上传遥测、扫描结果或 AI 提示词。

## 许可证

项目自身源码采用 [MIT License](LICENSE)。第三方运行时、模型和依赖保留各自许可证，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 安全问题

请阅读 [SECURITY.md](SECURITY.md)。涉及路径保护绕过或未授权清理的问题不应作为公开 Issue 披露。
