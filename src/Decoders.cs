using NAudio.Wave;

namespace Sonora;

/// <summary>Fuente de audio PCM (float intercalado) con búsqueda por cuadro.</summary>
public interface IPcmSource : IDisposable
{
    int SampleRate { get; }
    int Channels { get; }
    long Frames { get; }
    void Seek(long frame);
    /// <summary>Lee hasta <paramref name="frames"/> cuadros intercalados; devuelve los leídos (0 = fin).</summary>
    int Read(float[] buf, int frames);
}

/// <summary>
/// Formatos que Chromium no decodifica pero Sonora sí: DSD (DSF, decodificador propio) y ALAC (Media Foundation).
/// Se entregan al reproductor como WAV PCM de 24 bits generado al vuelo.
/// </summary>
public static class Decoders
{
    public static bool IsAlac(string ext, string codec) =>
        ext.Equals(".m4a", StringComparison.OrdinalIgnoreCase) && (codec ?? "").Contains("alac", StringComparison.OrdinalIgnoreCase);

    /// <summary>¿Este archivo se sirve decodificado (WAV al vuelo) en lugar de tal cual?</summary>
    public static bool NeedsPcm(string ext, string codec) =>
        ext.Equals(".dsf", StringComparison.OrdinalIgnoreCase) || IsAlac(ext, codec);

    public static IPcmSource Open(string path) =>
        Path.GetExtension(path).Equals(".dsf", StringComparison.OrdinalIgnoreCase) ? new DsfSource(path) : new MfSource(path);

    /// <summary>Para el analizador: cualquier archivo como ISampleProvider (DSF con el decodificador propio).</summary>
    public static PcmSampleProvider OpenSamples(string path) => new(Open(path));
}

/// <summary>Cualquier formato que entienda Media Foundation (ALAC, AAC, FLAC, MP3…), como float.</summary>
public sealed class MfSource : IPcmSource
{
    readonly MediaFoundationReader r;
    readonly int ba;
    byte[] tmp = Array.Empty<byte>();

    public MfSource(string path)
    {
        var settings = new MediaFoundationReader.MediaFoundationReaderSettings { RequestFloatOutput = true, SingleReaderObject = true };
        // Media Foundation no abre rutas de más de MAX_PATH (260): en ese caso se le pasa el archivo como stream
        r = path.Length < 260 ? new MediaFoundationReader(path, settings)
            : new StreamMediaFoundationReader(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16), settings);
        if (r.WaveFormat.Encoding != WaveFormatEncoding.IeeeFloat) { r.Dispose(); throw new NotSupportedException("Sin salida float"); }
        ba = r.WaveFormat.BlockAlign;
    }

    public int SampleRate => r.WaveFormat.SampleRate;
    public int Channels => r.WaveFormat.Channels;
    public long Frames => r.Length / ba;
    public void Seek(long frame) => r.Position = Math.Clamp(frame, 0, Frames) * ba;

    public int Read(float[] buf, int frames)
    {
        int want = frames * ba;
        if (tmp.Length < want) tmp = new byte[want];
        int got = 0;
        while (got < want)
        {
            int n = r.Read(tmp, got, want - got);
            if (n <= 0) break;
            got += n;
        }
        got -= got % ba;
        Buffer.BlockCopy(tmp, 0, buf, 0, got);
        return got / ba;
    }

    public void Dispose() => r.Dispose();
}

/// <summary>
/// Decodificador DSD → PCM para archivos DSF (DSD64/128/256…).
/// Filtro FIR pasabajos (ventana de Kaiser) con decimación directa a 88.2 kHz, evaluado por tablas:
/// cada byte DSD (8 muestras de 1 bit) se resuelve con una sola consulta a una tabla precalculada.
/// </summary>
public sealed class DsfSource : IPcmSource
{
    public const int OutRate = 88200;
    const int Group = 4096;          // bytes por canal en cada bloque del DSF
    const byte Idle = 0x69;          // patrón de silencio DSD

