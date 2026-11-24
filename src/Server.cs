using System.Net;

namespace Sonora;

/// <summary>
/// Servidor HTTP local (solo localhost). Sirve la interfaz, el audio por streaming con soporte de rangos
/// (los archivos nunca se cargan completos en RAM), las portadas y las imágenes en caché.
/// Todo bajo el mismo origen, así Web Audio puede procesar el sonido sin restricciones CORS.
///
/// Seguridad: escuchar en localhost no basta, porque cualquier página abierta en un navegador
/// (o en otro puerto de localhost) puede pedir http://localhost:47800/... Por eso cada petición debe:
///   1. Traer la cookie de sesión con un token aleatorio de 256 bits que cambia en cada arranque
///      (HttpOnly + SameSite=Strict; la pone el propio host en WebView2, nunca viaja en una URL).
///   2. Venir del mismo origen (Sec-Fetch-Site) y con Host = localhost:puerto (anti DNS rebinding).
///   3. Ser GET o HEAD.
/// Además todas las respuestas llevan cabeceras de seguridad (CSP, nosniff, CORP, sin framing).
/// </summary>
public class Server
{
    HttpListener http;
    readonly Library lib;
    readonly string ui;
    public int Port;
    public string BaseUrl => $"http://localhost:{Port}/";
    public const string CookieName = "sonora_sid";
    public readonly string Token = Secrets.NewToken();

    const string Csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
                       "media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; manifest-src 'self'; " +
                       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

    static readonly Dictionary<string, string> Mimes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8", [".js"] = "text/javascript; charset=utf-8", [".css"] = "text/css; charset=utf-8",
        [".json"] = "application/json", [".svg"] = "image/svg+xml", [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg",
        [".webp"] = "image/webp", [".woff2"] = "font/woff2", [".ico"] = "image/x-icon",
        [".flac"] = "audio/flac", [".mp3"] = "audio/mpeg", [".m4a"] = "audio/mp4", [".aac"] = "audio/aac", [".wav"] = "audio/wav",
        [".ogg"] = "audio/ogg", [".oga"] = "audio/ogg", [".opus"] = "audio/ogg", [".webm"] = "audio/webm", [".mka"] = "audio/webm",
    };

