using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Sonora;

public class ArtistInfo
{
    public string Name, Image, Thumb, Banner, Logo, Bio, BioSource, Country, Formed, Genre, Style, Mood, Url;
    public List<string> Fanarts = new();
    public List<string> Tags = new();
    public List<string> Similar = new();
    public long Listeners, Playcount, UserPlaycount, Fans;
    public long Fetched;
}

public class AlbumInfo
{
    public string Description, Source, Label, Released, Style, Mood, CoverHQ;
    public List<string> Tags = new();
    public long Listeners, Playcount;
    public long Fetched;
}

/// <summary>Metadatos externos: fotos HD (TheAudioDB, Deezer), biografías y etiquetas (Last.fm / TheAudioDB).</summary>
public class Meta
{
    public static readonly HttpClient Http = CreateHttp();
    static HttpClient CreateHttp()
    {
        var sockets = new SocketsHttpHandler
        {
            AutomaticDecompression = DecompressionMethods.All,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            MaxConnectionsPerServer = 4,
            MaxAutomaticRedirections = 5,          // .NET nunca sigue una redirección de https a http
            ConnectCallback = NetGuard.ConnectPublic, // nada de IPs locales/privadas, ni vía DNS
        };
        var h = new HttpClient(new HttpsOnlyHandler(sockets)) { Timeout = TimeSpan.FromSeconds(20) };
        h.DefaultRequestHeaders.UserAgent.ParseAdd("Sonora/1.0 (reproductor de escritorio)");
        return h;
    }

    // Clave de TheAudioDB: "123" es la clave pública de pruebas que la propia API documenta.
    // Si tienes una clave Patreon propia, ponla en la variable de entorno SONORA_AUDIODB_KEY
    // (nunca en el código ni en el repositorio).
    public readonly string AudioDbKey = Uri.EscapeDataString(Environment.GetEnvironmentVariable("SONORA_AUDIODB_KEY") is { Length: > 0 } k ? k.Trim() : "123");
    readonly LastFm fm;
    readonly Dictionary<string, ArtistInfo> artists;
    readonly Dictionary<string, AlbumInfo> albums;
    readonly Debouncer saveArtists, saveAlbums;
    readonly SemaphoreSlim gate = new(2, 2);
    readonly Dictionary<string, Task<ArtistInfo>> inflight = new();

    public Meta(LastFm fm)
    {
        this.fm = fm;
        artists = Json.Load<Dictionary<string, ArtistInfo>>(Paths.Of("meta-artists.json"));
        albums = Json.Load<Dictionary<string, AlbumInfo>>(Paths.Of("meta-albums.json"));
        saveArtists = new Debouncer(() => { lock (artists) Json.Save(Paths.Of("meta-artists.json"), artists); });
        saveAlbums = new Debouncer(() => { lock (albums) Json.Save(Paths.Of("meta-albums.json"), albums); });
    }

    static long Now => DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    public ArtistInfo Cached(string name) { lock (artists) return artists.TryGetValue(Key(name), out var a) ? a : null; }

    static string Key(string s) => (s ?? "").Trim().ToLowerInvariant();

    public Task<ArtistInfo> Artist(string name, bool force = false)
    {
        var k = Key(name);
        lock (artists)
        {
            if (!force && artists.TryGetValue(k, out var c) && Now - c.Fetched < 60L * 86400) return Task.FromResult(c);
            if (inflight.TryGetValue(k, out var running)) return running;
            var t = FetchArtist(name, k);
            inflight[k] = t;
            return t;
        }
    }

