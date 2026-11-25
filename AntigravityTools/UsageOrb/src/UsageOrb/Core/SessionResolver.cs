namespace UsageOrb.Core;

public enum SessionBindSource
{
    ManualPin,
    WindowTitleMatch,
    WorkspaceMatch,
    UnmatchedWindow,
    LatestActive,
}

public sealed record ResolvedDisplaySession(
    SessionDetail? Session,
    SessionBindSource Source,
    string SourceLabel);

/// <summary>
/// Resolves which conversation should be displayed across the Floating Orb, 3-Metric Pill,
/// Hover Mini-Card, Click Popover, System Tray, and Management Console Overview card.
/// Priority:
/// 1. Explicit manual pin selected by the user.
/// 2. Live Win32 Antigravity window title match (conversation title or workspace folder).
/// 3. Most recently active transcript / CLI statusLine session.
/// </summary>
public static class SessionResolver
{
    private static readonly HashSet<string> GenericHostSegments = new(StringComparer.OrdinalIgnoreCase)
    {
        "antigravity",
        "google antigravity",
        "antigravity ide",
        "visual studio code",
        "vscode",
        "code",
        "powershell",
        "windows terminal",
        "terminal",
        "cmd",
    };

    private static readonly HashSet<string> GenericDirNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "src", "source", "tests", "test", "bin", "obj", "dist", "build",
        "users", "program", "program files", "code", "projects", "repos",
        "windows", "temp", "tmp", "desktop", "documents", "downloads",
    };

    private static readonly string[] TitleSeparators = [" — ", " – ", " - ", " | ", " · "];

    public static ResolvedDisplaySession Resolve(
        DashboardSnapshot? snapshot,
        string? pinnedConversationId,
        string? trackedWindowTitle,
        AntigravitySurface? trackedSurface = null)
    {
        if (snapshot is null || snapshot.Sessions.Count == 0)
        {
            return new ResolvedDisplaySession(null, SessionBindSource.LatestActive, "Auto");
        }

        // 1. Explicit manual pin takes top priority across all surfaces
        if (!string.IsNullOrWhiteSpace(pinnedConversationId))
        {
            var pinned = snapshot.Sessions.FirstOrDefault(s =>
                string.Equals(s.ConversationId, pinnedConversationId, StringComparison.OrdinalIgnoreCase));
            if (pinned is not null)
            {
                return new ResolvedDisplaySession(pinned, SessionBindSource.ManualPin, "Pinned");
            }
        }

        // 2. Smart match against the focused Antigravity window title (chat title or workspace folder)
        if (!string.IsNullOrWhiteSpace(trackedWindowTitle))
        {
            var segments = ExtractCandidateTitleSegments(trackedWindowTitle);
            if (segments.Count > 0)
            {
                var primaries = snapshot.Sessions.Where(s => !s.IsSubagent &&
                    (trackedSurface is null || s.Surface == trackedSurface)).ToList();

                // 2A. Conversation title match
                SessionDetail? bestTitleMatch = null;
                int bestTitleScore = 0;
                bool ambiguous = false;

                foreach (var seg in segments)
                {
                    foreach (var s in primaries)
                    {
                        var st = s.Title?.Trim();
                        if (string.IsNullOrEmpty(st)) continue;

                        int score = ScoreTitleMatch(seg, st);
                        if (score > bestTitleScore)
                        {
                            bestTitleScore = score;
                            bestTitleMatch = s;
                            ambiguous = false;
                        }
                        else if (score > 0 && score == bestTitleScore && bestTitleMatch != s)
                        {
                            ambiguous = true;
                        }
                    }
                }

                if (bestTitleMatch is not null && !ambiguous)
                {
                    return new ResolvedDisplaySession(bestTitleMatch, SessionBindSource.WindowTitleMatch, "Window");
                }

                if (ambiguous || trackedSurface == AntigravitySurface.App)
                {
                    return new ResolvedDisplaySession(null, SessionBindSource.UnmatchedWindow, "Unmatched");
                }

                // 2B. Workspace folder match (e.g. "tools - Antigravity" or "file.cs - tools - Antigravity")
                foreach (var seg in segments)
                {
                    if (seg.Length < 2 || GenericDirNames.Contains(seg)) continue;

                    var wsMatch = primaries.FirstOrDefault(s => WorkspaceMatchesSegment(s.Workspace, seg));
                    if (wsMatch is not null)
                    {
                        return new ResolvedDisplaySession(wsMatch, SessionBindSource.WorkspaceMatch, "Workspace");
                    }
                }
            }
        }

        if (trackedSurface == AntigravitySurface.App)
        {
            return new ResolvedDisplaySession(null, SessionBindSource.UnmatchedWindow, "Unmatched");
        }

        // 3. Fallback: most recently active transcript / live CLI statusLine
        var latest = trackedSurface is not null && snapshot.ActiveSession?.Surface != trackedSurface
            ? snapshot.Sessions.FirstOrDefault(s => s.Surface == trackedSurface && !s.IsSubagent)
            : snapshot.ActiveSession;
        return new ResolvedDisplaySession(latest ?? snapshot.ActiveSession, SessionBindSource.LatestActive, "Auto");
    }

    private static List<string> ExtractCandidateTitleSegments(string windowTitle)
    {
        var rawParts = windowTitle.Split(TitleSeparators, StringSplitOptions.RemoveEmptyEntries);
        var list = new List<string>(rawParts.Length + 1);
        foreach (var raw in rawParts.Prepend(windowTitle).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var trimmed = raw.Trim().TrimStart('●', '★', '•', '*').Trim();
            if (trimmed.Length == 0) continue;
            if (GenericHostSegments.Contains(trimmed)) continue;
            list.Add(trimmed);
        }

        return list;
    }

    private static int ScoreTitleMatch(string windowSegment, string sessionTitle)
    {
        // Strip trailing ellipsis when windows truncate long titles
        if (string.Equals(windowSegment, sessionTitle, StringComparison.OrdinalIgnoreCase))
        {
            return 1000 + windowSegment.Length;
        }

        if (windowSegment.EndsWith("...", StringComparison.Ordinal) || windowSegment.EndsWith('…'))
        {
            var prefix = windowSegment.TrimEnd('.', '…').TrimEnd();
            if (prefix.Length >= 4 && sessionTitle.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return 800 + prefix.Length;
            }
        }

        return 0;
    }

    private static bool WorkspaceMatchesSegment(string? workspace, string segment)
    {
        if (string.IsNullOrWhiteSpace(workspace)) return false;

        try
        {
            var normalized = workspace.Replace('/', '\\').TrimEnd('\\');
            var parts = normalized.Split('\\', StringSplitOptions.RemoveEmptyEntries);

            // Check the leaf workspace directory first, then up to 2 meaningful ancestor folders
            int checkedCount = 0;
            for (int i = parts.Length - 1; i >= 1 && checkedCount < 3; i--)
            {
                var dirName = parts[i];
                if (GenericDirNames.Contains(dirName)) continue;
                checkedCount++;
                if (string.Equals(dirName, segment, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
        }
        catch
        {
            // Ignore invalid path characters
        }

        return false;
    }
}
