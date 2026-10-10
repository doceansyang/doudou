// JinyuTV 启动器：首次运行自动适配本机 → 拉起本地服务 → 打开**内嵌窗口**显示界面。
// 用 csc 编译成 winexe（无控制台窗口）：
//   csc /nologo /target:winexe /platform:x64 /optimize+ /out:JinyuTV.exe launcher.cs
//
// 窗口形态说明：
//   早先版本用 Process.Start(url, UseShellExecute=true) 打开界面，那是「交给系统默认浏览器」，
//   所以看起来像网页而不是软件。现在改为内嵌 WebView2（Edge 内核）窗口：
//   独立任务栏图标、自己的标题栏、没有地址栏与标签页，外观与原生桌面 UI 一致。
//   依赖：Microsoft.Web.WebView2.Core.dll / .WinForms.dll / WebView2Loader.dll（与本 exe 同目录），
//         以及系统上的 WebView2 Runtime（Win10 1607+ 通常已随 Edge 预装）。
//   若 Runtime 缺失，自动降级为默认浏览器打开并在窗口内提示，保证「永远有界面可看」。
//
// 豆包窗口的收编（本文件后半部分 EmbedWatch）：
//   RPA 需要真实浏览器（豆包风控识别无头），以前它另起一个**独立顶层窗口**，
//   被别的窗口一挡，用户就「找不到那个窗口」，扫码/人工验证无从下手。
//   现在由本进程定时扫出带 `--toonflow-rpa` 标记的浏览器进程，把它的窗口
//   SetParent 到右侧「豆包窗口」侧栏里 —— 用户全程在软件内部看到并操作。
//   侧栏按需自动展开；Ctrl+B 可手动收起/展开。
//
// 为什么要「自动适配本机」：
//   安装包里的 data/ 是**打包时那台机器**的快照，settings.json 与 doubao/accounts.json
//   里记的是绝对路径（形如 C:\Users\某人\...）。换台电脑、换个安装目录，这些路径就不存在：
//     - 工作区路径不存在 → 服务返回 404/403，界面报「工作目录不存在」甚至进程退出
//     - 账号 profile 不存在 → 误判为「已登录」，实际拿不到登录态
//   所以每次启动都做一次幂等校准：路径不存在就改成本机实际目录；额度状态清零。
//
// 用法：
//   JinyuTV.exe                  正常启动（校准 + 起服务 + 开窗口）
//   JinyuTV.exe --bootstrap-only 只做校准后退出（供 start-server.bat 复用）
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

class JinyuTVLauncher
{
    public const int PORT = 3000;
    // 打开软件落在**首页**（用户要求），不要直接进画布。
    // 这里刻意只给根地址，把落点交给前端路由决定：
    //   未完成引导 → 引导页；完成过 → 首页（router/index.ts 的 /hello beforeEnter）。
    // 硬编码 /#/workspace 会绕过那层判断，一打开就是画布。
    const string START_URL = "http://localhost:3000/";
    const string WINDOW_TITLE = "JinyuTV";
    public static readonly Color ShellBg = Color.FromArgb(23, 23, 26);

