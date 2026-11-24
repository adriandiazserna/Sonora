using System.Globalization;
using System.Text.RegularExpressions;

namespace Sonora;

public class GenreTag { public string N; public double C; }

public class GenreCache
{
    public Dictionary<string, List<GenreTag>> Artist = new();
    public Dictionary<string, List<GenreTag>> Album = new();
    public Dictionary<string, List<GenreTag>> Track = new();
}

/// <summary>
/// Clasificación meticulosa de géneros: combina las etiquetas locales del archivo, las etiquetas ponderadas
/// de Last.fm (pista, álbum y artista) y el género/estilo de TheAudioDB. Cada etiqueta se mapea a una
/// taxonomía de géneros principales; se puntúa por fuente y se elige el género principal y el subgénero.
/// </summary>
public class GenreEngine
{
    // Orden importa: reglas más específicas primero
    static readonly (string main, string[] keys)[] Rules =
    {
        ("Urbano latino", new[]{ "reggaeton","reggaetón","reguetón","regueton","perreo","dembow","latin trap","trap latino","urbano latino","latin urban","neoperreo","moombahton" }),
        ("Pop asiático", new[]{ "k-pop","kpop","j-pop","jpop","c-pop","mandopop","cantopop","city pop","anime","vocaloid","j-rock","jrock","visual kei","k-indie","k-rap" }),
        ("Ambient / Chill", new[]{ "ambient","dark ambient","drone","new age","meditation","chillout","chill out","lo-fi","lofi","lo fi","lo-fi hip hop","chillhop","sleep","relaxing" }),
        ("Pop", new[]{ "synthpop","synth-pop","synth pop","electropop","dance-pop","dance pop","art pop","hyperpop","bedroom pop","indie pop","dream pop" }),
        ("Electrónica", new[]{ "happy hardcore","hardstyle","gabber","hard dance","trip-hop","trip hop","downtempo","drum and bass","drum n bass","drum'n'bass","dnb","liquid funk","jungle","dubstep","brostep","riddim","future bass","house","deep house","tech house","progressive house","techno","minimal","trance","psytrance","psychedelic trance","goa","edm","electro","electronica","electrónica","electronic","idm","breakbeat","breaks","uk garage","2-step","synthwave","retrowave","outrun","darksynth","vaporwave","chillwave","glitch","bass music","big room","eurodance","eurobeat","electro house","dance","club","footwork","witch house","industrial techno","ebm","phonk","drift phonk" }),
        ("Metal", new[]{ "metal","heavy metal","black metal","death metal","thrash","doom","sludge","grindcore","djent","metalcore","deathcore","nu metal","nu-metal","power metal","symphonic metal","progressive metal","stoner","post-metal","mathcore" }),
        ("Hip-Hop / Rap", new[]{ "hip hop","hip-hop","hiphop","rap","trap","drill","uk drill","grime","boom bap","gangsta rap","conscious hip hop","underground hip hop","cloud rap","emo rap","crunk","g-funk","rap en español","hip hop en español","horrorcore","jazz rap" }),
        ("Punk / Emo", new[]{ "punk","pop punk","pop-punk","post-hardcore","hardcore punk","hardcore","emo","screamo","skate punk","midwest emo","emocore","crust" }),
        ("R&B / Soul", new[]{ "rnb","r&b","r'n'b","rhythm and blues","soul","neo-soul","neo soul","contemporary r&b","motown","alternative r&b","quiet storm","new jack swing" }),
        ("Jazz", new[]{ "jazz","bebop","hard bop","cool jazz","free jazz","smooth jazz","jazz fusion","fusion","swing","big band","acid jazz","nu jazz","vocal jazz","bossa nova","latin jazz","jazz funk" }),
        ("Clásica", new[]{ "classical","clásica","clasica","música clásica","baroque","barroco","romanticism","romantic era","orchestral","orchestra","symphony","symphonic","opera","ópera","chamber music","string quartet","contemporary classical","modern classical","neoclassical","neo-classical","minimalism","piano","choral","composer","impressionism" }),
        ("Bandas sonoras", new[]{ "soundtrack","original soundtrack","ost","score","film score","movie soundtrack","video game music","game music","videogame","vgm","musical","musicals","broadway","trailer music","epic music","cinematic","banda sonora","bandas sonoras" }),
        ("Reggae / Ska", new[]{ "reggae","roots reggae","dub","ska","rocksteady","dancehall","ragga","lovers rock" }),
        ("Latina", new[]{ "latin","latino","latina","latin pop","pop latino","salsa","bachata","merengue","cumbia","bolero","ranchera","mariachi","regional mexican","regional mexicano","norteño","norteno","corridos","corridos tumbados","banda","grupero","tango","flamenco","rumba","son cubano","son","vallenato","trova","nueva trova","bossa","samba","mpb","tropical","reggae en español","cuarteto","guaracha","латино","латина","латиноамериканская музыка","reggaeton latino","boleros","balada romántica" }),
        ("Blues", new[]{ "blues","delta blues","chicago blues","electric blues","blues rock" }),
        ("Country", new[]{ "country","alt-country","bluegrass","americana","country rock","outlaw country","honky tonk" }),
        ("Funk / Disco", new[]{ "funk","disco","nu disco","nu-disco","boogie","p-funk","italo disco","french house","funky" }),
        ("Gospel", new[]{ "gospel","christian","worship","christian rock","ccm","religious","cristiana","alabanza" }),
        ("Folk / Acústico", new[]{ "folk","indie folk","folk rock","acoustic","acústico","singer-songwriter","cantautor","cantautora","freak folk","neofolk","celtic","world","world music" }),
        ("Indie / Alternativo", new[]{ "indie","indie rock","alternative","alternative rock","alternativo","alt rock","shoegaze","post-punk","post punk","new wave","darkwave","coldwave","post-rock","post rock","math rock","noise rock","noise pop","lo-fi indie","garage rock revival","madchester","slowcore","art rock","experimental" }),
        ("Rock", new[]{ "rock","rock en español","rock latino","classic rock","hard rock","soft rock","grunge","britpop","garage rock","psychedelic","psychedelic rock","progressive rock","prog rock","prog","rock and roll","rock & roll","rockabilly","glam rock","southern rock","stoner rock","surf rock","space rock","krautrock","pop rock" }),
        ("Pop", new[]{ "pop","teen pop","boy band","girl group","ballad","balada","baladas","power pop","europop","eurovision","mainstream","top 40" }),
    };

