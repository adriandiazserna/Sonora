using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Sonora;

public static class Paths
{
    public static readonly string Data = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Sonora");

    public static string Covers => Ensure(Path.Combine(Data, "covers"));
    public static string Images => Ensure(Path.Combine(Data, "images"));
    public static string State => Ensure(Path.Combine(Data, "state"));
    public static string WebView => Ensure(Path.Combine(Data, "webview"));
    public static string Of(string name) => Path.Combine(Ensure(Data), name);

    static string Ensure(string p) { Directory.CreateDirectory(p); return p; }
}

public static class Json
{
    public static readonly JsonSerializerOptions Opt = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DictionaryKeyPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        IncludeFields = true,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
    };

    public static T Load<T>(string file) where T : new()
    {
        try
        {
            if (File.Exists(file))
                return JsonSerializer.Deserialize<T>(File.ReadAllText(file), Opt) ?? new T();
        }
        catch { /* archivo corrupto: se regenera */ }
        return new T();
    }

    public static void Save<T>(string file, T obj)
    {
        var tmp = file + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(obj, Opt));
        File.Move(tmp, file, true);
    }
}

/// <summary>Guarda en disco con retraso para no escribir en cada cambio.</summary>
public sealed class Debouncer
{
    readonly Action action; readonly int ms; System.Threading.Timer timer;
    public Debouncer(Action action, int ms = 1500) { this.action = action; this.ms = ms; }
    public void Poke()
    {
        timer ??= new System.Threading.Timer(_ => { try { action(); } catch { } }, null, Timeout.Infinite, Timeout.Infinite);
        timer.Change(ms, Timeout.Infinite);
    }
}

public static class Hash
{
    public static string Id(string s) =>
        Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(s.ToLowerInvariant())))[..16].ToLowerInvariant();

    public static bool IsId(string s) =>
        s != null && s.Length == 16 && s.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
}

public static class Img
{
    static readonly ImageCodecInfo Jpeg = ImageCodecInfo.GetImageEncoders().First(e => e.FormatID == ImageFormat.Jpeg.Guid);

    /// <summary>Redimensiona con bicúbica de alta calidad y guarda como JPEG.</summary>
    public static void SaveResized(byte[] data, string outPath, int max, long quality = 90)
    {
        using var ms = new MemoryStream(data);
        using var img = Image.FromStream(ms, false, false);
        double s = max <= 0 ? 1 : Math.Min(1.0, (double)max / Math.Max(img.Width, img.Height));
        int w = Math.Max(1, (int)Math.Round(img.Width * s)), h = Math.Max(1, (int)Math.Round(img.Height * s));
        using var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Black);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            using var attr = new ImageAttributes();
            attr.SetWrapMode(WrapMode.TileFlipXY); // evita bordes oscuros
            g.DrawImage(img, new Rectangle(0, 0, w, h), 0, 0, img.Width, img.Height, GraphicsUnit.Pixel, attr);
        }
        using var ps = new EncoderParameters(1);
        ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        var tmp = outPath + ".tmp";
        bmp.Save(tmp, Jpeg, ps);
        File.Move(tmp, outPath, true);
    }

    public static string MimeOf(string file)
    {
        try
        {
            var b = new byte[12];
            using var f = File.OpenRead(file);
            int n = f.Read(b);
            return MimeOf(b.AsSpan(0, n)) ?? "application/octet-stream";
        }
        catch { return "application/octet-stream"; }
    }

    /// <summary>Tipo de imagen según los primeros bytes (firma), o null si no es una imagen conocida.</summary>
    public static string MimeOf(ReadOnlySpan<byte> b)
    {
        int n = b.Length;
        if (n >= 3 && b[0] == 0xFF && b[1] == 0xD8) return "image/jpeg";
        if (n >= 4 && b[0] == 0x89 && b[1] == 0x50) return "image/png";
        if (n >= 12 && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
        if (n >= 3 && b[0] == 'G' && b[1] == 'I') return "image/gif";
        return null;
    }
}
