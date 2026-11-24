using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;

namespace Sonora;

/// <summary>Puente JSON entre la interfaz (JS) y el host nativo: peticiones {id,cmd,args} → {id,ok,data}; eventos {ev,data}.</summary>
public class Bridge
{
    readonly MainForm F;
    readonly CoreWebView2 W;

    public Bridge(MainForm f, CoreWebView2 w)
    {
        F = f; W = w;
        F.Lib.Progress += (d, t, cur) => Emit("scan", new { done = d, total = t, current = cur });
        F.Genres.Progress += (d, t, cur) => Emit("genre", new { done = d, total = t, current = cur });
        F.Dj.Progress += (d, t, cur) => Emit("djprogress", new { done = d, total = t, current = cur });
        F.Dj.Results += (list) => Emit("djinfo", list);
        F.Conv.Progress += (p) => Emit("convert", p);
    }

    public void OnMessage(object s, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!F.IsTrustedSource(e.Source)) return; // solo se aceptan mensajes de la interfaz local
        int id = 0; string cmd = null; JsonElement args = default;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var r = doc.RootElement;
            id = r.GetProperty("id").GetInt32();
            cmd = r.GetProperty("cmd").GetString();
            if (r.TryGetProperty("args", out var a)) args = a.Clone();
        }
        catch { return; }
        _ = Handle(id, cmd, args);
    }

    async Task Handle(int id, string cmd, JsonElement a)
    {
        object data = null; string err = null;
        try { data = await Dispatch(cmd, a); }
        catch (Exception ex) { err = ex.Message; }
        Post(new { id, ok = err == null, data, error = err });
    }

    void Post(object o)
    {
        string s;
        try { s = JsonSerializer.Serialize(o, Json.Opt); } catch (Exception ex) { s = JsonSerializer.Serialize(new { error = ex.Message }); }
        void Send() { try { W.PostWebMessageAsJson(s); } catch { } }
        if (F.IsDisposed) return;
        if (F.InvokeRequired) F.BeginInvoke(Send); else Send();
    }

    public void Emit(string ev, object data) => Post(new { ev, data });

    static string S(JsonElement a, string k) =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    static bool B(JsonElement a, string k) =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.True;
    static double N(JsonElement a, string k) =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;

    static readonly Regex SafeKey = new("^[a-z0-9_-]{1,40}$");

    async Task<object> Dispatch(string cmd, JsonElement a)
    {
        switch (cmd)
        {
            // ---------- Biblioteca ----------
            case "init":
                return new { folders = F.Lib.D.Folders, tracks = F.Lib.All(), lastfm = F.Fm.Status(), scanning = F.Lib.Scanning, genres = GenreEngine.MainGenres, fxSupported = MainForm.BackdropSupported };
            case "library.get":
                return F.Lib.All();
            case "library.scan":
                _ = ScanAndClassify();
                return true;
            case "library.addFolder":
            {
                using var d = new FolderBrowserDialog { Description = "Elige una carpeta de música", UseDescriptionForTitle = true, ShowNewFolderButton = false };
                if (d.ShowDialog(F) != DialogResult.OK) return F.Lib.D.Folders;
                lock (F.Lib.D) if (!F.Lib.D.Folders.Contains(d.SelectedPath, StringComparer.OrdinalIgnoreCase)) F.Lib.D.Folders.Add(d.SelectedPath);
                F.Lib.Save();
                _ = ScanAndClassify();
                return F.Lib.D.Folders;
            }
            case "library.removeFolder":
            {
                var p = S(a, "path");
                lock (F.Lib.D) F.Lib.D.Folders.RemoveAll(x => string.Equals(x, p, StringComparison.OrdinalIgnoreCase));
                F.Lib.Save();
                _ = ScanAndClassify();
                return F.Lib.D.Folders;
            }
            case "lyrics":
            {
                var t = F.Lib.Get(S(a, "id"));
                if (t == null) return null;
                var lrc = Path.ChangeExtension(t.Path, ".lrc");
                if (File.Exists(lrc)) return await File.ReadAllTextAsync(lrc);
                var txt = Path.ChangeExtension(t.Path, ".txt");
                return File.Exists(txt) ? await File.ReadAllTextAsync(txt) : null;
            }

            // ---------- Estado persistente (ajustes, estadísticas, playlists) ----------
            case "state.load":
            {
                var k = S(a, "key");
                if (k == null || !SafeKey.IsMatch(k)) throw new Exception("clave inválida");
                var f = Path.Combine(Paths.State, k + ".json");
                if (!File.Exists(f)) return null;
                using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(f));
                return doc.RootElement.Clone();
            }
            case "state.save":
            {
                var k = S(a, "key");
                if (k == null || !SafeKey.IsMatch(k)) throw new Exception("clave inválida");
                var f = Path.Combine(Paths.State, k + ".json");
                var raw = a.GetProperty("value").GetRawText();
                await File.WriteAllTextAsync(f + ".tmp", raw);
                File.Move(f + ".tmp", f, true);
                return true;
            }

            // ---------- Géneros ----------
            case "genre.analyze":
                if (!F.Genres.Running)
                    _ = F.Genres.Analyze(B(a, "deep")).ContinueWith(_ => Emit("library", F.Lib.All()));
                return true;

            // ---------- DJ ----------
            case "dj.analyze":
            {
                var ids = a.TryGetProperty("ids", out var arr) && arr.ValueKind == JsonValueKind.Array
                    ? arr.EnumerateArray().Select(x => x.GetString()).Where(x => x != null).ToList() : new List<string>();
                F.Dj.Enqueue(ids, B(a, "priority"));
                return F.Dj.Status();
            }
            case "dj.analyzeAll":
                F.Dj.Enqueue(F.Lib.All().Where(DjAnalyzer.Needs).OrderBy(t => t.AlbumArtist).Select(t => t.Id).ToList(), false);
                return F.Dj.Status();
            case "dj.status": return F.Dj.Status();

            // ---------- Conversión a FLAC ----------
            case "convert.status":
                return new { ffmpeg = Converter.FindFfmpeg(), running = F.Conv.Running };
            case "convert.start":
            {
                var ids = a.TryGetProperty("ids", out var arr) && arr.ValueKind == JsonValueKind.Array
                    ? arr.EnumerateArray().Select(x => x.GetString()).Where(x => x != null).ToList() : new List<string>();
                if (F.Conv.Running) return false;
                _ = F.Conv.Run(ids).ContinueWith(_ => ScanAndClassify());
                return true;
            }
            case "app.revealPath":
            {
                var p = S(a, "path");
                if (p != null && (File.Exists(p) || Directory.Exists(p))) Process.Start("explorer.exe", File.Exists(p) ? $"/select,\"{p}\"" : $"\"{p}\"");
                return true;
            }

            // ---------- Metadatos ----------
            case "meta.artist":
                return await F.Meta.Artist(S(a, "name"), B(a, "force"));
            case "meta.album":
                return await F.Meta.Album(S(a, "artist"), S(a, "album"));

            // ---------- Last.fm ----------
            case "lastfm.status": return F.Fm.Status();
            case "lastfm.configure":
                F.Fm.Configure(S(a, "key"), S(a, "secret"));
                return F.Fm.Status();
            case "lastfm.connect": return await F.Fm.BeginAuth(S(a, "browser"));
            case "app.browsers": return Browsers.List();
            case "lastfm.finish":
                await F.Fm.FinishAuth();
                return F.Fm.Status();
            case "lastfm.logout":
                F.Fm.Logout();
                return F.Fm.Status();
            case "lastfm.forget":
                F.Fm.Forget();
                return F.Fm.Status();
            case "lastfm.nowPlaying":
                _ = F.Fm.NowPlaying(S(a, "artist"), S(a, "track"), S(a, "album"), (int)N(a, "duration"));
                return true;
            case "lastfm.scrobble":
                _ = F.Fm.Scrobble(new ScrobbleItem { Artist = S(a, "artist"), Track = S(a, "track"), Album = S(a, "album"), Ts = (long)N(a, "timestamp"), Dur = (int)N(a, "duration") });
                return true;
            case "lastfm.love":
                await F.Fm.Love(S(a, "artist"), S(a, "track"), B(a, "love"));
                return true;
            case "lastfm.profile": return await F.Fm.Profile();

            // ---------- Ventana / sistema ----------
            case "app.open":
            {
                MainForm.OpenExternal(NetGuard.ToHttps(S(a, "url"))?.AbsoluteUri, S(a, "browser"));
                return true;
            }
            case "app.reveal":
            {
                var t = F.Lib.Get(S(a, "id"));
                if (t != null) Process.Start("explorer.exe", $"/select,\"{t.Path}\"");
                return true;
            }
            case "app.fullscreen": F.SetFullscreen(B(a, "on")); return true;
            case "app.caption": F.SetCaptionColor(S(a, "color")); return true;
            case "app.windowFx": F.SetWindowFx(S(a, "fx")); return F.WindowFx;
            case "app.window": return F.WindowAction(S(a, "action"));
            case "app.gameMode": F.GameMode = B(a, "on"); F.ApplyMemoryMode(); return true;
            case "app.closeToTray": F.CloseToTray = B(a, "on"); return true;
            case "app.nowPlaying": F.SetTrayText(S(a, "text")); return true;
            case "app.trim": F.TrimMemory(); return true;
            case "app.memory": return F.MemoryReport();
            case "app.exit": F.ExitApp(); return true;
            case "app.devtools": if (W.Settings.AreDevToolsEnabled) W.OpenDevToolsWindow(); return W.Settings.AreDevToolsEnabled;
        }
        throw new Exception("Comando desconocido: " + cmd);
    }

    async Task ScanAndClassify()
    {
        await F.Lib.Scan();
        F.Genres.ClassifyAll();
        Emit("library", F.Lib.All());
    }
}
