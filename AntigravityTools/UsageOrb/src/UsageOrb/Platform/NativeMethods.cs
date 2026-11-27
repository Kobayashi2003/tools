using System.Runtime.InteropServices;
using System.Text;

namespace UsageOrb.Platform;

public static class NativeMethods
{
    public const int GWL_EXSTYLE = -20;
    public const long WS_EX_TOOLWINDOW = 0x00000080L;
    public const long WS_EX_NOACTIVATE = 0x08000000L;
    private const long WS_EX_TRANSPARENT = 0x00000020L;

    public const uint DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    public const uint DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    public const uint DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWCP_ROUND = 2;
    private const uint GW_HWNDPREV = 3;
    private const uint DWMWA_CLOAKED = 14;

    public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    public const uint EVENT_SYSTEM_MOVESIZEEND = 0x000B;
    public const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016;
    public const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
    public const uint EVENT_OBJECT_DESTROY = 0x8001;
    public const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
    public const uint EVENT_OBJECT_NAMECHANGE = 0x800C;
    public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    public const uint WINEVENT_SKIPOWNPROCESS = 0x0002;

    public delegate void WinEventDelegate(
        IntPtr hWinEventHook,
        uint eventType,
        IntPtr hwnd,
        int idObject,
        int idChild,
        uint dwEventThread,
        uint dwmsEventTime);

    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public readonly int Width => Right - Left;
        public readonly int Height => Bottom - Top;
    }

    [DllImport("user32.dll")]
    public static extern IntPtr SetWinEventHook(
        uint eventMin,
        uint eventMax,
        IntPtr hmodWinEventProc,
        WinEventDelegate lpfnWinEventProc,
        uint idProcess,
        uint idThread,
        uint dwFlags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    internal static void MoveOverlayWindow(IntPtr hwnd, int x, int y)
    {
        const uint noSize = 0x0001;
        const uint noZOrder = 0x0004;
        const uint noActivate = 0x0010;
        SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, noSize | noZOrder | noActivate);
    }

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(
        IntPtr hwnd,
        uint dwAttribute,
        out RECT pvAttribute,
        int cbAttribute);

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(
        IntPtr hwnd,
        uint dwAttribute,
        ref int pvAttribute,
        int cbAttribute);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hwnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hwnd, uint command);

    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int DwmGetWindowAttributeInt(IntPtr hwnd, uint attribute, out int value, int size);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hwnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong32(IntPtr hwnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
    private static extern int SetWindowLong32(IntPtr hwnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyIcon(IntPtr hIcon);

    public static long GetWindowLongPtr(IntPtr hwnd, int nIndex) =>
        IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, nIndex).ToInt64() : GetWindowLong32(hwnd, nIndex);

    public static void SetWindowLongPtr(IntPtr hwnd, int nIndex, long dwNewLong)
    {
        if (IntPtr.Size == 8)
            SetWindowLongPtr64(hwnd, nIndex, new IntPtr(dwNewLong));
        else
            SetWindowLong32(hwnd, nIndex, (int)dwNewLong);
    }

    public static bool TryGetExtendedWindowBounds(IntPtr hwnd, out RECT rect)
    {
        int hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf<RECT>());
        if (hr == 0 && rect.Width > 0 && rect.Height > 0)
        {
            return true;
        }

        return GetWindowRect(hwnd, out rect) && rect.Width > 0 && rect.Height > 0;
    }

    internal static bool IsRectObscured(IntPtr target, RECT bounds, uint ignoredPid)
    {
        for (var other = GetWindow(target, GW_HWNDPREV); other != IntPtr.Zero; other = GetWindow(other, GW_HWNDPREV))
        {
            if (!IsWindowVisible(other) || IsIconic(other)) continue;
            GetWindowThreadProcessId(other, out uint pid);
            if (pid == ignoredPid || (GetWindowLongPtr(other, GWL_EXSTYLE) & WS_EX_TRANSPARENT) != 0) continue;
            if (DwmGetWindowAttributeInt(other, DWMWA_CLOAKED, out int cloaked, sizeof(int)) == 0 && cloaked != 0) continue;
            if (TryGetExtendedWindowBounds(other, out var covering) &&
                covering.Left < bounds.Right && covering.Right > bounds.Left &&
                covering.Top < bounds.Bottom && covering.Bottom > bounds.Top) return true;
        }
        return false;
    }

    public static string GetWindowTitle(IntPtr hwnd)
    {
        int len = GetWindowTextLength(hwnd);
        if (len <= 0) return string.Empty;
        var sb = new StringBuilder(len + 1);
        _ = GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static double GetDpiScaleForWindow(IntPtr hwnd)
    {
        try
        {
            uint dpi = GetDpiForWindow(hwnd);
            if (dpi >= 72) return dpi / 96.0;
        }
        catch
        {
            // Fall back to 96 DPI
        }

        return 1.0;
    }

    public static void ApplyOverlayWindowStyles(IntPtr hwnd, bool noActivate)
    {
        long style = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
        style |= WS_EX_TOOLWINDOW;
        if (noActivate)
        {
            style |= WS_EX_NOACTIVATE;
        }

        SetWindowLongPtr(hwnd, GWL_EXSTYLE, style);
    }

    public static void ApplyWindowDwmPolish(IntPtr hwnd, bool isDark)
    {
        if (hwnd == IntPtr.Zero) return;
        try
        {
            int darkVal = isDark ? 1 : 0;
            _ = DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref darkVal, sizeof(int));

            int cornerPref = DWMWCP_ROUND;
            _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref cornerPref, sizeof(int));
        }
        catch
        {
            // Ignore on older Windows builds without these DWM attributes
        }
    }
}