    static string BaseDir { get { return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'); } }

    [STAThread]
    static int Main(string[] args)
    {
        bool bootstrapOnly = Array.Exists(args, a => a == "--bootstrap-only");
        Trace("启动器开始（bootstrapOnly=" + bootstrapOnly + "），目录=" + BaseDir);

        // 关键：保证运行数据在本机真实存在，并把打包机残留的绝对路径改成本机路径。
        BootstrapData(BaseDir);
        Trace("本机适配完成");
        if (bootstrapOnly) return 0;

        string server = Path.Combine(BaseDir, "build", "server", "index.js");
        if (!File.Exists(server))
        {
            Fail("找不到 build\\server\\index.js\n\n请确认安装完整：\n" + BaseDir);
            return 1;
        }
        string bat = Path.Combine(BaseDir, "start-server.bat");
        if (!File.Exists(bat))
        {
            Fail("找不到 start-server.bat\n\n请确认安装完整：\n" + BaseDir);
            return 1;
        }
        Directory.CreateDirectory(Path.Combine(BaseDir, "logs"));

        // 已经在跑就不再重复起服务。若已有窗口，把它提到前台（双击第二次不该出现两个窗口）
        Process serverProc = null;
        if (PortAlive(PORT))
        {
            IntPtr hwnd = FindWindow(null, WINDOW_TITLE);
            if (hwnd != IntPtr.Zero)
            {
                Trace("3000 已在运行且已有窗口，前置已有窗口后退出");
                ShowWindow(hwnd, SW_RESTORE);
                SetForegroundWindow(hwnd);
                return 0;
            }
            Trace("3000 已在运行，直接打开窗口（不重复起服务）");
        }
        else
        {
            serverProc = StartServer();
            if (serverProc == null) return 1;
        }

        // 高 DPI 清晰渲染；必须在创建任何窗口之前调用
        try { SetProcessDPIAware(); } catch { }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        int exit = 0;
        try
        {
            using (var win = new MainWindow(BaseDir, START_URL))
            {
                Application.Run(win);
            }
        }
        catch (Exception ex)
        {
            Trace("界面异常：" + ex);
            Fail("界面启动失败：\n" + ex.Message);
            exit = 1;
        }

        // 关闭窗口 = 退出软件：把本次启动的服务进程树一并停掉，避免后台残留
        if (serverProc != null)
        {
            Trace("窗口已关闭，停止服务（PID=" + serverProc.Id + "）");
            KillTree(serverProc.Id);
        }
        Trace("启动器结束");
        return exit;
    }

    // ---------------------------------------------------------------- 服务进程

    static Process StartServer()
    {
        // 三个坑都踩过，这里刻意绕开：
        //   ① 不能用 psi.EnvironmentVariables 往子进程加环境变量 ——
        //      当用户环境里同时存在 HTTP_PROXY 和 http_proxy（装了代理工具的机器很常见）时，
        //      该字典在构造时就会抛 ArgumentException，启动器直接崩，表现是「双击没反应」。
        //      环境变量统一交给 start-server.bat 用 set 声明（单一来源）。
        //   ② 不用 `cmd /c start` —— 多包一层进程，工作目录与重定向容易跑偏，实测不执行。
        //   ③ 参数里不要给 .bat 套引号：`/c ""D:\...\start-server.bat""` 这种写法
        //      实测 cmd 解析失败、命令静默不执行。用「工作目录 + 相对文件名」最稳。
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c start-server.bat",
                WorkingDirectory = BaseDir,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            var p = Process.Start(psi);
            Trace("已拉起 start-server.bat（cmd /c，PID=" + p.Id + "，工作目录=" + BaseDir + "）");
            return p;
        }
        catch (Exception ex)
        {
            Trace("拉起失败：" + ex.Message);
            Fail("启动服务失败：\n" + ex.Message);
            return null;
        }
    }

    static void KillTree(int pid)
    {
        try
        {
            Process.Start(new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch { }
    }

    // ---------------------------------------------------------------- 本机适配

    static void BootstrapData(string dir)
    {
        string dataDir = Path.Combine(dir, "data");
        string wsRoot = Path.Combine(dataDir, "workspaces");
        // 项目 = workspaces 下的**一个独立文件夹**，文件夹名就是项目名。
        //   绝不把 workspaces 根当项目目录：那样「文档」面板会把 workspaces 下的
        //   各种内部目录（迁移备份、旧项目、assets）一并倒出来，
        //   用户看到的就是一堆看不懂的层级，而不是「一个一个的项目」。
        string projectDir = Path.Combine(wsRoot, "我的项目");
        try { Directory.CreateDirectory(wsRoot); } catch { }

        // 默认项目目录**只在真的要用到它时才创建**。
        //   以前是无条件创建，于是每个用户的工作区里都多出一个空的「我的项目」，
        //   在「导入项目 / 添加项目」的目录浏览器里就是一个看不懂的空文件夹 ——
        //   用户会以为那是别人的项目或者坏掉的目录。
        bool needDefault = PatchSettings(Path.Combine(dataDir, "settings.json"), projectDir, wsRoot);
        if (needDefault)
        {
            try
            {
                Directory.CreateDirectory(projectDir);
                Directory.CreateDirectory(Path.Combine(projectDir, "assets"));
            }
            catch { }
        }

        PatchAccounts(Path.Combine(dataDir, "doubao", "accounts.json"));
    }

    /// <summary>
    /// 项目目录校准。三种情况：
    ///   ① 记录指向的是「workspaces 根」→ 改写成 workspaces\我的项目
    ///      （旧版本把仓库根当成了项目，于是「文档」面板把 _before-migrate、旧项目、
    ///        assets 这些内部目录全倒出来，用户看到的不是「项目」而是一堆层级）；
    ///   ② 记录指向本机不存在的路径（换机残留）→ 同样改写到本机默认项目；
    ///   ③ 完全没有记录（发行版刻意清空）→ 注入一个默认项目，
    ///      让用户装完第一次打开就能直接用。
    /// 返回值：是否用到了默认项目目录（调用方据此决定要不要真的创建它）。
    /// </summary>
    static bool PatchSettings(string path, string projectDir, string wsRoot)
    {
        bool usedDefault = false;
        try
        {
            if (!File.Exists(path)) return false;
            string text = File.ReadAllText(path, Encoding.UTF8);
            string original = text;
            const string STORE_KEY = "toonflow.projectList";

            int storesStart = IndexOfKey(text, "\"stores\"");
            if (storesStart >= 0)
            {
                int brace = text.IndexOf('{', storesStart);
                if (brace >= 0)
                {
                    int close = MatchBrace(text, brace);
                    if (close > brace)
                    {
                        string inner = text.Substring(brace + 1, close - brace - 1);
                        if (inner.Contains("\"" + STORE_KEY + "\""))
                        {
                            // ①② 已有项目记录：根目录或不存在的路径都改写到本机默认项目
                            inner = Regex.Replace(inner, "\"directory\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"", m =>
                            {
                                string real = Unescape(m.Groups[1].Value);
                                if (SamePath(real, wsRoot) || !Exists(real))
                                {
                                    usedDefault = true;
                                    return "\"directory\": \"" + Escape(projectDir) + "\"";
                                }
                                return m.Value;
                            });
                        }
                        else
                        {
                            // ③ 全新安装：注入默认项目
                            usedDefault = true;
                            // lastOpenedAt 用「当前时间」而不是 0 —— 否则界面上会显示「最近打开 1970/1/1」。
                            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                            string trimmed = inner.TrimEnd();
                            string sep = trimmed.Length == 0 ? "" : ",";
                            string entry = "\"" + STORE_KEY + "\": {\"project\": {\"directory\": \"" + Escape(projectDir)
                                         + "\", \"name\": \"我的项目\", \"lastOpenedAt\": " + now + "}, \"projectList\": [{\"directory\": \""
                                         + Escape(projectDir) + "\", \"name\": \"我的项目\", \"lastOpenedAt\": " + now + "}]}";
                            inner = trimmed + sep + entry;
                        }
                        text = text.Substring(0, brace + 1) + inner + text.Substring(close);
                    }
                }
            }

            if (text != original)
            {
                Backup(path);
                File.WriteAllText(path, text, new UTF8Encoding(false));
            }
        }
        catch { /* 校准失败不阻断启动，服务端仍会给出明确报错 */ }
        return usedDefault;
    }

    /// <summary>
    /// 账号 profile 目录校准：指向打包机（不存在）时改写到本机用户目录，
    /// 并把「今日额度已用尽」等打包机状态清零，避免新电脑一上来就报额度耗尽。
    /// </summary>
    static void PatchAccounts(string path)
    {
        try
        {
            if (!File.Exists(path)) return;
            string text = File.ReadAllText(path, Encoding.UTF8);
            string original = text;
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            bool repointed = false;

            text = Regex.Replace(text, "\"profileDir\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"", m =>
            {
                string real = Unescape(m.Groups[1].Value);
                if (Exists(real)) return m.Value;
                string leaf = real.TrimEnd('\\');
                int cut = leaf.LastIndexOf('\\');
                if (cut >= 0) leaf = leaf.Substring(cut + 1);
                string target = (leaf.Length == 0 || leaf == ".toonflow-doubao-profile")
                    ? Path.Combine(home, ".toonflow-doubao-profile")
                    : Path.Combine(home, ".toonflow-doubao-accounts", leaf);
                repointed = true;
                return "\"profileDir\": \"" + Escape(target) + "\"";
            });

            if (repointed)
            {
                text = Regex.Replace(text, "\"hasLoggedIn\"\\s*:\\s*true", "\"hasLoggedIn\": false");
                text = Regex.Replace(text, "\"quotaExhaustedOn\"\\s*:\\s*\"[^\"]*\"", "\"quotaExhaustedOn\": \"\"");
                text = Regex.Replace(text, "\"quotaUsageDate\"\\s*:\\s*\"[^\"]*\"", "\"quotaUsageDate\": \"\"");
                text = Regex.Replace(text, "\"generatedToday\"\\s*:\\s*\\d+", "\"generatedToday\": 0");
            }

            if (text != original)
            {
                Backup(path);
                File.WriteAllText(path, text, new UTF8Encoding(false));
            }
        }
        catch { }
    }

    // ---------------------------------------------------------------- 小工具

    /// <summary>
    /// 记录启动器自身的操作轨迹到 logs\launcher.log。
    /// 启动器是 winexe（没有控制台），出问题时否则「什么都看不到、只看到双击没反应」，
    /// 所以关键步骤都留痕，方便排查。
    /// </summary>
    public static void Trace(string message)
    {
        try
        {
            string logs = Path.Combine(BaseDir, "logs");
            Directory.CreateDirectory(logs);
            File.AppendAllText(Path.Combine(logs, "launcher.log"),
                "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message + "\r\n",
                new UTF8Encoding(false));
        }
        catch { }
    }

    static int IndexOfKey(string text, string quotedKey) { return text.IndexOf(quotedKey, StringComparison.Ordinal); }

    /// <summary>从 open 位置的 '{' 找到配对的 '}'（跳过字符串字面量内的括号）。</summary>
    static int MatchBrace(string text, int open)
    {
        int depth = 0;
        bool inString = false;
        for (int i = open; i < text.Length; i++)
        {
            char c = text[i];
            if (inString)
            {
                if (c == '\\') { i++; continue; }
                if (c == '"') inString = false;
                continue;
            }
            if (c == '"') { inString = true; continue; }
            if (c == '{') depth++;
            else if (c == '}')
            {
                depth--;
                if (depth == 0) return i;
            }
        }
        return -1;
    }

    /// <summary>路径相等判断（忽略分隔符方向、结尾反斜杠与大小写）。</summary>
    static bool SamePath(string left, string right)
    {
        if (string.IsNullOrEmpty(left) || string.IsNullOrEmpty(right)) return false;
        return string.Equals(left.Replace('/', '\\').TrimEnd('\\'), right.Replace('/', '\\').TrimEnd('\\'),
                             StringComparison.OrdinalIgnoreCase);
    }

    static bool Exists(string path)
    {
        if (string.IsNullOrEmpty(path)) return false;
        try { return Directory.Exists(path); } catch { return false; }
    }

    static string Unescape(string raw) { return raw.Replace("\\\\", "\\").Replace("\\\"", "\""); }

    static string Escape(string path) { return path.Replace("\\", "\\\\"); }

    /// <summary>改动前留一份 .orig（只留第一次，避免覆盖真正的原始版本）。</summary>
    static void Backup(string path)
    {
        try
        {
            string bak = path + ".orig";
            if (!File.Exists(bak)) File.Copy(path, bak, false);
        }
        catch { }
    }

    public static string TailOf(string path, int lines)
    {
        try
        {
            if (!File.Exists(path)) return "(无日志)";
            var all = File.ReadAllLines(path);
            int n = Math.Min(lines, all.Length);
            return string.Join("\n", all, all.Length - n, n);
        }
        catch { return "(读取日志失败)"; }
    }

    public static bool PortAlive(int port)
    {
        try
        {
            using (var client = new System.Net.Sockets.TcpClient())
            {
                var task = client.ConnectAsync("127.0.0.1", port);
                return task.Wait(700) && client.Connected;
            }
        }
        catch { return false; }
    }

    public static void OpenInBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { }
    }

    // ---------------------------------------------------------------- 主题记忆
    // 为什么需要它：
    //   窗口边框的颜色靠「问工作台页面当前是深色还是浅色」来决定，但**启动动画阶段**
    //   页面还没载入（是内嵌的 HTML），此时拿不到主题，标题栏就会停在 Windows 默认的
    //   浅色上 —— 用户看到的现象就是「启动时有一条白色标题栏，进了界面才变深」。
    //   所以把上次判定出的主题落盘，窗口一创建就按它上色，启动全程颜色一致。

    static string ThemeFile { get { return Path.Combine(BaseDir, "data", "ui-theme.txt"); } }

    /// <summary>读取上次的主题（"dark" / "light"）。没有记录时按软件默认的深色。</summary>
    public static string ReadLastTheme()
    {
        try
        {
            if (File.Exists(ThemeFile))
            {
                string value = File.ReadAllText(ThemeFile, Encoding.UTF8).Trim().ToLowerInvariant();
                if (value == "dark" || value == "light") return value;
            }
        }
        catch { }
        return "dark";
    }

    public static void SaveLastTheme(bool dark)
    {
        try
        {
            string dir = Path.GetDirectoryName(ThemeFile);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(ThemeFile, dark ? "dark" : "light", new UTF8Encoding(false));
        }
        catch { }
    }

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    const int SW_RESTORE = 9;

    // 不引用 WinForms 之外的东西，用 powershell 弹一个原生提示框（仅在窗口都无法创建时使用）
    static void Fail(string text)
    {
        try
        {
            var esc = text.Replace("'", "''");
            Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -Command \"Add-Type -AssemblyName PresentationFramework; " +
                            "[System.Windows.MessageBox]::Show('" + esc + "','" + WINDOW_TITLE + "')\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch { }
    }
}

/// <summary>
/// 主窗口：内嵌 WebView2 承载工作台，右侧是可自动展开的「豆包窗口」侧栏。
/// </summary>
class MainWindow : Form
{
    // ---- 豆包浏览器窗口的收编：RPA 启动的浏览器带这个命令行标记
    const string RPA_MARK = "--toonflow-rpa";
    const int HOST_WIDTH = 620;
    /** 右侧「豆包窗口」侧栏的标题条高度（嵌入区从它下方开始） */
    const int HOST_BAR_H = 34;

    // ---- 窗口边框 / 标题栏跟随软件主题
    // 用户要求：软件是深色就用深色边框，软件是浅色就用浅色边框。
    // 原生的 Windows 标题栏永远是浅色，配深色界面很突兀；这里用 DWM 把它染成与软件一致。
    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;   // Win10 20H1+ 用 20，1809~1909 用 19
    const int DWMWA_USE_IMMERSIVE_DARK_MODE_OLD = 19;
    const int DWMWA_BORDER_COLOR = 34;              // 以下三个仅 Win11（build 22000+）
    const int DWMWA_CAPTION_COLOR = 35;
    const int DWMWA_TEXT_COLOR = 36;

    // Win32（嵌入外部窗口）
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hwnd, int idx, int val);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int idx);
    [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder buf, int max);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);

