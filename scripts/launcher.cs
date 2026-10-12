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
// 豆包窗口：**不再收编进软件**（用户要求「直接弹出来，不然来回乱跳」）。
//   早先版本把 RPA 浏览器 SetParent 到右侧侧栏，意图是让用户「在软件内看到并操作」。
//   但实际体验更差：①侧栏每 2.5 秒强制归位一次，和 RPA 自己摆位互相打架，
//   窗口在侧栏与全屏之间反复跳；②扫码/验证时用户要在这个窗口与外部窗口之间来回切。
//   → 现在启动器**完全不碰** RPA 浏览器窗口：它由 doubao-rpa-core 的
//   revealBrowserWindow() 摆到屏幕内并置前，作为普通独立窗口弹出。
//   本文件里与收编有关的一切（侧栏控件、WMI 扫描、Embed/Detach、Ctrl+B）已全部移除。
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
using System.Diagnostics;
using System.Drawing;
using System.IO;
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

        // ---- 主机授权（主机锁）：未激活就不往下走 ----
        // 为什么放在这一步：它是**起服务之前**的最后一道门。
        // 服务起来之后前端就能连上，只靠前端提示等于没锁；
        // 放在这里，未激活时连后端都不会启动，功能真正不可用。
        if (!EnsureLicensed())
        {
            Trace("未授权，退出（仅本机适配已完成）");
            return 2;
        }

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

    // ------------------------------------------------------------------ 主机授权

    static string LicenseFile { get { return Path.Combine(BaseDir, "data", "license.json"); } }

    static string BunPath()
    {
        string local = Path.Combine(BaseDir, "runtime", "bun.exe");
        return File.Exists(local) ? local : "bun";
    }

    /// <summary>
    /// 调用 license-bridge.ts（授权逻辑的唯一来源）。
    /// 为什么不让 C# 重写一遍机器码采集：两份实现必然漂移，
    /// 症状是「客户激活时提示机器码不匹配」，且极难排查。
    /// </summary>
    static string LicenseBridge(string json)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = BunPath(),
                Arguments = "scripts/license/license-bridge.ts",
                WorkingDirectory = BaseDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (var p = Process.Start(psi))
            {
                if (p == null) return "";
                p.StandardInput.Write(json);
                p.StandardInput.Close();
                string output = p.StandardOutput.ReadToEnd();
                // 超时保护：硬件采集最多 6 秒 ×3 项，给 30 秒足够；
                // 卡死会让「双击没反应」，比报错更难排查。
                if (!p.WaitForExit(30000)) { try { p.Kill(); } catch { } return ""; }
                string text = (output ?? "").Trim();
                int line = text.LastIndexOf('\n');
                return line >= 0 ? text.Substring(line + 1).Trim() : text;
            }
        }
        catch (Exception ex)
        {
            Trace("授权桥调用失败：" + ex.Message);
            return "";
        }
    }

    static string JsonString(string raw, string key)
    {
        if (string.IsNullOrEmpty(raw)) return "";
        string token = "\"" + key + "\":";
        int at = raw.IndexOf(token, StringComparison.Ordinal);
        if (at < 0) return "";
        int i = at + token.Length;
        while (i < raw.Length && (raw[i] == ' ' || raw[i] == '"')) i++;
        if (i < raw.Length && raw[i] == '"')
        {
            int end = raw.IndexOf('"', i + 1);
            return end < 0 ? "" : raw.Substring(i + 1, end - i - 1);
        }
        int stop = i;
        while (stop < raw.Length && raw[stop] != ',' && raw[stop] != '}') stop++;
        return raw.Substring(i, stop - i).Trim();
    }

    /// <summary>校验授权；未激活则弹授权窗口让用户输入授权码。返回是否可继续启动。</summary>
    static bool EnsureLicensed()
    {
        string file = LicenseFile.Replace("\\", "\\\\");

        // 已激活：直接校验（能识别「授权文件被复制到另一台机器」）
        string result = LicenseBridge("{\"action\":\"verify\",\"licenseFile\":\"" + file + "\"}");
        if (result.Contains("\"ok\":true"))
        {
            string note = JsonString(result, "note");
            Trace("授权有效" + (note.Length > 0 ? "（" + note + "）" : ""));
            return true;
        }

        // 没激活 / 授权无效 → 弹窗口
        string reason = JsonString(result, "reason");
        if (reason == "NOT_ACTIVATED") reason = "";
        string machine = JsonString(result, "machineCode");
        Trace("需要激活授权（机器码 " + machine + "）" + (reason.Length > 0 ? "：原因为 " + reason : ""));

        using (var form = new LicenseForm(machine, reason))
        {
            if (form.ShowDialog() != DialogResult.OK)
            {
                Trace("用户取消激活，退出");
                return false;
            }
        }

        // 激活后复核一次，不信任窗口的自述结果
        string again = LicenseBridge("{\"action\":\"verify\",\"licenseFile\":\"" + file + "\"}");
        bool ok = again.Contains("\"ok\":true");
        Trace(ok ? "激活成功" : "!! 激活后复核失败：" + again);
        return ok;
    }

    [DllImport("gdi32.dll")]
    static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int widthEllipse, int heightEllipse);
    [DllImport("user32.dll")]
    static extern int SetWindowRgn(IntPtr hwnd, IntPtr hRgn, bool redraw);
    const int WM_NCLBUTTONDOWN = 0x00A1;
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);