    static readonly Regex[] Compiled;
    static GenreEngine()
    {
        Compiled = Rules.Select(r => new Regex(@"(^|[\s\-/&,(])(" + string.Join("|", r.keys.OrderByDescending(k => k.Length).Select(Regex.Escape)) + @")($|[\s\-/&,)])",
            RegexOptions.Compiled | RegexOptions.CultureInvariant)).ToArray();
    }

    public static readonly string[] MainGenres = Rules.Select(r => r.main).Distinct().ToArray();

    readonly Library lib; readonly LastFm fm; readonly Meta meta;
    public GenreCache Cache;
    readonly Debouncer saver;
    public bool Running { get; private set; }
    public event Action<int, int, string> Progress;

    public GenreEngine(Library lib, LastFm fm, Meta meta)
    {
        this.lib = lib; this.fm = fm; this.meta = meta;
        Cache = Json.Load<GenreCache>(Paths.Of("genre-tags.json"));
        saver = new Debouncer(() => { lock (Cache) Json.Save(Paths.Of("genre-tags.json"), Cache); });
    }

    static string Norm(string tag) => Regex.Replace((tag ?? "").ToLowerInvariant().Replace('_', ' ').Trim(), @"\s+", " ");

    /// <summary>Mapea una etiqueta a (género principal, subgénero legible) o null si no es un género.</summary>
    public static (string main, string sub)? Map(string tag)
    {
        var t = Norm(tag);
        if (t.Length < 2 || t.Length > 40) return null;
        for (int i = 0; i < Compiled.Length; i++)
            if (Compiled[i].IsMatch(t))
                return (Rules[i].main, Title(Canon(t)));
        return null;
    }

