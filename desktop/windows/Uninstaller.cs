using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Uninstaller
{
    private const string ProductName = "Private Archive";

    [STAThread]
    private static void Main(string[] args)
    {
        bool silent = Array.Exists(args, value => string.Equals(value, "/silent", StringComparison.OrdinalIgnoreCase));
        try
        {
            string installDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "PrivateArchive");
            string desktop = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                ProductName + ".lnk");
            string startMenu = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
                "Programs",
                ProductName + ".lnk");

            TryDelete(desktop);
            TryDelete(startMenu);
            try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\PrivateArchive", false); }
            catch { }

            if (!silent)
            {
                MessageBox.Show(
                    "Private Archive 已卸载。",
                    ProductName,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }

            StartCleanupScript(installDir);
        }
        catch (Exception ex)
        {
            if (!silent)
            {
                MessageBox.Show(
                    "卸载时出现问题：" + ex.Message,
                    ProductName,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
            Environment.ExitCode = 1;
        }
    }

    private static void StartCleanupScript(string installDir)
    {
        string cleanup = Path.Combine(
            Path.GetTempPath(),
            "PrivateArchive-Cleanup-" + Guid.NewGuid().ToString("N") + ".cmd");
        string escapedDir = installDir.Replace("%", "%%");
        string script =
            "@echo off\r\n" +
            ">nul 2>&1 ping 127.0.0.1 -n 3\r\n" +
            "rmdir /s /q \"" + escapedDir + "\"\r\n" +
            "del /f /q \"%~f0\"\r\n";
        File.WriteAllText(cleanup, script, Encoding.ASCII);

        Process.Start(new ProcessStartInfo
        {
            FileName = cleanup,
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Hidden
        });
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { }
    }
}