/// <summary>
    /// 圆角矩形几何：所有自绘控件共用。
    ///
    /// ⚠️ 关键：四个角的直径 d 必须**算一次、四角共用**。
    /// 早先的实现是 `if (d > r.Height) d = r.Height; if (d > r.Width) d = r.Width;`
    /// 逐边裁剪 —— 当圆角半径接近短边一半时，横向两弧被裁成一个值、纵向两弧被裁成另一个值，
    /// 四条弧对不上，圆角处就出现"豁口/错位"（用户截图里卡片右上角那个缺口就是这个）。
    /// 正确做法：d 取 min(2*radius, width, height)，四角统一。
    /// </summary>
    static class Rounded
    {
        public static System.Drawing.Drawing2D.GraphicsPath Rect(RectangleF r, int radius)
        {
            var path = new System.Drawing.Drawing2D.GraphicsPath();
            if (r.Width <= 0 || r.Height <= 0) return path;
            float d = Math.Max(1f, radius * 2f);
            // 一次算清，四角共用 —— 保证四条弧半径一致，接缝严丝合缝
            d = Math.Min(d, Math.Min(r.Width, r.Height));
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    /// <summary>
    /// 纯色深色背景容器（用户要求：不要渐变，就深色背景）。
    ///
    /// 光晕的坑（踩过）：子控件设 BackColor=Transparent 时，WinForms 会用
    /// **子控件的矩形**作为裁剪区去调父级的 OnPaintBackground。若在父级里画一个
    /// 大半径径向光晕，裁剪边界正巧切到光晕的色阶变化处，就会在控件位置浮出
    /// 一个**硬边矩形紫斑**（关闭按钮后面那块紫方块就是这么来的）。
    /// 所以：光晕半径必须远大于任何子控件、且同心于面板，
    /// 或者干脆关掉。这里默认关（Glow=false），需要时再开。
    ///
    /// ⚠️ 背景必须画在 OnPaintBackground（不是 OnPaint）：子控件设
    /// BackColor=Transparent 时，WinForms 是调用**父控件的 OnPaintBackground**
    /// 来模拟透明的。若画在 OnPaint，子控件区域会露出父级纯色，背景被"挖洞"。
    /// </summary>
    class FlatPanel : Panel
    {
        public Color Fill = Color.FromArgb(0x11, 0x11, 0x13);
        public bool Glow = false;

        public FlatPanel()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            var g = e.Graphics;
            var rect = new Rectangle(0, 0, Width, Height);
            if (rect.Width <= 0 || rect.Height <= 0) return;
            using (var br = new SolidBrush(Fill)) g.FillRectangle(br, rect);

            if (Glow && e.ClipRectangle.Width >= Width - 2 && e.ClipRectangle.Height >= Height - 2)
            {
                // 只在"整面重绘"时才画光晕 —— 子控件触发的局部重绘一律跳过，
                // 从根上杜绝上面说的"硬边紫斑"。
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                DrawGlow(g, Width * 0.82f, -Height * 0.08f, Width * 0.55f, 10);
            }
        }

        void DrawGlow(Graphics g, float cx, float cy, float r, int alpha)
        {
            using (var path = new System.Drawing.Drawing2D.GraphicsPath())
            {
                path.AddEllipse(cx - r, cy - r, r * 2, r * 2);
                using (var brush = new System.Drawing.Drawing2D.PathGradientBrush(path))
                {
                    brush.CenterColor = Color.FromArgb(alpha, 0xFF, 0x9F, 0xFC);
                    brush.SurroundColors = new[] { Color.FromArgb(0, 0xFF, 0x9F, 0xFC) };
                    g.FillPath(brush, path);
                }
            }
        }
    }

    /// <summary>
    /// 卡片：圆角填充 + 1px 描边。填充走 OnPaintBackground（透明子控件靠它透出）。
    ///
    /// ⚠️ 描边为什么不用 (0.5, 0.5, W-1, H-1)：
    ///     0.5 偏移 + 抗锯齿在**圆角处**会让路径首尾两个 AddArc 的接缝错开半个像素，
    ///     表现为卡片右上角出现一个"豁口"，描边看着没闭合（用户截图里正是这个）。
    ///     正确做法：用整数内缩矩形 (0,0,W-1,H-1)，路径严格闭合，四条边齐平。
    /// </summary>
    class GlassCard : Panel
    {
        public int Radius = 14;
        public Color Fill = Color.FromArgb(0x1A, 0x1A, 0x1D);
        public Color Border = Color.FromArgb(0x2C, 0x2C, 0x32);

        public GlassCard()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        }

        /// <summary>
        /// 把控件自身的 **Region** 设成圆角路径。
        ///
        /// 为什么必须这么做（踩过的坑）：
        ///   只在 OnPaint 里画圆角是不够的 —— 子控件（内嵌输入框）重绘时，
        ///   WinForms 会用**自己的方形矩形**去裁剪父级背景重绘。于是卡片右上角的
        ///   圆角弧被方形裁剪切出一道**阶梯状豁口**，描边在拐角处整段消失
        ///   （放大 6 倍能清晰看到锯齿）。把 Region 设成圆角后，裁剪区本身是圆的，
        ///   子控件再重绘也不会切坏圆角。
        /// </summary>
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            ApplyRoundRegion();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyRoundRegion();
        }

        void ApplyRoundRegion()
        {
            if (Width <= 1 || Height <= 1) return;
            using (var path = Rounded.Rect(new RectangleF(0, 0, Width, Height), Radius))
            {
                var old = Region;
                Region = new Region(path);
                if (old != null) old.Dispose();
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            if (Width <= 1 || Height <= 1) return;
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (var br = new SolidBrush(Fill))
                e.Graphics.FillRectangle(br, 0, 0, Width, Height);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (Width <= 1 || Height <= 1) return;
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            // 描边画在偏移 0.5 的整数网格上，1px 线严格落在像素中心，四边粗细一致
            using (var path = Rounded.Rect(new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f), Radius))
            using (var pen = new Pen(Border, 1f))
                e.Graphics.DrawPath(pen, path);
            // ⚠️ 绝不能调 base.OnPaint(e)：Panel 的基类实现会用自己的 BackColor
            //    **从 (0,0) 起铺满整个矩形**，把刚画好的圆角描边和圆角外的透明区一起盖掉 ——
            //    表现就是"卡片右上角缺一个直角缺口"。这是本控件最容易踩的坑。
        }
    }

    /// <summary>
    /// 按钮：纯色或渐变填充 + 可选描边，带 hover / pressed 三态反馈。
    ///
    /// 三态怎么做：OnMouseEnter/Leave/Down/Up 只翻一个枚举，重绘交给 Invalidate。
    /// 不做 base.OnPaint —— Flat 按钮的系统绘制会把圆角与渐变盖掉。
    /// </summary>
    class RoundedButton : Button
    {
        public int Radius = 10;
        public Color GradientFrom = Color.Empty;
        public Color GradientTo = Color.Empty;
        public Color BorderColor = Color.Empty;
        public int BorderWidth = 1;
        /// <summary>禁用按下的"下沉感"。</summary>
        public bool PressedShift = true;

        enum BtnState { Normal, Hover, Pressed }
        BtnState _state = BtnState.Normal;

        public RoundedButton()
        {
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                     | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        }

        protected override void OnMouseEnter(EventArgs e) { _state = BtnState.Hover; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _state = BtnState.Normal; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { _state = BtnState.Pressed; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { _state = BtnState.Hover; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { _state = BtnState.Normal; Invalidate(); base.OnEnabledChanged(e); }

        /// <summary>按状态把颜色整体提亮/压暗，避免为每个状态都写一组配色。</summary>
        static Color Shift(Color c, int delta)
        {
            if (c == Color.Empty) return c;
            int r = Math.Min(255, Math.Max(0, c.R + delta));
            int g = Math.Min(255, Math.Max(0, c.G + delta));
            int b = Math.Min(255, Math.Max(0, c.B + delta));
            return Color.FromArgb(c.A, r, g, b);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;

            int dy = (_state == BtnState.Pressed && PressedShift && Enabled) ? 1 : 0;
            var rect = new RectangleF(0.5f, 0.5f + dy, Width - 1f, Height - 1f);

            int tint = _state == BtnState.Hover ? 14 : (_state == BtnState.Pressed ? -12 : 0);
            if (!Enabled) tint = -18;

            using (var path = Rounded.Rect(rect, Radius))
            {
                if (GradientFrom != Color.Empty && GradientTo != Color.Empty)
                {
                    using (var br = new System.Drawing.Drawing2D.LinearGradientBrush(
                        new Rectangle(0, 0, Width, Height), Shift(GradientFrom, tint), Shift(GradientTo, tint), 0f))
                        g.FillPath(br, path);
                }
                else
                {
                    using (var br = new SolidBrush(Shift(BackColor, tint))) g.FillPath(br, path);
                }
                if (BorderColor != Color.Empty)
                {
                    using (var pen = new Pen(Shift(BorderColor, tint / 2), BorderWidth)) g.DrawPath(pen, path);
                }
            }

            // 文字自绘：不调 base.OnPaint，否则 Flat 按钮会盖掉圆角与渐变
            Color fg = Enabled ? ForeColor : Color.FromArgb(0x6A, 0x6A, 0x72);
            TextRenderer.DrawText(g, Text, Font, new Rectangle(0, dy, Width, Height), fg,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter
                | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        }
    }

    /// <summary>
    /// 悬停才出现的圆形底衬（关闭按钮等"弱功能"控件用）。
    ///
    /// 为什么不用 RoundedButton 给它填色：在纯深色窗体上，一个常驻的方形/圆形色块
    /// 会变成一个突兀的"补丁"。正确做法是**平时完全透明**，只在鼠标进入时浮出
    /// 一圈低对比度圆底 —— 这是当前主流桌面应用的通用做法。
    /// </summary>
    class HoverCircle : Panel
    {
        public Color HoverFill = Color.FromArgb(0x28, 0x28, 0x2C);
        bool _hover;

        public HoverCircle()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                     | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }

        /// <summary>
        /// 即使不悬停也必须**主动把自己的区域涂成父级底色**。
        ///
        /// 踩过的坑：早先不悬停时什么都不画，屏幕上看着没问题，但
        /// `PrintWindow` 截图时这块区域因为从未被任何一帧覆盖，会捕获到
        /// 残留的显存内容 —— 表现是关闭按钮背后浮出一块**硬边紫方块**。
        /// 结论：设了 Transparent 的自绘控件，也必须自己把底填一遍，
        /// 不能指望"不画=露出父级"。
        /// </summary>
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            if (Width <= 1 || Height <= 1) return;
            var parentBg = (Parent != null) ? Parent.BackColor : Color.FromArgb(0x11, 0x11, 0x13);
            if (parentBg.A == 0) parentBg = Color.FromArgb(0x11, 0x11, 0x13);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            if (!_hover)
            {
                using (var br = new SolidBrush(parentBg)) e.Graphics.FillRectangle(br, 0, 0, Width, Height);
                return;
            }
            using (var br0 = new SolidBrush(parentBg)) e.Graphics.FillRectangle(br0, 0, 0, Width, Height);
            using (var path = Rounded.Rect(new RectangleF(0, 0, Width - 1, Height - 1), Math.Min(Width, Height) / 2))
            using (var br = new SolidBrush(HoverFill))
                e.Graphics.FillPath(br, path);
        }
    }

    /// <summary>
    /// 输入框外壳：圆角与描边由**容器**绘制，内部放原生 TextBox。
    ///
    /// ⚠️ 为什么不让 TextBox 自己画圆角（设 UserPaint）：
    ///     TextBox 是原生控件，一旦开启 UserPaint，Windows 就不再绘制它的文字 ——
    ///     表现是"框看得见、自己输入的内容看不见"。授权码框尤其致命。
    ///     所以圆角画在外层 Panel 上，TextBox 保持原生（BorderStyle.None）。
    /// </summary>
    class FieldShell : Panel
    {
        public int Radius = 10;
        public Color BorderColor = Color.FromArgb(0x46, 0x3A, 0x74);
        public Color FocusBorderColor = Color.FromArgb(0x8B, 0x6F, 0xE8);

        readonly TextBox _inner;
        readonly Label _placeholder;
        bool _focused;

        public TextBox Inner { get { return _inner; } }

        public FieldShell()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);

            _inner = new TextBox { BorderStyle = BorderStyle.None };
            _inner.Enter += delegate { _focused = true; Invalidate(); };
            _inner.Leave += delegate { _focused = false; Invalidate(); };
            _inner.TextChanged += delegate { SyncPlaceholder(); };
            Controls.Add(_inner);

            _placeholder = new Label
            {
                AutoSize = false,
                BackColor = Color.Transparent,
                ForeColor = Color.FromArgb(0x82, 0x82, 0x8C),
                TextAlign = ContentAlignment.MiddleLeft,
            };
            _placeholder.Click += delegate { _inner.Focus(); };
            Controls.Add(_placeholder);
            SyncPlaceholder();
        }

        public string Placeholder
        {
            get { return _placeholder.Text; }
            set { _placeholder.Text = value; SyncPlaceholder(); }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyRoundRegion();
            LayoutInner();
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            ApplyRoundRegion();
            LayoutInner();
        }

        /// <summary>
        /// 同 GlassCard：Region 设成圆角，避免内嵌 TextBox 重绘时用方形裁剪
        /// 把外壳的圆角切出阶梯豁口。
        /// </summary>
        void ApplyRoundRegion()
        {
            if (Width <= 1 || Height <= 1) return;
            using (var path = Rounded.Rect(new RectangleF(0, 0, Width, Height), Radius))
            {
                var old = Region;
                Region = new Region(path);
                if (old != null) old.Dispose();
            }
        }

        protected override void OnFontChanged(EventArgs e)
        {
            base.OnFontChanged(e);
            _placeholder.Font = Font;
            LayoutInner();
        }

        void LayoutInner()
        {
            if (_inner == null || _placeholder == null) return;
            const int padX = 11;
            int h = _inner.PreferredHeight;
            int y = (Height - h) / 2;
            if (y < 0) y = 0;
            _inner.SetBounds(padX, y, Width - padX * 2, h);
            _placeholder.SetBounds(padX + 1, 0, Width - padX * 2, Height);
        }

        void SyncPlaceholder()
        {
            bool show = _inner.TextLength == 0;
            if (_placeholder.Visible != show)
            {
                _placeholder.Visible = show;
                if (show) _placeholder.BringToFront();
                // 隐藏占位符后必须让外壳与输入框重绘一遍：
                // 占位符曾被 BringToFront 盖在 TextBox 上方，直接设 Visible=false
                // 在部分时序下不会触发其所在区域重绘，表现为"明明有值，占位提示还在"。
                Invalidate(true);
                _inner.Invalidate();
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            if (Width <= 1 || Height <= 1) return;
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            // Region 已裁成圆角，这里直接铺满即可；只把描边按圆角路径画细
            using (var br = new SolidBrush(BackColor))
                e.Graphics.FillRectangle(br, 0, 0, Width, Height);
            using (var path = Rounded.Rect(new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f), Radius))
            using (var pen = new Pen(_focused ? FocusBorderColor : BorderColor, _focused ? 1.4f : 1f))
                e.Graphics.DrawPath(pen, path);
        }
    }

    /// <summary>
    /// 渐变色文字（首页 “JinyuDream” 字标的同款做法：把渐变当文字填充色）。
    /// 渐变方向 0°（左→右），与首页 CSS `linear-gradient(90deg, ...)` 一致。
    /// </summary>
    class GradientLabel : Control
    {
        public Color FromColor = Color.FromArgb(0xB4, 0x8A, 0xEE);
        public Color ToColor = Color.FromArgb(0xE0, 0xCC, 0xFC);
        /// <summary>true = 文字水平居中（首页字标就是居中）。</summary>
        public bool AlignCenter = false;
        /// <summary>要铺的底色（窗体底色），必须由调用方指定。</summary>
        public Color BgColor = Color.FromArgb(0x11, 0x11, 0x13);

        public GradientLabel()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                     | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                     | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }

        /// <summary>
        /// 同 IconBox：透明自绘控件必须自己铺底，否则截图会有残留色斑。
        /// 注意这里改用 BgColor（= 窗体底色），不是 Parent.BackColor ——
        /// GradientLabel 永远直接挂在窗体底的 FlatPanel 上。
        /// </summary>
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            if (Width <= 0 || Height <= 0) return;
            using (var br = new SolidBrush(BgColor)) e.Graphics.FillRectangle(br, 0, 0, Width, Height);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (Width <= 0 || Height <= 0) return;
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            using (var br = new System.Drawing.Drawing2D.LinearGradientBrush(
                new Rectangle(0, 0, Width, Height), FromColor, ToColor, 0f))
            {
                var sf = new StringFormat();
                sf.LineAlignment = StringAlignment.Center;
                sf.Alignment = AlignCenter ? StringAlignment.Center : StringAlignment.Near;
                g.DrawString(Text, Font, br, new RectangleF(0, 0, Width, Height), sf);
            }
        }
    }

    /// <summary>
    /// 图标控件。两类来源：
    ///   1. `Kind == "logo"` —— 加载**真实品牌 logo 图片**（磁盘上的 logo.png / logo.ico）。
    ///      用户明确要求用自己的 logo，不再手绘星球（手绘版无论如何都不像）。
    ///   2. 其余 —— GDI+ 矢量描边图标（显示器 / 钥匙 / 关闭 / 问号 / 盾牌 / 复制 / 箭头）。
    ///
    /// 版权注意：这里只做"按需绘制"，不修改 logo 像素，保持品牌原色。
    /// </summary>
    class IconBox : Control
    {
        public string Kind = "monitor";
        public Color Stroke = Color.FromArgb(0xA9, 0x8B, 0xEA);
        public float StrokeWidth = 1.6f;
        /// <summary>logo 图片的搜索目录（由 LicenseForm 注入，通常为程序根目录）。</summary>
        public string BaseDir = "";
        /// <summary>圆角半径（仅 logo 用；圆形 logo 传 0 表示不裁切）。</summary>
        public int CropRadius = 0;
        /// <summary>
        /// 自绘控件要铺的底色。**必须由调用方显式指定**，不能用 Parent.BackColor ——
        /// 父级（GlassCard）的 BackColor 是它构造时的属性值(#141414)，
        /// 而它实际画出来的面是更亮的 Fill(#1A1A1D)。用 BackColor 会让图标周围
        /// 浮出一个比卡片更暗的小方块。
        /// </summary>
        public Color BgColor = Color.FromArgb(0x11, 0x11, 0x13);

        static Image _logoCache;
        static string _logoCachePath;

        public IconBox()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                     | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                     | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }

        /// <summary>
        /// 按候选顺序找真实 logo。优先 PNG（带透明通道、显示最干净），
        /// 再退回 ICO。找不到返回 null，调用方自行降级。
        /// </summary>
        static Image LoadLogo(string baseDir)
        {
            if (string.IsNullOrEmpty(baseDir)) baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string[] names = { "logo.png", "assets\\logo.png", "logo.ico", "assets\\logo.ico" };
            foreach (string n in names)
            {
                string p = Path.Combine(baseDir, n);
                if (!File.Exists(p)) continue;
                if (p == _logoCachePath && _logoCache != null) return _logoCache;
                try
                {
                    // 先读进内存流再用 —— 直接从文件构造 Image 会长期锁住该文件，
                    // 后续重新打包替换 logo 时会失败（"文件正被另一进程使用"）。
                    byte[] bytes = File.ReadAllBytes(p);
                    using (var ms = new MemoryStream(bytes))
                    {
                        var img = Image.FromStream(ms);
                        _logoCache = img;
                        _logoCachePath = p;
                        return img;
                    }
                }
                catch { }
            }
            return null;
        }

        /// <summary>
        /// 自绘控件设了 BackColor=Transparent 后，**必须自己把底填一遍**。
        /// 不填的话：屏幕上看不出问题，但 PrintWindow 截图会捕获到残留显存，
        /// 在控件矩形处浮出一块硬边色斑（关闭按钮后的紫方块即此因）。
        /// 这里统一从父级取底色铺满，再画图标。
        /// </summary>
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            if (Width <= 0 || Height <= 0) return;
            Color bg = (Parent != null) ? Parent.BackColor : Color.FromArgb(0x11, 0x11, 0x13);
            if (bg.A == 0) bg = Color.FromArgb(0x11, 0x11, 0x13);
            using (var br = new SolidBrush(bg)) e.Graphics.FillRectangle(br, 0, 0, Width, Height);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            float w = Width, h = Height;

            if (Kind == "logo")
            {
                var img = LoadLogo(BaseDir);
                if (img != null)
                {
                    // 等比缩放居中，避免不同尺寸 logo 被拉变形
                    float scale = Math.Min(w / img.Width, h / img.Height);
                    float dw = img.Width * scale, dh = img.Height * scale;
                    var dest = new RectangleF((w - dw) / 2f, (h - dh) / 2f, dw, dh);
                    if (CropRadius > 0)
                    {
                        using (var path = Rounded.Rect(dest, CropRadius))
                        {
                            var old = g.Clip;
                            g.SetClip(path);
                            g.DrawImage(img, dest);
                            g.Clip = old;
                        }
                    }
                    else
                    {
                        g.DrawImage(img, dest);
                    }
                    return;
                }
                // 降级：找不到图片文件时画一个中性圆角方块，而不是再手绘假星球
                using (var br = new SolidBrush(Color.FromArgb(0x26, 0x26, 0x27)))
                using (var path = Rounded.Rect(new RectangleF(0, 0, w - 1, h - 1), 12))
                    g.FillPath(br, path);
                return;
            }

            using (var pen = new Pen(Stroke, StrokeWidth))
            {
                pen.StartCap = System.Drawing.Drawing2D.LineCap.Round;
                pen.EndCap = System.Drawing.Drawing2D.LineCap.Round;
                pen.LineJoin = System.Drawing.Drawing2D.LineJoin.Round;

                if (Kind == "monitor")
                {
                    // 显示器：圆角屏 + 支架。用 GraphicsPath 画圆角屏比 DrawRectangle 精致得多
                    var scr = new RectangleF(1f, 1.5f, w - 2f, h * 0.66f);
                    using (var p = Rounded.Rect(scr, 3))
                        g.DrawPath(pen, p);
                    g.DrawLine(pen, w / 2f, h * 0.66f + 1.5f, w / 2f, h * 0.82f);
                    g.DrawLine(pen, w * 0.30f, h * 0.84f, w * 0.70f, h * 0.84f);
                }
                else if (Kind == "key")
                {
                    // 钥匙：环 + 杆 + 两齿。全部按 w/h 比例定位，任何尺寸下都不越界。
                    // 早先版本环画在 w*0.06 且齿用绝对值，小尺寸下齿会顶出右边界被裁。
                    float ring = Math.Min(w, h) * 0.34f;      // 环直径
                    float cx = w * 0.22f;                      // 环心 x
                    float cy = h * 0.50f;                      // 环心 y（垂直居中）
                    g.DrawEllipse(pen, cx - ring / 2f, cy - ring / 2f, ring, ring);
                    float shaftStart = cx + ring / 2f;
                    float shaftEnd = w * 0.90f;
                    g.DrawLine(pen, shaftStart, cy, shaftEnd, cy);
                    // 齿：从杆往下，长度按 h 比例，位置在杆的后半段
                    g.DrawLine(pen, w * 0.64f, cy, w * 0.64f, cy + h * 0.22f);
                    g.DrawLine(pen, w * 0.82f, cy, w * 0.82f, cy + h * 0.16f);
                }
                else if (Kind == "shield")
                {
                    // 盾牌：品牌/安全语义，用于顶部"正版授权"标识
                    var p = new System.Drawing.Drawing2D.GraphicsPath();
                    float top = h * 0.08f, bot = h * 0.92f;
                    p.AddLine(w * 0.5f, top, w * 0.9f, top + h * 0.12f);
                    p.AddLine(w * 0.9f, top + h * 0.12f, w * 0.9f, h * 0.52f);
                    p.AddBezier(w * 0.9f, h * 0.52f, w * 0.9f, h * 0.80f, w * 0.5f, bot, w * 0.5f, bot);
                    p.AddBezier(w * 0.5f, bot, w * 0.1f, h * 0.80f, w * 0.1f, h * 0.52f, w * 0.1f, h * 0.52f);
                    p.AddLine(w * 0.1f, h * 0.52f, w * 0.1f, top + h * 0.12f);
                    p.CloseFigure();
                    g.DrawPath(pen, p);
                    // 盾内对勾
                    g.DrawLine(pen, w * 0.32f, h * 0.50f, w * 0.45f, h * 0.64f);
                    g.DrawLine(pen, w * 0.45f, h * 0.64f, w * 0.70f, h * 0.36f);
                }
                else if (Kind == "copy")
                {
                    // 复制：两张叠纸（比纯文字"复制"更直观）
                    var back = new RectangleF(w * 0.06f, h * 0.06f, w * 0.60f, h * 0.60f);
                    var front = new RectangleF(w * 0.30f, h * 0.30f, w * 0.64f, h * 0.64f);
                    using (var p1 = Rounded.Rect(back, 2)) g.DrawPath(pen, p1);
                    using (var p2 = Rounded.Rect(front, 2))
                    {
                        using (var bg = new SolidBrush(Color.Transparent)) { }
                        g.DrawPath(pen, p2);
                    }
                }
                else if (Kind == "close")
                {
                    g.DrawLine(pen, w * 0.24f, h * 0.24f, w * 0.76f, h * 0.76f);
                    g.DrawLine(pen, w * 0.76f, h * 0.24f, w * 0.24f, h * 0.76f);
                }
                else if (Kind == "help")
                {
                    g.DrawEllipse(pen, 0.9f, 0.9f, w - 1.8f, h - 1.8f);
                    using (var f = new Font("Microsoft YaHei UI", 8f, FontStyle.Bold))
                    using (var b = new SolidBrush(Stroke))
                    {
                        var sf = new StringFormat();
                        sf.LineAlignment = StringAlignment.Center;
                        sf.Alignment = StringAlignment.Center;
                        g.DrawString("?", f, b, new RectangleF(0, -0.5f, w, h), sf);
                    }
                }
            }
        }
    }

    /// <summary>授权窗口：显示机器码（可一键复制）+ 输入授权码 + 激活按钮。</summary>
    class LicenseForm : Form
    {
        readonly string _machine;
        readonly string _reason;
        readonly TextBox _input;
        readonly Label _status;
        readonly Button _activate;
        readonly Button _exitButton;

        /// <summary>统一的字段标签：小号灰字，贴在输入框正上方。</summary>
        static Label MakeFieldLabel(string text, Color color)
        {
            return new Label { Text = text, ForeColor = color, Font = new Font("Microsoft YaHei UI", 8.5F), Height = 16 };
        }

        /// <summary>无边框窗体拖动：把鼠标按下转成标题栏行为（WM_NCLBUTTONDOWN + HTCAPTION）。</summary>
        void DragWindow()
        {
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, new IntPtr(2), IntPtr.Zero);
        }

