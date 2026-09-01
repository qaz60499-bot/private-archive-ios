using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

internal static class Launcher
{
    private const string DefaultUrl = "https://photo.joye.cc.cd/?app=personal-desktop";
#if LOCAL
    // Local.exe now opens the real archive by default. The isolated mock UI is
    // retained only behind --preview so the normal entry can never be mistaken
    // for the user's Telegram-backed production archive.
    private const int PreferredLocalPort = 8808;
    private const int FirstFallbackPort = 8810;
    private const int LastFallbackPort = 8838;
    private const string PreviewLaunchMutexName = @"Local\PrivateArchivePreviewLaunch";
    private static readonly string LocalRoot = Path.GetFullPath(
        Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
    private static readonly string PreviewRuntimeRoot = Path.Combine(
        Path.GetTempPath(), "PrivateArchivePreview");
    private static readonly string PreviewLeaseRoot = Path.Combine(
        PreviewRuntimeRoot, "leases");
#endif

    [STAThread]
    private static void Main(string[] args)
    {
#if LOCAL
        if (RunPreviewMaintenanceMode(args)) return;
#endif

        string url = DefaultUrl;
        bool isolatedPreview = false;
        string previewProfileDir = null;
#if LOCAL
        int previewPort = -1;
        Mutex previewLaunchMutex = null;
        bool previewLaunchMutexHeld = false;

        foreach (string arg in args)
        {
            if (string.Equals(arg, "--preview", StringComparison.OrdinalIgnoreCase))
            {
                isolatedPreview = true;
                break;
            }
        }

        if (isolatedPreview)
        {
            if (!TryAcquirePreviewLaunchMutex(out previewLaunchMutex)) return;
            previewLaunchMutexHeld = true;

            CleanupStalePreviewWorkers();
            previewPort = ResolveLocalPort();
            if (previewPort <= 0)
            {
                ReleasePreviewLaunchMutex(previewLaunchMutex);
                previewLaunchMutexHeld = false;
                return;
            }

            StartLocalWorker(previewPort);
            if (!WaitForLocal(previewPort, TimeSpan.FromSeconds(60)))
            {
                KillOwnedPreviewWorkersOnPort(previewPort);
                ReleasePreviewLaunchMutex(previewLaunchMutex);
                previewLaunchMutexHeld = false;
                return;
            }

            EnsureLocalDemoData(previewPort);
            previewProfileDir = CreatePreviewProfileDirectory();
            url = "http://127.0.0.1:" + previewPort + "/?localPreview=" + DateTime.UtcNow.Ticks;
        }
#endif

        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], "--url", StringComparison.OrdinalIgnoreCase))
            {
                url = args[i + 1];
                break;
            }
        }

        if (!IsAllowedUrl(url)) url = DefaultUrl;

        Process edge = LaunchEdgeApp(url, isolatedPreview, previewProfileDir);
        if (edge == null)
        {
            OpenDefaultBrowser(url);
#if LOCAL
            if (isolatedPreview)
            {
                WritePreviewLease(previewPort, 0, previewProfileDir);
                ReleasePreviewLaunchMutex(previewLaunchMutex);
                previewLaunchMutexHeld = false;
            }
#endif
            return;
        }

#if LOCAL
        if (isolatedPreview)
        {
            WritePreviewLease(previewPort, edge.Id, previewProfileDir);
            StartPreviewSupervisor(edge.Id, previewPort, previewProfileDir);
            ReleasePreviewLaunchMutex(previewLaunchMutex);
            previewLaunchMutexHeld = false;
        }

        if (previewLaunchMutexHeld)
            ReleasePreviewLaunchMutex(previewLaunchMutex);
#endif
    }

    private static bool IsAllowedUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return false;
        return url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            || url.StartsWith("http://127.0.0.1:", StringComparison.OrdinalIgnoreCase)
            || url.StartsWith("http://localhost:", StringComparison.OrdinalIgnoreCase);
    }

