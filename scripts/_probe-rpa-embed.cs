// 探针：验证「豆包浏览器窗口能被自动认出并收编进软件侧栏」的完整链路。
//
// 链路：命令行标记 --toonflow-rpa=1 → WMI 扫进程 → 定位顶层窗口 → SetParent 进侧栏 → 截图
//
// 用法（由 _probe-rpa-embed.py 调用）：
//   ProbeRpaEmbed.exe <输出png> <浏览器exe路径>
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class ProbeRpaEmbed
{
    const string RPA_MARK = "--toonflow-rpa";

    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hwnd, int idx, int val);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int idx);
    [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder buf, int max);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    static string Rect(IntPtr h)
    {
        RECT r;
        if (!GetWindowRect(h, out r)) return "(读取失败)";
        return string.Format("{0},{1} {2}x{3}", r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    }

    const int GWL_STYLE = -16;
    const int WS_CHILD = 0x40000000;
    const int WS_POPUP = unchecked((int)0x80000000);
    const int WS_CAPTION = 0x00C00000;
    const int WS_THICKFRAME = 0x00040000;

    static void Log(string path, string msg)
    {
        try { File.AppendAllText(path, "[" + DateTime.Now.ToString("HH:mm:ss.fff") + "] " + msg + "\r\n", new UTF8Encoding(false)); }
        catch { }
    }

    static List<int> FindMarkedPids(string log)
    {
        var pids = new List<int>();
        using (var searcher = new ManagementObjectSearcher(
            "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='chrome.exe' OR Name='msedge.exe'"))
        using (var results = searcher.Get())
        {
            foreach (ManagementBaseObject mo in results)
            {
                string cmd = mo["CommandLine"] as string;
                if (string.IsNullOrEmpty(cmd) || cmd.IndexOf(RPA_MARK, StringComparison.Ordinal) < 0) continue;
                int pid = Convert.ToInt32(mo["ProcessId"]);
                pids.Add(pid);
                Log(log, "WMI 命中带标记进程 PID=" + pid);
            }
        }
        return pids;
    }

    static IntPtr TopWindowOfPid(int pid)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr p)
        {
            uint wpid;
            GetWindowThreadProcessId(hwnd, out wpid);
            if ((int)wpid != pid || !IsWindowVisible(hwnd)) return true;
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

    [STAThread]
    static void Main(string[] args)
    {
        string outPng = args.Length > 0 ? args[0] : "rpa-embed-probe.png";
        string browser = args.Length > 1 ? args[1] : @"C:\Program Files\Google\Chrome\Application\chrome.exe";
        string cropPng = Path.Combine(Path.GetDirectoryName(outPng),
                                      Path.GetFileNameWithoutExtension(outPng) + "-crop.png");
        string log = Path.ChangeExtension(outPng, ".log");
        try { File.Delete(log); } catch { }

        Log(log, "探针启动，浏览器=" + browser);

        // 模拟 JinyuTV 主窗口：左侧工作台 + 右侧豆包侧栏
        var form = new Form();
        form.Text = "JinyuTV (probe)";
        form.StartPosition = FormStartPosition.Manual;
        form.Location = new Point(40, 30);
        form.ClientSize = new Size(1500, 900);
        form.BackColor = Color.FromArgb(23, 23, 26);
        form.TopMost = true;

        var shell = new Panel();
        shell.BackColor = Color.FromArgb(30, 30, 36);
        shell.Bounds = new Rectangle(0, 0, 880, 900);

        var label = new Label();
        label.Text = "工作台区域（探针里用一个色块代替 WebView2）";
        label.ForeColor = Color.FromArgb(120, 120, 132);
        label.AutoSize = false;
        label.Bounds = new Rectangle(24, 24, 700, 30);
        shell.Controls.Add(label);

        var hostBar = new Panel();
        hostBar.BackColor = Color.FromArgb(30, 30, 35);
        hostBar.Bounds = new Rectangle(880, 0, 620, 34);

        var hostTitle = new Label();
        hostTitle.Text = "豆包窗口 · Ctrl+B 收起";
        hostTitle.ForeColor = Color.FromArgb(170, 170, 180);
        hostTitle.Dock = DockStyle.Fill;
        hostTitle.TextAlign = ContentAlignment.MiddleLeft;
        hostTitle.Padding = new Padding(12, 0, 0, 0);
        hostBar.Controls.Add(hostTitle);

        var host = new Panel();
        host.BackColor = Color.FromArgb(34, 34, 40);
        host.Bounds = new Rectangle(880, 0, 620, 900);

        var embedArea = new Panel();
        embedArea.BackColor = Color.FromArgb(34, 34, 40);
        embedArea.Bounds = new Rectangle(0, 34, 620, 866);

        host.Controls.Add(embedArea);
        host.Controls.Add(hostBar);
        form.Controls.Add(shell);
        form.Controls.Add(host);
        form.Show();
        Application.DoEvents();
        Thread.Sleep(300);
        Log(log, "宿主窗口已显示，侧栏嵌入区句柄=" + embedArea.Handle);

        // 模拟 RPA 拉起豆包浏览器（带标记）
        string profile = Path.Combine(Path.GetTempPath(), "rpaprobe-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        var psi = new ProcessStartInfo
        {
            FileName = browser,
            Arguments = "--user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check"
                      + " --disable-session-crashed-bubble --window-position=80,60 --window-size=1200,820"
                      + " " + RPA_MARK + "=1 https://www.doubao.com/chat/",
            UseShellExecute = false,
        };
        Process proc = null;
        try { proc = Process.Start(psi); }
        catch (Exception ex) { Log(log, "启动浏览器失败：" + ex.Message); }

        IntPtr target = IntPtr.Zero;
        for (int i = 0; i < 60 && target == IntPtr.Zero; i++)
        {
            Thread.Sleep(500);
            Application.DoEvents();
            foreach (int pid in FindMarkedPids(log))
            {
                IntPtr h = TopWindowOfPid(pid);
                if (h != IntPtr.Zero) { target = h; break; }
            }
        }
        if (target == IntPtr.Zero)
        {
            Log(log, "!! 没扫到带标记的浏览器窗口，收编失败");
            Shot(form, embedArea, outPng, cropPng, log);
            return;
        }
        Log(log, "扫到浏览器窗口句柄=" + target);

        int style = GetWindowLong(target, GWL_STYLE);
        IntPtr ok = SetParent(target, embedArea.Handle);
        SetWindowLong(target, GWL_STYLE, (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD);
        MoveWindow(target, 0, 0, embedArea.ClientSize.Width, embedArea.ClientSize.Height, true);
        Log(log, "SetParent 返回=" + ok + "，已铺满 " + embedArea.ClientSize.Width + "x" + embedArea.ClientSize.Height);
        Log(log, "诊断：嵌入区屏幕矩形=" + Rect(embedArea.Handle) + "，浏览器实际矩形=" + Rect(target)
                 + "，父窗口=" + GetParent(target) + "（应为 " + embedArea.Handle + "）");
        Thread.Sleep(1200);
        Application.DoEvents();
        Log(log, "诊断(1.2s 后)：浏览器实际矩形=" + Rect(target));
        RECT cr; GetClientRect(target, out cr);
        Log(log, "诊断(1.2s 后)：浏览器客户区=" + (cr.Right - cr.Left) + "x" + (cr.Bottom - cr.Top));

        SetForegroundWindow(form.Handle);
        // 给豆包页面留出加载时间，截图才有意义
        for (int i = 0; i < 16; i++) { Thread.Sleep(500); Application.DoEvents(); }
        Shot(form, embedArea, outPng, cropPng, log);

        // 还原
        SetWindowLong(target, GWL_STYLE, style);
        SetParent(target, IntPtr.Zero);
        Log(log, "已还原，探针结束");
        try { if (proc != null) proc.Kill(); } catch { }
    }

    static void Shot(Form form, Panel area, string outPng, string cropPng, string log)
    {
        try
        {
            var bmp = new Bitmap(form.Width, form.Height);
            using (var g = Graphics.FromImage(bmp))
                g.CopyFromScreen(form.Location, Point.Empty, form.Size);
            bmp.Save(outPng, ImageFormat.Png);
            bmp.Dispose();
            Log(log, "截图已保存：" + outPng);

            // 单独裁出侧栏区域：整窗截图被缩略后不易判断，裁剪图能看清渲染细节
            Rectangle rect = area.RectangleToScreen(area.ClientRectangle);
            var crop = new Bitmap(rect.Width, rect.Height);
            using (var g = Graphics.FromImage(crop))
                g.CopyFromScreen(rect.Location, Point.Empty, rect.Size);
            crop.Save(cropPng, ImageFormat.Png);
            crop.Dispose();
            Log(log, "侧栏裁剪图已保存：" + cropPng + "（" + rect.Width + "x" + rect.Height + "）");
        }
        catch (Exception ex) { Log(log, "截图失败：" + ex.Message); }
    }
}