    readonly FileStream fs;
    readonly int ch, decim, taps;    // decim: bytes DSD por muestra de salida; taps: bytes del filtro
    readonly long dataStart, dsdBytes; // bytes DSD por canal (reales, sin el relleno final)
    readonly float[] table;          // [taps * 256]
    readonly byte[][] win;           // ventana deslizante por canal: historia + bloque actual
    readonly byte[] block;
    int have, pos;                   // bytes válidos en win y posición de lectura
    long nextByte;                   // próximo byte DSD (por canal) a cargar
    long frame;

    public int SampleRate => OutRate;
    public int Channels => ch;
    public long Frames { get; }

    public DsfSource(string path)
    {
        fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16);
        var br = new BinaryReader(fs);
        if (new string(br.ReadChars(4)) != "DSD ") throw new InvalidDataException("No es DSF");
        long dsdSize = br.ReadInt64();
        fs.Position = dsdSize;
        if (new string(br.ReadChars(4)) != "fmt ") throw new InvalidDataException("DSF sin fmt");
        long fmtSize = br.ReadInt64();
        br.ReadInt32();                              // versión
        if (br.ReadInt32() != 0) throw new NotSupportedException("DSF comprimido");
        br.ReadInt32();                              // tipo de canales
        ch = br.ReadInt32();
        int rate = br.ReadInt32();
        int bits = br.ReadInt32();                   // 1 = LSB primero, 8 = MSB primero
        long samples = br.ReadInt64();               // muestras de 1 bit por canal
        int blk = br.ReadInt32();
        if (blk != Group || ch < 1 || ch > 8 || rate % (OutRate * 8) != 0) throw new NotSupportedException("DSF no compatible");
        fs.Position = dsdSize + fmtSize;
        if (new string(br.ReadChars(4)) != "data") throw new InvalidDataException("DSF sin data");
        br.ReadInt64();
        dataStart = fs.Position;

