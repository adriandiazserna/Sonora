using System.Diagnostics;
using Microsoft.Win32;

namespace Sonora;

/// <summary>Navegadores instalados (para elegir con cuál conectar Last.fm).</summary>
public static class Browsers
{
    public static List<object> List()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var list = new List<object>();
        string def = null;
        try { def = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice")?.GetValue("ProgId") as string; } catch { }
        foreach (var (hive, path) in new[] { (Registry.CurrentUser, @"SOFTWARE\Clients\StartMenuInternet"), (Registry.LocalMachine, @"SOFTWARE\Clients\StartMenuInternet"), (Registry.LocalMachine, @"SOFTWARE\WOW6432Node\Clients\StartMenuInternet") })
        {
            try
            {
                using var root = hive.OpenSubKey(path);
                if (root == null) continue;
                foreach (var sub in root.GetSubKeyNames())
                {
                    using var k = root.OpenSubKey(sub);
                    var name = k?.GetValue(null) as string ?? sub;
                    var cmd = k?.OpenSubKey(@"shell\open\command")?.GetValue(null) as string;
                    if (string.IsNullOrWhiteSpace(cmd) || name.Contains("Internet Explorer")) continue;
                    var exe = cmd.Trim().Trim('"');
                    var q = cmd.Trim().StartsWith("\"") ? cmd.Trim().IndexOf('"', 1) : -1;
                    if (q > 0) exe = cmd.Trim().Substring(1, q - 1);
                    if (!File.Exists(exe) || !seen.Add(exe)) continue;
                    bool isDefault = def != null && (
                        (def.StartsWith("MSEdge", StringComparison.OrdinalIgnoreCase) && exe.Contains("msedge", StringComparison.OrdinalIgnoreCase)) ||
                        (def.StartsWith("Chrome", StringComparison.OrdinalIgnoreCase) && exe.Contains("chrome.exe", StringComparison.OrdinalIgnoreCase)) ||
                        (def.StartsWith("Brave", StringComparison.OrdinalIgnoreCase) && exe.Contains("brave", StringComparison.OrdinalIgnoreCase)) ||
                        (def.StartsWith("Firefox", StringComparison.OrdinalIgnoreCase) && exe.Contains("firefox", StringComparison.OrdinalIgnoreCase)) ||
                        (def.StartsWith("Opera", StringComparison.OrdinalIgnoreCase) && exe.Contains("opera", StringComparison.OrdinalIgnoreCase)));
                    list.Add(new { name = name.Replace(" Stable", ""), path = exe, isDefault });
                }
            }
            catch { }
        }
        return list;
    }

    /// <summary>Solo se acepta como navegador un ejecutable registrado como tal en Windows, nunca una ruta arbitraria.</summary>
    static bool IsRegisteredBrowser(string exe) =>
        List().Any(b => string.Equals((string)b.GetType().GetProperty("path")!.GetValue(b), exe, StringComparison.OrdinalIgnoreCase));

    public static void Open(string url, string browser)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || u.Scheme != Uri.UriSchemeHttps) return; // solo https
        url = u.AbsoluteUri;
        if (!string.IsNullOrEmpty(browser) && File.Exists(browser) && IsRegisteredBrowser(browser))
            Process.Start(new ProcessStartInfo(browser) { ArgumentList = { url }, UseShellExecute = false });
        else
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}

/// <summary>
/// Convierte a FLAC con ffmpeg lo que el motor no reproduce: DSD (DSF/DFF) → FLAC 24-bit/176.4 kHz,
/// ALAC/APE/WMA → FLAC sin pérdida. Copia etiquetas y portada; los originales no se tocan.
/// </summary>
public class Converter
{
    readonly Library lib;
    public bool Running { get; private set; }
    public event Action<object> Progress;

    public Converter(Library lib) { this.lib = lib; }

    public static string FindFfmpeg()
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try { var p = Path.Combine(dir.Trim(), "ffmpeg.exe"); if (File.Exists(p)) return p; } catch { }
        }
        var winget = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\WinGet\Packages");
        try
        {
            if (Directory.Exists(winget))
                foreach (var d in Directory.GetDirectories(winget, "*FFmpeg*"))
                {
                    var hit = Directory.EnumerateFiles(d, "ffmpeg.exe", SearchOption.AllDirectories).FirstOrDefault();
                    if (hit != null) return hit;
                }
        }
        catch { }
        foreach (var p in new[] { @"C:\ffmpeg\bin\ffmpeg.exe", @"C:\Program Files\ffmpeg\bin\ffmpeg.exe" })
            if (File.Exists(p)) return p;
        return null;
    }

    public static string Target(string path) => Path.ChangeExtension(path, ".flac");

    public Task Run(List<string> ids) => Task.Run(() =>
    {
        if (Running) return;
        var ff = FindFfmpeg();
        if (ff == null) { Progress?.Invoke(new { error = "No encontré ffmpeg" }); return; }
        Running = true;
        int done = 0, ok = 0, fail = 0;
        var tracks = ids.Select(lib.Get).Where(t => t != null && !t.Playable).ToList();
        try
        {
            foreach (var t in tracks)
            {
                Progress?.Invoke(new { done, total = tracks.Count, current = t.Title, ok, fail });
                var outFile = Target(t.Path);
                if (File.Exists(outFile)) { ok++; done++; continue; }
                var tmp = outFile + ".part.flac";
                var ext = Path.GetExtension(t.Path).ToLowerInvariant();
                var audio = ext is ".dsf" or ".dff"
                    // DSD: a PCM con remuestreo de alta calidad (soxr) a 176.4 kHz, 24 bits; filtro suave que quita el ruido ultrasónico del DSD
                    ? new[] { "-af", "aresample=176400:resampler=soxr:precision=28,lowpass=f=45000:poles=2", "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24" }
                    : new[] { "-c:a", "flac" };
                var psi = new ProcessStartInfo(ff) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true };
                foreach (var a in new[] { "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", t.Path, "-map", "0:a:0", "-map", "0:v?", "-map_metadata", "0" }) psi.ArgumentList.Add(a);
                foreach (var a in audio) psi.ArgumentList.Add(a);
                foreach (var a in new[] { "-compression_level", "8", "-c:v", "copy", "-disposition:v", "attached_pic", tmp }) psi.ArgumentList.Add(a);
                try
                {
                    using var p = Process.Start(psi);
                    try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
                    var err = p.StandardError.ReadToEnd();
                    p.WaitForExit();
                    if (p.ExitCode == 0 && File.Exists(tmp) && new FileInfo(tmp).Length > 1000) { File.Move(tmp, outFile, true); ok++; }
                    else { fail++; try { File.Delete(tmp); } catch { } }
                }
                catch { fail++; try { File.Delete(tmp); } catch { } }
                done++;
            }
        }
        finally
        {
            Running = false;
            Progress?.Invoke(new { done, total = tracks.Count, current = (string)null, ok, fail, finished = true });
        }
    });
}
