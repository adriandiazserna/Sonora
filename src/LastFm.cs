using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Sonora;

/// <summary>
/// Configuración de Last.fm. En disco (lastfm.json) la API key, el shared secret y la clave de sesión
/// van cifrados con DPAPI (<see cref="Secrets"/>); en memoria se usan descifrados.
/// Sonora nunca ve ni guarda la contraseña de Last.fm: la autorización se hace en el navegador.
/// </summary>
public class LastFmConfig
{
    public string User;
    public string KeyEnc, SecretEnc, SessionEnc;
    public List<ScrobbleItem> Queue = new();

    [JsonIgnore] public string Key, Secret, Session;

    // Formato antiguo (texto plano): solo se lee para migrarlo y luego se borra del archivo
    [JsonPropertyName("key")] public string OldKey;
    [JsonPropertyName("secret")] public string OldSecret;
    [JsonPropertyName("session")] public string OldSession;

    /// <summary>Descifra al cargar. Devuelve true si había datos en texto plano que hay que migrar.</summary>
    public bool Unseal()
    {
        Key = Secrets.Unprotect(KeyEnc) ?? OldKey;
        Secret = Secrets.Unprotect(SecretEnc) ?? OldSecret;
        Session = Secrets.Unprotect(SessionEnc) ?? OldSession;
        return OldKey != null || OldSecret != null || OldSession != null;
    }

    public void Seal()
    {
        KeyEnc = Secrets.Protect(Key); SecretEnc = Secrets.Protect(Secret); SessionEnc = Secrets.Protect(Session);
        OldKey = OldSecret = OldSession = null;
    }
}

public class ScrobbleItem
{
    public string Artist, Track, Album;
    public long Ts;
    public int Dur;
}

public class LastFmException : Exception
{
    public int Code;
    public LastFmException(int code, string msg) : base(msg) { Code = code; }
}

/// <summary>Cliente de la API de Last.fm: autenticación de escritorio, scrobbling con cola offline, etiquetas e info.</summary>
public class LastFm
{
    const string Api = "https://ws.audioscrobbler.com/2.0/";
    public LastFmConfig C;
    string pendingToken;
    readonly SemaphoreSlim flushGate = new(1, 1);
    readonly SemaphoreSlim rate = new(1, 1);
    DateTime lastCall = DateTime.MinValue;

    public LastFm()
    {
        C = Json.Load<LastFmConfig>(Paths.Of("lastfm.json"));
        if (C.Unseal()) Save(); // migra un lastfm.json antiguo en texto plano a cifrado
    }

    public bool HasKey => !string.IsNullOrEmpty(C.Key);
    public bool Connected => HasKey && !string.IsNullOrEmpty(C.Session) && !string.IsNullOrEmpty(C.Secret);

    // La interfaz solo recibe la key enmascarada; el secret y la sesión nunca salen del núcleo .NET
    public object Status() { lock (C) return new { hasKey = HasKey, hasSecret = !string.IsNullOrEmpty(C.Secret), keyHint = Secrets.Mask(C.Key), user = C.User, connected = Connected, queued = C.Queue.Count }; }

    void Save() { lock (C) { C.Seal(); Json.Save(Paths.Of("lastfm.json"), C); } }

    public void Configure(string key, string secret)
    {
        lock (C)
        {
            // Campo vacío = conservar lo guardado (la interfaz ya no recibe la key completa)
            key = string.IsNullOrWhiteSpace(key) ? C.Key : key.Trim();
            if (key != null && !Regex.IsMatch(key, "^[0-9a-fA-F]{32}$")) throw new Exception("La API key de Last.fm debe tener 32 caracteres hexadecimales");
            if (!string.IsNullOrWhiteSpace(secret) && !Regex.IsMatch(secret.Trim(), "^[0-9a-fA-F]{32}$")) throw new Exception("El shared secret debe tener 32 caracteres hexadecimales");
            if (key != C.Key) { C.Session = null; C.User = null; }
            C.Key = key;
            if (!string.IsNullOrWhiteSpace(secret)) C.Secret = secret.Trim();
        }
        Save();
    }

    public void Logout() { lock (C) { C.Session = null; C.User = null; } Save(); }

    /// <summary>Borra la key, el secret y la sesión de este equipo.</summary>
    public void Forget() { lock (C) { C.Key = C.Secret = C.Session = C.User = null; } pendingToken = null; Save(); }

