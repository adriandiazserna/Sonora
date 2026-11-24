namespace Sonora;

/// <summary>
/// Cola de análisis en un hilo de prioridad mínima.
/// - Prioritaria: lo que el DJ necesita ya (siempre corre, incluso minimizado).
/// - De fondo: el resto de la biblioteca (se pausa en modo juego o con la ventana minimizada).
/// </summary>
public class DjAnalyzer
{
    readonly Library lib;
    readonly LinkedList<string> urgent = new(), background = new();
    readonly HashSet<string> queued = new();
    readonly AutoResetEvent signal = new(false);
    readonly object gate = new();
    public volatile bool AllowBackground = true;
    int done, total;
    List<object> batch = new();

    public event Action<int, int, string> Progress;
    public event Action<List<object>> Results;

    public DjAnalyzer(Library lib)
    {
        this.lib = lib;
        new Thread(Loop) { IsBackground = true, Priority = ThreadPriority.Lowest, Name = "Sonora DJ analyzer" }.Start();
    }

    public static bool Needs(Track t) => t != null && t.Playable && (t.Dj == null || t.Dj.V != BeatAnalyzer.Version);

    public object Status()
    {
        var all = lib.All().Where(t => t.Playable).ToList();
        lock (gate) return new { analyzed = all.Count(t => !Needs(t)), playable = all.Count, pending = urgent.Count + background.Count, done, total };
    }

    public void Enqueue(IEnumerable<string> ids, bool priority)
    {
        lock (gate)
        {
            var list = priority ? ids.Reverse() : ids; // al frente conservando el orden pedido
            foreach (var id in list)
            {
                if (!Needs(lib.Get(id))) continue;
                if (queued.Contains(id))
                {
                    if (!priority) continue;
                    background.Remove(id); urgent.Remove(id);
                }
                else { queued.Add(id); total++; }
                if (priority) urgent.AddFirst(id); else background.AddLast(id);
            }
        }
        signal.Set();
    }

    public void Wake() => signal.Set();

    void Loop()
    {
        while (true)
        {
            string id = null;
            lock (gate)
            {
                if (urgent.Count > 0) { id = urgent.First.Value; urgent.RemoveFirst(); }
                else if (AllowBackground && background.Count > 0) { id = background.First.Value; background.RemoveFirst(); }
                if (id != null) queued.Remove(id);
            }
            if (id == null)
            {
                Flush();
                signal.WaitOne(3000);
                continue;
            }
            var t = lib.Get(id);
            if (!Needs(t)) continue;
            try { t.Dj = BeatAnalyzer.Analyze(t.Path); }
            catch { t.Dj = new DjInfo { V = BeatAnalyzer.Version }; } // formato no soportado por Media Foundation
            int d, tot; bool empty;
            lock (gate) { d = ++done; tot = total; empty = urgent.Count == 0 && background.Count == 0; batch.Add(new { id, dj = t.Dj }); }
            Progress?.Invoke(d, tot, t.Title);
            if (batch.Count >= 4 || empty || urgent.Count > 0) Flush();
            if (empty) lock (gate) { done = 0; total = 0; }
        }
    }

    void Flush()
    {
        List<object> b;
        lock (gate) { if (batch.Count == 0) return; b = batch; batch = new(); }
        lib.SaveLater();
        Results?.Invoke(b);
    }
}