#if LOCAL
    private static bool TryAcquirePreviewLaunchMutex(out Mutex mutex)
    {
        mutex = null;
        try
        {
            mutex = new Mutex(false, PreviewLaunchMutexName);
            try
            {
                return mutex.WaitOne(TimeSpan.FromSeconds(90));
            }
            catch (AbandonedMutexException)
            {
                return true;
            }
        }
        catch
        {
            if (mutex != null) mutex.Dispose();
            mutex = null;
            return false;
        }
    }

    private static void ReleasePreviewLaunchMutex(Mutex mutex)
    {
        if (mutex == null) return;
        try { mutex.ReleaseMutex(); }
        catch { }
        try { mutex.Dispose(); }
        catch { }
    }

    private static int ResolveLocalPort()
    {
        if (!HttpReady(PreferredLocalPort))
            return PreferredLocalPort;

        for (int port = FirstFallbackPort; port <= LastFallbackPort; port++)
        {
            if (!HttpReady(port)) return port;
        }
        return -1;
    }

    private static bool HttpReady(int port)
    {
        try
        {
            using (var client = new TcpClient())
            {
                IAsyncResult result = client.BeginConnect("127.0.0.1", port, null, null);
                if (!result.AsyncWaitHandle.WaitOne(700)) return false;
                client.EndConnect(result);
                client.ReceiveTimeout = 900;
                client.SendTimeout = 900;
                using (NetworkStream stream = client.GetStream())
                {
                    byte[] request = Encoding.ASCII.GetBytes("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
                    stream.Write(request, 0, request.Length);
                    var buffer = new byte[16];
                    int read = stream.Read(buffer, 0, buffer.Length);
                    return read >= 5 && Encoding.ASCII.GetString(buffer, 0, read).StartsWith("HTTP/");
                }
            }
        }
        catch { return false; }
    }

    private static bool IsPrivateArchiveWorker(int port)
    {
        if (!HttpReady(port)) return false;
        try
        {
            using (var web = new WebClient())
            {
                web.Headers[HttpRequestHeader.CacheControl] = "no-cache";
                string health = web.DownloadString(
                    "http://127.0.0.1:" + port + "/api/health?launcherProbe=" + DateTime.UtcNow.Ticks);
                return health.IndexOf("\"service\":\"private-archive\"", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch { return false; }
    }

    private static void StartLocalWorker(int port)
    {
        try
        {
            string logPath = Path.Combine(Path.GetTempPath(), "PrivateArchive-wrangler-" + port + ".log");
            string command =
                "npx wrangler d1 migrations apply private-archive-db --local --persist-to .wrangler/local-preview-state >nul 2>&1" +
                " && npx wrangler dev --local --port " + port + " --persist-to .wrangler/local-preview-state" +
                " >> \"\"" + logPath + "\"\" 2>&1";
            var info = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/D /S /C \"" + command + "\"",
                WorkingDirectory = LocalRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(info);
        }
        catch { }
    }

    private static bool WaitForLocal(int port, TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow.Add(timeout);
        while (DateTime.UtcNow < deadline)
        {
            if (IsPrivateArchiveWorker(port)) return true;
            Thread.Sleep(350);
        }
        return false;
    }

    private static void EnsureLocalDemoData(int port)
    {
        try
        {
            using (var web = new WebClient())
            {
                web.Headers[HttpRequestHeader.ContentType] = "application/json";
                web.UploadString("http://127.0.0.1:" + port + "/api/dev/seed", "POST", "{}");
            }
        }
        catch { }
    }

    private static bool RunPreviewMaintenanceMode(string[] args)
    {
        if (args.Length == 0) return false;

        if (string.Equals(args[0], "--cleanup-stale-preview", StringComparison.OrdinalIgnoreCase))
        {
            CleanupStalePreviewWorkers();
            return true;
        }

        if (string.Equals(args[0], "--supervise-preview", StringComparison.OrdinalIgnoreCase) && args.Length >= 4)
        {
            int edgePid;
            int port;
            if (int.TryParse(args[1], out edgePid) && int.TryParse(args[2], out port))
                SupervisePreview(edgePid, port, args[3]);
            return true;
        }

        return false;
    }

    private static string CreatePreviewProfileDirectory()
    {
        string path = Path.Combine(PreviewRuntimeRoot, "profiles", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static string LeasePath(int port)
    {
        return Path.Combine(PreviewLeaseRoot, port + ".lease");
    }

    private static void WritePreviewLease(int port, int edgePid, string profileDir)
    {
        try
        {
            Directory.CreateDirectory(PreviewLeaseRoot);
            File.WriteAllLines(LeasePath(port), new[]
            {
                edgePid.ToString(),
                profileDir ?? string.Empty
            });
        }
        catch { }
    }

    private static void StartPreviewSupervisor(int edgePid, int port, string profileDir)
    {
        try
        {
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            Process.Start(new ProcessStartInfo
            {
                FileName = executable,
                Arguments = "--supervise-preview " + edgePid + " " + port + " \"" + profileDir + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
        }
        catch { }
    }

    private static void SupervisePreview(int edgePid, int port, string profileDir)
    {
        while (IsPreviewSessionAlive(edgePid, profileDir))
            Thread.Sleep(2000);

        KillOwnedPreviewWorkersOnPort(port);
        DeleteLeaseAndProfile(port, profileDir);
    }

    private static bool IsPreviewSessionAlive(int edgePid, string profileDir)
    {
        if (edgePid > 0)
        {
            try
            {
                Process process = Process.GetProcessById(edgePid);
                if (!process.HasExited && string.Equals(process.ProcessName, "msedge", StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            catch { }
        }

        if (string.IsNullOrWhiteSpace(profileDir)) return false;
        try
        {
            using (var searcher = new ManagementObjectSearcher(
                "SELECT CommandLine FROM Win32_Process WHERE Name='msedge.exe'"))
            {
                foreach (ManagementObject item in searcher.Get())
                {
                    string commandLine = Convert.ToString(item["CommandLine"]) ?? string.Empty;
                    if (commandLine.IndexOf(profileDir, StringComparison.OrdinalIgnoreCase) >= 0)
                        return true;
                }
            }
        }
        catch { }
        return false;
    }

    private static void CleanupStalePreviewWorkers()
    {
        var livePorts = new HashSet<int>();
        var liveProfiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            Directory.CreateDirectory(PreviewLeaseRoot);
            foreach (string leasePath in Directory.GetFiles(PreviewLeaseRoot, "*.lease"))
            {
                int port;
                if (!int.TryParse(Path.GetFileNameWithoutExtension(leasePath), out port))
                {
                    TryDeleteFile(leasePath);
                    continue;
                }

                string[] lines;
                try { lines = File.ReadAllLines(leasePath); }
                catch { lines = new string[0]; }

                int edgePid = 0;
                if (lines.Length > 0) int.TryParse(lines[0], out edgePid);
                string profileDir = lines.Length > 1 ? lines[1] : string.Empty;

                if (IsPreviewSessionAlive(edgePid, profileDir))
                {
                    livePorts.Add(port);
                    if (!string.IsNullOrWhiteSpace(profileDir))
                    {
                        try { liveProfiles.Add(Path.GetFullPath(profileDir)); }
                        catch { }
                    }
                    continue;
                }

                KillOwnedPreviewWorkersOnPort(port);
                DeleteLeaseAndProfile(port, profileDir);
            }
        }
        catch { }

        foreach (Tuple<int, int> worker in GetOwnedPreviewWranglers())
        {
            if (!livePorts.Contains(worker.Item2))
                KillProcessTree(worker.Item1);
        }

        CleanupOrphanPreviewProfiles(liveProfiles);
    }

    private static void CleanupOrphanPreviewProfiles(HashSet<string> liveProfiles)
    {
        string profilesRoot = Path.Combine(PreviewRuntimeRoot, "profiles");
        if (!Directory.Exists(profilesRoot)) return;

        foreach (string profileDir in Directory.GetDirectories(profilesRoot))
        {
            string fullProfile;
            try { fullProfile = Path.GetFullPath(profileDir); }
            catch { continue; }
            if (liveProfiles.Contains(fullProfile)) continue;

            KillPreviewEdgeProcessesForProfile(fullProfile);
            try { Directory.Delete(fullProfile, true); }
            catch { }
        }
    }

    private static void KillPreviewEdgeProcessesForProfile(string profileDir)
    {
        try
        {
            using (var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe'"))
            {
                foreach (ManagementObject item in searcher.Get())
                {
                    string commandLine = Convert.ToString(item["CommandLine"]) ?? string.Empty;
                    if (commandLine.IndexOf(profileDir, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    int pid = Convert.ToInt32((uint)item["ProcessId"]);
                    KillProcessTree(pid);
                }
            }
        }
        catch { }
    }

    private static List<Tuple<int, int>> GetOwnedPreviewWranglers()
    {
        var result = new List<Tuple<int, int>>();
        try
        {
            using (var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'"))
            {
                foreach (ManagementObject item in searcher.Get())
                {
                    string commandLine = Convert.ToString(item["CommandLine"]) ?? string.Empty;
                    if (!IsOwnedPreviewWranglerCommand(commandLine)) continue;

                    int port = ExtractPreviewPort(commandLine);
                    if (port <= 0) continue;
                    int pid = Convert.ToInt32((uint)item["ProcessId"]);
                    result.Add(Tuple.Create(pid, port));
                }
            }
        }
        catch { }
        return result;
    }

    private static bool IsOwnedPreviewWranglerCommand(string commandLine)
    {
        if (commandLine.IndexOf(LocalRoot, StringComparison.OrdinalIgnoreCase) < 0) return false;
        if (commandLine.IndexOf("wrangler-dist\\cli.js", StringComparison.OrdinalIgnoreCase) < 0) return false;
        if (commandLine.IndexOf("--local", StringComparison.OrdinalIgnoreCase) < 0) return false;
        return commandLine.IndexOf(".wrangler/local-preview-state", StringComparison.OrdinalIgnoreCase) >= 0
            || commandLine.IndexOf(".wrangler\\local-preview-state", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static int ExtractPreviewPort(string commandLine)
    {
        if (ContainsPortArgument(commandLine, PreferredLocalPort)) return PreferredLocalPort;
        for (int port = FirstFallbackPort; port <= LastFallbackPort; port++)
        {
            if (ContainsPortArgument(commandLine, port)) return port;
        }
        return -1;
    }

    private static bool ContainsPortArgument(string commandLine, int port)
    {
        string marker = "--port " + port;
        int index = commandLine.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (index < 0) return false;
        int end = index + marker.Length;
        return end == commandLine.Length || char.IsWhiteSpace(commandLine[end]);
    }

    private static void KillOwnedPreviewWorkersOnPort(int port)
    {
        foreach (Tuple<int, int> worker in GetOwnedPreviewWranglers())
        {
            if (worker.Item2 == port)
                KillProcessTree(worker.Item1);
        }
    }

    private static void KillProcessTree(int pid)
    {
        try
        {
            using (Process killer = Process.Start(new ProcessStartInfo
            {
                FileName = "taskkill.exe",
                Arguments = "/PID " + pid + " /T /F",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            }))
            {
                if (killer != null) killer.WaitForExit(5000);
            }
        }
        catch { }
    }

    private static void DeleteLeaseAndProfile(int port, string profileDir)
    {
        TryDeleteFile(LeasePath(port));
        if (string.IsNullOrWhiteSpace(profileDir)) return;
        try
        {
            if (Directory.Exists(profileDir)) Directory.Delete(profileDir, true);
        }
        catch { }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch { }
    }
#endif

    private static Process LaunchEdgeApp(string url, bool isolatedPreview, string previewProfileDir)
    {
        string[] roots = new[]
        {
            Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
            Environment.GetEnvironmentVariable("ProgramFiles"),
            Environment.GetEnvironmentVariable("LOCALAPPDATA")
        };

        foreach (string root in roots)
        {
            if (string.IsNullOrWhiteSpace(root)) continue;
            string edge = Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe");
            if (!File.Exists(edge)) continue;
            try
            {
                string arguments = isolatedPreview
                    ? "--user-data-dir=\"" + previewProfileDir + "\" --inprivate --disk-cache-size=1 --app=\"" + url + "\" --start-maximized --no-first-run --no-default-browser-check"
                    : "--app=\"" + url + "\" --start-maximized --no-first-run --no-default-browser-check";
                return Process.Start(new ProcessStartInfo
                {
                    FileName = edge,
                    Arguments = arguments,
                    UseShellExecute = false
                });
            }
            catch { }
        }
        return null;
    }

    private static void OpenDefaultBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch { }
    }
}
