using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Text.Json;

if (args.Length != 1)
{
    Console.Error.WriteLine("usage: dotnet run -- <h2c-url>");
    return 2;
}

var pingEnabled = Environment.GetEnvironmentVariable("PING_ENABLED") != "0";
using var handler = new SocketsHttpHandler
{
    UseProxy = false,
    PooledConnectionIdleTimeout = TimeSpan.FromSeconds(90),
    EnableMultipleHttp2Connections = true,
};
if (pingEnabled)
{
    handler.KeepAlivePingDelay = TimeSpan.FromSeconds(1);
    handler.KeepAlivePingTimeout = TimeSpan.FromSeconds(2);
    handler.KeepAlivePingPolicy = HttpKeepAlivePingPolicy.Always;
}
using var client = new HttpClient(handler);
using var request = new HttpRequestMessage(HttpMethod.Get, args[0])
{
    Version = HttpVersion.Version20,
    VersionPolicy = HttpVersionPolicy.RequestVersionExact,
};
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
var started = Stopwatch.StartNew();
using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token);
await using var body = await response.Content.ReadAsStreamAsync(cts.Token);
using var buffer = new MemoryStream();
var bytes = new byte[3];
var arrivals = new List<object>();
while (true)
{
    var n = await body.ReadAsync(bytes, cts.Token);
    if (n == 0) break;
    await buffer.WriteAsync(bytes.AsMemory(0, n), cts.Token);
    arrivals.Add(new { atMs = started.Elapsed.TotalMilliseconds, text = System.Text.Encoding.UTF8.GetString(bytes, 0, n) });
}
Console.WriteLine(JsonSerializer.Serialize(new
{
    runtime = Environment.Version.ToString(),
    pingEnabled,
    status = (int)response.StatusCode,
    version = response.Version.ToString(),
    body = System.Text.Encoding.UTF8.GetString(buffer.ToArray()),
    arrivals,
    trailers = response.TrailingHeaders.Select(h => new { h.Key, Value = string.Join(",", h.Value) }).ToArray(),
}));
return 0;
