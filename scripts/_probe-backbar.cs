// 验证「外部网页返回条」：启动带 NAVTEST 的测试启动器 → 等它跳到外部网页 → 截图
//   → 点击「← 返回 JinyuTV」→ 等回到软件 → 再截图；然后再用 Alt+← 走一遍。
//
// 为什么用日志判定状态而不是靠 sleep 猜：
//   跳转与返回都是异步的（网络、SPA 重载），靠时间猜很容易把一个中间态当成终态。
//   启动器每次显示/隐藏返回条都会写 launcher.log，这里读日志计数，状态是确定的。
//
// 用法：BackBarProbe.exe <输出目录> <测试用启动器exe>
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class BackBarProbe
{
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder buf, int max);
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }

    const int SW_RESTORE = 9;
    const uint PW_RENDERFULLCONTENT = 2;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const byte VK_MENU = 0x12, VK_LEFT = 0x25;
    const uint KEYUP = 0x0002;

    static readonly StringBuilder LogBuf = new StringBuilder();
    static string _logPath;

    static void L(string m)
    {
        string line = DateTime.Now.ToString("HH:mm:ss") + "  " + m;
        LogBuf.AppendLine(line);
        try { File.WriteAllText(_logPath, LogBuf.ToString(), new UTF8Encoding(false)); } catch { }
        Console.WriteLine(line);
    }

    static IntPtr FindMainWindow(string title)
    {
        IntPtr found = IntPtr.Zero;
        long best = 0;
        EnumWindows(delegate(IntPtr hwnd, IntPtr p)
        {
            if (!IsWindowVisible(hwnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hwnd, sb, sb.Capacity);
            if (sb.ToString() != title) return true;
            RECT r;
            if (!GetWindowRect(hwnd, out r)) return true;
            long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
            if (area > best) { best = area; found = hwnd; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static void ForceForeground(IntPtr h)
    {
        try
        {
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
            IntPtr fg = GetForegroundWindow();
            uint dummy;
            uint fgThread = GetWindowThreadProcessId(fg, out dummy);
            uint myThread = GetCurrentThreadId();
            AttachThreadInput(myThread, fgThread, true);
            BringWindowToTop(h);
            SetForegroundWindow(h);
            AttachThreadInput(myThread, fgThread, false);
        }
        catch { }
    }

    static string ReadLog(string path)
    {
        // 必须 FileShare.ReadWrite 打开：File.ReadAllText 只允许共享「读」，
        // 会把被观测进程的追加写挡成 IOException，那行日志就被静默丢掉了
        // （现象：主题明明变了，日志里却没有那条记录）。
        try
        {
            if (!File.Exists(path)) return "";
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var sr = new StreamReader(fs, Encoding.UTF8))
                return sr.ReadToEnd();
        }
        catch { return ""; }
    }

    static int CountMarker(string text, string marker)
    {
        int n = 0, i = 0;
        while (i < text.Length && (i = text.IndexOf(marker, i, StringComparison.Ordinal)) >= 0)
        {
            n++;
            i += marker.Length;
        }
        return n;
    }

    static bool WaitMarker(string path, string marker, ref int prev, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            int now = CountMarker(ReadLog(path), marker);
            if (now > prev) { prev = now; return true; }
            Thread.Sleep(300);
        }
        return false;
    }

    static void Capture(IntPtr h, string outPng)
    {
        RECT r;
        if (!GetWindowRect(h, out r)) { L("GetWindowRect 失败"); return; }
        int w = r.Right - r.Left, hh = r.Bottom - r.Top;
        try
        {
            using (var bmp = new Bitmap(w, hh))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    PrintWindow(h, hdc, PW_RENDERFULLCONTENT);
                    g.ReleaseHdc(hdc);
                }
                bmp.Save(outPng, ImageFormat.Png);
            }
            L("截图 " + Path.GetFileName(outPng) + "  " + w + "x" + hh);
        }
        catch (Exception ex) { L("截图失败：" + ex.Message); }
    }

    /// <summary>点返回条上的「← 返回 JinyuTV」（返回条 38 高，按钮在客户区 8..132 × 6..32）。</summary>
    static void ClickBackButton(IntPtr h)
    {
        var p = new POINT { X = 70, Y = 19 };
        ClientToScreen(h, ref p);
        SetCursorPos(p.X, p.Y);
        Thread.Sleep(300);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(90);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        L("已点击「返回」按钮，屏幕坐标 " + p.X + "," + p.Y);
    }

    static void PressAltLeft()
    {
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        Thread.Sleep(60);
        keybd_event(VK_LEFT, 0, 0, UIntPtr.Zero);
        Thread.Sleep(70);
        keybd_event(VK_LEFT, 0, KEYUP, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYUP, UIntPtr.Zero);
        L("已发送 Alt+←");
    }

    static void Main(string[] args)
    {
        if (args.Length < 2) { Console.Error.WriteLine("usage: BackBarProbe <outDir> <launcherExe>"); return; }
        string outDir = args[0];
        string exe = args[1];
        _logPath = Path.Combine(outDir, "backbar-probe.log");
        string appDir = Path.GetDirectoryName(Path.GetFullPath(exe));
        string launcherLog = Path.Combine(appDir, "logs", "launcher.log");

        int seenOut = CountMarker(ReadLog(launcherLog), "显示返回条");
        int seenBack = CountMarker(ReadLog(launcherLog), "隐藏返回条");
        L("基线：显示返回条=" + seenOut + "，隐藏返回条=" + seenBack);

        Process.Start(new ProcessStartInfo
        {
            FileName = exe,
            WorkingDirectory = appDir,
            UseShellExecute = true,   // 不继承 stdout 句柄，否则调用方等管道关闭会卡住
        });

        IntPtr h = IntPtr.Zero;
        for (int i = 0; i < 80 && h == IntPtr.Zero; i++) { Thread.Sleep(500); h = FindMainWindow("JinyuTV"); }
        if (h == IntPtr.Zero) { L("!! 没找到主窗口"); return; }
        L("找到主窗口=" + h);
        ForceForeground(h);
        Thread.Sleep(1200);

        // ① 等进入外部网页（NAVTEST 会自动跳 api.linke.link）
        if (!WaitMarker(launcherLog, "显示返回条", ref seenOut, 120000))
        {
            L("!! 等不到「离开软件」状态");
            Capture(h, Path.Combine(outDir, "backbar-1.png"));
            return;
        }
        L("已进入外部网页状态");
        Thread.Sleep(3000);
        ForceForeground(h);
        Thread.Sleep(1500);   // 等合成稳定再抓，否则会抓到上一帧
        Capture(h, Path.Combine(outDir, "backbar-1.png"));

        // ② 点「返回」
        ClickBackButton(h);
        if (WaitMarker(launcherLog, "隐藏返回条", ref seenBack, 40000)) L("点击返回成功");
        else L("!! 点击返回无效");
        Thread.Sleep(3000);
        ForceForeground(h);
        Thread.Sleep(1500);   // 等合成稳定再抓，否则会抓到上一帧
        Capture(h, Path.Combine(outDir, "backbar-2.png"));

        // ③ 再进一次外部网页，用 Alt+← 返回
        if (WaitMarker(launcherLog, "显示返回条", ref seenOut, 90000))
        {
            Thread.Sleep(2500);
            ForceForeground(h);
            Thread.Sleep(400);
            PressAltLeft();
            if (WaitMarker(launcherLog, "隐藏返回条", ref seenBack, 40000)) L("Alt+← 返回成功");
            else L("!! Alt+← 无效");
            Thread.Sleep(3000);
            ForceForeground(h);
            Thread.Sleep(1500);   // 等合成稳定再抓，否则会抓到上一帧
            Capture(h, Path.Combine(outDir, "backbar-3.png"));
        }
        else L("(跳过 Alt+← 测试：没等到第二次跳转)");

        L("完成");
    }
}
