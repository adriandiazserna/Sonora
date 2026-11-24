using System.Collections.Concurrent;

namespace Sonora;

public class Track
{
    public string Id, Path, Ext, Codec;
    public string Title, Artist, AlbumArtist, Album, Genre, Composer;
    public int Year, TrackNo, DiscNo, Bitrate, SampleRate, BitDepth, Channels;
    public double Duration, Bpm;
    public double? RgTrack, RgAlbum;
    public string CoverId;
    public bool Playable, Lrc;
    public bool Pcm; // se sirve decodificado como WAV (DSD, ALAC)
    public long Mtime, Size, Added;
    // Resultado del motor de géneros
    public string MainGenre, SubGenre;
    public double GenreConf;
    public List<string> GenreTags;
    // Análisis para el DJ (BPM, rejilla, tonalidad, energía)
    public DjInfo Dj;
}

public class LibraryData
{
    public List<string> Folders = new();
    public Dictionary<string, Track> Tracks = new();
}

public class Library
{
    static readonly HashSet<string> Exts = new(StringComparer.OrdinalIgnoreCase)
        { ".flac", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".webm", ".dsf", ".dff", ".aiff", ".aif", ".ape", ".wv", ".wma", ".mka" };
    // Formatos que el motor (Chromium) decodifica de forma nativa
    static readonly HashSet<string> Native = new(StringComparer.OrdinalIgnoreCase)
        { ".flac", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".webm", ".mka" };
    static readonly string[] CoverNames = { "cover", "folder", "front", "album", "albumart", "albumartsmall", "portada", "caratula", "carátula" };
    static readonly string[] ImgExts = { ".jpg", ".jpeg", ".png", ".webp" };

    public LibraryData D;
    readonly string file = Paths.Of("library.json");
    readonly Debouncer saver;
    public bool Scanning { get; private set; }
    public event Action<int, int, string> Progress;

    public Library()
    {
        D = Json.Load<LibraryData>(file);
        foreach (var t in D.Tracks.Values) SetPlayable(t); // las pistas guardadas antes de soportar DSD/ALAC
        if (D.Folders.Count == 0)
        {
            var m = Environment.GetFolderPath(Environment.SpecialFolder.MyMusic);
            if (Directory.Exists(m)) D.Folders.Add(m);
        }
        saver = new Debouncer(Save, 2000);
    }

    public void Save() { lock (D) Json.Save(file, D); }
    public void SaveLater() => saver.Poke();

    public Track Get(string id) { lock (D) return D.Tracks.TryGetValue(id ?? "", out var t) ? t : null; }
    public List<Track> All() { lock (D) return D.Tracks.Values.ToList(); }

    public Task Scan() => Task.Run(() =>
    {
        if (Scanning) return;
        Scanning = true;
        try { DoScan(); }
        finally { Scanning = false; }
    });

    void DoScan()
    {
        var opts = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.System };
        List<string> folders; lock (D) folders = D.Folders.ToList();
        var files = folders.Where(Directory.Exists)
            .SelectMany(f => { try { return Directory.EnumerateFiles(f, "*", opts); } catch { return Enumerable.Empty<string>(); } })
            .Where(p => Exts.Contains(System.IO.Path.GetExtension(p)))
            // Si ya se convirtió a FLAC (mismo nombre al lado), se oculta el original no reproducible
            .Where(p => Native.Contains(System.IO.Path.GetExtension(p)) || !File.Exists(System.IO.Path.ChangeExtension(p, ".flac")))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        var seen = new ConcurrentDictionary<string, bool>();
        var coverLocks = new ConcurrentDictionary<string, Lazy<bool>>();
        int done = 0, total = files.Count;
        Progress?.Invoke(0, total, null);

        Parallel.ForEach(files, new ParallelOptions { MaxDegreeOfParallelism = 3 }, p =>
        {
            var id = Hash.Id(p);
            seen[id] = true;
            var fi = new FileInfo(p);
            long mt = fi.LastWriteTimeUtc.Ticks;
            Track old; lock (D) D.Tracks.TryGetValue(id, out old);
            if (old == null || old.Mtime != mt || old.Size != fi.Length)
            {
                var t = Read(p, fi, id, coverLocks);
                if (old != null)
                {
                    t.Added = old.Added;
                    t.MainGenre = old.MainGenre; t.SubGenre = old.SubGenre; t.GenreConf = old.GenreConf; t.GenreTags = old.GenreTags;
                }
                lock (D) D.Tracks[id] = t;
            }
            int n = Interlocked.Increment(ref done);
            if (n % 20 == 0) Progress?.Invoke(n, total, System.IO.Path.GetFileName(p));
        });

