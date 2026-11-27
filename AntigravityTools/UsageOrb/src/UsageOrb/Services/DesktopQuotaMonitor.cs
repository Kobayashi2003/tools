using System.IO;
using System.Net.Http;
using System.Text.Json;
using UsageOrb.Core;

namespace UsageOrb.Services;

internal sealed class DesktopQuotaMonitor : IDisposable
{
    private readonly CancellationTokenSource _shutdown = new();
    private readonly CancellationToken _cancellationToken;
    private readonly Action _onUpdated;
    private volatile DesktopQuotaSnapshot? _snapshot;
    private DateTimeOffset _nextRead;
    private int _serverPid;
    private int _refreshing;

    public DesktopQuotaMonitor(Action onUpdated)
    {
        _onUpdated = onUpdated;
        _cancellationToken = _shutdown.Token;
    }

    public DesktopQuotaSnapshot? Snapshot => _snapshot;

    public void Refresh(bool force = false)
    {
        if (_cancellationToken.IsCancellationRequested || Interlocked.Exchange(ref _refreshing, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try
            {
                var server = DesktopQuotaClient.FindServer();
                int pid = server?.Pid ?? 0;
                if (pid != _serverPid)
                {
                    _serverPid = pid;
                    _nextRead = default;
                    if (_snapshot is not null)
                    {
                        _snapshot = null;
                        _onUpdated();
                    }
                }

                if (server is null || (!force && DateTimeOffset.UtcNow < _nextRead)) return;
                _nextRead = DateTimeOffset.UtcNow.AddSeconds(30);
                var readings = await DesktopQuotaClient.ReadAsync(server, _cancellationToken).ConfigureAwait(false);
                if (readings is null || _cancellationToken.IsCancellationRequested) return;

                var capturedAt = DateTimeOffset.UtcNow;
                _snapshot = DesktopQuotaSnapshot.Capture(capturedAt, readings, _snapshot);
                _nextRead = capturedAt.AddMinutes(1);
                _onUpdated();
            }
            catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or IOException or JsonException or UnauthorizedAccessException)
            {
                // Quota failures should leave transcript updates running.
            }
            finally
            {
                Interlocked.Exchange(ref _refreshing, 0);
            }
        });
    }

    public void Dispose()
    {
        _shutdown.Cancel();
        _shutdown.Dispose();
    }
}
