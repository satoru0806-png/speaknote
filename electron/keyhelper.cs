using System;
using System.Runtime.InteropServices;
using System.Threading;

class Program {
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT {
        public uint type;
        public KEYBDINPUT ki;
        public ulong padding;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_SCANCODE = 0x0008;
    const uint MAPVK_VK_TO_VSC = 0;

    const ushort VK_CONTROL = 0x11;
    const ushort VK_V = 0x56;
    const ushort VK_SHIFT = 0x10;
    const ushort VK_INSERT = 0x2D;
    const ushort VK_LWIN = 0x5B;
    const ushort VK_H = 0x48;
    const ushort VK_A = 0x41;
    const ushort VK_C = 0x43;
    const ushort VK_ESCAPE = 0x1B;
    const ushort VK_END = 0x23;
    const ushort VK_MENU = 0x12; // Alt key

    // Make key input with proper scan code (important for web apps like Google Keep)
    static INPUT MakeKey(ushort vk, uint flags) {
        ushort scan = (ushort)MapVirtualKey(vk, MAPVK_VK_TO_VSC);
        return new INPUT {
            type = INPUT_KEYBOARD,
            ki = new KEYBDINPUT {
                wVk = vk, wScan = scan, dwFlags = flags,
                time = 0, dwExtraInfo = UIntPtr.Zero
            }
        };
    }

    // Release all modifier keys that might be stuck
    static void ReleaseModifiers() {
        int[] mods = { VK_MENU, VK_CONTROL, VK_SHIFT, VK_LWIN };
        foreach (var vk in mods) {
            if ((GetAsyncKeyState(vk) & 0x8000) != 0) {
                var up = new[] { MakeKey((ushort)vk, KEYEVENTF_KEYUP) };
                SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
            }
        }
        // Escapeでメニューを閉じる（Alt+VでViewメニューが開く問題対策）
        var esc = new[] { MakeKey(VK_ESCAPE, 0), MakeKey(VK_ESCAPE, KEYEVENTF_KEYUP) };
        SendInput((uint)esc.Length, esc, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(50);
    }

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    static extern bool BringWindowToTop(IntPtr hWnd);

    static void ForceForeground(IntPtr hwnd) {
        uint myThread = GetCurrentThreadId();
        uint pid;
        uint targetThread = GetWindowThreadProcessId(hwnd, out pid);
        if (myThread != targetThread) {
            AttachThreadInput(myThread, targetThread, true);
            SetForegroundWindow(hwnd);
            BringWindowToTop(hwnd);
            AttachThreadInput(myThread, targetThread, false);
        } else {
            SetForegroundWindow(hwnd);
        }
    }

    static void Main(string[] args) {
        string mode = args.Length > 0 ? args[0] : "paste";

        if (mode == "focuspaste" && args.Length > 1) {
            // hwnd指定でフォーカス復元してから貼り付け
            IntPtr hwnd = new IntPtr(long.Parse(args[1]));
            ReleaseModifiers();
            Thread.Sleep(30);
            ForceForeground(hwnd);
            Thread.Sleep(100);
            ForceForeground(hwnd);
            Thread.Sleep(30);
            var inputs = new[] {
                MakeKey(VK_CONTROL, 0),
                MakeKey(VK_V, 0),
                MakeKey(VK_V, KEYEVENTF_KEYUP),
                MakeKey(VK_CONTROL, KEYEVENTF_KEYUP)
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        } else if (mode == "paste") {
            ReleaseModifiers();
            Thread.Sleep(50);
            Thread.Sleep(30);
            var inputs = new[] {
                MakeKey(VK_CONTROL, 0),
                MakeKey(VK_V, 0),
                MakeKey(VK_V, KEYEVENTF_KEYUP),
                MakeKey(VK_CONTROL, KEYEVENTF_KEYUP)
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        } else if (mode == "grabline") {
            // Select current line and copy: Home, Shift+End, Ctrl+C, then End to deselect
            ReleaseModifiers();
            Thread.Sleep(30);
            // Home key
            var home = new[] { MakeKey(0x24, 0), MakeKey(0x24, KEYEVENTF_KEYUP) }; // VK_HOME
            SendInput((uint)home.Length, home, Marshal.SizeOf(typeof(INPUT)));
            Thread.Sleep(30);
            // Shift+End to select line
            var selEnd = new[] {
                MakeKey(VK_SHIFT, 0),
                MakeKey(0x23, 0), // VK_END
                MakeKey(0x23, KEYEVENTF_KEYUP),
                MakeKey(VK_SHIFT, KEYEVENTF_KEYUP)
            };
            SendInput((uint)selEnd.Length, selEnd, Marshal.SizeOf(typeof(INPUT)));
            Thread.Sleep(50);
            // Ctrl+C
            var copy = new[] {
                MakeKey(VK_CONTROL, 0),
                MakeKey(VK_C, 0),
                MakeKey(VK_C, KEYEVENTF_KEYUP),
                MakeKey(VK_CONTROL, KEYEVENTF_KEYUP)
            };
            SendInput((uint)copy.Length, copy, Marshal.SizeOf(typeof(INPUT)));
            Thread.Sleep(50);
            // End key to deselect
            var end = new[] { MakeKey(0x23, 0), MakeKey(0x23, KEYEVENTF_KEYUP) };
            SendInput((uint)end.Length, end, Marshal.SizeOf(typeof(INPUT)));
        } else if (mode == "selectall") {
            // Ctrl+A to select all
            ReleaseModifiers();
            Thread.Sleep(30);
            var inputs = new[] {
                MakeKey(VK_CONTROL, 0),
                MakeKey(VK_A, 0),
                MakeKey(VK_A, KEYEVENTF_KEYUP),
                MakeKey(VK_CONTROL, KEYEVENTF_KEYUP)
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        } else if (mode == "deselect") {
            // Press End to deselect
            var inputs = new[] {
                MakeKey(VK_END, 0),
                MakeKey(VK_END, KEYEVENTF_KEYUP)
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        } else if (mode == "copy") {
            // Ctrl+C to copy selection
            ReleaseModifiers();
            Thread.Sleep(30);
            var inputs = new[] {
                MakeKey(VK_CONTROL, 0),
                MakeKey(VK_C, 0),
                MakeKey(VK_C, KEYEVENTF_KEYUP),
                MakeKey(VK_CONTROL, KEYEVENTF_KEYUP)
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        } else if (mode == "esc") {
            var inputs = new[] {
                MakeKey(VK_ESCAPE, 0),
                MakeKey(VK_ESCAPE, KEYEVENTF_KEYUP)
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        } else if (mode == "winh") {
            var inputs = new[] {
                MakeKey(VK_LWIN, 0),
                MakeKey(VK_H, 0),
                MakeKey(VK_H, KEYEVENTF_KEYUP),
                MakeKey(VK_LWIN, KEYEVENTF_KEYUP)
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }
    }
}
