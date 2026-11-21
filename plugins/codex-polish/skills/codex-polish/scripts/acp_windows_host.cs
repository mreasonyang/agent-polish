// Loaded by the current host's Windows PowerShell. The provider starts suspended
// so its entire process tree belongs to the host's kill-on-close job before it runs.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class CodexPolishAcpHost {
    [StructLayout(LayoutKind.Sequential)]
    struct JobLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public JobLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Startup {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupEx { public Startup Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct Child { public IntPtr Process, Thread; public int Pid, Tid; }

    [DllImport("kernel32", SetLastError=true)] static extern SafeFileHandle CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits limits, int size);
    [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr child);
    [DllImport("kernel32", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr handles, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool CreateProcess(string exe, StringBuilder argv, IntPtr processSecurity, IntPtr threadSecurity,
        bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out Child child);
    [DllImport("kernel32", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32")] static extern bool TerminateProcess(IntPtr child, uint status);
    [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool success) { if (!success) throw new Win32Exception(); }

    // Limit handle inheritance to the three native byte pipes, even if the host's
    // execution tool has left other inheritable handles open in PowerShell.
    static Process StartProvider(string exe, string args, string cwd, SafeFileHandle job,
            AnonymousPipeServerStream input, AnonymousPipeServerStream output, AnonymousPipeServerStream errors) {
        var handles = new[] { input.ClientSafePipeHandle.DangerousGetHandle(),
            output.ClientSafePipeHandle.DangerousGetHandle(), errors.ClientSafePipeHandle.DangerousGetHandle() };
        var startup = new StartupEx { Info = new Startup { Size = Marshal.SizeOf(typeof(StartupEx)), Flags = 0x100,
            Input = handles[0], Output = handles[1], Error = handles[2] } };
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        startup.Attributes = Marshal.AllocHGlobal(size);
        var pointers = Marshal.AllocHGlobal(handles.Length * IntPtr.Size);
        Child child;
        try {
            Check(InitializeProcThreadAttributeList(startup.Attributes, 1, 0, ref size));
            try {
                Marshal.Copy(handles, 0, pointers, handles.Length);
                Check(UpdateProcThreadAttribute(startup.Attributes, 0, (IntPtr)0x20002, pointers,
                    (IntPtr)(handles.Length * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)); // PROC_THREAD_ATTRIBUTE_HANDLE_LIST
                Check(CreateProcess(exe, new StringBuilder("\"" + exe + "\" " + args), IntPtr.Zero, IntPtr.Zero,
                    true, 0x08080004, IntPtr.Zero, cwd, ref startup, out child)); // NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | SUSPENDED
            } finally { DeleteProcThreadAttributeList(startup.Attributes); }
        } finally { Marshal.FreeHGlobal(pointers); Marshal.FreeHGlobal(startup.Attributes); }
        try {
            Check(AssignProcessToJobObject(job, child.Process));
            var process = Process.GetProcessById(child.Pid);
            // Open the managed process handle before a short-lived child can exit.
            var pinned = process.Handle;
            Check(ResumeThread(child.Thread) != 0xffffffff);
            return process;
        } catch { TerminateProcess(child.Process, 1); throw; }
        finally {
            CloseHandle(child.Thread); CloseHandle(child.Process);
            input.DisposeLocalCopyOfClientHandle(); output.DisposeLocalCopyOfClientHandle(); errors.DisposeLocalCopyOfClientHandle();
        }
    }

    static async Task Copy(Stream from, Stream to, bool end) {
        try {
            // Process.StandardInput.BaseStream is buffered on .NET Framework.
            // Flush each chunk so a short reply can unblock the next agent action.
            byte[] buffer = new byte[32768];
            int count;
            while ((count = await from.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0) {
                await to.WriteAsync(buffer, 0, count).ConfigureAwait(false);
                await to.FlushAsync().ConfigureAwait(false);
            }
        }
        catch (IOException) {} catch (ObjectDisposedException) {}
        finally { if (end) to.Close(); }
    }

    public static int Run(string exe, string args, string node, string script, string settings, string cwd) {
        if (args != "acp --agent codex-polish-editor --sandbox") return 1;
        var info = new ProcessStartInfo(node, "\"" + script + "\" --observe " + settings + " " + Process.GetCurrentProcess().Id);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = info.RedirectStandardOutput = info.RedirectStandardError = true;
        info.EnvironmentVariables.Remove("OPENAI_API_KEY");
        // CreateProcess inherits the host environment. This dedicated exec invocation
        // exits when Run returns. Neither the relay nor agy receives the OpenAI key.
        Environment.SetEnvironmentVariable("OPENAI_API_KEY", null);
        using (var relay = Process.Start(info)) {
            if (relay.StandardOutput.BaseStream.ReadByte() != (int)'R') return 1;
            var events = Copy(relay.StandardError.BaseStream, Console.OpenStandardOutput(), false);
            int status = 1;
            try {
                using (var job = CreateJobObject(IntPtr.Zero, null))
                using (var input = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable))
                using (var output = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
                using (var errors = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable)) {
                    Check(!job.IsInvalid);
                    var limits = new ExtendedLimits();
                    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)));
                    using (var provider = StartProvider(exe, args, cwd, job, input, output, errors)) {
                        var writes = Copy(relay.StandardOutput.BaseStream, input, true);
                        var reads = Copy(output, relay.StandardInput.BaseStream, true);
                        var discard = Copy(errors, Stream.Null, false);
                        relay.WaitForExit();
                        status = relay.ExitCode;
                        if (provider.HasExited && status == 0) status = provider.ExitCode;
                        // Closing the job also kills descendants which have inherited a pipe.
                        job.Close();
                        provider.WaitForExit();
                        Task.WaitAll(new[] { writes, reads, discard }, 3000);
                    }
                }
            } finally {
                try { relay.StandardInput.BaseStream.Close(); } catch (ObjectDisposedException) {}
                if (!relay.HasExited && !relay.WaitForExit(3000)) relay.Kill();
                events.Wait(3000);
                // With the provider's cwd handle released the directory can now be removed.
                info.Arguments = "\"" + script + "\" --dispose " + settings;
                using (var cleanup = Process.Start(info)) cleanup.WaitForExit();
            }
            return status;
        }
    }
}
