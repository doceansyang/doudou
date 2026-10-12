# -*- coding: utf-8 -*-
"""从 launcher.cs 抽取授权窗口相关代码，生成离屏截图宿主。

为什么要这个脚本：改 WinForms 界面后若只能靠「让用户双击启动 → 截图反馈」，
往返太多。渲染成 PNG 可以立刻自查。

关键点：**必须原样抽取** launcher.cs 里的类，不能另写一份 ——
否则会出现「改了源码但截图还是旧的」。

抽三块：
  A. P/Invoke + 自绘控件（Rounded / GradientPanel / GlassCard /
     RoundedButton / RoundedTextBox / GradientLabel / IconBox）
  B. LicenseForm 类
  C. 配色方法（ReadPrimaryColor / ReadableOn / AccentFor / HexToColor）

用法：python scripts/sync-shot-license.py
"""
import io
import os

BASE = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.join(BASE, "launcher.cs")
HOST = os.path.join(BASE, "_shot-license.cs")

HEADER = '''// 本文件由 scripts/sync-shot-license.py 自动生成，请勿手改。
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

    // 抓真实窗口用（DrawToBitmap 是离屏合成，不经过 SetWindowRgn，圆角会丢）
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

'''

MAIN = '''
    /// <summary>
    /// 递归找到**所有可编辑的** TextBox（授权码框）并填值，用于验证文字渲染。
    /// 注意：不能"填第一个就 return" —— 机器码框虽是 ReadOnly，
    /// 但遍历顺序变化时容易误判；这里改成"全部非只读框都填"，行为更确定。
    /// </summary>
    static int PrefillCode(Control root, string text)
    {
        int n = 0;
        foreach (Control c in root.Controls)
        {
            var tb = c as TextBox;
            if (tb != null && !tb.ReadOnly) { tb.Text = text; tb.Invalidate(); n++; }
            n += PrefillCode(c, text);
        }
        return n;
    }

    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        string reason = args.Length > 0 ? args[0] : "";
        string outDir = args.Length > 1 ? args[1] : "scripts/_out";
        Directory.CreateDirectory(outDir);
        using (var form = new LicenseForm("81DE1-D8EC-15AE3-FAEDA", reason))
        {
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(0, 0);
            form.Show();
            Application.DoEvents();
            System.Threading.Thread.Sleep(600);
            Application.DoEvents();
            // 第 3 个参数：往授权码框里填测试文本，用来验证"输入内容能显示"
            // （TextBox 一旦被设 UserPaint 就不再绘制文字，必须实测才能发现）
            if (args.Length > 2 && !string.IsNullOrEmpty(args[2]))
            {
                foreach (Control c in form.Controls)
                    PrefillCode(c, args[2]);
                Application.DoEvents();
                System.Threading.Thread.Sleep(200);
            }
            string file = Path.Combine(outDir, "license-window.png");
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
    pos = src.find(sig)
    if pos < 0:
        return ""
    start = src.rfind("/// <summary>", 0, pos)
    end = src.find("\n    }\n", pos) + 7
    return src[start:end]


def slice_between(src, start_marker, end_marker):
    a = src.find(start_marker)
    b = src.find(end_marker, a) if a >= 0 else -1
    if a < 0 or b < 0:
        raise SystemExit("找不到边界：%r / %r" % (start_marker[:30], end_marker[:30]))
    return src[a:b]


def main():
    src = io.open(LAUNCHER, encoding="utf-8").read()

    widgets = slice_between(src, '    [DllImport("gdi32.dll")]',
                            "    /// <summary>授权窗口：显示机器码")
    form = slice_between(src, "    /// <summary>授权窗口：显示机器码",
                         "    // ---------------------------------------------------------------- 本机适配")
    colors = "".join(grab_method(src, s) for s in COLOR_SIGS)
    missing = [s for s in COLOR_SIGS if s not in colors]
    if missing:
        raise SystemExit("配色方法缺失：%s" % missing)

    host = HEADER + widgets + "\n" + colors + "\n" + form + MAIN
    host = host.replace("JinyuTVLauncher.ShellBg", "Shot.ShellBg")

    # 自检：重复定义会在编译期报 CS0111，这里提前挡住
    checks = {
        "class LicenseForm": 1, "static class Rounded": 1,
        "class FlatPanel": 1, "class GlassCard": 1,
        "class RoundedButton": 1, "class HoverCircle": 1,
        "class FieldShell": 1,
        "class GradientLabel": 1, "class IconBox": 1,
        "static void MakeRounded(": 1,
    }
    for sig, want in checks.items():
        got = host.count(sig)
        if got != want:
            raise SystemExit("注入后 %s 数量异常：%d（期望 %d）" % (sig, got, want))

    io.open(HOST, "w", encoding="utf-8", newline="").write(host)
    print("已生成 %s（控件 %d + LicenseForm %d + 配色 %d 字符）" %
          (os.path.basename(HOST), len(widgets), len(form), len(colors)))


if __name__ == "__main__":
    main()
