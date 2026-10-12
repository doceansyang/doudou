// 工具：抓取 JinyuTV 的**授权弹窗**（无边框、无标题，靠尺寸特征定位）。
//
// 为什么不用标题找：LicenseForm 是 FormBorderStyle.None 且没设 Text，
// 抓不到标题；主窗口标题叫 "JinyuTV" 但尺寸是 2576x1408。
// 弹窗 ClientSize = 620x540，用尺寸区间锁定最稳。
//
// 用法：
//   ShotDialog.exe <输出png> [--attach]
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class ShotDialog
{
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder buf, int max);
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    const uint PW_RENDERFULLCONTENT = 2;
    const int SW_RESTORE = 9;

    // 弹窗 ClientSize 620x540；主窗口 2576x1408。给足容差。
    static bool LooksLikeDialog(int w, int h)
    {
        return w >= 560 && w <= 700 && h >= 480 && h <= 620;
    }

    static IntPtr _found;

    static IntPtr FindDialog()
    {
        _found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr p)
        {
            if (!IsWindowVisible(hwnd)) return true;
            RECT r;
            if (!GetWindowRect(hwnd, out r)) return true;
            int w = r.Right - r.Left, h = r.Bottom - r.Top;
            if (!LooksLikeDialog(w, h)) return true;
            // 必须是 JinyuTV 进程
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            try
            {
                var proc = Process.GetProcessById((int)pid);
                if (!proc.ProcessName.Equals("JinyuTV", StringComparison.OrdinalIgnoreCase)) return true;
            }
            catch { return true; }
            _found = hwnd;
            return false;
        }, IntPtr.Zero);
        return _found;
    }

    static void ForceForeground(IntPtr h)
    {
        try
        {
            IntPtr fg = GetForegroundWindow();
            uint d;
            uint fgThread = GetWindowThreadProcessId(fg, out d);
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
        if (args.Length < 1) { Console.Error.WriteLine("usage: ShotDialog <out.png>"); return; }
        string outPng = args[0];

        IntPtr h = IntPtr.Zero;
        for (int i = 0; i < 60 && h == IntPtr.Zero; i++)
        {
            h = FindDialog();
            if (h == IntPtr.Zero) Thread.Sleep(500);
        }
        if (h == IntPtr.Zero)
        {
            File.WriteAllText(outPng + ".err", "没找到授权弹窗（尺寸 620x540 的可见窗口）", Encoding.UTF8);
            Console.WriteLine("NOTFOUND");
            return;
        }

        ForceForeground(h);
        Thread.Sleep(1500);

        RECT r;
        GetWindowRect(h, out r);
        int w = r.Right - r.Left, hh = r.Bottom - r.Top;

        using (var bmp = new Bitmap(w, hh))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                try { PrintWindow(h, hdc, PW_RENDERFULLCONTENT); }
                finally { g.ReleaseHdc(hdc); }
            }
            bmp.Save(outPng, ImageFormat.Png);
        }
        try
        {
            using (var bmp = new Bitmap(w, hh))
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(new Point(r.Left, r.Top), Point.Empty, new Size(w, hh));
                bmp.Save(Path.ChangeExtension(outPng, null) + "-screen.png", ImageFormat.Png);
            }
        }
        catch { }

        var cls = new StringBuilder(256);
        GetClassName(h, cls, cls.Capacity);
        File.WriteAllText(outPng + ".info",
            string.Format("弹窗矩形={0},{1} {2}x{3}\r\n类名={4}", r.Left, r.Top, w, hh, cls), Encoding.UTF8);
        Console.WriteLine("ok " + w + "x" + hh);
    }
}
