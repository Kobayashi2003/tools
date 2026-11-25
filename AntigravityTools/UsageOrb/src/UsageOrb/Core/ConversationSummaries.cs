using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace UsageOrb.Core;

internal sealed record ConversationSummary(
    AntigravitySurface Surface, string Title, string? ParentId, DateTimeOffset LastModified, string? Workspace);

internal static class ConversationSummaries
{
    internal const string DatabaseName = "conversation_summaries.db";

    public static Dictionary<string, ConversationSummary> Read()
    {
        var summaries = new Dictionary<string, ConversationSummary>(StringComparer.OrdinalIgnoreCase);
        foreach (var root in AntigravityPaths.GetBrainRoots())
        {
            var path = Path.Combine(Path.GetDirectoryName(root.BrainDir)!, DatabaseName);
            if (!File.Exists(path)) continue;

            nint db = 0;
            nint stmt = 0;
            try
            {
                // A live WAL can contain new titles, so open the database read-only without immutable mode.
                if (sqlite3_open_v2(path, out db, 1, 0) != 0) continue;
                const string sql = "SELECT conversation_id, title, parent_conversation_id, last_modified_time, workspace_uris FROM conversation_summaries";
                if (sqlite3_prepare_v2(db, sql, -1, out stmt, 0) != 0) continue;
                while (sqlite3_step(stmt) == 100)
                {
                    var id = Column(stmt, 0);
                    if (id.Length == 0) continue;
                    var parent = Column(stmt, 2);
                    DateTimeOffset.TryParse(Column(stmt, 3), out var modified);
                    var summary = new ConversationSummary(root.Surface, Column(stmt, 1),
                        parent.Length == 0 ? null : parent, modified, ReadWorkspace(Column(stmt, 4)));
                    if (!summaries.TryGetValue(id, out var existing) || modified > existing.LastModified)
                    {
                        summaries[id] = summary;
                    }
                }
            }
            finally
            {
                if (stmt != 0) sqlite3_finalize(stmt);
                if (db != 0) sqlite3_close(db);
            }
        }

        return summaries;
    }

    private static string? ReadWorkspace(string json)
    {
        try
        {
            foreach (var value in JsonSerializer.Deserialize<string[]>(json) ?? [])
            {
                if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.IsFile) return uri.LocalPath;
            }
        }
        catch (JsonException)
        {
            // Older entries can lack a workspace list.
        }

        return null;
    }

    private static string Column(nint statement, int index) =>
        Marshal.PtrToStringUTF8(sqlite3_column_text(statement, index)) ?? string.Empty;

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_open_v2([MarshalAs(UnmanagedType.LPUTF8Str)] string filename, out nint db, int flags, nint vfs);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_prepare_v2(nint db, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, int bytes, out nint stmt, nint tail);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_step(nint stmt);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern nint sqlite3_column_text(nint stmt, int index);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(nint stmt);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_close(nint db);
}