    public Server(Library lib)
    {
        this.lib = lib;
        // En desarrollo se sirve directamente la carpeta ui del proyecto (editar + F5)
        var dev = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "ui"));
        ui = Path.GetFullPath(Directory.Exists(dev) ? dev : Path.Combine(AppContext.BaseDirectory, "ui"));
        if (!ui.EndsWith(Path.DirectorySeparatorChar)) ui += Path.DirectorySeparatorChar;
    }

    public void Start()
    {
        for (int p = 47800; p < 47850; p++)
        {
            try
            {
                var h = new HttpListener();
                h.Prefixes.Add($"http://localhost:{p}/");
                h.Start();
                http = h; Port = p;
                break;
            }
            catch (HttpListenerException) { }
        }
        if (http == null) throw new Exception("No se pudo abrir un puerto local");
        _ = Loop();
    }

    public void Stop() { try { http?.Stop(); } catch { } }

    async Task Loop()
    {
        while (http.IsListening)
        {
            HttpListenerContext c;
            try { c = await http.GetContextAsync(); }
            catch { break; }
            _ = Task.Run(() => Handle(c));
        }
    }

    static Dictionary<string, string> Query(Uri u)
    {
        var d = new Dictionary<string, string>();
        foreach (var part in u.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var i = part.IndexOf('=');
            if (i < 0) d[Uri.UnescapeDataString(part)] = "";
            else d[Uri.UnescapeDataString(part[..i])] = Uri.UnescapeDataString(part[(i + 1)..].Replace('+', ' '));
        }
        return d;
    }

    /// <summary>¿La petición viene de la interfaz de Sonora? Si no, se rechaza sin decir por qué.</summary>
    bool Allowed(HttpListenerRequest q)
    {
        if (q.HttpMethod is not ("GET" or "HEAD")) return false;
        if (!string.Equals(q.Headers["Host"], $"localhost:{Port}", StringComparison.OrdinalIgnoreCase)) return false;
        var site = q.Headers["Sec-Fetch-Site"];
        if (site != null && site is not ("same-origin" or "none")) return false;
        return Secrets.SafeEquals(q.Cookies[CookieName]?.Value, Token);
    }

    static void SecurityHeaders(HttpListenerResponse r)
    {
        r.AddHeader("X-Content-Type-Options", "nosniff");
        r.AddHeader("Referrer-Policy", "no-referrer");
        r.AddHeader("Cross-Origin-Resource-Policy", "same-origin");
        r.AddHeader("Cross-Origin-Opener-Policy", "same-origin");
        r.AddHeader("X-Frame-Options", "DENY");
        r.AddHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
        r.AddHeader("Content-Security-Policy", Csp);
    }

    async Task Handle(HttpListenerContext c)
    {
        var res = c.Response;
        try
        {
            SecurityHeaders(res);
            if (!Allowed(c.Request)) { res.StatusCode = 403; res.Close(); return; }
            var path = Uri.UnescapeDataString(c.Request.Url.AbsolutePath);
            if (path == "/") path = "/index.html";

            if (path.StartsWith("/media/"))
            {
                var t = lib.Get(path[7..]);
                if (t == null || !File.Exists(t.Path)) { NotFound(res); return; }
                if (t.Pcm) { WavStream.Serve(c, t.Path); return; } // DSD / ALAC: WAV decodificado al vuelo
                res.AddHeader("Cache-Control", "no-store");
                ServeFile(c, t.Path, Mimes.GetValueOrDefault(Path.GetExtension(t.Path), "application/octet-stream"));
                return;
            }
            if (path.StartsWith("/cover/"))
            {
                var parts = path.Split('/');
                if (parts.Length < 3 || !Hash.IsId(parts[2])) { NotFound(res); return; }
                var f = Covers.PathFor(parts[2], parts.Length > 3 ? parts[3] : "s");
                if (!File.Exists(f)) { NotFound(res); return; }
                res.AddHeader("Cache-Control", "max-age=604800");
                ServeFile(c, f, "image/jpeg");
                return;
            }
            if (path == "/img")
            {
                var q = Query(c.Request.Url);
                int.TryParse(q.GetValueOrDefault("w"), out var w);
                var f = await ImageCache.Get(q.GetValueOrDefault("u"), w);
                if (f == null) { NotFound(res); return; }
                res.AddHeader("Cache-Control", "max-age=2592000");
                ServeFile(c, f, Img.MimeOf(f));
                return;
            }

            var full = Path.GetFullPath(Path.Combine(ui, path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
            if (!full.StartsWith(ui, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) { NotFound(res); return; }
            res.AddHeader("Cache-Control", "no-cache");
            ServeFile(c, full, Mimes.GetValueOrDefault(Path.GetExtension(full), "application/octet-stream"));
        }
        catch
        {
            try { res.Abort(); } catch { }
        }
    }

    static void NotFound(HttpListenerResponse r) { r.StatusCode = 404; r.Close(); }

    static void ServeFile(HttpListenerContext c, string path, string ctype)
    {
        var res = c.Response;
        long len = new FileInfo(path).Length, start = 0, end = len - 1;
        res.ContentType = ctype;
        res.AddHeader("Accept-Ranges", "bytes");
        var range = c.Request.Headers["Range"];
        if (!string.IsNullOrEmpty(range) && range.StartsWith("bytes="))
        {
            var r = range[6..].Split(',')[0].Split('-');
            if (r[0].Length == 0) { if (long.TryParse(r[1], out var n)) start = Math.Max(0, len - n); }
            else
            {
                long.TryParse(r[0], out start);
                if (r.Length > 1 && long.TryParse(r[1], out var e)) end = Math.Min(len - 1, e);
            }
            if (start >= len || start > end)
            {
                res.StatusCode = 416; res.AddHeader("Content-Range", $"bytes */{len}"); res.Close(); return;
            }
            res.StatusCode = 206;
            res.AddHeader("Content-Range", $"bytes {start}-{end}/{len}");
        }
        long count = end - start + 1;
        res.ContentLength64 = count;
        if (c.Request.HttpMethod == "HEAD") { res.Close(); return; }
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, FileOptions.SequentialScan);
            fs.Seek(start, SeekOrigin.Begin);
            var buf = new byte[64 * 1024];
            var o = res.OutputStream;
            while (count > 0)
            {
                int n = fs.Read(buf, 0, (int)Math.Min(buf.Length, count));
                if (n <= 0) break;
                o.Write(buf, 0, n);
                count -= n;
            }
            res.Close();
        }
        catch { try { res.Abort(); } catch { } } // el reproductor canceló la petición (normal al buscar)
    }
}