public LicenseForm(string machine, string reason)
        {
            _machine = machine ?? "";
            _reason = reason ?? "";

            // ==================================================================
            //  设计令牌（Design Tokens）
            //
            //  全部取自软件本体 Element Plus 深色主题的真实变量，不再自创紫色：
            //    --el-bg-color-page:      #0a0a0a
            //    --el-bg-color:           #141414
            //    --el-bg-color-overlay:   #1d1e1f
            //    --el-fill-color-light:   #262727
            //    --el-border-color-extra-light: #2b2b2c
            //    --el-text-color-primary: #e5eaf3
            //    --el-text-color-secondary:#a3a6ad
            //  这样弹窗与主界面**同源**，不再有"跟软件不搭"的问题。
            // ==================================================================
            // —— 中性色阶 ——
            Color bgPage = Color.FromArgb(0x11, 0x11, 0x12);   // 窗体底（比 page 略暖，避免纯黑发灰）
            Color surface = Color.FromArgb(0x1A, 0x1A, 0x1C);  // 卡片面
            Color surfaceHi = Color.FromArgb(0x22, 0x22, 0x25); // 卡片内嵌槽
            Color borderSub = Color.FromArgb(0x2E, 0x2E, 0x32);  // 常规描边
            Color borderSoft = Color.FromArgb(0x26, 0x26, 0x29); // 弱描边
            // —— 文本色阶 ——
            Color textPri = Color.FromArgb(0xE8, 0xE8, 0xEC);
            Color textSec = Color.FromArgb(0x9A, 0x9A, 0xA2);
            Color textTer = Color.FromArgb(0x6E, 0x6E, 0x76);
            // —— 品牌强调色（取自 logo 三色，用于按钮/焦点/图标）——
            Color brandA = Color.FromArgb(0x7C, 0x5C, 0xF0);   // 主紫
            Color brandB = Color.FromArgb(0xE0, 0x6C, 0xC8);   // 品红
            Color ok = Color.FromArgb(0x5C, 0xC9, 0x8A);
            Color danger = Color.FromArgb(0xF0, 0x7A, 0x7A);
            // —— 间距令牌（8pt 栅格）——
            const int PAD = 36;          // 窗体左右内边距
            const int GAP = 14;          // 区块间距
            // —— 圆角令牌 ——
            const int R_WINDOW = 16;
            const int R_CARD = 12;
            const int R_CTRL = 9;

            const int W = 620;
            const int H = 496;

            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.None;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(W, H);
            BackColor = bgPage;
            ForeColor = textPri;
            // 字体与首页一致：Inter → Segoe UI → 苹方 → 雅黑
            Font = new Font("Microsoft YaHei UI", 9F);
            KeyPreview = true;
            MakeRounded(this, R_WINDOW);

            // ---- 背景：纯深色 + 顶部极淡品牌晕染（不是渐变背景）----
            var backdrop = new FlatPanel
            {
                Bounds = new Rectangle(0, 0, W, H),
                Fill = bgPage,
                Glow = true,
                BackColor = bgPage,
            };
            backdrop.MouseDown += delegate { DragWindow(); };

            // ---- 关闭按钮：悬停才浮出圆形底，平时只有一个干净叉号 ----
            // 不能让 RoundedButton 填深色底 —— 那块方形色块在纯深底上很显眼（用户截图里就是）。
            // 改用 FlatPanel 作容器（透明底），由它管 hover，叉号是子控件。
            var closeBtn = new HoverCircle
            {
                Bounds = new Rectangle(W - 52, 18, 34, 34),
                Cursor = Cursors.Hand,
            };
            var closeIcon = new IconBox
            {
                Kind = "close",
                Stroke = textSec,
                StrokeWidth = 1.5f,
                BgColor = bgPage,
                Bounds = new Rectangle(10, 10, 14, 14),
                Cursor = Cursors.Hand,
            };
            closeIcon.Click += delegate { Close(); };
            closeBtn.Click += delegate { Close(); };
            closeBtn.Controls.Add(closeIcon);

            // ---- 品牌区（logo + 字标，居中）----
            var logo = new IconBox
            {
                Kind = "logo",
                BaseDir = AppDomain.CurrentDomain.BaseDirectory,
                BgColor = bgPage,
                Bounds = new Rectangle((W - 56) / 2, 44, 56, 56),
            };
            logo.MouseDown += delegate { DragWindow(); };

            // 字标用首页同款渐变（#5227FF → #FF9FFC → #B497CF）
            var brand = new GradientLabel
            {
                Text = "JinyuTV",
                Bounds = new Rectangle(0, 110, W, 40),
                Font = new Font("Segoe UI", 25F, FontStyle.Bold),
                AlignCenter = true,
                BgColor = bgPage,
                FromColor = Color.FromArgb(0x6C, 0x5C, 0xFF),
                ToColor = Color.FromArgb(0xFF, 0x9F, 0xFC),
            };
            brand.MouseDown += delegate { DragWindow(); };

            var brandSub = new Label
            {
                Text = "请输入产品密钥以完成激活",
                ForeColor = textSec,
                Font = new Font("Microsoft YaHei UI", 9.5F),
                TextAlign = ContentAlignment.MiddleCenter,
                Bounds = new Rectangle(0, 152, W, 22),
                BackColor = bgPage,
            };
            brandSub.MouseDown += delegate { DragWindow(); };

            // ---- 机器码区块 ----
            const int CARD_Y = 196;
            const int CARD_H = 104;
            var machineCard = new GlassCard
            {
                Radius = R_CARD, Fill = surface, Border = borderSoft,
                Bounds = new Rectangle(PAD, CARD_Y, W - PAD * 2, CARD_H),
            };
            var machineIcon = new IconBox
            {
                Kind = "monitor", Stroke = textSec, StrokeWidth = 1.5f, BgColor = surface,
                Bounds = new Rectangle(20, 20, 18, 18),
            };
            var machineLabel = new Label
            {
                Text = "本机机器码",
                ForeColor = textSec,
                Font = new Font("Microsoft YaHei UI", 9F),
                Bounds = new Rectangle(46, 19, 140, 20),
                // Label 是不透明原生控件，底色必须等于卡片实际画出的面色(surface)，
                // 否则会在卡片上留下一个色差小方块
                BackColor = surface,
            };
            var machineField = new FieldShell
            {
                Radius = R_CTRL,
                // 宽度 = 卡片宽 - 左右内边距 - 复制按钮宽 - 中间间隙(10)
                Bounds = new Rectangle(20, 46, machineCard.Width - 20 * 2 - 92 - 10, 38),
                BackColor = surfaceHi,
                BorderColor = borderSub,
                FocusBorderColor = brandA,
            };
            machineField.Inner.BackColor = surfaceHi;   // TextBox 不继承父容器底色
            machineField.Inner.Font = new Font("Consolas", 12.5F);
            machineField.Inner.ForeColor = textPri;
            machineField.Inner.ReadOnly = true;
            machineField.Inner.TabStop = false;
            machineField.Inner.Cursor = Cursors.Hand;
            machineField.Inner.Text = _machine;

            var copyBtn = new RoundedButton
            {
                Radius = R_CTRL,
                Text = "复制",
                Bounds = new Rectangle(machineCard.Width - 20 - 92, 46, 92, 38),
                BackColor = surfaceHi,
                ForeColor = textPri,
                BorderColor = borderSub,
                Font = new Font("Microsoft YaHei UI", 9.5F),
                TabStop = false,
                Cursor = Cursors.Hand,
            };
            // 复制按钮内嵌一个复制图标（左）+ 文字（右）——图标由 RoundedButton 自身画不了，
            // 所以把图标作为子控件贴在左侧，文字用 TextAlign 右移解决。
            var copyGlyph = new IconBox
            {
                Kind = "copy", Stroke = textSec, StrokeWidth = 1.4f, BgColor = surfaceHi,
                Bounds = new Rectangle(16, 11, 15, 15),
            };
            copyGlyph.Enabled = false;
            copyBtn.Controls.Add(copyGlyph);

            // 点机器码即复制，文字变绿作为反馈
            machineField.Inner.Click += delegate
            {
                try
                {
                    Clipboard.SetText(_machine);
                    machineField.Inner.ForeColor = ok;
                    var back = new System.Windows.Forms.Timer { Interval = 1200 };
                    back.Tick += delegate(object s3, EventArgs e3)
                    {
                        ((System.Windows.Forms.Timer)s3).Stop();
                        machineField.Inner.ForeColor = textPri;
                    };
                    back.Start();
                }
                catch { }
            };

            copyBtn.Click += delegate
            {
                try
                {
                    Clipboard.SetText(_machine);
                    copyBtn.Text = "已复制";
                    copyBtn.ForeColor = ok;
                    var timer = new System.Windows.Forms.Timer { Interval = 1600 };
                    timer.Tick += delegate(object s2, EventArgs e2)
                    {
                        ((System.Windows.Forms.Timer)s2).Stop();
                        copyBtn.Text = "复制";
                        copyBtn.ForeColor = textPri;
                    };
                    timer.Start();
                }
                catch (Exception ex) { SetStatus("复制失败：" + ex.Message, true); }
            };
            machineCard.Controls.AddRange(new Control[] { machineIcon, machineLabel, machineField, copyBtn });

            // ---- 产品密钥区块 ----
            const int CODE_Y = CARD_Y + CARD_H + GAP;
            var codeCard = new GlassCard
            {
                Radius = R_CARD, Fill = surface, Border = borderSoft,
                Bounds = new Rectangle(PAD, CODE_Y, W - PAD * 2, CARD_H),
            };
            var codeIcon = new IconBox
            {
                Kind = "key", Stroke = textSec, StrokeWidth = 1.5f, BgColor = surface,
                Bounds = new Rectangle(20, 20, 18, 18),
            };
            var codeLabel = new Label
            {
                Text = "产品密钥",
                ForeColor = textSec,
                Font = new Font("Microsoft YaHei UI", 9F),
                Bounds = new Rectangle(46, 19, 140, 20),
                BackColor = surface,
            };
            var codeShell = new FieldShell
            {
                Radius = R_CTRL,
                Bounds = new Rectangle(20, 46, codeCard.Width - 20 * 2, 38),
                BackColor = surfaceHi,
                BorderColor = borderSub,
                FocusBorderColor = brandA,
                Placeholder = "将管理员提供的密钥粘贴到这里",
            };
            codeShell.Inner.BackColor = surfaceHi;
            codeShell.Inner.Font = new Font("Consolas", 11.5F);
            codeShell.Inner.ForeColor = textPri;
            _input = codeShell.Inner;
            codeCard.Controls.AddRange(new Control[] { codeIcon, codeLabel, codeShell });

            // ---- 状态提示（出错/成功才显示）----
            _status = new Label
            {
                Text = _reason.Length > 0 ? _reason : "",
                ForeColor = danger,
                Font = new Font("Microsoft YaHei UI", 9F),
                TextAlign = ContentAlignment.MiddleLeft,
                Bounds = new Rectangle(PAD + 2, CODE_Y + CARD_H + 8, W - PAD * 2, 20),
                BackColor = bgPage,
            };

            // ---- 底部按钮（右对齐，主按钮最右，与卡片右边缘对齐）----
            const int BTN_Y = H - 66;
            const int BTN_H = 42;
            const int BTN_PRIMARY_W = 132;
            const int BTN_SUB_W = 88;
            const int BTN_GAP = 10;
            int btnRight = PAD + (W - PAD * 2);   // = W - PAD，卡片右边缘
            _activate = new RoundedButton
            {
                Radius = R_CTRL,
                Text = "激活",
                Bounds = new Rectangle(btnRight - BTN_PRIMARY_W, BTN_Y, BTN_PRIMARY_W, BTN_H),
                GradientFrom = brandA,
                GradientTo = brandB,
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei UI", 10.5F, FontStyle.Bold),
                TabStop = false,
                Cursor = Cursors.Hand,
            };
            _activate.Click += delegate { TryActivate(); };

            _exitButton = new RoundedButton
            {
                Radius = R_CTRL,
                Text = "取消",
                Bounds = new Rectangle(btnRight - BTN_PRIMARY_W - BTN_GAP - BTN_SUB_W, BTN_Y, BTN_SUB_W, BTN_H),
                BackColor = surface,
                ForeColor = textSec,
                BorderColor = borderSub,
                Font = new Font("Microsoft YaHei UI", 10F),
                TabStop = false,
                Cursor = Cursors.Hand,
                DialogResult = DialogResult.Cancel,
            };

            Controls.Add(backdrop);
            backdrop.Controls.AddRange(new Control[] { closeBtn, logo, brand, brandSub,
                                                       machineCard, codeCard, _status,
                                                       _exitButton, _activate });
            AcceptButton = _activate;
            CancelButton = _exitButton;
            Shown += delegate { _input.Focus(); };
        }

        /// <summary>统一的状态提示（红/绿两色，带底色的胶囊）。</summary>
        void SetStatus(string message, bool isError)
        {
            _status.Text = message ?? "";
            _status.ForeColor = isError ? Color.FromArgb(240, 130, 120) : Color.FromArgb(120, 214, 160);
        }

        // 命名避开 Form.Activate()（同名会触发 CS0108警告，且语义上也不该同名）
        void TryActivate()
        {
            string code = NormalizeCode(_input.Text);
            if (code.Length < 20)
            {
                SetStatus("授权码看起来不完整，请把整段复制进来（通常 200 多个字符）。", true);
                _input.Focus();
                return;
            }

            _activate.Enabled = false;
            _activate.Text = "验证中…";
            Application.DoEvents();
            try
            {
                string file = LicenseFile.Replace("\\", "\\\\");
                string result = LicenseBridge(
                    "{\"action\":\"activate\",\"code\":\"" + EscapeJson(code) + "\",\"licenseFile\":\"" + file + "\"}");
                if (result.Contains("\"ok\":true"))
                {
                    string note = JsonString(result, "note");
                    MessageBox.Show(this,
                        "激活成功！" + (note.Length > 0 ? ("\r\n\r\n授权信息：" + note) : "") + "\r\n\r\n现在将启动软件。",
                        "JinyuTV", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    DialogResult = DialogResult.OK;
                    Close();
                    return;
                }
                string reason = JsonString(result, "reason");
                if (reason.Length == 0) reason = "激活失败，请确认授权码完整无误。";
                SetStatus(reason, true);
                _input.Focus();
                _input.SelectAll();
            }
            catch (Exception ex)
            {
                SetStatus("激活出错：" + ex.Message, true);
            }
            finally
            {
                _activate.Enabled = true;
                _activate.Text = "激活";
            }
        }

        /// <summary>
        /// 规范化用户粘贴的授权码：**去掉所有空白字符**。
        ///
        /// 为什么必须做：授权码有 200+ 字符，用户常从记事本/微信粘贴，
        /// 会带上换行与空格。此前只做了 Trim()，码里的换行被原样送进 JSON，
        /// 轻则报「格式不正确」，重则让 bridge 解析异常后冒出
        /// `ENOENT: no such file or directory` 这种**完全对不上原因**的报错
        /// （用户实际遇到的就是这个）。
        /// 另外把中文全角空格也一并清掉。
        /// </summary>
        static string NormalizeCode(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return "";
            var sb = new System.Text.StringBuilder(raw.Length);
            foreach (char c in raw)
            {
                if (char.IsWhiteSpace(c)) continue;
                if (c == '\u3000' || c == '\u00A0') continue;   // 全角空格 / 不换行空格
                sb.Append(c);
            }
            return sb.ToString().Trim();
        }

        static string EscapeJson(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "");
        }

        /// <summary>
        /// 把控件裁成圆角。WinForms 的 FlatStyle.Flat 只有方角，
        /// 想要圆角必须自己给窗口区域（HRGN）——这是桌面端少见的原生做法。
        /// 尺寸变化时要重新应用，否则会残留旧形状。
        /// ⚠️ 这里必须用 lambda 而不是局部函数 `void Apply() {}`：
        ///    csc 编译 .NET 4.x 不支持局部函数语法（会报一堆 CS1519/CS1520）。
        /// </summary>
        static void MakeRounded(Control control, int radius)
        {
            Action apply = delegate
            {
                try
                {
                    if (!control.IsHandleCreated || control.Width <= 0 || control.Height <= 0) return;
                    var region = CreateRoundRectRgn(0, 0, control.Width + 1, control.Height + 1, radius * 2, radius * 2);
                    SetWindowRgn(control.Handle, region, true);   // 系统接管该区域的生命周期
                }
                catch { }
            };
            control.HandleCreated += delegate { apply(); };
            control.Resize += delegate { apply(); };
            apply();
        }
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

    /// <summary>
    /// 读取软件当前的主色（settings.json → ui.primaryColor），十六进制字符串。
    ///
    /// 为什么授权窗口要读它：主色是**用户在设置里可改的**，默认近黑 #171717。
    /// 激活窗口若写死一个紫色按钮，配色就和主界面完全对不上 —— 用户抱怨
    /// 「跟软件界面一点都不搭」正是这个原因。
    /// 读不到就回退到与默认主色协调的深灰，避免弹窗变花。
    /// </summary>
    static string ReadPrimaryColor()
    {
        try
        {
            string file = Path.Combine(BaseDir, "data", "settings.json");
            if (!File.Exists(file)) return "#3A3A3E";
            string raw = File.ReadAllText(file, Encoding.UTF8);
            // 用正则取primaryColor 的值；不引入 JSON 库（C# 侧保持零依赖）。
            var match = Regex.Match(raw, "\"primaryColor\"\\s*:\\s*\"(#[0-9a-fA-F]{3,8})\"");
            if (!match.Success) return "#3A3A3E";
            string hex = match.Groups[1].Value;
            //#171717 → 展开成 #RRGGBB，便于取色
            if (hex.Length == 4)
            {
                {
                    var sb = new StringBuilder(7);
                    sb.Append('#');
                    for (int i = 1; i <= 3; i++) { sb.Append(hex[i]); sb.Append(hex[i]); }
                    hex = sb.ToString();
                }
            }
            if (hex.Length == 9) hex = hex.Substring(0, 7);
            return hex;
        }
        catch { return "#3A3A3E"; }
    }

    /// <summary>按主色的亮度决定按钮上的文字用黑还是白 —— 与前端 readableBrand 同一套逻辑。</summary>
    static Color ReadableOn(Color background)
    {
        double luminance = (0.299 * background.R + 0.587 * background.G + 0.114 * background.B) / 255.0;
        return luminance > 0.6 ? Color.FromArgb(0x1B, 0x1B, 0x1F) : Color.White;
    }

    /// <summary>
    /// 把主色调成「在当前底色上看得见、且能承载按钮文字」的颜色。
    ///
    /// 为什么必须调：软件默认主色是**近黑 #171717**，而外壳底色也是 #17171A ——
    /// 直接拿主色当按钮底色，对比度只有 **1.00**，按钮会整个「消失」在背景里。
    /// （这与项目里反复出现的「主色近黑 → 选中态糊成黑块」是同一个根因。）
    ///
    /// 目标值选0.45 的中灰（实测是「两个方向都达标」的甜点）：
    /// 与深色底 (23,23,26) 对比 **3.77:1**（≥3 醒目），
    /// 白字压在上面对比 **4.74:1**（≥4.5 可读）。
    /// 再亮（0.50+）白字就看不见，再暗（0.40-）按钮又会糊进背景。
    /// </summary>
    static Color AccentFor(Color accent, Color background)
    {
        double b = (0.299 * background.R + 0.587 * background.G + 0.114 * background.B) / 255.0;
        const double target = 0.45;
        // 按主色与白色的插值比例，把相对亮度调到 target。
        // 主色越暗插得越多；已经够亮就原样用。
        double whiteL = 1.0;
        if (whiteL <= b) return accent;
        double a = (0.299 * accent.R + 0.587 * accent.G + 0.114 * accent.B) / 255.0;
        if (a >= target) return accent;
        double t = (target - b) / (whiteL - b);
        Func<double, int> mix = delegate(double channel)
        {
            double v = channel + (255 - channel) * t;
            return (int)Math.Round(v > 255 ? 255 : v);
        };
        return Color.FromArgb(mix(accent.R), mix(accent.G), mix(accent.B));
    }

    /// <summary>#RRGGBB / #RGB → Color。解析失败回退到中性深灰。</summary>
    static Color HexToColor(string hex)
    {
        try
        {
            string h = (hex ?? "").Trim().TrimStart('#');
            if (h.Length == 3)
            {
                // #RGB → #RRGGBB。用 StringBuilder 避免 char 相加得到 int。
                var sb = new StringBuilder(6);
                for (int i = 0; i < 3; i++) { sb.Append(h[i]); sb.Append(h[i]); }
                h = sb.ToString();
            }
            if (h.Length < 6) return Color.FromArgb(0x3A, 0x3A, 0x3E);
            return Color.FromArgb(
                Convert.ToInt32(h.Substring(0, 2), 16),
                Convert.ToInt32(h.Substring(2, 2), 16),
                Convert.ToInt32(h.Substring(4, 2), 16));
        }
        catch { return Color.FromArgb(0x3A, 0x3A, 0x3E); }
    }

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
/// 主窗口：内嵌 WebView2 承载工作台。
/// 豆包 RPA 浏览器**不再嵌入本窗口**，作为独立窗口弹出（见文件头说明）。
/// </summary>
class MainWindow : Form
{
    // ---- 窗口边框 / 标题栏跟随软件主题
    // 用户要求：软件是深色就用深色边框，软件是浅色就用浅色边框。
    // 原生的 Windows 标题栏永远是浅色，配深色界面很突兀；这里用 DWM 把它染成与软件一致。
    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;   // Win10 20H1+ 用 20，1809~1909 用 19
    const int DWMWA_USE_IMMERSIVE_DARK_MODE_OLD = 19;
    const int DWMWA_BORDER_COLOR = 34;              // 以下三个仅 Win11（build 22000+）
    const int DWMWA_CAPTION_COLOR = 35;
    const int DWMWA_TEXT_COLOR = 36;

