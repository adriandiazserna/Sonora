using NAudio.Wave;

namespace Sonora;

/// <summary>Resultado del análisis para el DJ automático.</summary>
public class DjInfo
{
    public int V;
    public double Bpm;      // tempo estimado
    public double Period;   // segundos por tiempo (afinado con dos zonas de la canción)
    public double Grid;     // instante del primer compás (tiempo 1) de la rejilla
    public double Conf;     // 0..1: qué tan estable y claro es el pulso
    public double Start;    // donde empieza la música (s)
    public double End;      // donde termina la música, sin silencio ni cola (s)
    public double Loud;     // sonoridad RMS en dBFS (zona central)
    public double Energy;   // densidad de ataques (cruda; el cliente la normaliza por rango)
    public string Key, Camelot;
    public string Wave;     // forma de onda compacta: 120 niveles 0..9 (para la barra de reproducción)
}

/// <summary>
/// Analizador de pulso, compás, tonalidad y energía.
/// Decodifica con Media Foundation (FLAC/WAV/M4A/MP3/ALAC) en una sola pasada secuencial (sin saltos:
/// la línea de tiempo queda exacta), reduce a mono ~11 kHz y solo guarda tres ventanas (intro, centro, final).
/// </summary>
public static class BeatAnalyzer
{
    public const int Version = 3;
    const double TargetRate = 11025;
    const int N = 1024, Hop = 128;

    sealed class Win
    {
        public float[] E, L;       // envolvente de ataques (completa y graves)
        public double T0, Fr;      // inicio (s) y fotogramas por segundo
        public double Phase, Down, Score;
    }

