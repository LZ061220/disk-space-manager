# 磁盘空间管家 v0.3.0 测试版

> 这是未签名测试版。Windows SmartScreen 可能显示“未知发布者”。请从本仓库下载并核对 `SHA256SUMS.txt`。

## 主要功能

- 可视化浏览 C/D 盘目录占用和文件类型分布。
- 识别有限的系统/浏览器缓存候选。
- 清理操作送入 Windows 回收站。
- 使用本地 Qwen2.5 模型或离线规则分析文件夹来源。

## 本次安全改进

- 本地 API 增加随机会话令牌、同源限制和安全响应头。
- 移除客户端可直接指定的 `force: true` 清理绕过。
- 白名单外清理改用短期、单路径、一次性确认令牌。
- 不再信任 `TEMP/TMP` 环境变量决定清理白名单。
- 增加真实路径、目录联接、系统目录、用户资料、OneDrive 和重定向 Known Folders 保护。
- 重新扫描会主动刷新磁盘根目录统计。
- 增加安全回归测试、CI 和 Dependabot。

## 下载与校验

下载便携版 ZIP 和同一 Release 中的 `SHA256SUMS.txt`，然后在 PowerShell 中运行：

```powershell
Get-FileHash -Algorithm SHA256 .\磁盘空间管家-0.3.0-x64-portable-unsigned.zip
```

输出必须与 `SHA256SUMS.txt` 完全一致。

## 已知限制

- 当前版本没有 Authenticode 数字签名。
- 首次 AI 分析需要加载约 500 MB 的本地模型，可能短暂占用较多内存。
- 扫描结果是近似统计；无权限、锁定和符号链接目录会跳过。
- 仅支持 Windows 10/11 的 C/D 盘。
