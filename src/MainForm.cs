using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Sonora;

static class Program
{
    [STAThread]
    static void Main()
    {
        using var mutex = new Mutex(true, "Sonora.Player.SingleInstance", out bool first);
        if (!first)
        {
            // Ya está abierto: traerlo al frente
            var p = Process.GetProcessesByName("Sonora").FirstOrDefault(x => x.Id != Environment.ProcessId && x.MainWindowHandle != IntPtr.Zero);
            if (p != null) { MainForm.ShowWindow(p.MainWindowHandle, 9); MainForm.SetForegroundWindow(p.MainWindowHandle); }
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

public class WindowState2 { public int X, Y, W = 1360, H = 860; public bool Max; }

public class MainForm : Form
{
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool SetProcessWorkingSetSize(IntPtr proc, IntPtr min, IntPtr max);
    [DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr h, ref Margins m);
    struct Margins { public int L, R, T, B; }
    [DllImport("user32.dll")] static extern int SetWindowCompositionAttribute(IntPtr h, ref WinCompAttrData d);
    [StructLayout(LayoutKind.Sequential)] struct AccentPolicy { public int AccentState, AccentFlags, GradientColor, AnimationId; }
    [StructLayout(LayoutKind.Sequential)] struct WinCompAttrData { public int Attribute; public IntPtr Data; public int SizeOfData; }

    /// <summary>Desenfoque "blur-behind" sin tinte: cristal transparente que deja ver ventanas y juegos detrás.</summary>
    void SetAccent(int state)
    {
        var acc = new AccentPolicy { AccentState = state, GradientColor = 0 };
        int size = Marshal.SizeOf(acc);
        IntPtr p = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(acc, p, false);
            var d = new WinCompAttrData { Attribute = 19, Data = p, SizeOfData = size }; // WCA_ACCENT_POLICY
            SetWindowCompositionAttribute(Handle, ref d);
        }
        finally { Marshal.FreeHGlobal(p); }
    }

    /// <summary>Efecto de ventana de Windows 11 (lo dibuja el compositor del sistema, no consume RAM de Sonora).</summary>
    public string WindowFx = ReadSetting("windowFx") ?? "glass";

    readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(12, 12, 16) };
    public Library Lib; public LastFm Fm; public Meta Meta; public GenreEngine Genres; public DjAnalyzer Dj; public Converter Conv;
    Server srv; Bridge br; NotifyIcon tray;
    public bool GameMode, CloseToTray;
    bool minimized, exiting;
    FormWindowState preFull = FormWindowState.Normal; FormBorderStyle preBorder = FormBorderStyle.Sizable; bool fullscreen;

    public MainForm()
    {
        Text = "Sonora";
        BackColor = Color.FromArgb(12, 12, 16);
        MinimumSize = new Size(820, 560);
        Icon = LoadAppIcon();
        var ws = Json.Load<WindowState2>(Paths.Of("window.json"));
        StartPosition = FormStartPosition.Manual;
        var area = Screen.FromPoint(new Point(ws.X + 50, ws.Y + 50)).WorkingArea;
        Size = new Size(Math.Min(ws.W, area.Width), Math.Min(ws.H, area.Height));
        Location = ws.X == 0 && ws.Y == 0
            ? new Point(area.X + (area.Width - Width) / 2, area.Y + (area.Height - Height) / 2)
            : new Point(Math.Clamp(ws.X, area.X, area.Right - 200), Math.Clamp(ws.Y, area.Y, area.Bottom - 200));
        if (ws.Max) WindowState = FormWindowState.Maximized;
        Controls.Add(web);
        Load += async (_, _) => await Init();
    }

    async Task Init()
    {
        try
        {
            Lib = new Library();
            Fm = new LastFm();
            Meta = new Meta(Fm);
            Genres = new GenreEngine(Lib, Fm, Meta);
            Dj = new DjAnalyzer(Lib);
            Conv = new Converter(Lib);
            srv = new Server(Lib);
            srv.Start();

            // Flags de Chromium para recortar memoria y procesos innecesarios
            var flags = string.Join(" ",
                "--disable-features=msSmartScreenProtection,msWebOOUI,msPdfOOUI,SpareRendererForSitePerProcess,Translate,AutofillServerCommunication,msEdgeShopping",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-sync",
                "--disable-extensions",
                "--renderer-process-limit=1",
                "--autoplay-policy=no-user-gesture-required",
                "--js-flags=--max-old-space-size=256");
            // Por defecto se dibuja por software: ~250 MB menos de RAM y la GPU queda libre para los juegos
            // Dibujo por software y el "proceso de GPU" dentro del principal: un proceso y ~16 MB menos
            if (!ReadGpuSetting()) flags += " --disable-gpu-compositing --disable-gpu-rasterization --in-process-gpu";
            var env = await CoreWebView2Environment.CreateAsync(null, Paths.WebView, new CoreWebView2EnvironmentOptions(flags));
            await web.EnsureCoreWebView2Async(env);
            var cw = web.CoreWebView2;
            cw.Settings.AreDefaultContextMenusEnabled = false;
            cw.Settings.IsStatusBarEnabled = false;
            cw.Settings.IsZoomControlEnabled = false;
            cw.Settings.IsPasswordAutosaveEnabled = false;
            cw.Settings.IsGeneralAutofillEnabled = false;
            cw.Settings.AreBrowserAcceleratorKeysEnabled = true;
            cw.Settings.IsNonClientRegionSupportEnabled = true; // CSS app-region: drag → arrastrar la ventana desde la interfaz
            cw.Settings.AreHostObjectsAllowed = false;            // el único canal con .NET es el puente de mensajes
            cw.Settings.IsSwipeNavigationEnabled = false;
#if DEBUG
            cw.Settings.AreDevToolsEnabled = true;
#else
            // En la versión final las DevTools solo se activan a propósito (SONORA_DEVTOOLS=1)
            cw.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("SONORA_DEVTOOLS") == "1";
#endif
            // Cookie de sesión: la pone el host, así el token nunca aparece en una URL ni en el JS (HttpOnly)
            var sid = cw.CookieManager.CreateCookie(Server.CookieName, srv.Token, "localhost", "/");
            sid.IsHttpOnly = true;
            sid.SameSite = CoreWebView2CookieSameSiteKind.Strict;
            cw.CookieManager.AddOrUpdateCookie(sid);

            // La vista solo puede mostrar la interfaz local; cualquier otro enlace se abre fuera (y solo si es https)
            cw.NavigationStarting += (_, e) =>
            {
                if (e.Uri.StartsWith(srv.BaseUrl, StringComparison.OrdinalIgnoreCase)) return;
                e.Cancel = true;
                OpenExternal(e.Uri);
            };
            cw.FrameNavigationStarting += (_, e) => { if (!e.Uri.StartsWith(srv.BaseUrl, StringComparison.OrdinalIgnoreCase)) e.Cancel = true; };
            cw.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
            cw.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny; // ni micrófono, ni cámara, ni ubicación...
            cw.DownloadStarting += (_, e) => e.Cancel = true;
            cw.ContainsFullScreenElementChanged += (_, _) => SetFullscreen(cw.ContainsFullScreenElement);

            br = new Bridge(this, cw);
            cw.WebMessageReceived += br.OnMessage;
            cw.Navigate(srv.BaseUrl);

            RegisterMediaKeys();
            SetupTray();
            if (Lib.D.Tracks.Count == 0) _ = Task.Run(async () => { await Lib.Scan(); Genres.ClassifyAll(); br.Emit("library", Lib.All()); });
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "No se pudo iniciar Sonora:\n\n" + ex.Message +
                "\n\nAsegúrate de tener instalado Microsoft Edge WebView2 Runtime.", "Sonora", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    /// <summary>Abre un enlace en el navegador solo si es https:// (nunca file:, javascript: u otros protocolos).</summary>
    public static void OpenExternal(string url, string browser = null)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps && string.IsNullOrEmpty(u.UserInfo))
            try { Browsers.Open(u.AbsoluteUri, browser); } catch { }
    }

    public bool IsTrustedSource(string source) => srv != null && source != null && source.StartsWith(srv.BaseUrl, StringComparison.OrdinalIgnoreCase);

    static bool ReadGpuSetting() => ReadSetting("gpuAccel") == "true";

    // Sin superficie propia: Windows compone el cristal y encima la página transparente de WebView2
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            if (WindowFx != "none") cp.ExStyle |= 0x00200000; // WS_EX_NOREDIRECTIONBITMAP
            cp.Style &= ~0x00080000;                            // sin WS_SYSMENU: los botones de ventana los dibuja Sonora
            return cp;
        }
    }

    static string ReadSetting(string key)
    {
        try
        {
            var f = Path.Combine(Paths.State, "settings.json");
            if (!File.Exists(f)) return null;
            using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(f));
            if (!doc.RootElement.TryGetProperty(key, out var v)) return null;
            return v.ValueKind switch { System.Text.Json.JsonValueKind.String => v.GetString(), System.Text.Json.JsonValueKind.True => "true", System.Text.Json.JsonValueKind.False => "false", _ => v.GetRawText() };
        }
        catch { return null; }
    }

    /// <summary>Acrílico (escritorio difuminado), Mica (tinte del fondo de pantalla) o ninguno.</summary>
    public void SetWindowFx(string fx)
    {
        WindowFx = fx is "glass" or "acrylic" or "mica" ? fx : "none";
        bool on = WindowFx != "none";
        try
        {
            var m = on ? new Margins { L = -1, R = -1, T = -1, B = -1 } : new Margins();
            DwmExtendFrameIntoClientArea(Handle, ref m);
            // Cristal y Acrílico usan el acrílico real de Windows (difumina en vivo ventanas y juegos detrás);
            // la diferencia es cuánto velo pone la página encima.
            int type = WindowFx is "glass" or "acrylic" ? 3 : WindowFx == "mica" ? 2 : 1;
            DwmSetWindowAttribute(Handle, 38, ref type, 4); // DWMWA_SYSTEMBACKDROP_TYPE
            if (on) { int none = unchecked((int)0xFFFFFFFE); DwmSetWindowAttribute(Handle, 35, ref none, 4); } // DWMWA_COLOR_NONE: sin franja de barra de título
        }
        catch { }
        var solid = Color.FromArgb(20, 20, 22);
        BackColor = on ? Color.Black : solid;          // el negro en el área extendida = "cristal"
        web.DefaultBackgroundColor = on ? Color.Transparent : solid;
    }

    // ---------- Barra de título oscura (Windows 11) ----------
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0020 | 0x0002 | 0x0001 | 0x0004); // SWP_FRAMECHANGED: aplica el marco propio
        int on = 1;
        DwmSetWindowAttribute(Handle, 20, ref on, 4);      // modo oscuro
        int round = 2; DwmSetWindowAttribute(Handle, 33, ref round, 4); // esquinas redondeadas
        SetWindowFx(WindowFx);
        if (WindowFx == "none") SetCaptionColor("#141416");
    }

    public void SetCaptionColor(string hex)
    {
        try
        {
            if (string.IsNullOrEmpty(hex) || hex[0] != '#' || hex.Length < 7) return;
            int r = Convert.ToInt32(hex.Substring(1, 2), 16), g = Convert.ToInt32(hex.Substring(3, 2), 16), b = Convert.ToInt32(hex.Substring(5, 2), 16);
            int c = r | (g << 8) | (b << 16);
            int dark = (r * 299 + g * 587 + b * 114) / 1000 > 150 ? 0 : 1;
            DwmSetWindowAttribute(Handle, 20, ref dark, 4); // tema claro/oscuro (también tiñe el acrílico)
            if (WindowFx != "none") return;
            DwmSetWindowAttribute(Handle, 35, ref c, 4); // color de la barra
            int txt = (r * 299 + g * 587 + b * 114) / 1000 > 150 ? 0x101010 : 0xF0F0F0;
            DwmSetWindowAttribute(Handle, 36, ref txt, 4); // color del texto
        }
        catch { }
    }

    public void SetFullscreen(bool on)
    {
        if (on == fullscreen) return;
        fullscreen = on;
        if (on)
        {
            preFull = WindowState; preBorder = FormBorderStyle;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Normal;
            WindowState = FormWindowState.Maximized;
        }
        else
        {
            FormBorderStyle = preBorder;
            WindowState = preFull;
        }
    }

    // ---------- Memoria: modo juego / minimizado ----------
    bool lastMax;
    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        bool max = WindowState == FormWindowState.Maximized;
        if (max != lastMax) { lastMax = max; br?.Emit("window", new { minimized, maximized = max }); }
        bool min = WindowState == FormWindowState.Minimized;
        if (min == minimized) return;
        minimized = min;
        ApplyMemoryMode();
        br?.Emit("window", new { minimized = min, maximized = max });
    }

    /// <summary>Botones propios de la interfaz: minimizar, maximizar/restaurar, cerrar.</summary>
    public object WindowAction(string action)
    {
        switch (action)
        {
            case "min": WindowState = FormWindowState.Minimized; break;
            case "max": WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized; break;
            case "close": Close(); break;
        }
        return new { maximized = WindowState == FormWindowState.Maximized };
    }

    // ---------- Marco propio: sin barra de título de Windows, pero con bordes, sombra, Snap y redimensión ----------
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
    [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index, uint dpi);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct NCCALCSIZE_PARAMS { public RECT R0, R1, R2; public IntPtr Pos; }

    bool CustomFrame => FormBorderStyle == FormBorderStyle.Sizable;

    void HandleNcCalcSize(ref Message m)
    {
        var p = Marshal.PtrToStructure<NCCALCSIZE_PARAMS>(m.LParam);
        int top = p.R0.Top;
        base.WndProc(ref m);                    // Windows calcula bordes laterales e inferior (para redimensionar)
        p = Marshal.PtrToStructure<NCCALCSIZE_PARAMS>(m.LParam);
        int inset = 0;
        if (WindowState == FormWindowState.Maximized)
        {
            uint dpi = GetDpiForWindow(Handle);
            inset = GetSystemMetricsForDpi(33, dpi) + GetSystemMetricsForDpi(92, dpi); // SM_CYFRAME + SM_CXPADDEDBORDER
        }
        p.R0.Top = top + inset;                 // …pero el área de la barra de título pasa a ser de la app
        Marshal.StructureToPtr(p, m.LParam, false);
        m.Result = IntPtr.Zero;
    }

    static Icon LoadAppIcon()
    {
        try { var i = Icon.ExtractAssociatedIcon(Application.ExecutablePath); if (i != null) return i; } catch { }
        return MakeIcon();
    }

    public void ApplyMemoryMode()
    {
        var cw = web.CoreWebView2;
        if (cw == null) return;
        bool low = minimized || !Visible || GameMode;
        if (Dj != null) { Dj.AllowBackground = !low; Dj.Wake(); }
        try { cw.MemoryUsageTargetLevel = low ? CoreWebView2MemoryUsageTargetLevel.Low : CoreWebView2MemoryUsageTargetLevel.Normal; } catch { }
        // Ocultar el control detiene el renderizado (el audio sigue sonando)
        if (minimized || !Visible) web.Visible = false; else web.Visible = true;
        if (low) TrimMemory();
    }

    public void TrimMemory()
    {
        GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, true, true);
        GC.WaitForPendingFinalizers();
        try { SetProcessWorkingSetSize(Process.GetCurrentProcess().Handle, -1, -1); } catch { }
    }

    public object MemoryReport()
    {
        long host = Process.GetCurrentProcess().PrivateMemorySize64, webMem = 0; int count = 0;
        try
        {
            foreach (var pi in web.CoreWebView2.Environment.GetProcessInfos())
            {
                try { using var p = Process.GetProcessById(pi.ProcessId); webMem += p.PrivateMemorySize64; count++; } catch { }
            }
        }
        catch { }
        return new { hostMB = host / 1048576.0, webMB = webMem / 1048576.0, totalMB = (host + webMem) / 1048576.0, processes = count + 1 };
    }

    // ---------- Teclas multimedia globales (funcionan mientras juegas) ----------
    void RegisterMediaKeys()
    {
        const uint NOREPEAT = 0x4000;
        RegisterHotKey(Handle, 1, NOREPEAT, 0xB3); // Play/Pausa
        RegisterHotKey(Handle, 2, NOREPEAT, 0xB0); // Siguiente
        RegisterHotKey(Handle, 3, NOREPEAT, 0xB1); // Anterior
        RegisterHotKey(Handle, 4, NOREPEAT, 0xB2); // Detener
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0083 && m.WParam != IntPtr.Zero && CustomFrame) { HandleNcCalcSize(ref m); return; } // WM_NCCALCSIZE
        if (m.Msg == 0x0312 && br != null)
        {
            var key = (int)m.WParam switch { 1 => "playpause", 2 => "next", 3 => "prev", 4 => "stop", _ => null };
            if (key != null) br.Emit("hotkey", new { key });
        }
        base.WndProc(ref m);
    }

    // ---------- Bandeja del sistema ----------
    void SetupTray()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Reproducir / Pausa", null, (_, _) => br.Emit("hotkey", new { key = "playpause" }));
        menu.Items.Add("Siguiente", null, (_, _) => br.Emit("hotkey", new { key = "next" }));
        menu.Items.Add("Anterior", null, (_, _) => br.Emit("hotkey", new { key = "prev" }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Mostrar Sonora", null, (_, _) => RestoreFromTray());
        menu.Items.Add("Salir", null, (_, _) => ExitApp());
        tray = new NotifyIcon { Icon = Icon, Text = "Sonora", Visible = true, ContextMenuStrip = menu };
        tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) { if (Visible && !minimized) HideToTray(); else RestoreFromTray(); } };
    }

    public void SetTrayText(string t)
    {
        if (tray == null) return;
        t = string.IsNullOrEmpty(t) ? "Sonora" : t;
        tray.Text = t.Length > 63 ? t[..62] + "…" : t;
    }

    void HideToTray() { Hide(); ApplyMemoryMode(); }

    void RestoreFromTray()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        ApplyMemoryMode();
    }

    public void ExitApp() { exiting = true; Close(); }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (CloseToTray && !exiting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true; HideToTray(); return;
        }
        try
        {
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            Json.Save(Paths.Of("window.json"), new WindowState2 { X = b.X, Y = b.Y, W = b.Width, H = b.Height, Max = WindowState == FormWindowState.Maximized });
            Lib?.Save();
        }
        catch { }
        for (int i = 1; i <= 4; i++) UnregisterHotKey(Handle, i);
        if (tray != null) { tray.Visible = false; tray.Dispose(); }
        srv?.Stop();
        base.OnFormClosing(e);
    }

    static Icon MakeIcon()
    {
        using var bmp = new Bitmap(64, 64);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var br = new LinearGradientBrush(new Rectangle(0, 0, 64, 64), Color.FromArgb(139, 124, 255), Color.FromArgb(255, 110, 170), 45f);
            g.FillEllipse(br, 2, 2, 60, 60);
            using var w = new SolidBrush(Color.FromArgb(245, 255, 255, 255));
            // ondas de sonido estilizadas
            int[] hs = { 14, 26, 36, 26, 14 };
            for (int i = 0; i < hs.Length; i++) g.FillRectangle(w, 15 + i * 7, 32 - hs[i] / 2, 4, hs[i]);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }
}