    const int GWL_STYLE = -16;
    const int WS_CHILD = 0x40000000;
    const int WS_POPUP = unchecked((int)0x80000000);
    const int WS_CAPTION = 0x00C00000;
    const int WS_THICKFRAME = 0x00040000;

    readonly string _dir;
    readonly string _url;
    WebView2 _web;
    Panel _host;
    Panel _embedArea;
    Panel _hostBar;
    Label _hostTitle;
    // 顶部「返回」条：只在 WebView 离开软件、加载了**外部网页**时出现。
    // 为什么需要：设置里那些外链（官方中转平台、GitHub 仓库、支付页…）是 target=_blank，
    // 而我们对 _blank 的处理是「在本窗口打开」（避免甩到找不到的浏览器窗口）。
    // 结果就是整个窗口被外部网页顶掉、没有任何返回入口 —— 用户进了死胡同。
    Panel _navBar;
    Button _navBtnBack;
    Button _navBtnBrowser;
    Label _navUrl;
    string _lastAppUrl = "";     // 离开软件前最后一个软件内地址，返回时用它（保留所在路由）
    string _externalUrl = "";    // 当前外部网页地址（供「用浏览器打开」）
    System.Windows.Forms.Timer _watch;
    System.Windows.Forms.Timer _themeWatch;
    bool? _appliedDark;
    // 软件自身的深浅色（只在软件页面上取样更新）。
    // 为什么单独存一份：外部网页没有我们的 dark 标记，去问它会把外壳误判成浅色；
    // 而且取样有竞态（外部页刚开始加载时可能问到的还是旧文档），
    // 所以另有一个确定性的兜底 —— 一旦离开软件，就用这个值把外壳拨回来。
    bool _appDark = true;

