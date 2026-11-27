using System.IO;
using UsageOrb.Core;

namespace UsageOrb.Services;

/// <summary>
/// Watches Antigravity transcripts and conversation metadata with debounced
/// background refresh so UI components receive real-time snapshots without blocking the UI thread.
/// </summary>
public sealed class TelemetryMonitorService : IDisposable
{
    private readonly List<FileSystemWatcher> _watchers = [];
    private readonly System.Threading.Timer _debounceTimer;
    private readonly System.Threading.Timer _periodicTimer;
    private readonly DesktopQuotaMonitor _desktopQuota;
    private readonly object _sync = new();
    private AppSettings _settings;
    private DashboardSnapshot? _latestSnapshot;
    private int _isRefreshing;
    private bool _disposed;

    public event Action<DashboardSnapshot>? SnapshotUpdated;

    public DashboardSnapshot? LatestSnapshot => _latestSnapshot;

    public TelemetryMonitorService(AppSettings initialSettings)
    {
        _settings = initialSettings.Clone();
        _debounceTimer = new System.Threading.Timer(_ => RefreshAsync(), null, Timeout.Infinite, Timeout.Infinite);
        _desktopQuota = new DesktopQuotaMonitor(RefreshAsync);
        _periodicTimer = new System.Threading.Timer(_ =>
        {
            RefreshAsync();
            _desktopQuota.Refresh();
        }, null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));

        SetupWatchers();
        RefreshAsync();
        _desktopQuota.Refresh();
    }

    public void UpdateSettings(AppSettings next)
    {
        lock (_sync)
        {
            _settings = next.Clone();
        }

        RefreshAsync();
    }

    public void RefreshNow()
    {
        _desktopQuota.Refresh(force: true);
        RefreshAsync();
    }

    private void SetupWatchers()
    {
        foreach (var root in AntigravityPaths.GetExistingBrainRoots())
        {
            TryAddWatcher(root.BrainDir, "*.jsonl", includeSubdirectories: true);
        }

        foreach (var root in AntigravityPaths.GetBrainRoots())
        {
            TryAddWatcher(Path.GetDirectoryName(root.BrainDir)!, ConversationSummaries.DatabaseName + "*", includeSubdirectories: false);
        }
    }

    private void TryAddWatcher(string dir, string filter, bool includeSubdirectories)
    {
        try
        {
            if (!Directory.Exists(dir)) return;
            var fsw = new FileSystemWatcher(dir, filter)
            {
                IncludeSubdirectories = includeSubdirectories,
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName | NotifyFilters.CreationTime,
                EnableRaisingEvents = true,
            };

            FileSystemEventHandler onChange = (_, _) => ScheduleDebouncedRefresh();
            fsw.Changed += onChange;
            fsw.Created += onChange;
            fsw.Deleted += onChange;
            fsw.Renamed += (_, _) => ScheduleDebouncedRefresh();
            _watchers.Add(fsw);
        }
        catch
        {
            // Ignore unwatched folder errors gracefully; periodic timer still keeps data fresh
        }
    }

    private void ScheduleDebouncedRefresh()
    {
        if (_disposed) return;
        try
        {
            _debounceTimer.Change(220, Timeout.Infinite);
        }
        catch
        {
            // Ignore if disposed concurrently
        }
    }

    private void RefreshAsync()
    {
        if (_disposed) return;
        if (Interlocked.Exchange(ref _isRefreshing, 1) == 1)
        {
            ScheduleDebouncedRefresh();
            return;
        }

        Task.Run(() =>
        {
            try
            {
                AppSettings settingsCopy;
                lock (_sync)
                {
                    settingsCopy = _settings.Clone();
                }

                var snapshot = AnalyticsEngine.Collect(settingsCopy, desktopQuota: _desktopQuota.Snapshot);
                _latestSnapshot = snapshot;
                SnapshotUpdated?.Invoke(snapshot);
            }
            catch
            {
                // Never crash background telemetry refresh
            }
            finally
            {
                Interlocked.Exchange(ref _isRefreshing, 0);
            }
        });
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _debounceTimer.Dispose();
        _periodicTimer.Dispose();
        _desktopQuota.Dispose();
        foreach (var w in _watchers)
        {
            w.EnableRaisingEvents = false;
            w.Dispose();
        }

        _watchers.Clear();
    }
}