    public static DjInfo Analyze(string path)
    {
        // Media Foundation para casi todo (también ALAC); DSF con el decodificador DSD propio
        using var sp = Decoders.OpenSamples(path);
        double dur = sp.Duration;
        var info = new DjInfo { V = Version, End = dur };
        if (dur < 25) return info;

        int ch = sp.WaveFormat.Channels, src = sp.WaveFormat.SampleRate;
        int dec = Math.Max(1, (int)Math.Round(src / TargetRate));
        double rate = (double)src / dec;

        double introLen = Math.Min(45, dur * 0.3);
        double midStart = dur * 0.4, midLen = Math.Min(30, dur * 0.25);
        double outStart = Math.Max(dur - 50, midStart + midLen);
        var intro = new List<float>((int)(introLen * rate) + 16);
        var mid = new List<float>((int)(midLen * rate) + 16);
        var outro = new List<float>((int)((dur - outStart) * rate) + 16);

        const double Block = 0.25;
        int blockN = (int)(Block * rate);
        var blocks = new List<float>((int)(dur / Block) + 4);
        double bAcc = 0; int bCnt = 0;

        var buf = new float[8192 * ch];
        double acc = 0; int cnt = 0; long idx = 0;
        while (true)
        {
            int n = sp.Read(buf, 0, buf.Length);
            if (n <= 0) break;
            for (int i = 0; i + ch <= n; i += ch)
            {
                float s = 0;
                for (int c = 0; c < ch; c++) s += buf[i + c];
                acc += s / ch;
                if (++cnt < dec) continue;
                float v = (float)(acc / dec); acc = 0; cnt = 0;
                double t = idx++ / rate;
                if (t < introLen) intro.Add(v);
                if (t >= midStart && t < midStart + midLen) mid.Add(v);
                if (t >= outStart) outro.Add(v);
                bAcc += v * v;
                if (++bCnt == blockN) { blocks.Add((float)Math.Sqrt(bAcc / blockN)); bAcc = 0; bCnt = 0; }
            }
        }

        // Forma de onda: 120 columnas con el pico RMS de cada tramo, escala perceptual
        if (blocks.Count > 0)
        {
            const int Cols = 120;
            var col = new double[Cols];
            for (int i = 0; i < blocks.Count; i++) { int k = Math.Min(Cols - 1, i * Cols / blocks.Count); col[k] = Math.Max(col[k], blocks[i]); }
            double mx = col.Max() + 1e-9;
            info.Wave = new string(col.Select(v => (char)('0' + (int)Math.Round(9 * Math.Pow(v / mx, 0.7)))).ToArray());
        }

        // Inicio y fin reales de la música (ignora silencios y colas)
        if (blocks.Count > 8)
        {
            var db = blocks.Select(x => 20 * Math.Log10(x + 1e-9)).ToArray();
            var sorted = db.OrderBy(x => x).ToArray();
            double loud = sorted[(int)(sorted.Length * 0.7)];
            double thr = loud - 18;
            int first = Array.FindIndex(db, x => x > thr), last = Array.FindLastIndex(db, x => x > thr);
            info.Start = Math.Max(0, first) * Block;
            info.End = last < 0 ? dur : Math.Min(dur, (last + 1) * Block);
            info.Loud = Math.Round(loud, 2);
        }

        var midArr = mid.ToArray();
        (info.Key, info.Camelot) = Key(midArr, rate);
        var wins = new[] { MakeWin(intro.ToArray(), 0, rate), MakeWin(midArr, midStart, rate), MakeWin(outro.ToArray(), outStart, rate) }
            .Where(w => w.E.Length > 300).ToArray();
        intro = mid = outro = null; midArr = null;
        if (wins.Length == 0) return info;

        // Tempo: la ventana con el pulso más claro
        double bpm = 0, strength = -1;
        foreach (var w in wins)
        {
            var (b, s) = Tempo(w);
            if (s > strength) { strength = s; bpm = b; }
        }
        if (bpm <= 0) return info;
        double P0 = 60 / bpm;
        foreach (var w in wins) Phase(w, P0);

        // Rejilla global: una sola rejilla (periodo + fase) que cuadre en TODA la canción a la vez.
        // Así el pulso es exacto tanto en la entrada como en la salida (lo que importa para mezclar).
        var (P, phase, score) = GlobalGrid(wins, P0);
        double bar = 4 * P;

        // Tiempo 1 del compás: la posición (de 4) donde más pega el bombo en todas las zonas
        var cls = new double[4];
        foreach (var w in wins)
        {
            double rateW = w.Fr * Hop;
            long k0 = (long)Math.Ceiling((w.T0 - phase) / P);
            for (long k = k0; ; k++)
            {
                double t = phase + k * P;
                double f = (t - w.T0) * rateW / Hop - (N / 2.0) / Hop;
                if (f >= w.E.Length - 1) break;
                if (f < 0) continue;
                int i = (int)f; double fr = f - i;
                cls[((k % 4) + 4) % 4] += w.L[i] * (1 - fr) + w.L[i + 1] * fr + 0.25 * (w.E[i] * (1 - fr) + w.E[i + 1] * fr);
            }
        }
        int j = Array.IndexOf(cls, cls.Max());
        double down = phase + j * P;
        info.Period = P;
        info.Bpm = Math.Round(60 / P, 2);
        info.Grid = down - Math.Floor(down / bar) * bar;
        info.Conf = Math.Round(Math.Clamp((score - 1.3) / 1.3, 0, 1), 3);

        var center = wins.Length > 1 ? wins[1] : wins[0];
        info.Energy = Math.Round(center.E.Average(), 4);
        return info;
    }

    static Win MakeWin(float[] x, double t0, double rate)
    {
        var (e, l) = Onset(x, rate);
        return new Win { E = e, L = l, T0 = t0, Fr = rate / Hop };
    }

    static double[] Hann(int n)
    {
        var w = new double[n];
        for (int i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (n - 1));
        return w;
    }