    async Task<ArtistInfo> FetchArtist(string name, string k)
    {
        await gate.WaitAsync();
        try
        {
            var info = new ArtistInfo { Name = name };
            var adb = AudioDbArtist(name);
            var dz = DeezerArtist(name);
            var lf = LastFmArtist(name);
            await Task.WhenAll(Swallow(adb), Swallow(dz), Swallow(lf));

            var a = adb.IsCompletedSuccessfully ? adb.Result : null;
            var d = dz.IsCompletedSuccessfully ? dz.Result : null;
            var l = lf.IsCompletedSuccessfully ? lf.Result : null;

            if (a != null)
            {
                info.Image = a.Image; info.Thumb = a.Thumb; info.Banner = a.Banner; info.Logo = a.Logo;
                info.Fanarts = a.Fanarts; info.Country = a.Country; info.Formed = a.Formed;
                info.Genre = a.Genre; info.Style = a.Style; info.Mood = a.Mood;
                if (!string.IsNullOrWhiteSpace(a.Bio)) { info.Bio = a.Bio; info.BioSource = a.BioSource; }
            }
            if (d != null)
            {
                // Deezer da retratos cuadrados 1000x1000 muy consistentes
                info.Image ??= d.Image; info.Thumb = d.Thumb ?? info.Thumb; info.Fans = d.Fans;
                if (string.IsNullOrEmpty(info.Image)) info.Image = d.Image;
            }
            if (l != null)
            {
                info.Tags = l.Tags; info.Similar = l.Similar; info.Listeners = l.Listeners; info.Playcount = l.Playcount;
                info.UserPlaycount = l.UserPlaycount; info.Url = l.Url;
                // Preferimos la bio en español; si TheAudioDB no la tiene en ES usamos Last.fm
                if (l.BioSource == "Last.fm (es)" || string.IsNullOrWhiteSpace(info.Bio)) { if (!string.IsNullOrWhiteSpace(l.Bio)) { info.Bio = l.Bio; info.BioSource = l.BioSource; } }
            }
            info.Thumb ??= info.Image;
            info.Fetched = Now;
            lock (artists) artists[k] = info;
            saveArtists.Poke();
            return info;
        }
        finally
        {
            gate.Release();
            lock (artists) inflight.Remove(k);
        }
    }

    static async Task Swallow(Task t) { try { await t; } catch { } }

    static async Task<JsonElement?> GetJson(string url)
    {
        using var r = await Http.GetAsync(url);
        if (!r.IsSuccessStatusCode) return null;
        var s = await r.Content.ReadAsStringAsync();
        if (string.IsNullOrWhiteSpace(s)) return null;
        using var doc = JsonDocument.Parse(s);
        return doc.RootElement.Clone();
    }

