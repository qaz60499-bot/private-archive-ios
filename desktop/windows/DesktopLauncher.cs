using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class DesktopLauncher
{
    private const string ProductName = "Private Archive";
    private const string BackendOrigin = "https://api.photo.joye.cc.cd";
    private const string AppSessionCookieName = "pa_account";
    private const string WebResource = "PrivateArchive.Web";
    private const string TelegramBridgeResource = "PrivateArchive.TelegramBridge";
    private const string ServerMutexName = @"Local\PrivateArchiveDesktopServer";
    private const int PreferredPort = 8798;
    private const int FirstFallbackPort = 8840;
    private const int LastFallbackPort = 8850;
    private const int PreferredBridgePort = 8797;
    private const int FirstBridgeFallbackPort = 8860;
    private const int LastBridgeFallbackPort = 8875;

    private static readonly string AppRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PrivateArchive");
    private static readonly string EdgeProfileDir = Path.Combine(AppRoot, "EdgeProfile");
    private static readonly string ServerStatePath = Path.Combine(AppRoot, "desktop-server.port");
    private static readonly string RuntimeDir = Path.Combine(AppRoot, "Runtime");
    private static readonly string TelegramBridgePath = Path.Combine(RuntimeDir, "TelegramStorageBridge.exe");

    [STAThread]
    private static void Main(string[] args)
    {
        Directory.CreateDirectory(AppRoot);
        Directory.CreateDirectory(EdgeProfileDir);
        Directory.CreateDirectory(RuntimeDir);

        bool serverOnly = HasArg(args, "--server-only");
        int serverOnlySeconds = ReadIntArg(args, "--server-seconds", 30);

        Mutex serverMutex = null;
        bool ownsMutex = false;
        Process telegramBridge = null;
        try
        {
            serverMutex = new Mutex(false, ServerMutexName);
            try { ownsMutex = serverMutex.WaitOne(0); }
            catch (AbandonedMutexException) { ownsMutex = true; }

            if (!ownsMutex)
            {
                int existingPort = WaitForExistingServer(TimeSpan.FromSeconds(12));
                if (existingPort > 0 && !serverOnly)
                    LaunchEdgeApp(LocalUrl(existingPort));
                return;
            }

            StopStaleTelegramBridges();

            int port = ResolveServerPort();
            if (port <= 0) return;

            int bridgePort = ResolveBridgePort();
            string bridgeSecret = CreateBridgeSecret();
            if (bridgePort > 0 && EnsureTelegramBridgeExecutable())
            {
                telegramBridge = StartTelegramBridge(bridgePort, bridgeSecret);
                if (telegramBridge == null || !WaitForTelegramBridge(bridgePort, bridgeSecret, TimeSpan.FromSeconds(20)))
                    bridgePort = -1;
            }
            else
            {
                bridgePort = -1;
            }

            using (var server = new LocalWebServer(port, bridgePort, bridgeSecret))
            {
                server.Start();
                WriteServerState(port);
                PurgeObsoleteDesktopServiceWorkerState();

                if (serverOnly)
                {
                    Thread.Sleep(TimeSpan.FromSeconds(Math.Max(1, serverOnlySeconds)));
                    return;
                }

                Process edge = LaunchEdgeApp(LocalUrl(port));
                if (edge == null)
                {
                    OpenDefaultBrowser(LocalUrl(port));
                    WaitForIdleServer(server, TimeSpan.FromMinutes(10));
                    return;
                }

                WaitForDesktopSession(edge.Id, TimeSpan.FromHours(12));
            }
        }
        catch
        {
            // The desktop shell is intentionally fail-closed: if the local server
            // cannot start, do not fall back to any remote web frontend.
        }
        finally
        {
            StopOwnedProcess(telegramBridge);
            TryDeleteFile(ServerStatePath);
            if (ownsMutex && serverMutex != null)
            {
                try { serverMutex.ReleaseMutex(); } catch { }
            }
            if (serverMutex != null) serverMutex.Dispose();
        }
    }

    private static bool HasArg(string[] args, string expected)
    {
        foreach (string arg in args)
            if (string.Equals(arg, expected, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static int ReadIntArg(string[] args, string name, int fallback)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (!string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) continue;
            int value;
            if (int.TryParse(args[i + 1], out value) && value > 0) return value;
        }
        return fallback;
    }

    private static string LocalUrl(int port)
    {
        return "http://127.0.0.1:" + port + "/?app=personal-desktop";
    }

    private static int ResolveServerPort()
    {
        if (CanBind(PreferredPort)) return PreferredPort;
        for (int port = FirstFallbackPort; port <= LastFallbackPort; port++)
            if (CanBind(port)) return port;
        return -1;
    }

    private static int ResolveBridgePort()
    {
        if (CanBind(PreferredBridgePort)) return PreferredBridgePort;
        for (int port = FirstBridgeFallbackPort; port <= LastBridgeFallbackPort; port++)
            if (CanBind(port)) return port;
        return -1;
    }

    private static string CreateBridgeSecret()
    {
        byte[] bytes = new byte[32];
        using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(bytes);
        return BitConverter.ToString(bytes).Replace("-", string.Empty).ToLowerInvariant();
    }

    private static bool EnsureTelegramBridgeExecutable()
    {
        string temp = TelegramBridgePath + ".new";
        try
        {
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(TelegramBridgeResource))
            {
                if (resource == null) return false;
                using (var output = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
                    resource.CopyTo(output);
            }
            if (File.Exists(TelegramBridgePath) && FilesHaveSameSha256(temp, TelegramBridgePath))
            {
                TryDeleteFile(temp);
                return true;
            }
            TryDeleteFile(TelegramBridgePath);
            File.Move(temp, TelegramBridgePath);
            return true;
        }
        catch
        {
            TryDeleteFile(temp);
            return File.Exists(TelegramBridgePath);
        }
    }

    private static bool FilesHaveSameSha256(string first, string second)
    {
        try
        {
            using (var sha = SHA256.Create())
            using (var left = File.OpenRead(first))
            using (var right = File.OpenRead(second))
            {
                byte[] a = sha.ComputeHash(left);
                byte[] b = sha.ComputeHash(right);
                return StructuralComparisons.StructuralEqualityComparer.Equals(a, b);
            }
        }
        catch { return false; }
    }

    private static Process StartTelegramBridge(int port, string secret)
    {
        try
        {
            var start = new ProcessStartInfo
            {
                FileName = TelegramBridgePath,
                Arguments = "--port " + port + " --parent-pid " + Process.GetCurrentProcess().Id,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = RuntimeDir,
            };
            start.EnvironmentVariables["PRIVATE_ARCHIVE_BRIDGE_SECRET"] = secret;
            return Process.Start(start);
        }
        catch { return null; }
    }

    private static bool WaitForTelegramBridge(int port, string secret, TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow.Add(timeout);
        while (DateTime.UtcNow < deadline)
        {
            if (TelegramBridgeReady(port, secret)) return true;
            Thread.Sleep(220);
        }
        return false;
    }

    private static bool TelegramBridgeReady(int port, string secret)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/v1/status");
            request.Method = "GET";
            request.Timeout = 900;
            request.ReadWriteTimeout = 900;
            request.Headers["X-Private-Archive-Bridge"] = secret;
            using (var response = (HttpWebResponse)request.GetResponse())
                return response.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    private static void StopOwnedProcess(Process process)
    {
        if (process == null) return;
        try
        {
            if (!process.HasExited)
            {
                process.CloseMainWindow();
                if (!process.WaitForExit(1500)) process.Kill();
            }
        }
        catch { }
        finally { try { process.Dispose(); } catch { } }
    }

    private static void StopStaleTelegramBridges()
    {
        Process[] processes = null;
        try { processes = Process.GetProcessesByName("TelegramStorageBridge"); }
        catch { return; }
        foreach (Process process in processes)
        {
            try
            {
                string executable = process.MainModule == null ? null : process.MainModule.FileName;
                if (!string.Equals(executable, TelegramBridgePath, StringComparison.OrdinalIgnoreCase)) continue;
                if (!process.HasExited)
                {
                    process.CloseMainWindow();
                    if (!process.WaitForExit(800)) process.Kill();
                    process.WaitForExit(1200);
                }
            }
            catch { }
            finally { try { process.Dispose(); } catch { } }
        }
    }

    private static bool CanBind(int port)
    {
        TcpListener listener = null;
        try
        {
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            return true;
        }
        catch { return false; }
        finally { if (listener != null) try { listener.Stop(); } catch { } }
    }

    private static void WriteServerState(int port)
    {
        try { File.WriteAllText(ServerStatePath, port.ToString(), Encoding.ASCII); } catch { }
    }

    private static int ReadServerState()
    {
        try
        {
            int port;
            if (int.TryParse(File.ReadAllText(ServerStatePath).Trim(), out port)) return port;
        }
        catch { }
        return -1;
    }

    private static int WaitForExistingServer(TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow.Add(timeout);
        while (DateTime.UtcNow < deadline)
        {
            int port = ReadServerState();
            if (port > 0 && LocalServerReady(port)) return port;
            Thread.Sleep(180);
        }
        return -1;
    }

    private static bool LocalServerReady(int port)
    {
        try
        {
            using (var web = new WebClient())
            {
                web.Headers[HttpRequestHeader.CacheControl] = "no-cache";
                string body = web.DownloadString("http://127.0.0.1:" + port + "/__private_archive_local_health");
                return body.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch { return false; }
    }

    private static Process LaunchEdgeApp(string url)
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
                string arguments =
                    "--user-data-dir=\"" + EdgeProfileDir + "\" " +
                    "--disable-background-mode --no-first-run --no-default-browser-check " +
                    "--app=\"" + url + "\" --start-maximized";
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

    private static void PurgeObsoleteDesktopServiceWorkerState()
    {
        // The desktop shell is versioned inside this executable, but an older PWA
        // service worker can still serve a stale cached index.html from the persistent
        // Edge profile. Remove only Service Worker/cache state before launching Edge;
        // keep Login Data, Cookies and Local Storage intact so saved credentials and
        // the HttpOnly pa_account session survive upgrades.
        string defaultProfile = Path.Combine(EdgeProfileDir, "Default");
        string[] disposable = new[]
        {
            Path.Combine(defaultProfile, "Service Worker"),
            Path.Combine(defaultProfile, "Cache"),
            Path.Combine(defaultProfile, "Code Cache"),
        };
        foreach (string path in disposable)
        {
            try
            {
                if (Directory.Exists(path)) Directory.Delete(path, true);
            }
            catch { }
        }
    }

    private static void OpenDefaultBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    private static bool HasDesktopEdgeProcess()
    {
        try
        {
            using (var searcher = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE Name='msedge.exe'"))
            {
                foreach (ManagementObject item in searcher.Get())
                {
                    string commandLine = Convert.ToString(item["CommandLine"]) ?? string.Empty;
                    if (commandLine.IndexOf(EdgeProfileDir, StringComparison.OrdinalIgnoreCase) >= 0)
                        return true;
                }
            }
        }
        catch { }
        return false;
    }

    private static void WaitForDesktopSession(int initialPid, TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow.Add(timeout);
        DateTime startupGrace = DateTime.UtcNow.AddSeconds(8);
        bool observed = false;
        while (DateTime.UtcNow < deadline)
        {
            bool alive = HasDesktopEdgeProcess();
            if (alive) observed = true;
            if (observed && !alive) return;
            if (!observed && DateTime.UtcNow >= startupGrace)
            {
                try
                {
                    Process process = Process.GetProcessById(initialPid);
                    if (process.HasExited) return;
                }
                catch { return; }
            }
            Thread.Sleep(700);
        }
    }

    private static void WaitForIdleServer(LocalWebServer server, TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow.Add(timeout);
        while (DateTime.UtcNow < deadline)
        {
            if (DateTime.UtcNow.Subtract(server.LastRequestUtc) > TimeSpan.FromMinutes(3)) return;
            Thread.Sleep(1000);
        }
    }

    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private sealed class LocalWebServer : IDisposable
    {
        private readonly int port;
        private readonly HttpListener listener;
        private readonly Thread acceptThread;
        private volatile bool stopping;
        private readonly int telegramBridgePort;
        private readonly string telegramBridgeSecret;
        public DateTime LastRequestUtc { get; private set; }

        public LocalWebServer(int port, int telegramBridgePort, string telegramBridgeSecret)
        {
            this.port = port;
            this.telegramBridgePort = telegramBridgePort;
            this.telegramBridgeSecret = telegramBridgeSecret ?? string.Empty;
            listener = new HttpListener();
            listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
            acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "PrivateArchiveLocalServer" };
            LastRequestUtc = DateTime.UtcNow;
        }

        public void Start()
        {
            listener.Start();
            acceptThread.Start();
        }

        private void AcceptLoop()
        {
            while (!stopping)
            {
                HttpListenerContext context = null;
                try { context = listener.GetContext(); }
                catch { if (stopping) return; }
                if (context == null) continue;
                ThreadPool.QueueUserWorkItem(delegate { Handle(context); });
            }
        }

        private void Handle(HttpListenerContext context)
        {
            LastRequestUtc = DateTime.UtcNow;
            try
            {
                string path = context.Request.Url.AbsolutePath;
                if (path == "/__private_archive_local_health")
                {
                    WriteText(context.Response, 200, "application/json; charset=utf-8", "{\"ok\":true,\"service\":\"private-archive-desktop\"}");
                    return;
                }
                if (path.StartsWith("/__telegram_storage/", StringComparison.OrdinalIgnoreCase))
                {
                    if (!RequireLocalMutationOrigin(context)) return;
                    ProxyTelegramBridge(context);
                    return;
                }
                if (path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase))
                {
                    if (!RequireLocalMutationOrigin(context)) return;
                    ProxyApi(context);
                    return;
                }
                ServeWeb(context);
            }
            catch
            {
                try { WriteText(context.Response, 500, "application/json; charset=utf-8", "{\"error\":\"LOCAL_SERVER_ERROR\"}"); } catch { }
            }
            finally
            {
                try { context.Response.OutputStream.Close(); } catch { }
            }
        }

        private bool RequireLocalMutationOrigin(HttpListenerContext context)
        {
            string method = context.Request.HttpMethod ?? string.Empty;
            if (string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase)
                || string.Equals(method, "HEAD", StringComparison.OrdinalIgnoreCase)
                || string.Equals(method, "OPTIONS", StringComparison.OrdinalIgnoreCase))
                return true;

            string expected = "http://127.0.0.1:" + port;
            string origin = context.Request.Headers["Origin"] ?? string.Empty;
            if (string.Equals(origin, expected, StringComparison.OrdinalIgnoreCase)) return true;

            WriteText(context.Response, 403, "application/json; charset=utf-8", "{\"error\":\"LOCAL_ORIGIN_NOT_ALLOWED\"}");
            return false;
        }

        private static void ApplyLocalBrowserSecurityHeaders(HttpListenerResponse response)
        {
            response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
            response.Headers["X-Content-Type-Options"] = "nosniff";
            response.Headers["X-Frame-Options"] = "DENY";
            response.Headers["Referrer-Policy"] = "no-referrer";
            response.Headers["Permissions-Policy"] = "geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), document-domain=()";
            response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
        }

        private void ServeWeb(HttpListenerContext context)
        {
            string path = Uri.UnescapeDataString(context.Request.Url.AbsolutePath).Replace('\\', '/');
            if (path.Contains("..")) { WriteText(context.Response, 400, "text/plain", "Bad request"); return; }
            string entryName = path.TrimStart('/');
            if (entryName.Length == 0) entryName = "index.html";

            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(WebResource))
            {
                if (resource == null) { WriteText(context.Response, 500, "text/plain", "Desktop web bundle missing"); return; }
                using (var archive = new ZipArchive(resource, ZipArchiveMode.Read, false))
                {
                    ZipArchiveEntry entry = archive.GetEntry(entryName);
                    if (entry == null) entry = archive.GetEntry(entryName.Replace('/', '\\'));
                    if (entry == null && Path.GetExtension(entryName).Length == 0)
                        entry = archive.GetEntry("index.html");
                    if (entry == null) { WriteText(context.Response, 404, "text/plain", "Not found"); return; }

                    context.Response.StatusCode = 200;
                    ApplyLocalBrowserSecurityHeaders(context.Response);
                    context.Response.ContentType = ContentType(entry.FullName);
                    context.Response.ContentLength64 = entry.Length;
                    if (string.Equals(entry.FullName, "index.html", StringComparison.OrdinalIgnoreCase) || string.Equals(entry.FullName, "sw.js", StringComparison.OrdinalIgnoreCase))
                        context.Response.Headers[HttpResponseHeader.CacheControl] = "no-store";
                    else if (entry.FullName.StartsWith("assets/", StringComparison.OrdinalIgnoreCase))
                        context.Response.Headers[HttpResponseHeader.CacheControl] = "public, max-age=31536000, immutable";

                    if (!string.Equals(context.Request.HttpMethod, "HEAD", StringComparison.OrdinalIgnoreCase))
                    {
                        using (Stream input = entry.Open()) input.CopyTo(context.Response.OutputStream);
                    }
                }
            }
        }

        private sealed class BackendJsonResult
        {
            public int StatusCode;
            public string RawBody;
            public Dictionary<string, object> Body;
        }

        private BackendJsonResult RequestBackendJson(HttpListenerRequest source, string path, string uploadToken)
        {
            var request = (HttpWebRequest)WebRequest.Create(BackendOrigin + path);
            request.Method = "GET";
            request.AllowAutoRedirect = false;
            request.Timeout = 30000;
            request.ReadWriteTimeout = 30000;
            request.KeepAlive = true;
            request.UserAgent = "PrivateArchiveDesktop/0.1.0";
            request.Headers["X-Requested-With"] = "XMLHttpRequest";
            CopyAppSessionCookie(source, request);
            if (!string.IsNullOrWhiteSpace(uploadToken)) request.Headers["X-Upload-Token"] = uploadToken;

            HttpWebResponse response = null;
            try { response = (HttpWebResponse)request.GetResponse(); }
            catch (WebException ex) { response = ex.Response as HttpWebResponse; if (response == null) throw; }
            using (response)
            using (Stream input = response.GetResponseStream())
            using (var reader = new StreamReader(input ?? Stream.Null, Encoding.UTF8, true))
            {
                string raw = reader.ReadToEnd();
                Dictionary<string, object> body = null;
                try { body = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(raw); } catch { }
                return new BackendJsonResult
                {
                    StatusCode = (int)response.StatusCode,
                    RawBody = string.IsNullOrWhiteSpace(raw) ? "{}" : raw,
                    Body = body ?? new Dictionary<string, object>()
                };
            }
        }

        private static string JsonString(Dictionary<string, object> body, string key)
        {
            object value;
            return body != null && body.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : null;
        }

        private static long JsonLong(Dictionary<string, object> body, string key)
        {
            object value;
            if (body == null || !body.TryGetValue(key, out value) || value == null) return -1;
            try { return Convert.ToInt64(value); } catch { return -1; }
        }

        private bool RequireOwnerSession(HttpListenerContext context)
        {
            if (string.IsNullOrWhiteSpace(context.Request.Headers["Cookie"]))
            {
                WriteText(context.Response, 401, "application/json; charset=utf-8", "{\"error\":\"APP_AUTH_REQUIRED\"}");
                return false;
            }

            BackendJsonResult auth;
            try { auth = RequestBackendJson(context.Request, "/api/auth/me", null); }
            catch
            {
                WriteText(context.Response, 503, "application/json; charset=utf-8", "{\"error\":\"BACKEND_AUTH_UNAVAILABLE\"}");
                return false;
            }
            if (auth.StatusCode != 200)
            {
                WriteText(context.Response, auth.StatusCode, "application/json; charset=utf-8", auth.RawBody);
                return false;
            }
            object userValue;
            var user = auth.Body.TryGetValue("user", out userValue) ? userValue as Dictionary<string, object> : null;
            if (!string.Equals(JsonString(user, "role"), "OWNER", StringComparison.OrdinalIgnoreCase))
            {
                WriteText(context.Response, 403, "application/json; charset=utf-8", "{\"error\":\"OWNER_AUTH_REQUIRED\"}");
                return false;
            }
            return true;
        }

        private bool TryBridgeLocator(HttpListenerContext context, string assetId, string endpoint, string uploadToken, out string chatId, out long messageId, out BackendJsonResult result)
        {
            chatId = null;
            messageId = -1;
            result = null;
            try { result = RequestBackendJson(context.Request, "/api/assets/" + Uri.EscapeDataString(assetId) + endpoint, uploadToken); }
            catch
            {
                WriteText(context.Response, 503, "application/json; charset=utf-8", "{\"error\":\"BACKEND_AUTH_UNAVAILABLE\"}");
                return false;
            }
            if (result.StatusCode != 200)
            {
                WriteText(context.Response, result.StatusCode, "application/json; charset=utf-8", result.RawBody);
                return false;
            }
            chatId = JsonString(result.Body, "chatId");
            messageId = JsonLong(result.Body, "messageId");
            if (string.IsNullOrWhiteSpace(chatId) || messageId <= 0)
            {
                WriteText(context.Response, 502, "application/json; charset=utf-8", "{\"error\":\"BRIDGE_LOCATOR_INVALID\"}");
                return false;
            }
            return true;
        }

        private void ProxyTelegramBridge(HttpListenerContext context)
        {
            if (telegramBridgePort <= 0 || string.IsNullOrWhiteSpace(telegramBridgeSecret))
            {
                WriteText(context.Response, 503, "application/json; charset=utf-8", "{\"error\":\"TELEGRAM_STORAGE_BRIDGE_OFFLINE\"}");
                return;
            }

            string path = context.Request.Url.AbsolutePath;
            const string prefix = "/__telegram_storage";
            const string assetPrefix = "/__telegram_storage/asset/";
            string target = null;
            string method = context.Request.HttpMethod;
            byte[] generatedBody = null;
            string forcedContentType = null;

            if (path.StartsWith(assetPrefix, StringComparison.OrdinalIgnoreCase))
            {
                string rest = path.Substring(assetPrefix.Length);
                int slash = rest.IndexOf('/');
                if (slash <= 0 || slash == rest.Length - 1)
                {
                    WriteText(context.Response, 404, "application/json; charset=utf-8", "{\"error\":\"NOT_FOUND\"}");
                    return;
                }
                string assetId = Uri.UnescapeDataString(rest.Substring(0, slash));
                string action = rest.Substring(slash + 1).ToLowerInvariant();
                if (assetId.Length < 8 || assetId.Length > 128)
                {
                    WriteText(context.Response, 400, "application/json; charset=utf-8", "{\"error\":\"INVALID_ASSET_ID\"}");
                    return;
                }

                if (action == "file")
                {
                    if (!string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase) && !string.Equals(method, "HEAD", StringComparison.OrdinalIgnoreCase))
                    {
                        WriteText(context.Response, 405, "application/json; charset=utf-8", "{\"error\":\"METHOD_NOT_ALLOWED\"}");
                        return;
                    }
                    string variant = string.Equals(context.Request.QueryString["variant"], "original", StringComparison.OrdinalIgnoreCase) ? "original" : "preview";
                    BackendJsonResult locatorResult;
                    string chatId;
                    long messageId;
                    if (!TryBridgeLocator(context, assetId, "/bridge-locator?variant=" + variant, null, out chatId, out messageId, out locatorResult)) return;
                    target = "http://127.0.0.1:" + telegramBridgePort + "/v1/file?chatId=" + Uri.EscapeDataString(chatId) + "&messageId=" + messageId + "&variant=" + variant;
                }
                else if (action == "upload")
                {
                    if (!string.Equals(method, "PUT", StringComparison.OrdinalIgnoreCase))
                    {
                        WriteText(context.Response, 405, "application/json; charset=utf-8", "{\"error\":\"METHOD_NOT_ALLOWED\"}");
                        return;
                    }
                    string uploadToken = context.Request.Headers["X-Upload-Token"];
                    BackendJsonResult authorization;
                    try { authorization = RequestBackendJson(context.Request, "/api/assets/" + Uri.EscapeDataString(assetId) + "/bridge-upload-authorize", uploadToken); }
                    catch
                    {
                        WriteText(context.Response, 503, "application/json; charset=utf-8", "{\"error\":\"BACKEND_AUTH_UNAVAILABLE\"}");
                        return;
                    }
                    if (authorization.StatusCode != 200)
                    {
                        WriteText(context.Response, authorization.StatusCode, "application/json; charset=utf-8", authorization.RawBody);
                        return;
                    }
                    long expectedSize = JsonLong(authorization.Body, "sizeBytes");
                    if (expectedSize < 0 || context.Request.ContentLength64 != expectedSize)
                    {
                        WriteText(context.Response, 400, "application/json; charset=utf-8", "{\"error\":\"CONTENT_LENGTH_MISMATCH\"}");
                        return;
                    }
                    string fileName = JsonString(authorization.Body, "originalName") ?? "upload.bin";
                    string mimeType = JsonString(authorization.Body, "mimeType") ?? "application/octet-stream";
                    string sha256 = context.Request.QueryString["sha256"] ?? string.Empty;
                    target = "http://127.0.0.1:" + telegramBridgePort + "/v1/upload?assetId=" + Uri.EscapeDataString(assetId)
                        + "&fileName=" + Uri.EscapeDataString(fileName) + "&mimeType=" + Uri.EscapeDataString(mimeType) + "&sha256=" + Uri.EscapeDataString(sha256);
                    forcedContentType = mimeType;
                }
                else if (action == "delete")
                {
                    if (!string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase))
                    {
                        WriteText(context.Response, 405, "application/json; charset=utf-8", "{\"error\":\"METHOD_NOT_ALLOWED\"}");
                        return;
                    }
                    BackendJsonResult locatorResult;
                    string chatId;
                    long messageId;
                    if (!TryBridgeLocator(context, assetId, "/bridge-delete-locator", null, out chatId, out messageId, out locatorResult)) return;
                    string json = new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "chatId", chatId }, { "messageId", messageId } });
                    generatedBody = Encoding.UTF8.GetBytes(json);
                    forcedContentType = "application/json; charset=utf-8";
                    target = "http://127.0.0.1:" + telegramBridgePort + "/v1/delete";
                }
                else
                {
                    WriteText(context.Response, 404, "application/json; charset=utf-8", "{\"error\":\"NOT_FOUND\"}");
                    return;
                }
            }
            else
            {
                string raw = context.Request.RawUrl ?? context.Request.Url.PathAndQuery;
                string suffix = raw.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? raw.Substring(prefix.Length) : string.Empty;
                string managementPath = context.Request.Url.AbsolutePath.Substring(prefix.Length);
                bool allowedManagement = managementPath == "/status" || managementPath == "/pending" || managementPath == "/sync" || managementPath == "/ack"
                    || managementPath.StartsWith("/auth/", StringComparison.OrdinalIgnoreCase);
                if (!allowedManagement)
                {
                    WriteText(context.Response, 404, "application/json; charset=utf-8", "{\"error\":\"NOT_FOUND\"}");
                    return;
                }
                if (!RequireOwnerSession(context)) return;
                target = "http://127.0.0.1:" + telegramBridgePort + "/v1" + suffix;
            }

            var outbound = (HttpWebRequest)WebRequest.Create(target);
            outbound.Method = method;
            outbound.AllowAutoRedirect = false;
            outbound.AllowWriteStreamBuffering = false;
            outbound.Timeout = 6 * 60 * 60 * 1000;
            outbound.ReadWriteTimeout = 6 * 60 * 60 * 1000;
            outbound.KeepAlive = true;
            outbound.UserAgent = "PrivateArchiveDesktop/0.1.0";
            outbound.Accept = context.Request.Headers["Accept"];
            outbound.ContentType = forcedContentType ?? context.Request.ContentType;
            outbound.Headers["X-Private-Archive-Bridge"] = telegramBridgeSecret;
            CopyRequestHeader(context.Request, outbound, "Range");
            CopyRequestHeader(context.Request, outbound, "If-None-Match");
            CopyRequestHeader(context.Request, outbound, "If-Modified-Since");
            try { outbound.ServicePoint.Expect100Continue = false; } catch { }

            try
            {
                if (generatedBody != null)
                {
                    outbound.ContentLength = generatedBody.Length;
                    using (Stream output = outbound.GetRequestStream()) output.Write(generatedBody, 0, generatedBody.Length);
                }
                else if (context.Request.HasEntityBody)
                {
                    if (context.Request.ContentLength64 >= 0) outbound.ContentLength = context.Request.ContentLength64;
                    using (Stream output = outbound.GetRequestStream()) context.Request.InputStream.CopyTo(output, 1024 * 1024);
                }

                HttpWebResponse remote = null;
                try { remote = (HttpWebResponse)outbound.GetResponse(); }
                catch (WebException ex) { remote = ex.Response as HttpWebResponse; if (remote == null) throw; }

                using (remote)
                {
                    context.Response.StatusCode = (int)remote.StatusCode;
                    if (!string.IsNullOrWhiteSpace(remote.ContentType)) context.Response.ContentType = remote.ContentType;
                    if (remote.ContentLength >= 0) context.Response.ContentLength64 = remote.ContentLength;
                    CopyResponseHeader(remote, context.Response, "Cache-Control");
                    CopyResponseHeader(remote, context.Response, "ETag");
                    CopyResponseHeader(remote, context.Response, "Last-Modified");
                    CopyResponseHeader(remote, context.Response, "Content-Disposition");
                    CopyResponseHeader(remote, context.Response, "Content-Range");
                    CopyResponseHeader(remote, context.Response, "Accept-Ranges");
                    CopyResponseHeader(remote, context.Response, "Retry-After");
                    using (Stream input = remote.GetResponseStream())
                    {
                        if (input != null && !string.Equals(context.Request.HttpMethod, "HEAD", StringComparison.OrdinalIgnoreCase))
                            input.CopyTo(context.Response.OutputStream, 1024 * 1024);
                    }
                }
            }
            catch
            {
                if (!context.Response.OutputStream.CanWrite) return;
                context.Response.Headers.Clear();
                WriteText(context.Response, 503, "application/json; charset=utf-8", "{\"error\":\"TELEGRAM_STORAGE_BRIDGE_OFFLINE\"}");
            }
        }

        private void ProxyApi(HttpListenerContext context)
        {
            string target = BackendOrigin + context.Request.RawUrl;
            var outbound = (HttpWebRequest)WebRequest.Create(target);
            outbound.Method = context.Request.HttpMethod;
            outbound.AllowAutoRedirect = false;
            outbound.Timeout = 180000;
            outbound.ReadWriteTimeout = 180000;
            outbound.KeepAlive = true;
            outbound.UserAgent = "PrivateArchiveDesktop/0.1.0";
            outbound.Accept = context.Request.Headers["Accept"];
            outbound.ContentType = context.Request.ContentType;

            CopyAppSessionCookie(context.Request, outbound);
            CopyRequestHeader(context.Request, outbound, "X-Upload-Token");
            CopyRequestHeader(context.Request, outbound, "X-Requested-With");
            CopyRequestHeader(context.Request, outbound, "If-None-Match");
            CopyRequestHeader(context.Request, outbound, "If-Match");
            CopyRequestHeader(context.Request, outbound, "Range");
            string origin = context.Request.Headers["Origin"];
            if (!string.IsNullOrWhiteSpace(origin)) outbound.Headers["Origin"] = origin;

            if (context.Request.HasEntityBody)
            {
                if (context.Request.ContentLength64 >= 0) outbound.ContentLength = context.Request.ContentLength64;
                using (Stream output = outbound.GetRequestStream())
                    context.Request.InputStream.CopyTo(output);
            }

            HttpWebResponse remote = null;
            try { remote = (HttpWebResponse)outbound.GetResponse(); }
            catch (WebException ex) { remote = ex.Response as HttpWebResponse; if (remote == null) throw; }

            using (remote)
            {
                context.Response.StatusCode = (int)remote.StatusCode;
                if (!string.IsNullOrWhiteSpace(remote.ContentType)) context.Response.ContentType = remote.ContentType;
                if (remote.ContentLength >= 0) context.Response.ContentLength64 = remote.ContentLength;
                CopyResponseHeader(remote, context.Response, "Cache-Control");
                CopyResponseHeader(remote, context.Response, "ETag");
                CopyResponseHeader(remote, context.Response, "Last-Modified");
                CopyResponseHeader(remote, context.Response, "Content-Disposition");
                CopyResponseHeader(remote, context.Response, "Content-Range");
                CopyResponseHeader(remote, context.Response, "Accept-Ranges");
                CopyResponseHeader(remote, context.Response, "Retry-After");
                CopyResponseHeader(remote, context.Response, "Location");

                string[] cookies = remote.Headers.GetValues("Set-Cookie");
                if (cookies != null)
                {
                    foreach (string cookie in cookies)
                    {
                        string rewritten = RewriteAppSessionCookieForLoopback(cookie);
                        if (!string.IsNullOrWhiteSpace(rewritten)) context.Response.Headers.Add("Set-Cookie", rewritten);
                    }
                }

                using (Stream input = remote.GetResponseStream())
                {
                    if (input != null && !string.Equals(context.Request.HttpMethod, "HEAD", StringComparison.OrdinalIgnoreCase))
                        input.CopyTo(context.Response.OutputStream);
                }
            }
        }

        private static void CopyAppSessionCookie(HttpListenerRequest source, HttpWebRequest target)
        {
            string raw = source.Headers["Cookie"];
            if (string.IsNullOrWhiteSpace(raw)) return;
            foreach (string segment in raw.Split(';'))
            {
                string part = segment.Trim();
                int equals = part.IndexOf('=');
                if (equals <= 0) continue;
                string name = part.Substring(0, equals).Trim();
                if (!string.Equals(name, AppSessionCookieName, StringComparison.Ordinal)) continue;
                string value = part.Substring(equals + 1).Trim();
                if (value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0) return;
                try { target.Headers["Cookie"] = AppSessionCookieName + "=" + value; } catch { }
                return;
            }
        }

        private static void CopyRequestHeader(HttpListenerRequest source, HttpWebRequest target, string name)
        {
            string value = source.Headers[name];
            if (string.IsNullOrWhiteSpace(value)) return;
            try { target.Headers[name] = value; } catch { }
        }

        private static void CopyResponseHeader(HttpWebResponse source, HttpListenerResponse target, string name)
        {
            string value = source.Headers[name];
            if (string.IsNullOrWhiteSpace(value)) return;
            try { target.Headers[name] = value; } catch { }
        }

        private static string RewriteAppSessionCookieForLoopback(string cookie)
        {
            if (string.IsNullOrWhiteSpace(cookie)) return null;
            string[] parts = cookie.Split(';');
            if (parts.Length == 0) return null;
            string first = parts[0].Trim();
            int equals = first.IndexOf('=');
            if (equals <= 0 || !string.Equals(first.Substring(0, equals).Trim(), AppSessionCookieName, StringComparison.Ordinal)) return null;

            var kept = new List<string> { first };
            for (int index = 1; index < parts.Length; index += 1)
            {
                string part = parts[index].Trim();
                if (part.Equals("Secure", StringComparison.OrdinalIgnoreCase)) continue;
                if (part.StartsWith("Domain=", StringComparison.OrdinalIgnoreCase)) continue;
                kept.Add(part);
            }
            return string.Join("; ", kept.ToArray());
        }

        private static string ContentType(string name)
        {
            string ext = Path.GetExtension(name).ToLowerInvariant();
            switch (ext)
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".webmanifest": return "application/manifest+json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".webp": return "image/webp";
                case ".ico": return "image/x-icon";
                case ".map": return "application/json; charset=utf-8";
                default: return "application/octet-stream";
            }
        }

        private static void WriteText(HttpListenerResponse response, int status, string contentType, string body)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(body);
            response.StatusCode = status;
            response.ContentType = contentType;
            response.ContentLength64 = bytes.Length;
            response.OutputStream.Write(bytes, 0, bytes.Length);
        }

        public void Dispose()
        {
            stopping = true;
            try { listener.Stop(); } catch { }
            try { listener.Close(); } catch { }
            if (acceptThread.IsAlive) try { acceptThread.Join(1500); } catch { }
        }
    }
}
