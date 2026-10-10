// 探针：验证「把 Chrome/Edge 窗口嵌进我们自己的窗口」这条路能不能走通。
//
// 背景：豆包 RPA 需要真实浏览器窗口（风控识别无头），扫码/人工验证时必须让用户看得见。
// 现在的做法是把窗口摆到屏幕内并置顶，但用户经常「找不到那个窗口」。
// 若能把浏览器窗口直接 SetParent 到软件窗口内，用户就永远在软件里看到并操作它。
//
// 本探针做三件事，最后把窗口截图落盘，用于客观判断渲染是否正常（不是靠猜）：
//   1. 开一个宿主窗口（模拟 JinyuTV 的工作区面板）
//   2. 起一个干净 profile 的 Chrome，找到它的顶层窗口
//   3. SetParent 到宿主面板 -> 改窗口样式为子窗口 -> MoveWindow 铺满 -> 截图
//
// 用法（由 _probe-embed-browser.py 调用）：
//   ProbeEmbed.exe <输出png> <浏览器exe路径>
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class ProbeEmbed
{
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll", SetLastError = true)] static extern int SetWindowLong(IntPtr hwnd, int idx, int val);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int idx);
    [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder buf, int max);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);

    const int GWL_STYLE = -16;
    const int WS_CHILD = 0x40000000;
    const int WS_POPUP = unchecked((int)0x80000000);
    const int WS_CAPTION = 0x00C00000;
    const int WS_THICKFRAME = 0x00040000;

    static readonly List<string> Tracker = new List<string>();

    static List<IntPtr> BrowserWindows()
    {
        var list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr p)
        {
            var sb = new StringBuilder(256);
            GetClassName(hwnd, sb, sb.Capacity);
            string cls = sb.ToString();
            if (cls.StartsWith("Chrome_WidgetWin_1", StringComparison.Ordinal)
                && IsWindowVisible(hwnd) && GetParent(hwnd) == IntPtr.Zero)
                list.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static void Log(string path, string msg)
    {
        try { File.AppendAllText(path, "[" + DateTime.Now.ToString("HH:mm:ss.fff") + "] " + msg + "\r\n", new UTF8Encoding(false)); }
        catch { }
    }

    [STAThread]
    static void Main(string[] args)
    {
        string outPng = args.Length > 0 ? args[0] : "embed-probe.png";
        string browser = args.Length > 1 ? args[1] : @"C:\Program Files\Google\Chrome\Application\chrome.exe";
        string log = Path.ChangeExtension(outPng, ".log");
        try { File.Delete(log); } catch { }

        Log(log, "探针启动，浏览器=" + browser);

        var form = new Form();
        form.Text = "EmbedProbe";
        form.StartPosition = FormStartPosition.Manual;
        form.Location = new Point(60, 40);
        form.ClientSize = new Size(1200, 760);
        form.BackColor = Color.FromArgb(20, 20, 24);
        form.TopMost = true;

        var panel = new Panel();
        panel.Dock = DockStyle.Fill;
        panel.BackColor = Color.FromArgb(45, 45, 55);
        form.Controls.Add(panel);
        form.Show();
        Application.DoEvents();
        Thread.Sleep(300);
        Log(log, "宿主窗口已显示，面板句柄=" + panel.Handle);

        // 记录基线，启动后取差集，避免认错到别的浏览器窗口
        var before = new HashSet<IntPtr>(BrowserWindows());

        string profile = Path.Combine(Path.GetTempPath(), "embedprobe-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        var psi = new ProcessStartInfo
        {
            FileName = browser,
            Arguments = "--user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check"
                      + " --disable-session-crashed-bubble --new-window about:blank",
            UseShellExecute = false,
        };
        Process proc = null;
        try { proc = Process.Start(psi); }
        catch (Exception ex) { Log(log, "启动浏览器失败：" + ex.Message); }

        IntPtr target = IntPtr.Zero;
        for (int i = 0; i < 80 && target == IntPtr.Zero; i++)
        {
            Thread.Sleep(300);
            Application.DoEvents();
            foreach (IntPtr h in BrowserWindows())
            {
                if (!before.Contains(h)) { target = h; break; }
            }
        }
        if (target == IntPtr.Zero)
        {
            Log(log, "没找到新的浏览器窗口，探针失败");
            WriteShot(form, outPng, log);
            return;
        }
        Log(log, "找到浏览器窗口句柄=" + target);

        IntPtr prevParent = GetParent(target);
        IntPtr ok = SetParent(target, panel.Handle);
        Log(log, "SetParent 返回=" + ok + "（0 表示失败），原父窗口=" + prevParent);

        int style = GetWindowLong(target, GWL_STYLE);
        int newStyle = (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD;
        SetWindowLong(target, GWL_STYLE, newStyle);
        Log(log, "样式 " + style.ToString("X8") + " -> " + newStyle.ToString("X8"));

        MoveWindow(target, 0, 0, panel.ClientSize.Width, panel.ClientSize.Height, true);
        Log(log, "已移动到面板 " + panel.ClientSize.Width + "x" + panel.ClientSize.Height);

        SetForegroundWindow(form.Handle);
        Thread.Sleep(2500);
        Application.DoEvents();
        WriteShot(form, outPng, log);

        // 还原并退出，不留下痕迹
        MoveWindow(target, 100, 100, 900, 700, true);
        SetWindowLong(target, GWL_STYLE, style);
        SetParent(target, IntPtr.Zero);
        Log(log, "已还原，探针结束");
        try { if (proc != null) proc.Kill(); } catch { }
    }

    static void WriteShot(Form form, string outPng, string log)
    {
        try
        {
            var bmp = new Bitmap(form.Width, form.Height);
            using (var g = Graphics.FromImage(bmp))
                g.CopyFromScreen(form.Location, Point.Empty, form.Size);
            bmp.Save(outPng, ImageFormat.Png);
            bmp.Dispose();
            Log(log, "截图已保存：" + outPng);
        }
        catch (Exception ex) { Log(log, "截图失败：" + ex.Message); }
    }
}