    /// <summary>Envolvente de ataques por flujo espectral (log), total y de graves (bombo).</summary>
    static (float[] all, float[] low) Onset(float[] x, double rate)
    {
        int frames = x.Length > N ? (x.Length - N) / Hop : 0;
        if (frames < 10) return (Array.Empty<float>(), Array.Empty<float>());
        var win = Hann(N);
        var re = new double[N]; var im = new double[N];
        int bins = N / 2;
        int kMax = Math.Min(bins - 1, (int)(6000 / (rate / N)));
        int kLow = Math.Max(2, (int)(160 / (rate / N)));
        var prev = new double[bins];
        var all = new float[frames]; var low = new float[frames];
        for (int f = 0; f < frames; f++)
        {
            int o = f * Hop;
            for (int i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
            Fft(re, im);
            double s = 0, sl = 0;
            for (int k = 1; k <= kMax; k++)
            {
                double m = Math.Log(1 + 100 * Math.Sqrt(re[k] * re[k] + im[k] * im[k]));
                double d = m - prev[k];
                if (d > 0) { s += d; if (k <= kLow) sl += d; }
                prev[k] = m;
            }
            all[f] = (float)s; low[f] = (float)sl;
        }
        return (Detrend(all, 8), Detrend(low, 8));
    }

    static float[] Detrend(float[] e, int r)
    {
        var o = new float[e.Length];
        double sum = 0; int lo = 0, hi = -1;
        for (int i = 0; i < e.Length; i++)
        {
            while (hi < Math.Min(e.Length - 1, i + r)) sum += e[++hi];
            while (lo < i - r) sum -= e[lo++];
            double mean = sum / (hi - lo + 1);
            o[i] = (float)Math.Max(0, e[i] - mean);
        }
        return o;
    }

    /// <summary>Tempo por autocorrelación con peine de múltiplos y una preferencia suave hacia ~105 BPM.</summary>
    static (double bpm, double strength) Tempo(Win w)
    {
        var e = w.E; int n = e.Length; double fr = w.Fr;
        int maxLag = Math.Min(n - 2, (int)(fr * 60 / 70 * 4) + 2);
        if (maxLag < 20) return (0, 0);
        var ac = new double[maxLag + 2];
        for (int lag = 0; lag <= maxLag; lag++)
        {
            double s = 0;
            for (int i = 0; i + lag < n; i++) s += e[i] * e[i + lag];
            ac[lag] = s / (n - lag);
        }
        double A(double lag)
        {
            if (lag >= maxLag) return 0;
            int i = (int)lag; double f = lag - i;
            return ac[i] * (1 - f) + ac[i + 1] * f;
        }
        double best = 0, bb = 0;
        for (double bpm = 70; bpm <= 180; bpm += 0.05)
        {
            double L = fr * 60 / bpm;
            double s = A(L) + 0.5 * A(2 * L) + 0.25 * A(4 * L);
            double prior = Math.Exp(-0.5 * Math.Pow(Math.Log2(bpm / 105) / 0.8, 2));
            s *= 0.6 + 0.4 * prior;
            if (s > best) { best = s; bb = bpm; }
        }
        return (bb, ac[0] > 0 ? best / ac[0] : 0);
    }

    /// <summary>Fase del pulso (peine sobre la envolvente) y tiempo 1 del compás (donde más pega el bombo).</summary>
    static void Phase(Win w, double P)
    {
        var e = w.E; int n = e.Length;
        double Pf = P * w.Fr, mean = e.Average() + 1e-9;
        double best = -1, bphi = 0;
        for (double phi = 0; phi < Pf; phi += 0.25)
        {
            double s = 0; int c = 0;
            for (double p = phi; p < n - 1; p += Pf) { int i = (int)p; double f = p - i; s += e[i] * (1 - f) + e[i + 1] * f; c++; }
            s /= Math.Max(1, c);
            if (s > best) { best = s; bphi = phi; }
        }
        var cls = new double[4]; int k = 0;
        for (double p = bphi; p < n - 1; p += Pf, k++)
        {
            int i = (int)p; double f = p - i;
            cls[k % 4] += w.L[i] * (1 - f) + w.L[i + 1] * f + 0.25 * (e[i] * (1 - f) + e[i + 1] * f);
        }
        int j = Array.IndexOf(cls, cls.Max());
        double rate = w.Fr * Hop;
        double T(double frame) => w.T0 + (frame * Hop + N / 2.0) / rate;
        w.Phase = T(bphi);
        w.Down = T(bphi + j * Pf);
        w.Score = best / mean;
    }

    /// <summary>
    /// Busca el periodo exacto (±0.8 % alrededor del estimado) y la fase global que maximizan
    /// la energía de ataques sobre los tiempos en todas las ventanas a la vez.
    /// </summary>
    static (double P, double phase, double score) GlobalGrid(Win[] wins, double P0)
    {
        double mean = wins.Sum(w => w.E.Sum()) / Math.Max(1, wins.Sum(w => w.E.Length)) + 1e-9;
        double bestS = -1, bestP = P0, bestPh = 0;
        // Muestreo de la envolvente en un instante absoluto
        static double At(Win w, double t)
        {
            double f = (t - w.T0) * w.Fr - (N / 2.0) / Hop;
            if (f < 0 || f >= w.E.Length - 1) return double.NaN;
            int i = (int)f; double r = f - i;
            return w.E[i] * (1 - r) + w.E[i + 1] * r;
        }
        void Search(double from, double to, double step, double phStep)
        {
            for (double P = from; P <= to; P += step)
            {
                for (double ph = 0; ph < P; ph += phStep)
                {
                    double s = 0; int c = 0;
                    foreach (var w in wins)
                    {
                        double end = w.T0 + w.E.Length / w.Fr;
                        long k = (long)Math.Ceiling((w.T0 - ph) / P);
                        for (double t = ph + k * P; t < end; t += P)
                        {
                            double v = At(w, t);
                            if (!double.IsNaN(v)) { s += v; c++; }
                        }
                    }
                    if (c == 0) continue;
                    s /= c;
                    if (s > bestS) { bestS = s; bestP = P; bestPh = ph; }
                }
            }
        }
        // Grueso y luego fino alrededor del mejor
        Search(P0 * 0.992, P0 * 1.008, P0 * 0.0004, 0.008);
        double c0 = bestP, ph0 = bestPh;
        bestS = -1;
        Search(c0 - P0 * 0.0004, c0 + P0 * 0.0004, P0 * 0.00002, 0.002);
        return (bestP, bestPh, bestS / mean);
    }

    static readonly double[] Major = { 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88 };
    static readonly double[] Minor = { 6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17 };
    static readonly string[] Notes = { "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B" };
    static readonly int[] CamMajor = { 8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1 };
    static readonly int[] CamMinor = { 5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10 };

    /// <summary>Tonalidad por croma + perfiles de Krumhansl, con su código Camelot (mezcla armónica).</summary>
    static (string key, string camelot) Key(float[] x, double rate)
    {
        const int M = 4096;
        if (x == null || x.Length < M * 4) return (null, null);
        var win = Hann(M);
        var re = new double[M]; var im = new double[M];
        var chroma = new double[12];
        int kLo = Math.Max(1, (int)(80 / (rate / M))), kHi = Math.Min(M / 2 - 1, (int)(2000 / (rate / M)));
        var pc = new int[kHi + 1];
        for (int k = kLo; k <= kHi; k++) { double f = k * rate / M; int midi = (int)Math.Round(69 + 12 * Math.Log2(f / 440)); pc[k] = ((midi % 12) + 12) % 12; }
        for (int s = 0; s + M <= x.Length; s += M / 2)
        {
            for (int i = 0; i < M; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
            Fft(re, im);
            for (int k = kLo; k <= kHi; k++) chroma[pc[k]] += Math.Sqrt(re[k] * re[k] + im[k] * im[k]);
        }
        double best = double.MinValue; int bk = 0; bool minor = false;
        for (int r = 0; r < 12; r++)
        {
            double cM = Corr(chroma, Major, r), cm = Corr(chroma, Minor, r);
            if (cM > best) { best = cM; bk = r; minor = false; }
            if (cm > best) { best = cm; bk = r; minor = true; }
        }
        return (Notes[bk] + (minor ? "m" : ""), (minor ? CamMinor[bk] : CamMajor[bk]) + (minor ? "A" : "B"));
    }

    static double Corr(double[] c, double[] prof, int rot)
    {
        double mc = c.Average(), mp = prof.Average(), num = 0, dc = 0, dp = 0;
        for (int i = 0; i < 12; i++)
        {
            double a = c[(i + rot) % 12] - mc, b = prof[i] - mp;
            num += a * b; dc += a * a; dp += b * b;
        }
        return num / Math.Sqrt(dc * dp + 1e-12);
    }

    static void Fft(double[] re, double[] im)
    {
        int n = re.Length;
        for (int i = 1, j = 0; i < n; i++)
        {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { (re[i], re[j]) = (re[j], re[i]); (im[i], im[j]) = (im[j], im[i]); }
        }
        for (int len = 2; len <= n; len <<= 1)
        {
            double ang = -2 * Math.PI / len, wr = Math.Cos(ang), wi = Math.Sin(ang);
            int half = len / 2;
            for (int i = 0; i < n; i += len)
            {
                double cr = 1, ci = 0;
                for (int k = 0; k < half; k++)
                {
                    int a = i + k, b = a + half;
                    double xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                    double t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
                }
            }
        }
    }
}
