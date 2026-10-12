# -*- coding: utf-8 -*-
"""从 launcher.cs 抽取 LicenseForm，生成离屏截图宿主。

为什么要这个脚本：改WinForms 界面后若只能靠「让用户双击启动 → 截图反馈」，
往返太多。渲染成 PNG 可以立刻自查。

关键点：**必须原样抽取** launcher.cs 里的类，不能另写一份 ——
否则会出现「改了源码但截图还是旧的」。

用法：python scripts/sync-shot-license.py
"""
import io
import os

BASE = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.join(BASE, "launcher.cs")
HOST = os.path.join(BASE, "_shot-license.cs")

HEADER = '''// ⚠️ 本文件由 scripts/sync-shot-license.py 自动生成，请勿手改。
// 内容从 launcher.cs 原样抽取，保证截图 = 用户真实看到的界面。
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

class Shot
{
    public static readonly Color ShellBg = Color.FromArgb(23, 23, 26);

    // 截图路径走不到的依赖，给桩
    static string BaseDir { get { return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\\\'); } }
    static string LicenseFile { get { return Path.Combine(BaseDir, "data", "license.json"); } }
    static string LicenseBridge(string json) { return ""; }
    static string JsonString(string raw, string key) { return ""; }

    // ---- 圆角控件（与 launcher.cs 一致：HRGN 裁剪）----
    class RoundedPanel : Panel
    {
        public int Radius { get { return _r; } set { _r = value; Apply(); } }
        int _r = 6;
        public RoundedPanel() { SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true); }
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Apply(); }
        protected override void OnSizeChanged(EventArgs e) { base.OnSizeChanged(e); Apply(); }
        void Apply()
        {
            try {
                if (!IsHandleCreated || Width <= 0 || Height <= 0) return;
                SetWindowRgn(Handle, CreateRoundRectRgn(0, 0, Width + 1, Height + 1, _r * 2, _r * 2), true);
            } catch { }
        }
    }

    class RoundedButton : Button
    {
        public int Radius { get { return _r; } set { _r = value; Apply(); } }
        int _r = 6;
        public RoundedButton() { FlatStyle = FlatStyle.Flat; SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true); }
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Apply(); }
        protected override void OnSizeChanged(EventArgs e) { base.OnSizeChanged(e); Apply(); }
        void Apply()
        {
            try {
                if (!IsHandleCreated || Width <= 0 || Height <= 0) return;
                SetWindowRgn(Handle, CreateRoundRectRgn(0, 0, Width + 1, Height + 1, _r * 2, _r * 2), true);
            } catch { }
        }
    }

    class RoundedTextBox : TextBox
    {
        public int Radius { get { return _r; } set { _r = value; Invalidate(); } }
        int _r = 6;
        public RoundedTextBox() { SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true); }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (var p = new System.Drawing.Drawing2D.GraphicsPath())
            {
                int d = Math.Max(1, _r * 2);
                p.AddArc(0, 0, d, d, 180, 90); p.AddArc(Width - d, 0, d, d, 270, 90);
                p.AddArc(Width - d, Height - d, d, d, 0, 90); p.AddArc(0, Height - d, d, d, 90, 90);
                p.CloseFigure();
                e.Graphics.DrawPath(new Pen(Parent != null ? Parent.BackColor : ForeColor), p);
            }
        }
    }

    [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr hwnd, IntPtr r, bool redraw);
    const int WM_NCLBUTTONDOWN = 0x00A1;
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    
'''

MAIN = '''
    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        string reason = args.Length > 0 ? args[0] : "";
        string outDir = args.Length > 1 ? args[1] : "scripts/_out";
        Directory.CreateDirectory(outDir);
        using (var form = new LicenseForm("81DE1-D8EC7-15AE3-FAEDA", reason))
        {
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(0, 0);
            form.Show();
            Application.DoEvents();
            System.Threading.Thread.Sleep(500);
            Application.DoEvents();
            string file = Path.Combine(outDir, "license-window.png");
            // 必须用 PrintWindow 抓真实窗口：DrawToBitmap 是离屏合成，
            // 不经过 SetWindowRgn 裁剪 → 圆角在截图里会丢失。
            System.Threading.Thread.Sleep(300);
            using (var bmp = new Bitmap(form.Width, form.Height))
            using (var g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                try { PrintWindow(form.Handle, hdc, 2); }
                finally { g.ReleaseHdc(hdc); }
                bmp.Save(file, System.Drawing.Imaging.ImageFormat.Png);
            }
            Console.WriteLine("saved " + file + "  " + form.Width + "x" + form.Height);
        }
    }
}
'''

COLOR_SIGS = ["static string ReadPrimaryColor()", "static Color ReadableOn(",
              "static Color AccentFor(", "static Color HexToColor("]


def grab_method(src, sig):
    """按方法签名抽出完整方法（含其上方的 xml 注释）。"""
    pos = src.find(sig)
    if pos < 0:
        return ""
    start = src.rfind("/// <summary>", 0, pos)
    end = src.find("\n    }\n", pos) + 7
    return src[start:end]


def main():
    src = io.open(LAUNCHER, encoding="utf-8").read()

    # 1) 抽 LicenseForm 类（从它的文档注释到「本机适配」分隔注释之前）
    start = src.find("    /// <summary>授权窗口：显示机器码")
    end = src.find("    // ---------------------------------------------------------------- 本机适配")
    if start < 0 or end < 0:
        raise SystemExit("找不到 LicenseForm，请检查 launcher.cs")
    form = src[start:end]

    # MakeRounded 与 P/Invoke 都跟LicenseForm 在同一片段里，无需剔除。

    # 2) 抽配色方法
    colors = "".join(grab_method(src, s) for s in COLOR_SIGS)

    host = HEADER + colors + "\n" + form + MAIN
    host = host.replace("JinyuTVLauncher.ShellBg", "Shot.ShellBg")

    # 3) 自检：重复定义会编译失败，先在这里挡住
    if host.count("class LicenseForm") != 1:
        raise SystemExit("注入后 LicenseForm 数量异常：%d" % host.count("class LicenseForm"))
    if host.count("static void MakeRounded(") != 1:
        raise SystemExit("MakeRounded 数量异常：%d" % host.count("static void MakeRounded("))
    for sig in COLOR_SIGS:
        if host.count(sig) != 1:
            raise SystemExit("注入后 %s 数量异常：%d" % (sig, host.count(sig)))

    io.open(HOST, "w", encoding="utf-8", newline="").write(host)
    print("已生成 %s（LicenseForm %d 字符 + 配色 %d 字符）" %
          (os.path.basename(HOST), len(form), len(colors)))


if __name__ == "__main__":
    main()