    static readonly TextInfo TI = CultureInfo.GetCultureInfo("es-ES").TextInfo;
    // Variantes que significan lo mismo → una sola forma
    static readonly Dictionary<string, string> Alias = new()
    {
        ["hip hop"] = "hip-hop", ["hiphop"] = "hip-hop", ["rnb"] = "r&b", ["r'n'b"] = "r&b", ["rhythm and blues"] = "r&b",
        ["alternative"] = "alternative", ["alternative & indie"] = "alternative", ["alt rock"] = "alternative rock",
        ["synth-pop"] = "synthpop", ["synth pop"] = "synthpop", ["drum n bass"] = "drum and bass", ["drum'n'bass"] = "drum and bass", ["dnb"] = "drum and bass",
        ["trip hop"] = "trip-hop", ["lo fi"] = "lo-fi", ["lofi"] = "lo-fi", ["chill out"] = "chillout", ["pop-punk"] = "pop punk", ["post punk"] = "post-punk",
        ["post rock"] = "post-rock", ["nu-metal"] = "nu metal", ["k-pop"] = "k-pop", ["kpop"] = "k-pop", ["j-pop"] = "j-pop", ["jpop"] = "j-pop",
        ["reggaetón"] = "reggaeton", ["reguetón"] = "reggaeton", ["regueton"] = "reggaeton", ["rock español"] = "rock en español", ["rock en espanol"] = "rock en español",
        ["electrónica"] = "electronic", ["electronica"] = "electronic", ["clásica"] = "classical", ["clasica"] = "classical", ["acústico"] = "acoustic",
        ["neo soul"] = "neo-soul", ["nu disco"] = "nu-disco", ["latino"] = "latin", ["latina"] = "latin", ["pop latino"] = "latin pop", ["rock & roll"] = "rock and roll",
    };

    static string Canon(string t) => Alias.TryGetValue(t, out var a) ? a : t;
    static string Squash(string s) => new string((s ?? "").ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());

    static string Title(string t)
    {
        var s = TI.ToTitleCase(t);
        return s.Replace("R&B", "R&B").Replace("Edm", "EDM").Replace("Idm", "IDM").Replace("Dnb", "DnB").Replace("Ost", "OST").Replace("Uk ", "UK ").Replace("K-Pop", "K-Pop").Replace("Ebm", "EBM").Replace("Mpb", "MPB");
    }