    static string Str(JsonElement e, string p) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString()) ? v.GetString().Trim() : null;

    static bool SameName(string a, string b)
    {
        static string N(string s) => Regex.Replace((s ?? "").ToLowerInvariant(), @"[^\p{L}\p{N}]", "");
        var x = N(a); var y = N(b);
        return x.Length > 0 && (x == y || (x.Length > 3 && (x.Contains(y) || y.Contains(x))));
    }

    async Task<ArtistInfo> AudioDbArtist(string name)
    {
        var j = await GetJson($"https://www.theaudiodb.com/api/v1/json/{AudioDbKey}/search.php?s={Uri.EscapeDataString(name)}");
        if (j == null || !j.Value.TryGetProperty("artists", out var arr) || arr.ValueKind != JsonValueKind.Array) return null;
        var a = arr.EnumerateArray().FirstOrDefault(x => SameName(Str(x, "strArtist"), name));
        if (a.ValueKind != JsonValueKind.Object) return null;
        var i = new ArtistInfo
        {
            Image = Str(a, "strArtistThumb"), Banner = Str(a, "strArtistBanner"), Logo = Str(a, "strArtistLogo"),
            Country = Str(a, "strCountry"), Formed = Str(a, "intFormedYear") ?? Str(a, "intBornYear"),
            Genre = Str(a, "strGenre"), Style = Str(a, "strStyle"), Mood = Str(a, "strMood"),
        };
        if (i.Image != null) i.Thumb = i.Image + "/preview";
        foreach (var f in new[] { "strArtistFanart", "strArtistFanart2", "strArtistFanart3", "strArtistFanart4", "strArtistWideThumb" })
            if (Str(a, f) is string u) i.Fanarts.Add(u);
        var es = Str(a, "strBiographyES");
        if (es != null) { i.Bio = es; i.BioSource = "TheAudioDB (es)"; }
        else if (Str(a, "strBiographyEN") is string en) { i.Bio = en; i.BioSource = "TheAudioDB (en)"; }
        return i;
    }

    static async Task<ArtistInfo> DeezerArtist(string name)
    {
        var j = await GetJson($"https://api.deezer.com/search/artist?q={Uri.EscapeDataString(name)}&limit=5");
        if (j == null || !j.Value.TryGetProperty("data", out var arr) || arr.ValueKind != JsonValueKind.Array) return null;
        var a = arr.EnumerateArray().FirstOrDefault(x => SameName(Str(x, "name"), name));
        if (a.ValueKind != JsonValueKind.Object) return null;
        var img = Str(a, "picture_xl");
        if (img == null || img.Contains("/artist//")) return null; // sin foto real
        return new ArtistInfo
        {
            Image = img, Thumb = Str(a, "picture_big"),
            Fans = a.TryGetProperty("nb_fan", out var f) && f.ValueKind == JsonValueKind.Number ? f.GetInt64() : 0,
        };
    }

    static readonly Regex Html = new(@"<[^>]+>", RegexOptions.Compiled);
    static readonly Regex ReadMore = new(@"\s*<a href=""https?://www\.last\.fm[^""]*"">.*?</a>\.?\s*", RegexOptions.Compiled | RegexOptions.Singleline);

    static string CleanBio(string s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = ReadMore.Replace(s, "");
        s = WebUtility.HtmlDecode(Html.Replace(s, "")).Trim();
        if (s.StartsWith("User-contributed text is available")) return null;
        return s.Length < 20 ? null : s;
    }

    async Task<ArtistInfo> LastFmArtist(string name)
    {
        if (!fm.HasKey) return null;
        var args = new Dictionary<string, string> { ["artist"] = name, ["autocorrect"] = "1", ["lang"] = "es" };
        if (!string.IsNullOrEmpty(fm.C.User)) args["username"] = fm.C.User;
        var r = await fm.Call("artist.getInfo", args);
        if (!r.TryGetProperty("artist", out var a)) return null;
        var i = new ArtistInfo { Url = Str(a, "url") };
        if (a.TryGetProperty("stats", out var st))
        {
            long.TryParse(Str(st, "listeners"), out i.Listeners);
            long.TryParse(Str(st, "playcount"), out i.Playcount);
            long.TryParse(Str(st, "userplaycount"), out i.UserPlaycount);
        }
        if (a.TryGetProperty("tags", out var tg) && tg.TryGetProperty("tag", out var ta) && ta.ValueKind == JsonValueKind.Array)
            i.Tags = ta.EnumerateArray().Select(x => Str(x, "name")).Where(x => x != null).ToList();
        if (a.TryGetProperty("similar", out var sm) && sm.TryGetProperty("artist", out var sa) && sa.ValueKind == JsonValueKind.Array)
            i.Similar = sa.EnumerateArray().Select(x => Str(x, "name")).Where(x => x != null).ToList();
        if (a.TryGetProperty("bio", out var bio))
        {
            i.Bio = CleanBio(Str(bio, "content"));
            if (i.Bio != null) i.BioSource = "Last.fm (es)";
        }
        if (i.Bio == null)
        {
            try
            {
                args.Remove("lang");
                var en = await fm.Call("artist.getInfo", args);
                if (en.TryGetProperty("artist", out var ea) && ea.TryGetProperty("bio", out var eb))
                {
                    i.Bio = CleanBio(Str(eb, "content"));
                    if (i.Bio != null) i.BioSource = "Last.fm (en)";
                }
            }
            catch { }
        }
        return i;
    }

    public async Task<AlbumInfo> Album(string artist, string album)
    {
        var k = Key(artist) + "|" + Key(album);
        lock (albums) if (albums.TryGetValue(k, out var c) && Now - c.Fetched < 60L * 86400) return c;
        var info = new AlbumInfo();
        try
        {
            var j = await GetJson($"https://www.theaudiodb.com/api/v1/json/{AudioDbKey}/searchalbum.php?s={Uri.EscapeDataString(artist)}&a={Uri.EscapeDataString(album)}");
            if (j != null && j.Value.TryGetProperty("album", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                var a = arr.EnumerateArray().FirstOrDefault();
                if (a.ValueKind == JsonValueKind.Object)
                {
                    info.Label = Str(a, "strLabel"); info.Released = Str(a, "intYearReleased");
                    info.Style = Str(a, "strStyle"); info.Mood = Str(a, "strMood");
                    info.CoverHQ = Str(a, "strAlbumThumbHQ") ?? Str(a, "strAlbumThumb");
                    var d = Str(a, "strDescriptionES");
                    if (d != null) { info.Description = d; info.Source = "TheAudioDB (es)"; }
                    else if (Str(a, "strDescriptionEN") is string en) { info.Description = en; info.Source = "TheAudioDB (en)"; }
                }
            }
        }
        catch { }
        if (fm.HasKey)
        {
            try
            {
                var r = await fm.Call("album.getInfo", new() { ["artist"] = artist, ["album"] = album, ["autocorrect"] = "1", ["lang"] = "es" });
                if (r.TryGetProperty("album", out var a))
                {
                    long.TryParse(Str(a, "listeners"), out info.Listeners);
                    long.TryParse(Str(a, "playcount"), out info.Playcount);
                    if (a.TryGetProperty("tags", out var tg) && tg.ValueKind == JsonValueKind.Object && tg.TryGetProperty("tag", out var ta) && ta.ValueKind == JsonValueKind.Array)
                        info.Tags = ta.EnumerateArray().Select(x => Str(x, "name")).Where(x => x != null).ToList();
                    if (info.Description == null && a.TryGetProperty("wiki", out var w))
                    {
                        info.Description = CleanBio(Str(w, "content"));
                        if (info.Description != null) info.Source = "Last.fm";
                    }
                }
            }
            catch { }
        }
        info.Fetched = Now;
        lock (albums) albums[k] = info;
        saveAlbums.Poke();
        return info;
    }
}