        decim = rate / OutRate / 8;                  // DSD64 → 4, DSD128 → 8
        dsdBytes = samples / 8;
        Frames = dsdBytes / decim;
        taps = 16 * decim;                           // 512 coeficientes en DSD64, 1024 en DSD128
        table = Coefs.Get(rate, taps, bits == 1);
        win = Enumerable.Range(0, ch).Select(_ => new byte[taps + Group]).ToArray();
        block = new byte[Group * ch];
        Seek(0);
    }

    public void Seek(long f)
    {
        frame = Math.Clamp(f, 0, Frames);
        // La primera muestra necesita 'taps' bytes de historia: se arranca antes y se rellena con silencio
        long first = frame * decim - (taps - decim);
        long pre = Math.Max(0, -first);
        nextByte = Math.Max(0, first);
        foreach (var w in win) Array.Fill(w, Idle, 0, (int)pre);
        have = (int)pre; pos = 0;
        // Alinea la carga al bloque: se lee el bloque que contiene nextByte y se descarta lo anterior
        int skip = (int)(nextByte % Group);
        nextByte -= skip;
        Load(skip);
    }

    /// <summary>Carga el siguiente bloque en la ventana, omitiendo sus primeros <paramref name="skip"/> bytes.</summary>
    bool Load(int skip = 0)
    {
        if (nextByte >= dsdBytes) return false;
        // Compacta: conserva solo lo que aún no se ha consumido
        if (pos > 0) { foreach (var w in win) Buffer.BlockCopy(w, pos, w, 0, have - pos); have -= pos; pos = 0; }
        fs.Position = dataStart + nextByte / Group * Group * ch;
        int n = 0;
        while (n < block.Length) { int r = fs.Read(block, n, block.Length - n); if (r <= 0) break; n += r; }
        Array.Clear(block, n, block.Length - n);
        int len = (int)Math.Min(Group - skip, dsdBytes - nextByte - skip);
        for (int c = 0; c < ch; c++) Buffer.BlockCopy(block, c * Group + skip, win[c], have, len);
        have += len;
        nextByte += Group;
        return true;
    }

    public int Read(float[] buf, int frames)
    {
        int done = 0;
        var t = table;
        while (done < frames && frame < Frames)
        {
            if (pos + taps > have) { if (!Load()) break; continue; }
            int o = done * ch;
            for (int c = 0; c < ch; c++)
            {
                var w = win[c];
                float s = 0;
                for (int j = 0, k = pos; j < taps; j++, k++) s += t[(j << 8) | w[k]];
                buf[o + c] = s;
            }
            pos += decim; done++; frame++;
        }
        return done;
    }

    public void Dispose() => fs.Dispose();

    /// <summary>Coeficientes del filtro, agrupados por byte (una tabla por frecuencia DSD y orden de bits).</summary>
    static class Coefs
    {
        static readonly Dictionary<(int, int, bool), float[]> cache = new();

        public static float[] Get(int rate, int tapBytes, bool lsbFirst)
        {
            lock (cache)
            {
                if (cache.TryGetValue((rate, tapBytes, lsbFirst), out var t)) return t;
                return cache[(rate, tapBytes, lsbFirst)] = Build(rate, tapBytes, lsbFirst);
            }
        }

        static float[] Build(int rate, int tapBytes, bool lsbFirst)
        {
            // Banda de paso hasta 20 kHz; banda de rechazo desde 56 kHz (lo que se refleje cae por encima de 32 kHz,
            // fuera del oído y lo elimina el remuestreo del motor). Kaiser β = 8.6 → ~86 dB de atenuación.
            int n = tapBytes * 8;
            double fc = 38000.0 / rate, beta = 8.6, mid = (n - 1) / 2.0;
            var h = new double[n];
            double sum = 0;
            for (int i = 0; i < n; i++)
            {
                double x = i - mid;
                double sinc = x == 0 ? 2 * fc : Math.Sin(2 * Math.PI * fc * x) / (Math.PI * x);
                double r = 2.0 * i / (n - 1) - 1;
                h[i] = sinc * I0(beta * Math.Sqrt(Math.Max(0, 1 - r * r))) / I0(beta);
                sum += h[i];
            }
            var t = new float[tapBytes * 256];
            for (int j = 0; j < tapBytes; j++)
                for (int v = 0; v < 256; v++)
                {
                    double s = 0;
                    for (int k = 0; k < 8; k++)
                    {
                        int bit = lsbFirst ? (v >> k) & 1 : (v >> (7 - k)) & 1;
                        s += h[j * 8 + k] / sum * (bit == 1 ? 1 : -1);
                    }
                    t[(j << 8) | v] = (float)s;
                }
            return t;
        }

        static double I0(double x)
        {
            double s = 1, term = 1;
            for (int k = 1; k < 50; k++) { term *= x * x / (4.0 * k * k); s += term; if (term < 1e-12 * s) break; }
            return s;
        }
    }
}

/// <summary>Adaptador a NAudio para el analizador de BPM.</summary>
public sealed class PcmSampleProvider : ISampleProvider, IDisposable
{
    readonly IPcmSource s;
    float[] tmp = Array.Empty<float>();
    public PcmSampleProvider(IPcmSource s) { this.s = s; WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(s.SampleRate, s.Channels); }
    public WaveFormat WaveFormat { get; }
    public double Duration => (double)s.Frames / s.SampleRate;

    public int Read(float[] buffer, int offset, int count)
    {
        int frames = count / s.Channels;
        if (offset == 0) return s.Read(buffer, frames) * s.Channels;
        if (tmp.Length < count) tmp = new float[count];
        int n = s.Read(tmp, frames) * s.Channels;
        Array.Copy(tmp, 0, buffer, offset, n);
        return n;
    }

    public void Dispose() => s.Dispose();
}