        lock (D)
            foreach (var k in D.Tracks.Keys.Where(k => !seen.ContainsKey(k)).ToList())
                D.Tracks.Remove(k);
        Save();
        Progress?.Invoke(total, total, null);
    }

    Track Read(string p, FileInfo fi, string id, ConcurrentDictionary<string, Lazy<bool>> coverLocks)
    {
        var ext = fi.Extension.ToLowerInvariant();
        var dir = fi.DirectoryName ?? "";
        var t = new Track
        {
            Id = id, Path = p, Ext = ext.TrimStart('.'), Mtime = fi.LastWriteTimeUtc.Ticks, Size = fi.Length,
            Title = System.IO.Path.GetFileNameWithoutExtension(p),
            Added = new DateTimeOffset(fi.CreationTimeUtc < fi.LastWriteTimeUtc ? fi.CreationTimeUtc : fi.LastWriteTimeUtc).ToUnixTimeSeconds(),
            Lrc = File.Exists(System.IO.Path.ChangeExtension(p, ".lrc")),
        };
        byte[] embedded = null;
        try
        {
            using var f = TagLib.File.Create(p);
            var tag = f.Tag;
            if (!string.IsNullOrWhiteSpace(tag.Title)) t.Title = tag.Title.Trim();
            t.Artist = Clean(tag.JoinedPerformers);
            t.AlbumArtist = Clean(tag.JoinedAlbumArtists);
            t.Album = Clean(tag.Album);
            t.Genre = Clean(string.Join("; ", tag.Genres ?? Array.Empty<string>()));
            t.Composer = Clean(tag.JoinedComposers);
            t.Year = (int)tag.Year; t.TrackNo = (int)tag.Track; t.DiscNo = (int)tag.Disc;
            t.Bpm = tag.BeatsPerMinute;
            if (!double.IsNaN(tag.ReplayGainTrackGain)) t.RgTrack = tag.ReplayGainTrackGain;
            if (!double.IsNaN(tag.ReplayGainAlbumGain)) t.RgAlbum = tag.ReplayGainAlbumGain;

            var pr = f.Properties;
            if (pr != null)
            {
                t.Duration = pr.Duration.TotalSeconds;
                t.Bitrate = pr.AudioBitrate; t.SampleRate = pr.AudioSampleRate;
                t.BitDepth = pr.BitsPerSample; t.Channels = pr.AudioChannels;
                t.Codec = pr.Description;
            }
            var pics = tag.Pictures;
            if (pics != null && pics.Length > 0)
            {
                var pic = pics.FirstOrDefault(x => x.Type == TagLib.PictureType.FrontCover) ?? pics[0];
                embedded = pic.Data?.Data;
            }
        }
        catch { /* archivo sin etiquetas legibles */ }

        // Respaldo por carpetas: Artista\Álbum\pista
        var parent = Directory.GetParent(dir);
        t.Album ??= System.IO.Path.GetFileName(dir);
        t.Artist ??= parent != null ? parent.Name : "Desconocido";
        t.AlbumArtist ??= t.Artist;

        SetPlayable(t);

        // Portada: una por carpeta+álbum
        var cid = Hash.Id("cover:" + dir + "|" + t.Album);
        var ok = coverLocks.GetOrAdd(cid, _ => new Lazy<bool>(() => Covers.Has(cid) || MakeCover(cid, embedded, dir))).Value;
        if (!ok && embedded != null) ok = MakeCover(cid, embedded, null); // otro archivo del mismo álbum sí trae portada
        if (ok) t.CoverId = cid;
        return t;
    }

    static bool MakeCover(string cid, byte[] embedded, string dir)
    {
        if (embedded != null && embedded.Length > 100 && Covers.Save(cid, embedded)) return true;
        if (dir == null) return false;
        try
        {
            var imgs = Directory.EnumerateFiles(dir)
                .Where(f => ImgExts.Contains(System.IO.Path.GetExtension(f).ToLowerInvariant()))
                .Select(f => new FileInfo(f)).Where(f => f.Length < 25_000_000).ToList();
            if (imgs.Count == 0) return false;
            var best = imgs
                .OrderBy(f => { var n = System.IO.Path.GetFileNameWithoutExtension(f.Name).ToLowerInvariant(); int i = Array.FindIndex(CoverNames, c => n == c || n.StartsWith(c)); return i < 0 ? 99 : i; })
                .ThenByDescending(f => f.Length).First();
            return Covers.Save(cid, File.ReadAllBytes(best.FullName));
        }
        catch { return false; }
    }

    /// <summary>Chromium reproduce lo nativo tal cual; DSF y ALAC se sirven decodificados (WAV al vuelo).</summary>
    static void SetPlayable(Track t)
    {
        var ext = "." + t.Ext;
        t.Pcm = Decoders.NeedsPcm(ext, t.Codec);
        t.Playable = t.Pcm || Native.Contains(ext);
    }

    static string Clean(string s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}

public static class Covers
{
    public static string PathFor(string id, string size) => System.IO.Path.Combine(Paths.Covers, $"{id}_{(size == "l" ? "l" : "s")}.jpg");
    public static bool Has(string id) => File.Exists(PathFor(id, "s"));

    public static bool Save(string id, byte[] data)
    {
        try
        {
            Img.SaveResized(data, PathFor(id, "s"), 320, 88);   // miniatura para cuadrículas (poca RAM)
            Img.SaveResized(data, PathFor(id, "l"), 1400, 92);  // alta calidad para vista inmersiva
            return true;
        }
        catch { return false; }
    }
}