/// <summary>Descarga y guarda en disco las imágenes remotas (opcionalmente redimensionadas) para no repetir descargas.</summary>
public static class ImageCache
{
    static readonly Dictionary<string, Task<string>> inflight = new();

    public static Task<string> Get(string url, int w)
    {
        var safe = NetGuard.ToHttps(url); // solo https y solo hosts públicos
        if (safe == null) return Task.FromResult<string>(null);
        url = safe.AbsoluteUri;
        w = w <= 0 ? 0 : Math.Clamp((w + 99) / 100 * 100, 100, 2400); // agrupa tamaños
        var id = Hash.Id(url + "|" + w);
        var file = Path.Combine(Paths.Images, id + ".img");
        if (File.Exists(file)) return Task.FromResult(file);
        lock (inflight)
        {
            if (inflight.TryGetValue(id, out var t)) return t;
            t = Fetch(url, w, file, id);
            inflight[id] = t;
            return t;
        }
    }

    static async Task<string> Fetch(string url, int w, string file, string id)
    {
        try
        {
            using var r = await Meta.Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            if (!r.IsSuccessStatusCode) return null;
            if (r.Content.Headers.ContentLength > 30_000_000) return null;
            var type = r.Content.Headers.ContentType?.MediaType;
            if (type != null && !type.StartsWith("image/") && type != "application/octet-stream") return null; // solo imágenes
            var bytes = await r.Content.ReadAsByteArrayAsync();
            if (Img.MimeOf((ReadOnlySpan<byte>)bytes) == null) return null; // comprobación por firma real del archivo
            if (bytes.Length < 100 || bytes.Length > 30_000_000) return null;
            if (w > 0) await Task.Run(() => Img.SaveResized(bytes, file, w, 90));
            else await File.WriteAllBytesAsync(file, bytes);
            return file;
        }
        catch { return null; }
        finally { lock (inflight) inflight.Remove(id); }
    }
}
