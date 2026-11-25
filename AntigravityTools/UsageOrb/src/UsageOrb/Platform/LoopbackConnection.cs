using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace UsageOrb.Platform;

internal static class LoopbackConnection
{
    public static async ValueTask<Stream> ConnectAsync(int pid, int port, CancellationToken cancellationToken)
    {
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        try
        {
            await socket.ConnectAsync(IPAddress.Loopback, port, cancellationToken).ConfigureAwait(false);
            var clientPort = ((IPEndPoint)socket.LocalEndPoint!).Port;
            if (!IsOwnedBy(pid, port, clientPort))
            {
                throw new IOException("The loopback connection is not owned by the registered Antigravity server.");
            }
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private static bool IsOwnedBy(int pid, int serverPort, int clientPort)
    {
        const int ipv4 = 2;
        const int ownerPidConnections = 4;
        const int insufficientBuffer = 122;
        const int established = 5;
        const int loopback = 0x0100007f;
        int size = 0;
        if (GetExtendedTcpTable(0, ref size, false, ipv4, ownerPidConnections, 0) != insufficientBuffer) return false;

        for (int attempt = 0; attempt < 2; attempt++)
        {
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                int result = GetExtendedTcpTable(buffer, ref size, false, ipv4, ownerPidConnections, 0);
                if (result == insufficientBuffer) continue;
                if (result != 0) return false;

                const int rowSize = 6 * sizeof(int);
                int count = Marshal.ReadInt32(buffer);
                for (int i = 0; i < count; i++)
                {
                    var row = buffer + sizeof(int) + i * rowSize;
                    if (Marshal.ReadInt32(row, 20) == pid && Marshal.ReadInt32(row, 0) == established &&
                        Marshal.ReadInt32(row, 4) == loopback && Marshal.ReadInt32(row, 12) == loopback &&
                        ReadPort(row, 8) == serverPort && ReadPort(row, 16) == clientPort)
                    {
                        return true;
                    }
                }
                return false;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        return false;
    }

    private static int ReadPort(nint row, int offset) =>
        (ushort)IPAddress.NetworkToHostOrder(Marshal.ReadInt16(row, offset));

    [DllImport("iphlpapi.dll")]
    private static extern int GetExtendedTcpTable(nint buffer, ref int size, bool order, int family, int tableClass, int reserved);
}
