// Windows-only run supervisor. Build as a Windows-subsystem executable so it
// never creates a console. No model is launched by this source without a job.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class Supervisor
{
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint SYNCHRONIZE = 0x00100000;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int JobObjectExtendedLimitInformation = 9;
    const int JobObjectBasicAccountingInformation = 1;
    const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    const uint PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
    const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    const uint WAIT_OBJECT_0 = 0, WAIT_FAILED = 0xFFFFFFFF;
    const int ERROR_ALREADY_EXISTS = 183;
    static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    struct FILETIME { public uint Low; public uint High; public ulong Value { get { return ((ulong)High << 32) | Low; } } }
    [StructLayout(LayoutKind.Sequential)]
    struct BASIC_LIMIT {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct EXTENDED_LIMIT {
        public BASIC_LIMIT BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct BASIC_ACCOUNTING {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    sealed class LaunchRequest {
        public string runId { get; set; }
        public string leaseId { get; set; }
        public string deviceId { get; set; }
        public string nonce { get; set; }
        public uint bridgePid { get; set; }
        public string bridgeCreationFileTime { get; set; }
        public uint bridgeSessionId { get; set; }
        public string receiptDir { get; set; }
        public string cwd { get; set; }
        public string executable { get; set; }
        public string[] args { get; set; }
        public Dictionary<string, string> env { get; set; }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out BASIC_ACCOUNTING info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenEventW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetEvent(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit,
        out FILETIME kernel, out FILETIME user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, uint attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd,
        ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    static void Require(bool okay, string operation) {
        if (!okay) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static void Close(ref IntPtr handle) {
        if (handle != IntPtr.Zero && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
        handle = IntPtr.Zero;
    }
    static string Quote(string arg) {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '"' }) < 0) return arg;
        StringBuilder b = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append('"'); slashes = 0; continue; }
            b.Append('\\', slashes); slashes = 0; b.Append(c);
        }
        b.Append('\\', slashes * 2); b.Append('"');
        return b.ToString();
    }
    static ulong CreationTime(IntPtr process) {
        FILETIME c, e, k, u;
        Require(GetProcessTimes(process, out c, out e, out k, out u), "GetProcessTimes");
        return c.Value;
    }
    static void WriteLine(string value) {
        byte[] bytes = Encoding.UTF8.GetBytes(value + "\n");
        using (Stream stream = Console.OpenStandardOutput()) { stream.Write(bytes, 0, bytes.Length); stream.Flush(); }
    }
    static void DurableJson(string directory, string name, string json) {
        string final = Path.Combine(directory, name);
        // Keep the atomic file in the receipt directory without repeating the
        // long receipt name. The legacy shape could cross MAX_PATH even when
        // the final ready/stopped receipt itself still fit.
        string temporary = Path.Combine(directory,
            ".tmp-" + Guid.NewGuid().ToString("N").Substring(0, 16));
        byte[] bytes = Encoding.UTF8.GetBytes(json + "\n");
        using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write,
            FileShare.None, 4096, FileOptions.WriteThrough)) {
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
        // File.Move does not overwrite an existing receipt. A replay must fail closed.
        File.Move(temporary, final);
    }
    static bool IsLocalAbsolutePath(string value) {
        return value != null && value.Length >= 3 &&
            ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) &&
            value[1] == ':' && (value[2] == '\\' || value[2] == '/');
    }
    static uint ActiveProcesses(IntPtr job) {
        BASIC_ACCOUNTING info;
        Require(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info,
            (uint)Marshal.SizeOf(typeof(BASIC_ACCOUNTING)), IntPtr.Zero), "QueryInformationJobObject");
        return info.ActiveProcesses;
    }
    static bool Drain(IntPtr job, int milliseconds) {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
        do {
            if (ActiveProcesses(job) == 0) return true;
            Thread.Sleep(25);
        } while (DateTime.UtcNow < deadline);
        return ActiveProcesses(job) == 0;
    }
    static void ConfigureKillOnClose(IntPtr job) {
        EXTENDED_LIMIT limits = new EXTENDED_LIMIT();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EXTENDED_LIMIT)));
        try {
            Marshal.StructureToPtr(limits, buffer, false);
            Require(SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer,
                (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "SetInformationJobObject");
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static IntPtr DuplicateStandard(int kind) {
        IntPtr source = GetStdHandle(kind), duplicate;
        if (source == IntPtr.Zero || source == INVALID_HANDLE_VALUE)
            throw new InvalidOperationException("All three redirected standard handles are required");
        Require(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out duplicate,
            0, true, DUPLICATE_SAME_ACCESS), "DuplicateHandle");
        return duplicate;
    }
    static IntPtr BuildEnvironment(Dictionary<string, string> values) {
        if (values == null || values.Count == 0) throw new ArgumentException("Explicit model environment is required");
        List<string> names = new List<string>(values.Keys);
        names.Sort(StringComparer.OrdinalIgnoreCase);
        StringBuilder block = new StringBuilder();
        foreach (string name in names) {
            string value = values[name];
            if (String.IsNullOrEmpty(name) || name.IndexOf('=') >= 0 || name.IndexOf('\0') >= 0 ||
                value == null || value.IndexOf('\0') >= 0)
                throw new ArgumentException("Invalid environment variable");
            block.Append(name).Append('=').Append(value).Append('\0');
        }
        block.Append('\0');
        byte[] bytes = Encoding.Unicode.GetBytes(block.ToString());
        IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        return pointer;
    }
    static PROCESS_INFORMATION StartInJob(IntPtr job, LaunchRequest request, out IntPtr promptWrite) {
        IntPtr list = IntPtr.Zero, jobValue = IntPtr.Zero, handleValues = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        IntPtr inputRead = IntPtr.Zero, environment = IntPtr.Zero;
        promptWrite = IntPtr.Zero;
        bool listInitialized = false;
        try {
            Require(CreatePipe(out inputRead, out promptWrite, IntPtr.Zero, 0), "CreatePipe model stdin");
            Require(DuplicateHandle(GetCurrentProcess(), inputRead, GetCurrentProcess(), out input,
                0, true, DUPLICATE_SAME_ACCESS), "DuplicateHandle stdin");
            output = DuplicateStandard(STD_OUTPUT_HANDLE);
            error = DuplicateStandard(STD_ERROR_HANDLE);
            environment = BuildEnvironment(request.env);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Attribute list size");
            list = Marshal.AllocHGlobal(size);
            Require(InitializeProcThreadAttributeList(list, 2, 0, ref size), "InitializeProcThreadAttributeList");
            listInitialized = true;
            jobValue = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobValue, job);
            Require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Job list attribute");
            handleValues = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleValues, 0, input);
            Marshal.WriteIntPtr(handleValues, IntPtr.Size, output);
            Marshal.WriteIntPtr(handleValues, IntPtr.Size * 2, error);
            Require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handleValues, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "Handle list attribute");
            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = input;
            startup.StartupInfo.hStdOutput = output;
            startup.StartupInfo.hStdError = error;
            startup.lpAttributeList = list;
            StringBuilder commandLine = new StringBuilder(Quote(request.executable));
            foreach (string arg in request.args) commandLine.Append(' ').Append(Quote(arg));
            PROCESS_INFORMATION process;
            Require(CreateProcessW(request.executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                environment, request.cwd,
                ref startup, out process), "CreateProcessW with Job list");
            return process;
        } finally {
            if (listInitialized) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
            if (handleValues != IntPtr.Zero) Marshal.FreeHGlobal(handleValues);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            Close(ref inputRead);
            Close(ref input); Close(ref output); Close(ref error);
        }
    }
    static byte[] ReadExact(Stream stream, int length) {
        byte[] bytes = new byte[length];
        int offset = 0;
        while (offset < length) {
            int got = stream.Read(bytes, offset, length - offset);
            if (got == 0) throw new EndOfStreamException("Incomplete launch frame");
            offset += got;
        }
        return bytes;
    }
    static LaunchRequest ReadLaunch(out byte[] prompt) {
        Stream stream = Console.OpenStandardInput();
        byte[] size = ReadExact(stream, 4);
        int length = BitConverter.ToInt32(size, 0);
        if (length <= 0 || length > 4 * 1024 * 1024)
            throw new ArgumentException("Launch header exceeds 4 MiB");
        string json = new UTF8Encoding(false, true).GetString(ReadExact(stream, length));
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = 4 * 1024 * 1024;
        LaunchRequest request = serializer.Deserialize<LaunchRequest>(json);
        if (request == null) throw new ArgumentException("Invalid launch header");
        using (MemoryStream collected = new MemoryStream()) {
            byte[] buffer = new byte[8192];
            int got;
            while ((got = stream.Read(buffer, 0, buffer.Length)) != 0) {
                if (collected.Length + got > 64 * 1024 * 1024)
                    throw new ArgumentException("Model stdin exceeds 64 MiB");
                collected.Write(buffer, 0, got);
            }
            prompt = collected.ToArray();
        }
        return request;
    }
    static int Run() {
        byte[] prompt;
        LaunchRequest request = ReadLaunch(out prompt);
        Guid runId;
        Guid leaseId, nonceId;
        if (!Guid.TryParse(request.runId, out runId) ||
            runId.ToString("D") != request.runId.ToLowerInvariant() ||
            !Guid.TryParse(request.leaseId, out leaseId) ||
            !Guid.TryParse(request.nonce, out nonceId) ||
            String.IsNullOrWhiteSpace(request.deviceId) || request.deviceId.Length > 128)
            throw new ArgumentException("runId must be a canonical UUID");
        ulong bridgeCreation;
        if (request.bridgePid == 0 ||
            !ulong.TryParse(request.bridgeCreationFileTime, out bridgeCreation) || bridgeCreation == 0)
            throw new ArgumentException("invalid bridge identity");
        if (request.receiptDir == null || request.cwd == null || request.executable == null ||
            request.args == null) throw new ArgumentException("Incomplete launch header");
        if (!IsLocalAbsolutePath(request.receiptDir) || !IsLocalAbsolutePath(request.cwd) ||
            !IsLocalAbsolutePath(request.executable))
            throw new ArgumentException("Local absolute paths are required");
        string directory = Path.GetFullPath(request.receiptDir);
        request.cwd = Path.GetFullPath(request.cwd);
        request.executable = Path.GetFullPath(request.executable);
        if (!File.Exists(request.executable) || !Directory.Exists(request.cwd) || !Directory.Exists(directory) ||
            !request.executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("absolute existing Windows executable, cwd and receipt directory required");
        string receiptName = runId.ToString("D") + ".stopped.json";
        string readyName = runId.ToString("D") + ".ready.json";
        if (File.Exists(Path.Combine(directory, receiptName)) || File.Exists(Path.Combine(directory, readyName)))
            throw new InvalidOperationException("run identity already has a receipt or launch marker");
        IntPtr bridge = IntPtr.Zero, job = IntPtr.Zero, cancel = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        try {
            bridge = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, request.bridgePid);
            if (bridge == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess bridge");
            uint actualSession;
            Require(ProcessIdToSessionId(request.bridgePid, out actualSession), "ProcessIdToSessionId");
            if (CreationTime(bridge) != bridgeCreation || actualSession != request.bridgeSessionId ||
                WaitForMultipleObjects(1, new IntPtr[] { bridge }, false, 0) != 0x102)
                throw new InvalidOperationException("bridge process identity changed or stopped");
            string nonce = nonceId.ToString("N");
            string jobName = @"Local\PaperclipRun-" + runId.ToString("N") + "-" + nonce;
            string cancelName = @"Local\PaperclipCancel-" + runId.ToString("N") + "-" + nonce;
            job = CreateJobObjectW(IntPtr.Zero, jobName);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW");
            if (Marshal.GetLastWin32Error() == ERROR_ALREADY_EXISTS)
                throw new InvalidOperationException("Job name collision");
            ConfigureKillOnClose(job);
            cancel = CreateEventW(IntPtr.Zero, true, false, cancelName);
            if (cancel == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateEventW");
            if (Marshal.GetLastWin32Error() == ERROR_ALREADY_EXISTS)
                throw new InvalidOperationException("Cancel event collision");
            if (WaitForMultipleObjects(1, new IntPtr[] { bridge }, false, 0) != 0x102)
                throw new InvalidOperationException("Bridge stopped before model launch");
            IntPtr promptWrite;
            child = StartInJob(job, request, out promptWrite);
            Exception promptError = null;
            Thread promptThread = new Thread(() => {
                try {
                    using (FileStream pipe = new FileStream(new SafeFileHandle(promptWrite, true), FileAccess.Write)) {
                        pipe.Write(prompt, 0, prompt.Length);
                        pipe.Flush();
                    }
                } catch (Exception error) { promptError = error; }
            });
            promptThread.IsBackground = true;
            promptThread.Start();
            ulong modelCreation = CreationTime(child.hProcess);
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            DurableJson(directory, readyName, serializer.Serialize(new {
                runId = runId.ToString("D"), leaseId = leaseId.ToString("D"),
                deviceId = request.deviceId, nonce = nonceId.ToString("D"),
                bridgePid = request.bridgePid, bridgeCreationFileTime = request.bridgeCreationFileTime,
                bridgeSessionId = request.bridgeSessionId, modelPid = child.dwProcessId,
                modelCreationFileTime = modelCreation.ToString(), cancelEvent = cancelName
            }));
            uint signal = WaitForMultipleObjects(3, new IntPtr[] { bridge, child.hProcess, cancel }, false, 0xFFFFFFFF);
            if (signal == WAIT_FAILED || signal < WAIT_OBJECT_0 || signal > WAIT_OBJECT_0 + 2)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForMultipleObjects");
            string cause = signal == WAIT_OBJECT_0 ? "bridge_exit" :
                signal == WAIT_OBJECT_0 + 2 ? "cancelled" : "model_exit";
            if (cause == "model_exit") {
                if (!Drain(job, 5000)) {
                    cause = "descendant_timeout";
                    Require(TerminateJobObject(job, 1), "TerminateJobObject descendants");
                }
            } else {
                if (ActiveProcesses(job) != 0)
                    Require(TerminateJobObject(job, 1), "TerminateJobObject");
            }
            if (!Drain(job, 20000)) throw new InvalidOperationException("Job did not drain; stop is unproven");
            if (!promptThread.Join(2000) || promptError != null) cause = "input_failure";
            Array.Clear(prompt, 0, prompt.Length);
            uint exitCode;
            Require(GetExitCodeProcess(child.hProcess, out exitCode), "GetExitCodeProcess");
            DurableJson(directory, receiptName, serializer.Serialize(new {
                runId = runId.ToString("D"), leaseId = leaseId.ToString("D"),
                deviceId = request.deviceId, nonce = nonceId.ToString("D"),
                bridgePid = request.bridgePid, bridgeCreationFileTime = request.bridgeCreationFileTime,
                bridgeSessionId = request.bridgeSessionId, modelPid = child.dwProcessId,
                modelCreationFileTime = modelCreation.ToString(), cause = cause,
                modelExitCode = exitCode, activeProcesses = 0, completedAtUtc = DateTime.UtcNow.ToString("o")
            }));
            return cause == "model_exit" ? (exitCode <= 255 ? (int)exitCode : 1) : 2;
        } finally {
            Close(ref child.hThread); Close(ref child.hProcess);
            Close(ref cancel); Close(ref job); Close(ref bridge);
        }
    }
    static int Main(string[] args) {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT) return 64;
        try {
            if (args.Length == 2 && args[0] == "identity") {
                uint pid, session;
                if (!uint.TryParse(args[1], out pid) || pid == 0) return 64;
                IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid);
                if (process == IntPtr.Zero) return 65;
                try {
                    Require(ProcessIdToSessionId(pid, out session), "ProcessIdToSessionId");
                    WriteLine(pid + " " + CreationTime(process) + " " + session);
                    return 0;
                } finally { Close(ref process); }
            }
            if (args.Length == 2 && args[0] == "cancel" && args[1].StartsWith(@"Local\PaperclipCancel-", StringComparison.Ordinal)) {
                IntPtr handle = OpenEventW(0x0002, false, args[1]);
                if (handle == IntPtr.Zero) return 65;
                try { Require(SetEvent(handle), "SetEvent"); return 0; }
                finally { Close(ref handle); }
            }
            if (args.Length == 1 && args[0] == "run") return Run();
            return 64;
        } catch (Exception error) {
            // An error never produces a stopped receipt. The job's last handle
            // closes during stack unwind, and the caller must fail closed.
            Console.Error.WriteLine("PaperclipRunSupervisor: " +
                error.GetType().FullName + ": " + error.Message);
            Console.Error.Flush();
            return 70;
        }
    }
}
