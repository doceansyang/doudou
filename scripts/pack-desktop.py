# -*- coding: utf-8 -*-
"""把 JinyuTV 桌面应用打包出来（等价于 apps/desktop/scripts/build.ts package，但能在本机跑通）。

为什么要自己写一遍：
  build.ts 里用 `await $` 执行 npm scripts，而在 Windows 下 bun 会用 cmd.exe 跑脚本 ——
  于是 `bun run build:tools` 里那句 `bun -e "...双引号..."` 被 cmd 吃掉引号，
  直接报 "The system cannot find the path specified."；web 构建又会因为 vite 清空
  build/web/assets 撞上 WorkBuddy 的批量删除守卫。
这里改用 Python subprocess **直接 exec 可执行文件（不经 shell）**，两个坑都绕开。

步骤（对齐 build.ts）：
  1. 构建启动动画线程 windowsSplashWorker.js
  2. 用 .NET Framework 的 C# 编译器产出 3 个原生小工具（协议启动器/保存对话框/更新助手）
  3. 各插件包与 web / mcp / server 构建
  4. electrobun build 产出应用目录
  5. （可选）NSIS 打安装包 —— 未安装 NSIS 时跳过并给出绿色版路径

用法：
  python scripts/pack-desktop.py            # 只出绿色版（不需要 NSIS）
  python scripts/pack-desktop.py --installer # 额外尝试打 NSIS 安装包
"""
import os
import shutil
import subprocess
import sys

PROJECT = "C:/Users/JinYuDream/WorkBuddy/豆包画布开发/toonflow"
BUN = "C:/Users/JinYuDream/.workbuddy/tools/bun/bun.exe"
ELECTROBUN = os.path.join(PROJECT, "apps", "desktop", "node_modules", "electrobun", "bin", "electrobun.cjs")
CSC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"),
                   "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
NSIS = os.environ.get("NSIS_PATH", r"C:/Program Files (x86)/NSIS/makensis.exe")

BUILD = os.path.join(PROJECT, "build")
DESKTOP = os.path.join(BUILD, "desktop")
PROTOCOL = os.path.join(DESKTOP, "protocol")


def build_env():
    """Windows 目录优先的 PATH。

    关键：Git 自带的 /usr/bin/tar 是 GNU tar，它会把 "C:\\Users\\..." 里的 "C:" 当成
    远程主机名，于是 Hutch 安装器解压时报 `tar: Cannot connect to C: resolve failed`。
    把 System32 放到 PATH 最前面，让它用上 Windows 自带的 bsdtar。
    """
    root = os.environ.get("SystemRoot", r"C:\Windows")
    head = [os.path.join(root, "System32"), root, os.path.dirname(BUN)]
    return dict(os.environ, NODE_ENV="production",
                PATH=os.pathsep.join(head + [os.environ.get("PATH", "")]))


def run(label, args, cwd=PROJECT, check=True, env=None):
    print("\n=== %s ===" % label)
    print("$ " + " ".join(args[:6]) + (" ..." if len(args) > 6 else ""))
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace",
                          env=env or build_env())
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if out:
        print(out[-2500:])
    if err:
        print("[stderr] " + err[-1500:])
    if check and proc.returncode != 0:
        raise SystemExit("步骤失败：%s（退出码 %d）" % (label, proc.returncode))
    return proc.returncode


def main():
    want_installer = "--installer" in sys.argv

    if not os.path.exists(BUN):
        raise SystemExit("找不到 bun：%s" % BUN)
    if not os.path.exists(ELECTROBUN):
        raise SystemExit("找不到 electrobun CLI：%s" % ELECTROBUN)

    os.makedirs(PROTOCOL, exist_ok=True)
    os.makedirs(os.path.join(DESKTOP, "startup"), exist_ok=True)

    # 1) 启动动画 worker
    run("构建启动动画 worker", [BUN, "run", "scripts/build-splash.ts"])

    # 2) 三个原生小工具
    if not os.path.exists(CSC):
        print("!! 找不到 C# 编译器，跳过原生工具：%s" % CSC)
    else:
        native = [
            ("protocolLauncher.exe", "protocolLauncher.cs",
             ["/reference:System.Windows.Forms.dll", "/reference:System.Web.Extensions.dll"], "winexe"),
            ("saveFileDialog.exe", "saveFileDialog.cs",
             ["/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll"], "winexe"),
            ("updateHelper.exe", "updateHelper.cs",
             ["/reference:System.Web.Extensions.dll", "/reference:System.Windows.Forms.dll",
              "/reference:Microsoft.CSharp.dll"], "winexe"),
        ]
        for out_name, src_name, refs, target in native:
            run("编译 %s" % out_name,
                [CSC, "/nologo", "/target:" + target, "/platform:x64", "/optimize+"] + refs +
                ["/out:" + os.path.join(PROTOCOL, out_name),
                 os.path.join(PROJECT, "apps", "desktop", "native", src_name)])

    # 3) 插件包 + web + mcp（server 由 electrobun 的 copy 直接取 build/server）
    env = build_env()

    # web 目录先改名，避免 vite 清空时撞删除守卫
    web_dir = os.path.join(BUILD, "web")
    if os.path.isdir(web_dir):
        # 注意：这里**绝不能删除**旧目录 —— 本会话有批量删除守卫（阈值 50 个文件），
        # 删 1031 个文件的目录会让进程被直接掐断（无 traceback）。改成唯一后缀改名。
        index = 3
        while os.path.isdir(web_dir + ".bak%d" % index):
            index += 1
        shutil.move(web_dir, web_dir + ".bak%d" % index)

    for label, args in [
        ("构建工具插件", [BUN, "run", "--filter", "./packages/tools/*", "build"]),
        ("构建扩展插件", [BUN, "run", "--filter", "./packages/ext/*", "build"]),
        ("构建节点插件", [BUN, "run", "--filter", "./packages/nodes/*", "build"]),
        ("构建前端", [BUN, "run", "--filter", "@toonflow/web", "build"]),
        ("构建 MCP", [BUN, "run", "--filter", "@toonflow/mcp", "build"]),
    ]:
        print("\n--- %s ---" % label)
        proc = subprocess.run(args, cwd=PROJECT, env=env, capture_output=True,
                              text=True, encoding="utf-8", errors="replace")
        tail = (proc.stdout or "").strip().splitlines()[-6:]
        for line in tail:
            print("   " + line)
        if proc.returncode != 0:
            print((proc.stderr or "")[-1200:])
            raise SystemExit("步骤失败：%s" % label)

    # 4) electrobun 打包
    run("electrobun build", [BUN, ELECTROBUN, "build", "--env=stable"])

    artifact = os.path.join(DESKTOP, "artifacts")
    print("\n构建产物目录：%s" % artifact)
    if os.path.isdir(artifact):
        for name in sorted(os.listdir(artifact))[:12]:
            print("   %s" % name)

    # 5) NSIS 安装包
    if want_installer:
        if not os.path.exists(NSIS):
            print("\n!! 未安装 NSIS（%s），跳过安装包。绿色版可直接运行。" % NSIS)
        else:
            run("NSIS 安装包", [BUN, os.path.join(PROJECT, "apps", "desktop", "scripts", "packageWindows.ts")])


if __name__ == "__main__":
    main()