    // Win32（窗口几何 / 枚举）
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    readonly string _dir;
    readonly string _url;
    WebView2 _web;
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
    System.Windows.Forms.Timer _themeWatch;
    bool? _appliedDark;
    // 软件自身的深浅色（只在软件页面上取样更新）。
    // 为什么单独存一份：外部网页没有我们的 dark 标记，去问它会把外壳误判成浅色；
    // 而且取样有竞态（外部页刚开始加载时可能问到的还是旧文档），
    // 所以另有一个确定性的兜底 —— 一旦离开软件，就用这个值把外壳拨回来。
    bool _appDark = true;

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
        // 与网页**不重叠**，但层级仍要明确 —— 否则会看到网页压在返回条上面。
        _navBar.BringToFront();

        Load += async delegate(object s, EventArgs e) { await Boot(); };

        // 定时同步主题：读页面当前深浅色，把窗口标题栏/边框染成一致的颜色
        _themeWatch = new System.Windows.Forms.Timer();
        _themeWatch.Interval = 2000;
        _themeWatch.Tick += async delegate { await SyncTheme(); };

        // 尺寸必须放到控件全部建好之后再设：赋 ClientSize 会立刻触发
        // OnSizeChanged -> LayoutShell()，若那时 _web 还是 null 就抛
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
        // 那时控件还没建好 —— 必须保护，否则NullReferenceException 会让软件启动即失败。
        if (_web == null || _navBar == null) return;