    IntPtr _embedded = IntPtr.Zero;
    int _embeddedStyle;
    bool _scanning;
    bool _userCollapsed;
    // 载入失败重试（见 RetryNavigate）：服务被外部重启时，窗口原来会一直停在浏览器的
    // 错误页（整片白），必须手动重开软件才恢复。现在改成自动重试到服务回来为止。
    bool _booted;
    int _navRetry;
    bool _navRetryPending;
    bool _navRetryGaveUp;
    DateTime _navRetrySince;

    public MainWindow(string dir, string url)
    {
        _dir = dir;
        _url = url;

        Text = "JinyuTV";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1024, 640);
        BackColor = JinyuTVLauncher.ShellBg;
        AutoScaleMode = AutoScaleMode.Dpi;
        KeyPreview = true;
        try
        {
            string ico = FindIcon();
            if (ico != null) Icon = new Icon(ico);
        }
        catch { }

        // 右侧「豆包窗口」侧栏（默认隐藏，检测到 RPA 浏览器时自动展开）
        _hostBar = new Panel();
        _hostBar.Height = HOST_BAR_H;
        _hostBar.BackColor = Color.FromArgb(30, 30, 35);

        _hostTitle = new Label();
        _hostTitle.Text = "豆包窗口 · Ctrl+B 收起";
        _hostTitle.ForeColor = Color.FromArgb(170, 170, 180);
        _hostTitle.AutoSize = false;
        _hostTitle.Dock = DockStyle.Fill;
        _hostTitle.TextAlign = ContentAlignment.MiddleLeft;
        _hostTitle.Padding = new Padding(12, 0, 0, 0);

        _hostBar.Controls.Add(_hostTitle);

        _embedArea = new Panel();
        _embedArea.BackColor = Color.FromArgb(34, 34, 40);

        _host = new Panel();
        _host.Visible = false;
        _host.BackColor = Color.FromArgb(34, 34, 40);
        // _embedArea / _web 都用**显式 Bounds**（在 LayoutShell 里算），不用 Dock=Fill：
        //   Dock=Fill 会在每次布局时把手写的 Bounds 覆盖掉，于是这两个控件铺满整个区域，
        //   把顶部的「返回条」和侧栏标题条**盖在下面看不见**（用户报的「遮挡」）。
        _host.Controls.Add(_embedArea);
        _host.Controls.Add(_hostBar);

        _web = new WebView2();
        try { _web.DefaultBackgroundColor = JinyuTVLauncher.ShellBg; } catch { }

        // 顶部「返回」条（默认隐藏，离开软件加载外部网页时出现）
        _navBar = new Panel();
        _navBar.Visible = false;

        _navBtnBack = new Button();
        _navBtnBack.Text = "← 返回 JinyuTV";
        _navBtnBack.FlatStyle = FlatStyle.Flat;
        _navBtnBack.FlatAppearance.BorderSize = 0;
        _navBtnBack.Cursor = Cursors.Hand;
        _navBtnBack.TabStop = false;
        _navBtnBack.Click += delegate { GoBackToApp(); };

        _navUrl = new Label();
        _navUrl.AutoSize = false;
        _navUrl.AutoEllipsis = true;
        _navUrl.TextAlign = ContentAlignment.MiddleLeft;

        _navBtnBrowser = new Button();
        _navBtnBrowser.Text = "用浏览器打开";
        _navBtnBrowser.FlatStyle = FlatStyle.Flat;
        _navBtnBrowser.FlatAppearance.BorderSize = 0;
        _navBtnBrowser.Cursor = Cursors.Hand;
        _navBtnBrowser.TabStop = false;
        _navBtnBrowser.Click += delegate
        {
            if (!string.IsNullOrEmpty(_externalUrl)) JinyuTVLauncher.OpenInBrowser(_externalUrl);
        };

        _navBar.Controls.Add(_navBtnBack);
        _navBar.Controls.Add(_navUrl);
        _navBar.Controls.Add(_navBtnBrowser);

        Controls.Add(_web);
        Controls.Add(_navBar);
        Controls.Add(_host);
        // 它们与网页**不重叠**，但层级仍要明确 —— 否则会看到网页压在返回条/侧栏上面。
        _navBar.BringToFront();
        _host.BringToFront();
        _host.Resize += delegate { SyncEmbedSize(); };

        Load += async delegate(object s, EventArgs e) { await Boot(); };

        // 定时收编豆包浏览器窗口
        _watch = new System.Windows.Forms.Timer();
        _watch.Interval = 2500;
        _watch.Tick += delegate { WatchTick(); };

        // 定时同步主题：读页面当前深浅色，把窗口标题栏/边框染成一致的颜色
        _themeWatch = new System.Windows.Forms.Timer();
        _themeWatch.Interval = 2000;
        _themeWatch.Tick += async delegate { await SyncTheme(); };

