# -*- coding: utf-8 -*-
"""把本次安装包相关的结论追加到当日工作日志。"""
import io

NOTE = """

### 安装版 exe 已产出（改用 NSIS，绕开 ElectroBun）

**ElectroBun 的坑最终确认无解**：它必须从 GitHub Releases 下载 bun 1.4.0 toolchain，而本机直连 GitHub
**小请求正常（206 / 1 秒）但大文件会卡死**（40MB 的包 150 秒下不完），hutch 又不支持配置国内镜像。放弃这条路。

**改用 NSIS 直接打包**（NSIS 3.13 已通过 winget 装好）：
- `toonflow/scripts/launcher.cs` → 用 .NET Framework 的 C# 编译器编成 `JinyuTV.exe`（无控制台窗口的启动器：拉起服务 → 等服务就绪 → 打开页面）
- `toonflow/scripts/installer.nsi` → 标准 Windows 安装程序（欢迎页/选目录/进度/完成页 + 开始菜单与桌面快捷方式 + 应用图标 + 卸载项，装到 %LOCALAPPDATA%\\Programs\\JinyuTV）
- `toonflow/scripts/build-installer.py` → 一键流程：停服务 → 编译启动器 → makensis 打包
- 产物：`豆包画布开发/JinyuTV-2.0.0-Setup.exe`（约 51.9 MB）

**三个必须记住的修复（否则软件起不来）**：
1. **必须设 `toonflowDesktop=1`**。否则服务按「服务器部署」校验工作区（`apps/server/src/utils/workspace/index.ts` 的 resolveWorkspace），
   本地任意目录一律 403「服务器部署只能使用服务器工作区」，前端一请求就把进程带崩（实测服务启动几秒后自行退出）。
   `start-server.bat` 与 `launcher.cs` 里都已写入该变量。
2. **settings.json 里的工作区路径必须指向软件自己的 data/workspaces**。绿色版是从项目目录复制的，里面记着
   `...\\toonflow\\data\\workspaces`，而软件的工作区根是 `<软件目录>/data/workspaces`，对不上同样触发 403。
   → 已改路径，并把项目的画布数据同步了过去。
3. NSIS 打包前必须**停掉服务**，否则 `logs/server.log`、`data/` 下被占用的文件会让 makensis 报
   `File: failed opening file` 直接退出（已做 `stop_services()`，并在 nsi 里 `/x "logs"` 排除）。

**可用命令汇总**：
- 改完代码 → 更新软件并重启：`python toonflow/scripts/dev-update.py`（或双击 `toonflow/update-app.bat`）
- 重新出安装包：`python toonflow/scripts/build-installer.py`
- 出绿色版 zip：`python toonflow/scripts/make-portable.py`
"""

path = "2026-10-09.md"
with io.open(path, "a", encoding="utf-8") as fh:
    fh.write(NOTE)
print("已追加到 %s" % path)
