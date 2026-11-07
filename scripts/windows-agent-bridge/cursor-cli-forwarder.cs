using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

// Local, credential-free wrapper. The official Cursor binaries stay in the
// user's installation while HOME, config and data remain member-private.
internal static class CursorCliForwarder {
  private static string Quote(string value) {
    if (value.Length == 0) return "\"\"";
    if (value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
    var result = new StringBuilder("\"");
    var slashes = 0;
    foreach (var c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
      if (slashes > 0) { result.Append('\\', slashes); slashes = 0; }
      result.Append(c);
    }
    if (slashes > 0) result.Append('\\', slashes * 2);
    return result.Append('"').ToString();
  }

  private static int Main(string[] args) {
    var root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    var lines = File.ReadAllLines(Path.Combine(root, "cursor-cli-paths.txt"));
    if (lines.Length != 2 || !File.Exists(lines[0]) || !File.Exists(lines[1])) {
      Console.Error.WriteLine("Cursor CLI runtime path is missing");
      return 2;
    }
    var psi = new ProcessStartInfo {
      FileName = lines[0],
      Arguments = Quote(lines[1]),
      UseShellExecute = false,
      CreateNoWindow = true,
      WindowStyle = ProcessWindowStyle.Hidden,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
    };
    foreach (var arg in args) psi.Arguments += " " + Quote(arg);
    psi.EnvironmentVariables["CURSOR_INVOKED_AS"] = "agent";
    using (var process = Process.Start(psi)) {
      if (process == null) return 3;
      process.OutputDataReceived += (sender, eventArgs) => {
        if (eventArgs.Data != null) Console.Out.WriteLine(eventArgs.Data);
      };
      process.ErrorDataReceived += (sender, eventArgs) => {
        if (eventArgs.Data != null) Console.Error.WriteLine(eventArgs.Data);
      };
      process.BeginOutputReadLine();
      process.BeginErrorReadLine();
      process.WaitForExit();
      return process.ExitCode;
    }
  }
}
