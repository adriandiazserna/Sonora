using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace Sonora;

/// <summary>
/// Cifrado de credenciales en reposo con DPAPI de Windows (ámbito: usuario actual).
/// Solo la cuenta de Windows que las guardó puede descifrarlas; copiar el archivo a otra
/// PC u otra cuenta no sirve. Se añade una entropía propia para que otra app que use DPAPI
/// no pueda descifrar por accidente estos datos.
/// </summary>
public static class Secrets
{
    static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Sonora.v1.credentials");
    const string Prefix = "dpapi:";

    public static string Protect(string plain)
    {
        if (string.IsNullOrEmpty(plain)) return null;
        var enc = ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), Entropy, DataProtectionScope.CurrentUser);
        return Prefix + Convert.ToBase64String(enc);
    }

    public static string Unprotect(string stored)
    {
        if (string.IsNullOrEmpty(stored) || !stored.StartsWith(Prefix)) return null;
        try
        {
            var dec = ProtectedData.Unprotect(Convert.FromBase64String(stored[Prefix.Length..]), Entropy, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(dec);
        }
        catch (CryptographicException) { return null; } // otra cuenta / otra PC: hay que volver a configurar
        catch (FormatException) { return null; }
    }

    /// <summary>Muestra solo el principio y el final («abcd…wxyz») para que la interfaz nunca reciba el valor completo.</summary>
    public static string Mask(string s) =>
        string.IsNullOrEmpty(s) ? null : s.Length <= 8 ? "••••" : s[..4] + "…" + s[^4..];

    /// <summary>Token aleatorio criptográficamente seguro (256 bits) en base64url.</summary>
    public static string NewToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Comparación en tiempo constante (evita ataques de temporización al validar el token).</summary>
    public static bool SafeEquals(string a, string b) =>
        a != null && b != null && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
}

/// <summary>
/// HTTPS forzado para todo el tráfico saliente: cualquier petición que no sea https:// se rechaza
/// antes de salir de la PC, y tampoco se aceptan hosts locales o de red privada (evita SSRF).
/// </summary>
public sealed class HttpsOnlyHandler : DelegatingHandler
{
    public HttpsOnlyHandler(HttpMessageHandler inner) : base(inner) { }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var u = req.RequestUri;
        if (u == null || u.Scheme != Uri.UriSchemeHttps) throw new HttpRequestException("Bloqueado: Sonora solo se conecta por HTTPS");
        if (!NetGuard.IsPublicHost(u)) throw new HttpRequestException("Bloqueado: destino local o de red privada");
        return base.SendAsync(req, ct);
    }
}

public static class NetGuard
{
    /// <summary>Convierte http:// en https:// (las fuentes de imágenes admiten ambos) y descarta cualquier otro esquema.</summary>
    public static Uri ToHttps(string url)
    {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url.Trim(), UriKind.Absolute, out var u)) return null;
        if (u.Scheme == Uri.UriSchemeHttp) u = new UriBuilder(u) { Scheme = Uri.UriSchemeHttps, Port = -1 }.Uri;
        if (u.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(u.UserInfo)) return null;
        return IsPublicHost(u) ? u : null;
    }

    /// <summary>Rechaza localhost, IPs de loopback, privadas, link-local y nombres sin dominio.</summary>
    public static bool IsPublicHost(Uri u)
    {
        var host = u.IdnHost;
        if (string.IsNullOrEmpty(host) || host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase) || host.EndsWith(".local", StringComparison.OrdinalIgnoreCase)) return false;
        return !IPAddress.TryParse(host.Trim('[', ']'), out var ip) ? host.Contains('.') : IsPublicIp(ip);
    }

    public static bool IsPublicIp(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip)) return false;
        if (ip.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = ip.GetAddressBytes();
            return !(b[0] == 10 || b[0] == 0 || b[0] == 127 || b[0] >= 224 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254) || (b[0] == 100 && b[1] >= 64 && b[1] <= 127));
        }
        return !(ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6UniqueLocal || ip.IsIPv6Multicast || ip.Equals(IPAddress.IPv6Any));
    }

    /// <summary>
    /// Conexión TCP que comprueba las IPs ya resueltas por DNS: así un dominio público que apunte
    /// a 127.0.0.1 o a 192.168.x.x (DNS rebinding) tampoco puede usarse para llegar a la red local.
    /// </summary>
    public static async ValueTask<Stream> ConnectPublic(SocketsHttpConnectionContext ctx, CancellationToken ct)
    {
        var all = await Dns.GetHostAddressesAsync(ctx.DnsEndPoint.Host, ct);
        var ok = all.Where(IsPublicIp).ToArray();
        if (ok.Length == 0) throw new HttpRequestException("Bloqueado: el dominio apunta a una dirección local o privada");
        var s = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try { await s.ConnectAsync(ok, ctx.DnsEndPoint.Port, ct); return new NetworkStream(s, ownsSocket: true); }
        catch { s.Dispose(); throw; }
    }
}
