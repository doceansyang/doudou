// 工具：启动 JinyuTV，把主窗口截图落盘，用于客观检查渲染/布局/边框配色。
//
// 两个关键坑（都踩过）：
//   ① 别用 FindWindow：程序里有若干同标题的隐藏辅助窗口，可能抓到 -32000,-32000 的空白窗口。
//      → 改为枚举可见窗口、标题匹配、取面积最大的那个。
//   ② 别只靠 CopyFromScreen：目标窗口若未真正置顶（Windows 限制前台切换），
//      截到的会是压在它上面的别的窗口。
//      → 主用 PrintWindow(PW_RENDERFULLCONTENT) 直接从窗口 DC 取图，不受遮挡影响；
//        同时保留一张屏幕截图便于对照。
//
// 用法：
//   ShotApp.exe <输出png> <JinyuTV.exe路径> [等待毫秒]
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class ShotApp
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
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder buf, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder buf, int max);
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    const int SW_RESTORE = 9;
    const uint PW_RENDERFULLCONTENT = 2;

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

    /** 强制把窗口提到前台：单独 SetForegroundWindow 常被 Windows 拒绝，需要先附到当前前台线程。 */
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

    static void Main(string[] args)
    {
        if (args.Length < 2) { Console.Error.WriteLine("usage: ShotApp <out.png> <app.exe> [waitMs]"); return; }
        string outPng = args[0];
        string exe = args[1];
        int waitMs = args.Length > 2 ? int.Parse(args[2]) : 18000;
        bool launch = !Array.Exists(args, a => a == "--attach");

        string dir = Path.GetDirectoryName(Path.GetFullPath(exe));
        if (launch)
        {
            try
            {
                // UseShellExecute=true：不让新进程继承本进程的 stdout/stderr 句柄。
                // 否则调用方（Python）会一直等管道关闭 —— 明明已经退出却卡住不返回。
                Process.Start(new ProcessStartInfo
                {
                    FileName = exe,
                    WorkingDirectory = dir,
                    UseShellExecute = true,
                });
            }
            catch (Exception ex) { File.WriteAllText(outPng + ".err", "启动失败：" + ex.Message, Encoding.UTF8); return; }
            Thread.Sleep(waitMs);
        }

        IntPtr h = IntPtr.Zero;
        for (int i = 0; i < 30 && h == IntPtr.Zero; i++)
        {
            h = FindMainWindow("JinyuTV");
            if (h == IntPtr.Zero) Thread.Sleep(500);
        }
        if (h == IntPtr.Zero)
        {
            File.WriteAllText(outPng + ".err", "没找到可见的 JinyuTV 主窗口", Encoding.UTF8);
            return;
        }

        ForceForeground(h);
        // WebView2 从最小化/后台恢复后，合成器要过一会儿才把内容画回来。
        // 只等 1 秒会截到空白窗口（这次就踩了），故给足 2.5 秒。
        Thread.Sleep(2500);

        RECT r;
        if (!GetWindowRect(h, out r))
        {
            File.WriteAllText(outPng + ".err", "GetWindowRect 失败", Encoding.UTF8);
            return;
        }
        int w = r.Right - r.Left, hh = r.Bottom - r.Top;
        if (w <= 0 || hh <= 0)
        {
            File.WriteAllText(outPng + ".err", "窗口尺寸异常：" + w + "x" + hh, Encoding.UTF8);
            return;
        }

        // 主图：PrintWindow 直接从窗口取图（不受遮挡影响），能拿到 DWM 绘制的标题栏
        bool printed = false;
        try
        {
            using (var bmp = new Bitmap(w, hh))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    printed = PrintWindow(h, hdc, PW_RENDERFULLCONTENT);
                    g.ReleaseHdc(hdc);
                }
                bmp.Save(outPng, ImageFormat.Png);
            }
        }
        catch (Exception ex) { File.WriteAllText(outPng + ".err", "PrintWindow 失败：" + ex.Message, Encoding.UTF8); }

        // 对照图：屏幕截图（若窗口确实在最前，两者内容应当一致）
        try
        {
            using (var bmp = new Bitmap(w, hh))
            {
                using (var g = Graphics.FromImage(bmp))
                    g.CopyFromScreen(new Point(r.Left, r.Top), Point.Empty, new Size(w, hh));
                bmp.Save(Path.ChangeExtension(outPng, null) + "-screen.png", ImageFormat.Png);
            }
        }
        catch { }

        var cls = new StringBuilder(256);
        GetClassName(h, cls, cls.Capacity);
        File.WriteAllText(outPng + ".info",
            string.Format("窗口矩形={0},{1} {2}x{3}\r\n类名={4}\r\nPrintWindow={5}\r\n截图={6}",
                r.Left, r.Top, w, hh, cls, printed, outPng), Encoding.UTF8);
        Console.WriteLine("ok " + w + "x" + hh + " print=" + printed);
    }
}