        int w = ClientSize.Width, h = ClientSize.Height;
        int navH = _navBar.Visible ? NAV_H : 0;   // 返回条出现时，工作台整体下移，不被遮挡

        _navBar.Bounds = new Rectangle(0, 0, w, navH);
        // 网页从返回条下方开始（不是被返回条盖住上面 38px）
        _web.Bounds = new Rectangle(0, navH, w, Math.Max(0, h - navH));

        if (_navBar.Visible)
        {
            int top = (NAV_H - 26) / 2;
            _navBtnBack.Bounds = new Rectangle(8, top, 124, 26);
            int browserX = Math.Max(8 + 124 + 8, w - 132);
            _navBtnBrowser.Bounds = new Rectangle(browserX, top, 124, 26);
            int labelX = 8 + 124 + 10;
            _navUrl.Bounds = new Rectangle(labelX, top, Math.Max(0, browserX - labelX - 10), 26);
        }
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

    protected override void OnKeyDown(KeyEventArgs e)
    {
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

            // ③ 窗口底色 / WebView2 底色跟上，避免拉伸时闪出异色
            Color bg = dark ? JinyuTVLauncher.ShellBg : Color.FromArgb(0xF7, 0xF7, 0xF8);
            BackColor = bg;
            try { _web.DefaultBackgroundColor = bg; } catch { }
            try
            {
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
        _themeWatch.Stop();
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