/// <summary>Sirve una fuente PCM como WAV de 24 bits con soporte de rangos (los bytes equivalen a tiempos: se puede adelantar).</summary>
public static class WavStream
{
    const int Hdr = 44;

    public static void Serve(System.Net.HttpListenerContext c, string path)
    {
        var req = c.Request; var res = c.Response;
        IPcmSource src = null;
        try
        {
            src = Decoders.Open(path);
            int chn = src.Channels, rate = src.SampleRate, ba = chn * 3;
            long dataLen = src.Frames * ba, len = Hdr + dataLen, start = 0, end = len - 1;
            res.ContentType = "audio/wav";
            res.AddHeader("Accept-Ranges", "bytes");
            res.AddHeader("Cache-Control", "no-store");
            var range = req.Headers["Range"];
            if (!string.IsNullOrEmpty(range) && range.StartsWith("bytes="))
            {
                var r = range[6..].Split(',')[0].Split('-');
                if (r[0].Length == 0) { if (long.TryParse(r[1], out var n)) start = Math.Max(0, len - n); }
                else
                {
                    long.TryParse(r[0], out start);
                    if (r.Length > 1 && long.TryParse(r[1], out var e)) end = Math.Min(len - 1, e);
                }
                if (start >= len || start > end) { res.StatusCode = 416; res.AddHeader("Content-Range", $"bytes */{len}"); res.Close(); return; }
                res.StatusCode = 206;
                res.AddHeader("Content-Range", $"bytes {start}-{end}/{len}");
            }
            long count = end - start + 1;
            res.ContentLength64 = count;
            if (req.HttpMethod == "HEAD") { res.Close(); return; }

            var o = res.OutputStream;
            long p = start;
            if (p < Hdr)
            {
                var h = Header(chn, rate, dataLen);
                int n = (int)Math.Min(Hdr - p, count);
                o.Write(h, (int)p, n);
                p += n; count -= n;
            }
            if (count > 0)
            {
                long f = (p - Hdr) / ba; int skip = (int)((p - Hdr) % ba);
                src.Seek(f);
                const int Chunk = 4096;
                var fb = new float[Chunk * chn];
                var bb = new byte[Chunk * ba];
                while (count > 0)
                {
                    int frames = src.Read(fb, Chunk);
                    int bytes;
                    if (frames <= 0) { Array.Clear(bb); bytes = bb.Length; } // la fuente terminó antes de lo previsto: silencio
                    else
                    {
                        int samples = frames * chn;
                        for (int i = 0, k = 0; i < samples; i++, k += 3)
                        {
                            float v = fb[i];
                            int s = v >= 1f ? 8388607 : v <= -1f ? -8388608 : (int)MathF.Round(v * 8388607f);
                            bb[k] = (byte)s; bb[k + 1] = (byte)(s >> 8); bb[k + 2] = (byte)(s >> 16);
                        }
                        bytes = frames * ba;
                    }
                    int off = skip; skip = 0;
                    int w = (int)Math.Min(bytes - off, count);
                    if (w > 0) { o.Write(bb, off, w); count -= w; }
                }
            }
            res.Close();
        }
        catch { try { res.Abort(); } catch { } } // el reproductor canceló (normal al adelantar) o el archivo no se pudo leer
        finally { src?.Dispose(); }
    }

    static byte[] Header(int ch, int rate, long dataLen)
    {
        var h = new byte[Hdr];
        using var w = new BinaryWriter(new MemoryStream(h));
        uint d = (uint)Math.Min(dataLen, uint.MaxValue - 36);
        w.Write("RIFF"u8); w.Write(36 + d); w.Write("WAVE"u8);
        w.Write("fmt "u8); w.Write(16); w.Write((short)1); w.Write((short)ch); w.Write(rate);
        w.Write(rate * ch * 3); w.Write((short)(ch * 3)); w.Write((short)24);
        w.Write("data"u8); w.Write(d);
        return h;
    }
}