        // 尺寸必须放到控件全部建好之后再设：赋 ClientSize 会立刻触发
        // OnSizeChanged -> LayoutShell()，若那时 _host/_web 还是 null 就抛
        // NullReferenceException，表现为「一启动就弹『界面启动失败』」（已踩过）。
        ClientSize = new Size(1500, 920);
        LayoutShell();
    }

    string FindIcon()
    {
        string[] cands = { "logo.ico", "assets\\logo.ico", "build\\logo.ico", "runtime\\logo.ico" };
        foreach (string c in cands)
        {
            string p = Path.Combine(_dir, c);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    // ---------------------------------------------------------------- 界面布局

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // 窗口一创建就按「上次的主题」染色。否则启动动画那几秒（工作台还没载入、
        // 问不到页面主题）标题栏会停在系统默认的浅色上，用户看到一条白边。
        string last = JinyuTVLauncher.ReadLastTheme();
        JinyuTVLauncher.Trace("窗口创建，按上次主题上色：" + last);
        _appDark = string.Equals(last, "dark", StringComparison.OrdinalIgnoreCase);
        ApplyTitleBarTheme(_appDark);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        LayoutShell();
    }

    void LayoutShell()
    {
        // 构造期（ClientSize / MinimumSize / AutoScaleMode 赋值）就会触发 SizeChanged，
        // 那时控件还没建好 —— 必须保护，否则 NullReferenceException 会让软件启动即失败。
        if (_host == null || _web == null || _hostBar == null || _navBar == null || _embedArea == null) return;

        int w = ClientSize.Width, h = ClientSize.Height;
        int hostW = _host.Visible ? Math.Min(HOST_WIDTH, Math.Max(240, w / 2)) : 0;
        int webW = Math.Max(0, w - hostW);
        int navH = _navBar.Visible ? NAV_H : 0;   // 返回条出现时，工作台整体下移，不被遮挡

        _host.Bounds = new Rectangle(w - hostW, 0, hostW, h);
        _navBar.Bounds = new Rectangle(0, 0, webW, navH);
        // 网页从返回条下方开始（不是被返回条盖住上面 38px）
        _web.Bounds = new Rectangle(0, navH, webW, Math.Max(0, h - navH));
        // 侧栏：标题条在上，嵌入区在其下方（同样不能让标题条压住浏览器内容）
        _hostBar.Bounds = new Rectangle(0, 0, hostW, HOST_BAR_H);
        _embedArea.Bounds = new Rectangle(0, HOST_BAR_H, hostW, Math.Max(0, h - HOST_BAR_H));

        if (_navBar.Visible)
        {
            int top = (NAV_H - 26) / 2;
            _navBtnBack.Bounds = new Rectangle(8, top, 124, 26);
            int browserX = Math.Max(8 + 124 + 8, webW - 132);
            _navBtnBrowser.Bounds = new Rectangle(browserX, top, 124, 26);
            int labelX = 8 + 124 + 10;
            _navUrl.Bounds = new Rectangle(labelX, top, Math.Max(0, browserX - labelX - 10), 26);
        }
        SyncEmbedSize();
    }

    // ---------------------------------------------------------------- 外部网页的返回条

    const int NAV_H = 38;

    /// <summary>是否是软件自身页面（本地服务）。</summary>
    static bool IsAppUrl(string url)
    {
        return !string.IsNullOrEmpty(url) && url.StartsWith(
            "http://localhost:" + JinyuTVLauncher.PORT, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>是否是外部网页（http/https 且不是本地软件页面）。</summary>
    static bool IsExternalUrl(string url)
    {
        if (string.IsNullOrEmpty(url)) return false;
        if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
            !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return false;
        return !IsAppUrl(url);
    }

    /// <summary>
    /// 根据当前地址决定是否显示返回条。
    /// 顺带记住「离开前最后一个软件内地址」—— 返回时回到那里，
    /// 而不是粗暴地回到根地址（那样会把用户所在的画布/页面丢掉）。
    /// </summary>
    void UpdateNavBar(string src)
    {
        if (string.IsNullOrEmpty(src)) return;
        if (IsAppUrl(src)) _lastAppUrl = src;

        bool external = IsExternalUrl(src);
        if (external) _externalUrl = src;
        if (_navBar.Visible == external) return;

        _navBar.Visible = external;
        if (external)
        {
            try { _navUrl.Text = "外部网页：" + new Uri(src).Host; }
            catch { _navUrl.Text = src; }
            // 外壳保持软件自己的主题，不被外部网页带走
            ApplyTitleBarTheme(_appDark);
        }
        LayoutShell();
        JinyuTVLauncher.Trace(external ? ("已离开软件，显示返回条：" + src) : "已回到软件，隐藏返回条");
    }

    void GoBackToApp()
    {
        string target = string.IsNullOrEmpty(_lastAppUrl) ? _url : _lastAppUrl;
        try
        {
            _web.CoreWebView2.Navigate(target);
            JinyuTVLauncher.Trace("从外部网页返回软件：" + target);
        }
        catch { }
    }

    void ShowHost(bool show)
    {
        bool want = show && !_userCollapsed;
        if (_host.Visible == want) return;
        _host.Visible = want;
        LayoutShell();
        JinyuTVLauncher.Trace("豆包侧栏 " + (want ? "展开" : "收起"));
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.Control && e.KeyCode == Keys.B)
        {
            _userCollapsed = !_userCollapsed;
            _host.Visible = !_userCollapsed && _embedded != IntPtr.Zero;
            LayoutShell();
            e.Handled = true;
            return;
        }
        // 在外部网页里时，Alt+← 返回软件（浏览器用户的肌肉记忆）
        if (e.Alt && (e.KeyCode == Keys.Left || e.KeyCode == Keys.Back))
        {
            if (_navBar.Visible)
            {
                GoBackToApp();
                e.Handled = true;
                return;
            }
        }
        base.OnKeyDown(e);
    }

    // ---------------------------------------------------------------- 浏览器窗口收编

    void WatchTick()
    {
        if (_scanning) return;
        _scanning = true;
        // WMI 查询会阻塞上百毫秒，放后台线程做，避免卡界面
        Task.Run(delegate
        {
            IntPtr found = ScanForRpaWindow();
            try
            {
                BeginInvoke(new Action(delegate
                {
                    try { ApplyScan(found); }
                    finally { _scanning = false; }
                }));
            }
            catch { _scanning = false; }
        });
    }

    static IntPtr ScanForRpaWindow()
    {
        try
        {
            var pids = new List<int>();
            using (var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='chrome.exe' OR Name='msedge.exe'"))
            using (var results = searcher.Get())
            {
                foreach (ManagementBaseObject mo in results)
                {
                    string cmd = mo["CommandLine"] as string;
                    if (string.IsNullOrEmpty(cmd)) continue;
                    if (cmd.IndexOf(RPA_MARK, StringComparison.Ordinal) < 0) continue;
                    try { pids.Add(Convert.ToInt32(mo["ProcessId"])); } catch { }
                }
            }
            foreach (int pid in pids)
            {
                IntPtr h = TopWindowOfPid(pid);
                if (h != IntPtr.Zero) return h;
            }
        }
        catch (Exception ex)
        {
            JinyuTVLauncher.Trace("扫描豆包窗口失败：" + ex.Message);
        }
        return IntPtr.Zero;
    }

    static IntPtr TopWindowOfPid(int pid)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr p)
        {
            uint wpid;
            GetWindowThreadProcessId(hwnd, out wpid);
            if ((int)wpid != pid) return true;
            if (!IsWindowVisible(hwnd)) return true;
            var sb = new StringBuilder(256);
            GetClassName(hwnd, sb, sb.Capacity);
            if (sb.ToString().StartsWith("Chrome_WidgetWin_1", StringComparison.Ordinal))
            {
                found = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    void ApplyScan(IntPtr target)
    {
        if (target != IntPtr.Zero)
        {
            if (_embedded != target) Embed(target);
            else
            {
                // 每轮都强制归位：RPA 在需要用户扫码/验证时会用 CDP 把窗口
                // 当成顶层窗口重新摆位（setWindowBounds），那会把已嵌入的窗口顶偏。
                // 这里周期性纠正回侧栏，用户看到的始终是「就在软件里」。
                if (!_host.Visible) ShowHost(true);
                SyncEmbedSize();
            }
            return;
        }
        // 没扫到：只有确认已嵌入的那个窗口真的没了，才解除并收起
        if (_embedded != IntPtr.Zero && !IsWindow(_embedded))
        {
            Detach();
            ShowHost(false);
        }
    }

    void Embed(IntPtr hwnd)
    {
        Detach();
        try
        {
            _embeddedStyle = GetWindowLong(hwnd, GWL_STYLE);
            SetParent(hwnd, _embedArea.Handle);
            int style = (_embeddedStyle & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD;
            SetWindowLong(hwnd, GWL_STYLE, style);
            _embedded = hwnd;
            JinyuTVLauncher.Trace("已将豆包窗口嵌入侧栏，句柄=" + hwnd);
            ShowHost(true);
            SyncEmbedSize();
        }
        catch (Exception ex)
        {
            JinyuTVLauncher.Trace("嵌入豆包窗口失败：" + ex.Message);
            _embedded = IntPtr.Zero;
        }
    }

    void Detach()
    {
        if (_embedded == IntPtr.Zero) return;
        try
        {
            SetParent(_embedded, IntPtr.Zero);
            SetWindowLong(_embedded, GWL_STYLE, _embeddedStyle);
            JinyuTVLauncher.Trace("已解除豆包窗口嵌入");
        }
        catch { }
        _embedded = IntPtr.Zero;
    }

    void SyncEmbedSize()
    {
        if (_embedded == IntPtr.Zero) return;
        int w = _embedArea.ClientSize.Width, h = _embedArea.ClientSize.Height;
        // 侧栏收起时尺寸会变成 0，此时不要改浏览器窗口尺寸（否则页面布局会被压坏）
        if (w < 80 || h < 80) return;
        MoveWindow(_embedded, 0, 0, w, h, true);
    }

    // ---------------------------------------------------------------- 窗口边框跟随主题

    /// <summary>
    /// 读工作台当前的深浅色，同步窗口标题栏与边框的颜色。
    ///
    /// 直接向页面要答案（ExecuteScriptAsync 读 html 上的 dark class），
    /// 不需要前端配合改代码；用户在设置里切换深浅色后，最多 2 秒边框就跟上。
    /// </summary>
    async Task SyncTheme()
    {
        if (_web == null || _web.CoreWebView2 == null) return;
        try
        {
            // 只在软件自身的页面上取样。外部网页没有我们的 dark 标记，
            // 去问它会把窗口边框/外壳误判成浅色 —— 表现是「随手点个外链，整个软件外壳变白」。
            string before = _web.CoreWebView2.Source;
            if (IsExternalUrl(before)) return;

            string raw = await _web.CoreWebView2.ExecuteScriptAsync(
                "document.documentElement.classList.contains('dark') ? 'dark' : 'light'");
            if (string.IsNullOrEmpty(raw)) return;

            // 关键：await 期间页面可能已经跳走（点外链就是这种情况），
            // 此时脚本实际跑在新页面上、算出来的「浅色」是错的。
            // 所以执行完要再校一次地址：变了就整次采样作废。
            string after = _web.CoreWebView2.Source;
            if (IsExternalUrl(after) || !string.Equals(after, before, StringComparison.Ordinal)) return;

            bool dark = raw.IndexOf("dark", StringComparison.OrdinalIgnoreCase) >= 0;
            _appDark = dark;
            JinyuTVLauncher.SaveLastTheme(dark);   // 记住，供下次启动的窗口创建阶段直接使用
            ApplyTitleBarTheme(dark);
        }
        catch { }
    }

    void ApplyTitleBarTheme(bool dark)
    {
        if (_appliedDark.HasValue && _appliedDark.Value == dark) return;
        _appliedDark = dark;
        try
        {
            if (!IsHandleCreated) return;
            IntPtr h = Handle;

            // ① 让原生标题栏进入深色模式（Win10 1809+；属性号在不同版本上不同，两个都试）
            int flag = dark ? 1 : 0;
            if (DwmSetWindowAttribute(h, DWMWA_USE_IMMERSIVE_DARK_MODE, ref flag, sizeof(int)) != 0)
                DwmSetWindowAttribute(h, DWMWA_USE_IMMERSIVE_DARK_MODE_OLD, ref flag, sizeof(int));

            // ② Win11 还能直接指定标题栏 / 文字 / 描边颜色，做到与软件配色完全一致
            if (Environment.OSVersion.Version.Build >= 22000)
            {
                int caption = dark ? ColorRef(0x17, 0x17, 0x1A) : ColorRef(0xF7, 0xF7, 0xF8);
                int text = dark ? ColorRef(0xE8, 0xE8, 0xEA) : ColorRef(0x1B, 0x1B, 0x1F);
                DwmSetWindowAttribute(h, DWMWA_CAPTION_COLOR, ref caption, sizeof(int));
                DwmSetWindowAttribute(h, DWMWA_TEXT_COLOR, ref text, sizeof(int));
                DwmSetWindowAttribute(h, DWMWA_BORDER_COLOR, ref caption, sizeof(int));
            }

            // ③ 窗口底色 / WebView2 底色 / 侧栏一起跟上，避免拉伸或收起侧栏时闪出异色
            Color bg = dark ? JinyuTVLauncher.ShellBg : Color.FromArgb(0xF7, 0xF7, 0xF8);
            BackColor = bg;
            try { _web.DefaultBackgroundColor = bg; } catch { }
            try
            {
                _host.BackColor = bg;
                _embedArea.BackColor = dark ? Color.FromArgb(0x22, 0x22, 0x28) : Color.FromArgb(0xEA, 0xEA, 0xEF);
                _hostBar.BackColor = dark ? Color.FromArgb(0x1E, 0x1E, 0x23) : Color.FromArgb(0xEE, 0xEE, 0xF2);
                _hostTitle.ForeColor = dark ? Color.FromArgb(0xAA, 0xAA, 0xB4) : Color.FromArgb(0x55, 0x55, 0x60);

                // 返回条同样跟随主题
                Color barBg = dark ? Color.FromArgb(0x1E, 0x1E, 0x23) : Color.FromArgb(0xEE, 0xEE, 0xF2);
                Color barFg = dark ? Color.FromArgb(0xE8, 0xE8, 0xEA) : Color.FromArgb(0x1B, 0x1B, 0x1F);
                Color barHover = dark ? Color.FromArgb(0x2E, 0x2E, 0x36) : Color.FromArgb(0xDE, 0xDE, 0xE6);
                _navBar.BackColor = barBg;
                _navUrl.ForeColor = dark ? Color.FromArgb(0xAA, 0xAA, 0xB4) : Color.FromArgb(0x55, 0x55, 0x60);
                _navBtnBack.BackColor = barBg;
                _navBtnBrowser.BackColor = barBg;
                _navBtnBack.ForeColor = barFg;
                _navBtnBrowser.ForeColor = barFg;
                _navBtnBack.FlatAppearance.MouseOverBackColor = barHover;
                _navBtnBrowser.FlatAppearance.MouseOverBackColor = barHover;
                _navBtnBack.FlatAppearance.MouseDownBackColor = barHover;
                _navBtnBrowser.FlatAppearance.MouseDownBackColor = barHover;
            }
            catch { }

            JinyuTVLauncher.Trace("窗口边框主题 -> " + (dark ? "深色" : "浅色"));
        }
        catch (Exception ex)
        {
            JinyuTVLauncher.Trace("设置窗口边框主题失败：" + ex.Message);
        }
    }

    static int ColorRef(int r, int g, int b) { return r | (g << 8) | (b << 16); }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _watch.Stop();
        _themeWatch.Stop();
        Detach();
        base.OnFormClosing(e);
    }

    // ---------------------------------------------------------------- 内嵌工作台

    async Task Boot()
    {
        // ① WebView2 Runtime 检测：缺失则降级为浏览器打开，绝不出现「双击没反应」
        try
        {
            string ver = CoreWebView2Environment.GetAvailableBrowserVersionString();
            JinyuTVLauncher.Trace("WebView2 Runtime 版本：" + ver);
        }
        catch (Exception ex)
        {
            JinyuTVLauncher.Trace("未检测到 WebView2 Runtime：" + ex.Message);
            MessageBox.Show(
                "本机缺少 WebView2 运行时，已改用默认浏览器打开界面。\n\n" +
                "如需在应用窗口内显示，请安装 Microsoft Edge WebView2 Runtime 后重试。",
                "JinyuTV", MessageBoxButtons.OK, MessageBoxIcon.Information);
            JinyuTVLauncher.OpenInBrowser(_url);
            Close();
            return;
        }

        // ② 初始化内嵌浏览器（用户数据放安装目录下 data/webview2，不污染系统盘）
        try
        {
            string udf = Path.Combine(_dir, "data", "webview2");
            Directory.CreateDirectory(udf);
            var env = await CoreWebView2Environment.CreateAsync(null, udf, null);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            JinyuTVLauncher.Trace("WebView2 初始化失败：" + ex);
            MessageBox.Show(
                "应用窗口初始化失败，已改用默认浏览器打开界面。\n\n" + ex.Message,
                "JinyuTV", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            JinyuTVLauncher.OpenInBrowser(_url);
            Close();
            return;
        }

        var core = _web.CoreWebView2;
        try
        {
            core.Settings.AreDefaultContextMenusEnabled = false; // 去掉「刷新/另存为」等浏览器味菜单
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = true;
        }
        catch { }
        // 页面内 target=_blank 一律在本窗口打开，不弹出外部浏览器
        core.NewWindowRequested += delegate(object s2, CoreWebView2NewWindowRequestedEventArgs e2)
        {
            e2.Handled = true;
            try { core.Navigate(e2.Uri); } catch { }
        };

        // 地址变化时决定是否显示顶部返回条（加载了外部网页就出现）
        core.SourceChanged += delegate(object s2, CoreWebView2SourceChangedEventArgs e2)
        {
            try { UpdateNavBar(core.Source); } catch { }
        };
        core.NavigationCompleted += delegate(object s2, CoreWebView2NavigationCompletedEventArgs e2)
        {
            try { UpdateNavBar(core.Source); } catch { }
            if (e2.IsSuccess) { _navRetry = 0; _navRetrySince = default(DateTime); _navRetryGaveUp = false; return; }
            // 载入失败：软件自身页面还没起来（服务正在重启/刚被拉起）→ 稍后自动重试。
            // 判据刻意保守：只对「软件自己的地址 / 空白页」重试，绝不干扰外部网页。
            try
            {
                string src = core.Source;
                bool selfPage = string.IsNullOrEmpty(src) || src == "about:blank" || IsAppUrl(src);
                if (_booted && selfPage) RetryNavigate();
            }
            catch { }
        };

        // ④ 接管下载：更新包（以及别的文件）点一下就落到「下载」文件夹，并告知位置、可一键安装。
        //
        // 为什么必须自己处理：WebView2 默认不接管下载，用户会不知道文件存到哪了 ——
        // 而「检查更新 → 一键下载」的价值就在这一步。这里显式指定落盘路径，
        // 完成后问一句「现在安装吗」，答是就拉起安装包并退出本程序（否则安装程序改不动正在被占用的文件）。
        core.DownloadStarting += delegate(object s2, CoreWebView2DownloadStartingEventArgs e2)
        {
            try
            {
                string name = "JinyuTV-Setup.exe";
                try
                {
                    string suggested = e2.ResultFilePath;
                    if (!string.IsNullOrEmpty(suggested)) name = Path.GetFileName(suggested);
                }
                catch { }

                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
                try { Directory.CreateDirectory(dir); } catch { }
                string target = Path.Combine(dir, name);
                // 重名就加序号，避免把用户上一次下载的安装包直接覆盖掉
                if (File.Exists(target))
                {
                    string stem = Path.GetFileNameWithoutExtension(name);
                    string ext = Path.GetExtension(name);
                    for (int i = 2; File.Exists(target) && i < 100; i++)
                        target = Path.Combine(dir, stem + " (" + i + ")" + ext);
                }

                e2.ResultFilePath = target;
                e2.Handled = true;   // 自己接管，不弹浏览器的下载界面
                JinyuTVLauncher.Trace("开始下载：" + name + " → " + target);

                e2.DownloadOperation.StateChanged += delegate(object s3, object e3)
                {
                    try
                    {
                        if (e2.DownloadOperation.State != CoreWebView2DownloadState.Completed) return;
                        JinyuTVLauncher.Trace("下载完成：" + target);
                        BeginInvoke((Action)delegate
                        {
                            var choice = MessageBox.Show(
                                "安装包已下载完成：\n" + target + "\n\n现在安装吗？\n（会先关闭 JinyuTV，装完再打开即可）",
                                "JinyuTV 更新", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                            if (choice != DialogResult.Yes) return;
                            try
                            {
                                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
                                Close();   // 关窗口 = 退出，先让出被占用的文件
                            }
                            catch (Exception ex)
                            {
                                MessageBox.Show("无法启动安装包：" + ex.Message, "JinyuTV", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                            }
                        });
                    }
                    catch (Exception ex)
                    {
                        JinyuTVLauncher.Trace("下载完成回调异常：" + ex.Message);
                    }
                };
            }
            catch (Exception ex)
            {
                JinyuTVLauncher.Trace("接管下载失败：" + ex.Message);
            }
        };

        // ⑤ 启动动画 + 等服务就绪（最多 60 秒：首次启动要解压/初始化）
        ShowHtml(LoadingHtml("正在启动服务…"));
        for (int i = 0; i < 240; i++)
        {
            if (JinyuTVLauncher.PortAlive(JinyuTVLauncher.PORT))
            {
                ShowHtml(LoadingHtml("正在载入工作台…"));
                await Task.Delay(300);
                Navigate();
                _watch.Start();        // 工作台起来后再开始盯豆包窗口
                _themeWatch.Start();   // 同步窗口边框颜色
                await Task.Delay(1500);
                await SyncTheme();
#if NAVTEST
                // 仅验证用（以 /define:NAVTEST 编译时才存在，正式构建不含）：
                // 隔一段时间跳到一个外部网页，用来检查顶部「返回条」是否出现、返回是否有效。
                // 间隔刻意拉到 20 秒 —— 太密会让「抓图 / 点击 / 返回」踩在切换瞬间上，看不清稳定状态。
                for (int k = 0; k < 3; k++)
                {
                    await Task.Delay(20000);
                    try { _web.CoreWebView2.Navigate("https://api.linke.link/"); } catch { }
                }
#endif
                return;
            }
            await Task.Delay(250);
        }

        string tail = JinyuTVLauncher.TailOf(Path.Combine(_dir, "logs", "server.log"), 15);
        JinyuTVLauncher.Trace("等待服务超时");
        ShowHtml(ErrorHtml("服务启动超时（端口 3000 无响应）。\n请查看 logs\\server.log", tail));
    }

    void Navigate()
    {
        try
        {
            _lastAppUrl = _url;
            _booted = true;
            _web.CoreWebView2.Navigate(_url);
            JinyuTVLauncher.Trace("已载入界面：" + _url);
        }
        catch (Exception ex)
        {
            JinyuTVLauncher.Trace("载入界面失败：" + ex.Message);
        }
    }

    /// <summary>
    /// 界面载入失败后自动重试。
    /// 为什么需要：服务被外部重启（更新脚本、崩溃重拉）时，窗口会停在 WebView2 的错误页上，
    /// 用户看到的是一片空白窗口，且没有地址栏可以刷新 —— 只能手动关掉重开。
    /// 现在会一直重试，服务一回来界面就自己恢复。
    ///
    /// 两个必须的约束（第一版没加，实测重试节奏乱掉、5 秒内撞了 9 次）：
    ///   ① **同一时刻只允许一个重试在飞**：每次失败都会回调 NavigationCompleted，
    ///      不拦住就会叠出多条重试链，越滚越密；
    ///   ② 用**时间预算**（5 分钟）而不是次数上限：次数上限在密集重试下几十秒就耗光。
    /// </summary>
    void RetryNavigate()
    {
        if (_navRetryPending) return;
        DateTime now = DateTime.Now;
        if (_navRetrySince == default(DateTime)) _navRetrySince = now;
        if ((now - _navRetrySince).TotalMinutes > 5)
        {
            if (!_navRetryGaveUp)
            {
                _navRetryGaveUp = true;
                JinyuTVLauncher.Trace("界面载入连续失败超过 5 分钟，停止重试（请查看 logs\\server.log）");
            }
            return;
        }
        _navRetry++;
        if (_navRetry <= 3 || _navRetry % 10 == 0)
            JinyuTVLauncher.Trace("界面载入失败，第 " + _navRetry + " 次重试（1.5 秒后）");

        _navRetryPending = true;
        var timer = new System.Windows.Forms.Timer();
        timer.Interval = 1500;
        timer.Tick += delegate
        {
            timer.Stop();
            timer.Dispose();
            _navRetryPending = false;
            try { _web.CoreWebView2.Navigate(_url); } catch { }
        };
        timer.Start();
    }

    void ShowHtml(string html)
    {
        try { _web.CoreWebView2.NavigateToString(html); }
        catch { }
    }

    static string Header()
    {
        return "<style>" +
               "html,body{margin:0;height:100%;background:#17171a;color:#e8e8ea;" +
               "font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}" +
               ".wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}" +
               ".logo{font-size:34px;font-weight:600;letter-spacing:.14em;color:#fff}" +
               ".logo span{color:#6ea8fe}" +
               ".msg{font-size:14px;color:#9a9aa2}" +
               ".bar{width:220px;height:3px;border-radius:3px;background:#2a2a30;overflow:hidden}" +
               ".bar i{display:block;height:100%;width:40%;background:#6ea8fe;border-radius:3px;" +
               "animation:run 1.1s ease-in-out infinite}" +
               "@keyframes run{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}" +
               "pre{margin:0;max-width:78%;max-height:44%;overflow:auto;text-align:left;" +
               "font-size:12px;line-height:1.6;color:#8f8f98;background:#1d1d21;" +
               "border:1px solid #2c2c33;border-radius:10px;padding:14px 16px;white-space:pre-wrap}" +
               "</style>";
    }

    static string LoadingHtml(string msg)
    {
        return "<!DOCTYPE html><html><head><meta charset='utf-8'>" + Header() + "</head><body>" +
               "<div class='wrap'><div class='logo'>Jinyu<span>TV</span></div>" +
               "<div class='bar'><i></i></div>" +
               "<div class='msg'>" + msg + "</div></div></body></html>";
    }

    static string ErrorHtml(string msg, string tail)
    {
        return "<!DOCTYPE html><html><head><meta charset='utf-8'>" + Header() + "</head><body>" +
               "<div class='wrap'><div class='logo'>Jinyu<span>TV</span></div>" +
               "<div class='msg'>" + msg + "</div>" +
               "<pre>" + EscapeHtml(tail) + "</pre></div></body></html>";
    }

    static string EscapeHtml(string s)
    {
        if (s == null) return "";
        return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
    }
}