    string Sign(SortedDictionary<string, string> p)
    {
        var sb = new StringBuilder();
        foreach (var kv in p)
            if (kv.Key != "format" && kv.Key != "callback") sb.Append(kv.Key).Append(kv.Value);
        sb.Append(C.Secret);
        // MD5 lo exige el protocolo de firmas de Last.fm (api_sig); no se usa para guardar nada.
        return Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(sb.ToString()))).ToLowerInvariant();
    }

    public async Task<JsonElement> Call(string method, Dictionary<string, string> args = null, bool signed = false, bool post = false)
    {
        if (!HasKey) throw new LastFmException(10, "Falta la API key de Last.fm");
        var p = new SortedDictionary<string, string>(StringComparer.Ordinal) { ["method"] = method, ["api_key"] = C.Key };
        if (args != null) foreach (var kv in args) if (!string.IsNullOrEmpty(kv.Value)) p[kv.Key] = kv.Value;
        if (signed)
        {
            if (method != "auth.getToken" && method != "auth.getSession" && !string.IsNullOrEmpty(C.Session)) p["sk"] = C.Session;
            p["api_sig"] = Sign(p);
        }
        p["format"] = "json";

        // Límite amable: ~4 peticiones por segundo
        await rate.WaitAsync();
        try
        {
            var wait = 250 - (int)(DateTime.UtcNow - lastCall).TotalMilliseconds;
            if (wait > 0) await Task.Delay(wait);
            lastCall = DateTime.UtcNow;
        }
        finally { rate.Release(); }

        using var r = post
            ? await Meta.Http.PostAsync(Api, new FormUrlEncodedContent(p))
            : await Meta.Http.GetAsync(Api + "?" + string.Join("&", p.Select(kv => kv.Key + "=" + Uri.EscapeDataString(kv.Value))));
        var s = await r.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(s);
        var root = doc.RootElement.Clone();
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("error", out var e))
        {
            var code = e.ValueKind == JsonValueKind.Number ? e.GetInt32() : 0;
            if (code == 9) Logout(); // sesión inválida
            throw new LastFmException(code, root.TryGetProperty("message", out var m) ? m.GetString() : "Error de Last.fm");
        }
        return root;
    }

    public async Task<string> BeginAuth(string browser = null)
    {
        if (string.IsNullOrEmpty(C.Secret)) throw new Exception("Falta el 'shared secret' de Last.fm");
        var r = await Call("auth.getToken", null, signed: true);
        pendingToken = r.GetProperty("token").GetString();
        var url = $"https://www.last.fm/api/auth/?api_key={C.Key}&token={pendingToken}";
        Browsers.Open(url, browser);
        return url;
    }

    public async Task FinishAuth()
    {
        if (pendingToken == null) throw new Exception("Primero pulsa «Conectar»");
        var r = await Call("auth.getSession", new() { ["token"] = pendingToken }, signed: true);
        var s = r.GetProperty("session");
        lock (C) { C.Session = s.GetProperty("key").GetString(); C.User = s.GetProperty("name").GetString(); }
        pendingToken = null;
        Save();
        _ = Flush();
    }

    public async Task NowPlaying(string artist, string track, string album, int dur)
    {
        if (!Connected) return;
        try
        {
            await Call("track.updateNowPlaying", new() { ["artist"] = artist, ["track"] = track, ["album"] = album, ["duration"] = dur > 0 ? dur.ToString() : null }, true, true);
        }
        catch { }
    }

    public Task Scrobble(ScrobbleItem it)
    {
        lock (C) { C.Queue.Add(it); if (C.Queue.Count > 5000) C.Queue.RemoveAt(0); }
        Save();
        return Flush();
    }

    /// <summary>Envía la cola pendiente (en lotes de 50). Si no hay red, queda guardada.</summary>
    public async Task Flush()
    {
        if (!Connected) return;
        if (!await flushGate.WaitAsync(0)) return;
        try
        {
            while (true)
            {
                List<ScrobbleItem> batch;
                lock (C) batch = C.Queue.Take(50).ToList();
                if (batch.Count == 0) break;
                var a = new Dictionary<string, string>();
                for (int i = 0; i < batch.Count; i++)
                {
                    a[$"artist[{i}]"] = batch[i].Artist; a[$"track[{i}]"] = batch[i].Track;
                    a[$"timestamp[{i}]"] = batch[i].Ts.ToString();
                    if (!string.IsNullOrEmpty(batch[i].Album)) a[$"album[{i}]"] = batch[i].Album;
                    if (batch[i].Dur > 0) a[$"duration[{i}]"] = batch[i].Dur.ToString();
                }
                try { await Call("track.scrobble", a, true, true); }
                catch (LastFmException ex) when (ex.Code is 6 or 7 or 13) { /* datos inválidos: se descartan */ }
                lock (C) C.Queue.RemoveRange(0, Math.Min(batch.Count, C.Queue.Count));
                Save();
            }
        }
        catch { /* sin conexión: se reintenta en el próximo scrobble */ }
        finally { flushGate.Release(); }
    }

    public async Task Love(string artist, string track, bool love)
    {
        if (!Connected) throw new Exception("Conecta tu cuenta de Last.fm");
        await Call(love ? "track.love" : "track.unlove", new() { ["artist"] = artist, ["track"] = track }, true, true);
    }

    public async Task<object> Profile()
    {
        if (!Connected) return null;
        var u = C.User;
        var info = Call("user.getInfo", new() { ["user"] = u });
        var top = Call("user.getTopArtists", new() { ["user"] = u, ["period"] = "1month", ["limit"] = "10" });
        var tags = Call("user.getTopTags", new() { ["user"] = u, ["limit"] = "15" });
        var recent = Call("user.getRecentTracks", new() { ["user"] = u, ["limit"] = "12" });
        return new
        {
            info = await Safe(info), top = await Safe(top), tags = await Safe(tags), recent = await Safe(recent),
        };
    }

    static async Task<JsonElement?> Safe(Task<JsonElement> t) { try { return await t; } catch { return null; } }

    /// <summary>Etiquetas ponderadas (nombre, peso 0-100).</summary>
    public async Task<List<GenreTag>> TopTags(string method, Dictionary<string, string> args)
    {
        var res = new List<GenreTag>();
        try
        {
            args["autocorrect"] = "1";
            var r = await Call(method, args);
            if (r.TryGetProperty("toptags", out var tt) && tt.TryGetProperty("tag", out var arr) && arr.ValueKind == JsonValueKind.Array)
                foreach (var t in arr.EnumerateArray().Take(15))
                {
                    var name = t.GetProperty("name").GetString();
                    double c = 0;
                    if (t.TryGetProperty("count", out var cv))
                        c = cv.ValueKind == JsonValueKind.Number ? cv.GetDouble() : double.TryParse(cv.GetString(), out var d) ? d : 0;
                    if (c > 0) res.Add(new GenreTag { N = name, C = c });
                }
        }
        catch (LastFmException ex) when (ex.Code == 6) { /* no encontrado */ }
        return res;
    }
}