    static IEnumerable<string> SplitLocal(string g) =>
        string.IsNullOrWhiteSpace(g) ? Enumerable.Empty<string>() : g.Split(new[] { ';', '/', ',', '|', '\\' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    static string AK(string s) => (s ?? "").Trim().ToLowerInvariant();

    public void Classify(Track t)
    {
        var mains = new Dictionary<string, double>();
        var subs = new Dictionary<string, (string main, double w)>();
        var evidence = new Dictionary<string, double>();

        void Add(string tag, double w)
        {
            if (w <= 0) return;
            var m = Map(tag);
            if (m == null) return;
            var (main, sub) = m.Value;
            mains[main] = mains.GetValueOrDefault(main) + w;
            var prev = subs.GetValueOrDefault(sub);
            subs[sub] = (main, prev.w + w);
            evidence[sub] = evidence.GetValueOrDefault(sub) + w;
        }

        // 1) Etiquetas del archivo: son decisión del usuario → peso alto
        foreach (var g in SplitLocal(t.Genre)) Add(g, 1.6);

        List<GenreTag> tl;
        lock (Cache)
        {
            // 2) Etiquetas de la pista (si se analizaron)
            if (Cache.Track.TryGetValue(AK(t.Artist) + "|" + AK(t.Title), out tl)) foreach (var x in tl) Add(x.N, 1.2 * x.C / 100);
            // 3) Etiquetas del álbum
            if (Cache.Album.TryGetValue(AK(t.AlbumArtist) + "|" + AK(t.Album), out tl)) foreach (var x in tl) Add(x.N, 1.0 * x.C / 100);
            // 4) Etiquetas del artista
            if (Cache.Artist.TryGetValue(AK(t.AlbumArtist), out tl)) foreach (var x in tl) Add(x.N, 0.65 * x.C / 100);
            else if (t.Artist != t.AlbumArtist && Cache.Artist.TryGetValue(AK(t.Artist), out tl)) foreach (var x in tl) Add(x.N, 0.65 * x.C / 100);
        }
        // 5) TheAudioDB (género y estilo del artista)
        var ai = meta.Cached(t.AlbumArtist) ?? meta.Cached(t.Artist);
        if (ai != null) { Add(ai.Genre, 0.5); Add(ai.Style, 0.55); }

        if (mains.Count == 0)
        {
            t.MainGenre = string.IsNullOrWhiteSpace(t.Genre) ? "Sin clasificar" : Title(Norm(SplitLocal(t.Genre).First()));
            t.SubGenre = null; t.GenreConf = 0; t.GenreTags = null;
            return;
        }
        var total = mains.Values.Sum();
        var best = mains.OrderByDescending(kv => kv.Value).First();
        t.MainGenre = best.Key;
        t.GenreConf = Math.Round(best.Value / total, 3);
        var sub = subs.Where(kv => kv.Value.main == best.Key)
            .OrderByDescending(kv => kv.Value.w)
            .ThenByDescending(kv => kv.Key.Length) // ante empate, el más específico
            .Select(kv => kv.Key).FirstOrDefault();
        // Si el subgénero es el mismo nombre del principal (p. ej. «Hip-Hop» en «Hip-Hop / Rap»), no aporta nada
        var mainParts = best.Key.Split('/').Select(Squash).ToHashSet();
        t.SubGenre = sub != null && !mainParts.Contains(Squash(sub)) && Squash(sub) != Squash(best.Key) ? sub : null;
        t.GenreTags = evidence.OrderByDescending(kv => kv.Value).Take(5).Select(kv => kv.Key).ToList();
    }

    public void ClassifyAll()
    {
        foreach (var t in lib.All()) Classify(t);
        lib.SaveLater();
    }

    /// <summary>Descarga etiquetas de Last.fm por artista y álbum (y por pista si hay ambigüedad) y reclasifica.</summary>
    public Task Analyze(bool deep) => Task.Run(async () =>
    {
        if (Running) return;
        Running = true;
        try
        {
            var tracks = lib.All();
            var artistNames = tracks.Select(t => t.AlbumArtist).Where(a => !string.IsNullOrWhiteSpace(a))
                .GroupBy(AK).Select(g => g.First()).ToList();
            var albumsList = tracks.Where(t => !string.IsNullOrWhiteSpace(t.Album))
                .GroupBy(t => AK(t.AlbumArtist) + "|" + AK(t.Album)).Select(g => g.First()).ToList();
            int total = artistNames.Count + (fm.HasKey ? albumsList.Count : 0), done = 0;

            foreach (var a in artistNames)
            {
                Progress?.Invoke(done++, total, a);
                try { await meta.Artist(a); } catch { } // trae también fotos y bio (quedan en caché)
                if (!fm.HasKey) continue;
                bool has; lock (Cache) has = Cache.Artist.ContainsKey(AK(a));
                if (has) continue;
                var tags = await fm.TopTags("artist.getTopTags", new() { ["artist"] = a });
                lock (Cache) Cache.Artist[AK(a)] = tags;
                saver.Poke();
            }
            if (fm.HasKey)
                foreach (var t in albumsList)
                {
                    Progress?.Invoke(done++, total, t.Album);
                    var k = AK(t.AlbumArtist) + "|" + AK(t.Album);
                    bool has; lock (Cache) has = Cache.Album.ContainsKey(k);
                    if (has) continue;
                    var tags = await fm.TopTags("album.getTopTags", new() { ["artist"] = t.AlbumArtist, ["album"] = t.Album });
                    lock (Cache) Cache.Album[k] = tags;
                    saver.Poke();
                }

            foreach (var t in tracks) Classify(t);

            // Análisis profundo: pistas con baja confianza consultan sus propias etiquetas
            if (deep && fm.HasKey)
            {
                var unsure = tracks.Where(t => t.GenreConf < 0.55).ToList();
                int i = 0;
                foreach (var t in unsure)
                {
                    Progress?.Invoke(i++, unsure.Count, "Pista: " + t.Title);
                    var k = AK(t.Artist) + "|" + AK(t.Title);
                    bool has; lock (Cache) has = Cache.Track.ContainsKey(k);
                    if (!has)
                    {
                        var tags = await fm.TopTags("track.getTopTags", new() { ["artist"] = t.Artist, ["track"] = t.Title });
                        lock (Cache) Cache.Track[k] = tags;
                        saver.Poke();
                    }
                    Classify(t);
                }
            }
            lib.SaveLater();
            Progress?.Invoke(total, total, null);
        }
        finally { Running = false; }
    });
}
