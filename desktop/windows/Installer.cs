using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Installer
{
    private const string AppResource = "PrivateArchive.App";
    private const string UninstallResource = "PrivateArchive.Uninstall";
    private const string ProductName = "Private Archive";
    private const string Version = "0.1.0";

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
            Directory.CreateDirectory(installDir);

            string appPath = Path.Combine(installDir, "PrivateArchive.exe");
            string uninstallPath = Path.Combine(installDir, "PrivateArchive-Uninstall.exe");
            ExtractResource(AppResource, appPath);
            ExtractResource(UninstallResource, uninstallPath);
            File.WriteAllText(Path.Combine(installDir, "VERSION.txt"), "Private Archive Desktop " + Version + Environment.NewLine);

            CreateShortcuts(appPath, installDir);
            RegisterUninstaller(installDir, uninstallPath);

            if (!silent)
            {
                MessageBox.Show(
                    "Private Archive 已安装。桌面和开始菜单已创建快捷方式。",
                    ProductName,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                Process.Start(new ProcessStartInfo { FileName = appPath, UseShellExecute = true });
            }
        }
        catch (Exception ex)
        {
            if (!silent)
            {
                MessageBox.Show(
                    "安装失败：" + ex.Message,
                    ProductName,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            Environment.ExitCode = 1;
        }
    }

    private static void ExtractResource(string name, string destination)
    {
        Assembly assembly = Assembly.GetExecutingAssembly();
        using (Stream input = assembly.GetManifestResourceStream(name))
        {
            if (input == null) throw new InvalidOperationException("Missing installer resource: " + name);
            using (FileStream output = File.Create(destination))
                input.CopyTo(output);
        }
    }

    private static void CreateShortcuts(string appPath, string installDir)
    {
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        string startMenu = Environment.GetFolderPath(Environment.SpecialFolder.StartMenu);
        CreateShortcut(Path.Combine(desktop, ProductName + ".lnk"), appPath, installDir);
        CreateShortcut(Path.Combine(startMenu, "Programs", ProductName + ".lnk"), appPath, installDir);
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath));
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) return;
        object shell = Activator.CreateInstance(shellType);
        object shortcut = shellType.InvokeMember(
            "CreateShortcut",
            BindingFlags.InvokeMethod,
            null,
            shell,
            new object[] { shortcutPath });
        Type shortcutType = shortcut.GetType();
        shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
        shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDirectory });
        shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { ProductName });
        shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
    }

    private static void RegisterUninstaller(string installDir, string uninstallPath)
    {
        const string keyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\PrivateArchive";
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(keyPath))
        {
            if (key == null) return;
            key.SetValue("DisplayName", ProductName);
            key.SetValue("DisplayVersion", Version);
            key.SetValue("Publisher", "Private Archive");
            key.SetValue("InstallLocation", installDir);
            key.SetValue("UninstallString", "\"" + uninstallPath + "\"");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }
}
