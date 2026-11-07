// Fake process tree for test.ps1. Never invokes a model or a shell.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class TestChild
{
    static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "sleep") {
            Thread.Sleep(int.Parse(args[1]));
            return 0;
        }
        if (args.Length == 2 && args[0] == "exit") return int.Parse(args[1]);
        if (args.Length == 2 && args[0] == "stdin-marker") {
            using (Stream input = Console.OpenStandardInput())
            using (Stream output = new FileStream(args[1], FileMode.CreateNew, FileAccess.Write)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0) output.Write(buffer, 0, read);
            }
            return 0;
        }
        if (args.Length == 2 && args[0] == "env-marker") {
            File.WriteAllText(args[1], Environment.GetEnvironmentVariable("SUPERVISOR_TEST") ?? "");
            return 0;
        }
        if (args.Length == 3 && args[0] == "arg-marker") {
            File.WriteAllText(args[1], args[2]);
            return 0;
        }
        if (args.Length == 3 && (args[0] == "tree-exit" || args[0] == "tree-wait")) {
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = System.Reflection.Assembly.GetExecutingAssembly().Location;
            start.Arguments = "sleep 60000";
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            Process child = Process.Start(start);
            File.WriteAllText(args[1], child.Id.ToString());
            if (args[0] == "tree-wait") Thread.Sleep(int.Parse(args[2]));
            return 0;
        }
        return 64;
    }
}
