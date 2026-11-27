namespace UsageOrb.Core;

internal sealed record DesktopQuotaReading(
    string Label,
    string? PoolName,
    double? RemainingFraction,
    double? RemainingAmount,
    DateTimeOffset? ResetTime,
    double? ResetInSeconds,
    bool Disabled,
    WindowKey? Window);

internal sealed record DesktopQuotaSnapshot(
    DateTimeOffset CapturedAt,
    IReadOnlyDictionary<string, DesktopQuotaReading> Buckets,
    IReadOnlyList<QuotaHistoryPoint> History)
{
    private const int MaxHistoryPoints = 500;

    public static DesktopQuotaSnapshot Capture(
        DateTimeOffset capturedAt,
        IReadOnlyDictionary<string, DesktopQuotaReading> readings,
        DesktopQuotaSnapshot? previous = null)
    {
        var fractions = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        foreach (var (id, reading) in readings)
        {
            if (!reading.Disabled && reading.RemainingFraction is { } fraction) fractions.Add(id, fraction);
        }

        IReadOnlyList<QuotaHistoryPoint> history = previous?.History ?? [];
        var last = history.LastOrDefault();
        if (fractions.Count > 0 &&
            (last is null || capturedAt - last.CapturedAt >= TimeSpan.FromMinutes(1) ||
             last.RemainingFractions.Count != fractions.Count ||
             fractions.Any(pair => !last.RemainingFractions.TryGetValue(pair.Key, out var sample) || pair.Value != sample)))
        {
            history = history.TakeLast(MaxHistoryPoints - 1).Append(new QuotaHistoryPoint(capturedAt, fractions)).ToArray();
        }

        return new DesktopQuotaSnapshot(capturedAt, readings, history);
    }

    public IReadOnlyList<QuotaBucketStatus> BuildBucketStatuses(DateTimeOffset now)
    {
        var statuses = new List<QuotaBucketStatus>(Buckets.Count);
        foreach (var (id, reading) in Buckets)
        {
            double? burnRate = reading.RemainingFraction.HasValue ? EstimateBurnRate(id, now.AddHours(-5)) : null;
            DateTimeOffset? exhaustion = null;
            if (reading.RemainingFraction is > 0 && burnRate is > 0)
            {
                double hoursLeft = reading.RemainingFraction.Value / burnRate.Value;
                if (hoursLeft < 24 * 14) exhaustion = now.AddHours(hoursLeft);
            }

            var status = new QuotaBucketStatus(
                id, reading.Label, ModelCatalog.InferQuotaGroupFromBucketId(id),
                reading.RemainingFraction, reading.RemainingAmount, reading.ResetTime,
                reading.ResetInSeconds, reading.Disabled, CapturedAt, burnRate, exhaustion, null)
            {
                PoolName = reading.PoolName,
                Window = reading.Window,
            };

            if (exhaustion.HasValue && status.GetLiveResetInSeconds(now) is { } resetSeconds)
            {
                var resetAt = reading.ResetTime ?? now.AddSeconds(resetSeconds);
                status = status with { WillExhaustBeforeReset = exhaustion.Value < resetAt };
            }
            statuses.Add(status);
        }

        return statuses.OrderBy(status => status.RemainingFraction ?? 2.0).ToList();
    }

    private double? EstimateBurnRate(string id, DateTimeOffset cutoff)
    {
        (DateTimeOffset Time, double Fraction)? newest = null;
        (DateTimeOffset Time, double Fraction)? oldest = null;
        for (int i = History.Count - 1; i >= 0; i--)
        {
            var point = History[i];
            if (point.CapturedAt < cutoff) break;
            if (!point.RemainingFractions.TryGetValue(id, out var fraction)) continue;

            // A jump upward marks a reset. Samples before it belong to a different period.
            if (oldest is { } newer && fraction + 0.005 < newer.Fraction) break;
            oldest = (point.CapturedAt, fraction);
            newest ??= oldest;
        }

        if (newest is not { } end || oldest is not { } start) return null;
        double hours = (end.Time - start.Time).TotalHours;
        double used = start.Fraction - end.Fraction;
        return hours >= 0.05 && used > 0.0005 ? used / hours : null;
    }
}
