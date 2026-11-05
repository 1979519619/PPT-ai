param([int]$OwnerPid = 0)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies @('System.Windows.Forms','System.Drawing','System.Core') -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  private delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
  private delegate IntPtr MouseProc(int code, IntPtr message, IntPtr data);
  private delegate IntPtr KeyboardProc(int code, IntPtr message, IntPtr data);
  private static readonly WinEventProc EventCallback = OnWinEvent;
  private static readonly MouseProc MouseCallback = OnMouse;
  private static readonly KeyboardProc KeyboardCallback = OnKeyboard;
  private static readonly List<IntPtr> EventHooks = new List<IntPtr>();
  private static IntPtr MouseHook = IntPtr.Zero;
  private static IntPtr KeyboardHook = IntPtr.Zero;
  private static long TrackedWindow;
  private static long CurrentShowWindow;
  private static string TrackedRect = "";
  private static uint OwnerProcess;
  private static long Serial;
  private static long NavigationSerial;
  private static Thread HookThread, OutputThread;
  private static uint HookThreadId;
  private static readonly ManualResetEvent HookStarted = new ManualResetEvent(false);
  private static readonly AutoResetEvent InputReady = new AutoResetEvent(false);
  private static readonly ConcurrentQueue<string> InputEvents = new ConcurrentQueue<string>();
  private static readonly object OutputGate = new object();
  private static volatile bool HookReady, StopOutput, VoicePressed, LassoPressed;
  private static long LastPumpStamp;
  private static IntPtr OwnerHandle = IntPtr.Zero;

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int v);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
  [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int id, MouseProc callback, IntPtr module, uint thread);
  [DllImport("user32.dll", EntryPoint="SetWindowsHookExW", CharSet=CharSet.Unicode)] private static extern IntPtr SetKeyboardHookEx(int id, KeyboardProc callback, IntPtr module, uint thread);
  [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr process);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("user32.dll", EntryPoint="PostThreadMessageW", ExactSpelling=true)] private static extern bool PostThreadMessage(uint thread, uint message, IntPtr wparam, IntPtr lparam);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] private struct MONITORINFO { public int Size; public RECT Monitor, Work; public uint Flags; }
  [StructLayout(LayoutKind.Sequential)] private struct MOUSEINFO { public POINT Point; public uint Data, Flags, Time; public IntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] private struct KEYBOARDINFO { public uint Key, Scan, Flags, Time; public IntPtr Extra; }

  public sealed class WindowInfo {
    public long Hwnd;
    public uint Pid;
    public string Exe, Title, ClassName, Rect;
    public bool Full, ShowClass;
  }

  public static void EnablePhysicalCoordinates() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) {}
  }
  public static string ExeOf(uint pid) {
    IntPtr hp=OpenProcess(0x1000,false,pid);
    if(hp==IntPtr.Zero)return "";
    try {
      StringBuilder name=new StringBuilder(1024);uint size=1024;
      return QueryFullProcessImageName(hp,0,name,ref size) ? System.IO.Path.GetFileName(name.ToString()) : "";
    } finally { CloseHandle(hp); }
  }
  private static string TextOf(IntPtr h, bool windowClass) {
    StringBuilder text=new StringBuilder(1024);
    if(windowClass)GetClassName(h,text,text.Capacity);else GetWindowText(h,text,text.Capacity);
    return text.ToString();
  }
  public static bool IsFullScreen(IntPtr h) {
    RECT rect;
    if(h==IntPtr.Zero || !GetWindowRect(h,out rect))return false;
    MONITORINFO monitor=new MONITORINFO();monitor.Size=Marshal.SizeOf(typeof(MONITORINFO));
    if(!GetMonitorInfo(MonitorFromWindow(h,2),ref monitor))return false;
    return Math.Abs(rect.L-monitor.Monitor.L)<=3 && Math.Abs(rect.T-monitor.Monitor.T)<=3
      && Math.Abs(rect.R-monitor.Monitor.R)<=3 && Math.Abs(rect.B-monitor.Monitor.B)<=3;
  }
  public static WindowInfo Info(IntPtr h) {
    RECT rect=new RECT();GetWindowRect(h,out rect);uint process;GetWindowThreadProcessId(h,out process);
    return new WindowInfo {Hwnd=h.ToInt64(),Pid=process,Exe=ExeOf(process),Title=TextOf(h,false),
      ClassName=TextOf(h,true),Rect=rect.L+","+rect.T+","+rect.R+","+rect.B,Full=IsFullScreen(h)};
  }
  public static WindowInfo[] FindShows() {
    List<WindowInfo> found=new List<WindowInfo>();
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h) || !IsFullScreen(h))return true;
      WindowInfo info=Info(h);
      bool presentation=String.Equals(info.Exe,"POWERPNT.EXE",StringComparison.OrdinalIgnoreCase)
        || String.Equals(info.Exe,"wpp.exe",StringComparison.OrdinalIgnoreCase);
      bool showClass=Regex.IsMatch(info.ClassName,@"^(screenClass|wpp.*(slideshow|slide.?show|showwindow|screen).*|(wps|kingsoft).*(slideshow|slide.?show|showwindow).*)$",RegexOptions.IgnoreCase);
      bool showTitle=Regex.IsMatch(info.Title,@"幻灯片放映|投影片放映|Slide\s*Show",RegexOptions.IgnoreCase);
      info.ShowClass=showClass;
      // Let COM validate unfamiliar WPS window classes too; native fallback still requires ShowClass.
      if(presentation)found.Add(info);
      return true;
    },IntPtr.Zero);
    return found.ToArray();
  }
  public static void TrackForeground(IntPtr h) {
    IntPtr root=GetAncestor(h,2);if(root==IntPtr.Zero)root=h;
    uint process;GetWindowThreadProcessId(root,out process);
    if(root!=IntPtr.Zero && process!=OwnerProcess) {
      RECT rect;
      if(!GetWindowRect(root,out rect))return;
      string geometry=rect.L+","+rect.T+","+rect.R+","+rect.B;
      if(root.ToInt64()==Interlocked.Read(ref TrackedWindow) && TrackedRect!=geometry)Interlocked.Increment(ref Serial);
      Interlocked.Exchange(ref TrackedWindow,root.ToInt64());TrackedRect=geometry;
    }
  }
  private static bool IsTrackedSource(IntPtr h) {
    if(h==IntPtr.Zero)return false;
    IntPtr root=GetAncestor(h,2);if(root==IntPtr.Zero)root=h;
    uint process;GetWindowThreadProcessId(root,out process);
    return root.ToInt64()==Interlocked.Read(ref TrackedWindow) && process!=OwnerProcess;
  }
  public static void SetShowWindow(IntPtr h) { Interlocked.Exchange(ref CurrentShowWindow,h.ToInt64()); }
  private static bool IsShowSource(IntPtr h) {
    long show=Interlocked.Read(ref CurrentShowWindow);
    if(show==0 || !IsTrackedSource(h))return false;
    IntPtr root=GetAncestor(h,2);if(root==IntPtr.Zero)root=h;
    return root.ToInt64()==show;
  }
  private static void OnWinEvent(IntPtr hook,uint ev,IntPtr hwnd,int obj,int child,uint thread,uint time) {
    try {
      if(obj==-9 || obj==-8 || !IsTrackedSource(hwnd))return;
      bool scrollEvent=ev==0x12 || ev==0x13;
      bool scrollbar=obj==-5 || obj==-6 || TextOf(hwnd,true).IndexOf("scroll",StringComparison.OrdinalIgnoreCase)>=0;
      bool sourceClient=hwnd.ToInt64()==Interlocked.Read(ref TrackedWindow) && obj==-4 && child==0;
      // Ignore unrelated child controls, caret blinking and duplicate root move
      // notifications. Actual root geometry is compared in TrackForeground.
      if(scrollEvent || scrollbar || sourceClient)Interlocked.Increment(ref Serial);
    } catch {}
  }
  private static IntPtr OnMouse(int code,IntPtr message,IntPtr data) {
    try {
      long kind=message.ToInt64();
      bool wheel=kind==0x020A || kind==0x020E;
      bool down=kind==0x0201 || kind==0x0204 || kind==0x0207 || kind==0x020B;
      if(code>=0 && (wheel || down)) {
        MOUSEINFO mouse=(MOUSEINFO)Marshal.PtrToStructure(data,typeof(MOUSEINFO));
        IntPtr target=WindowFromPoint(mouse.Point);
        if(wheel && IsTrackedSource(target))Interlocked.Increment(ref Serial);
        // The clicked window, rather than the old foreground window, is used
        // because activation occurs after the low-level mouse-down callback.
        if(IsShowSource(target))Interlocked.Increment(ref NavigationSerial);
      }
    } catch {}
    return CallNextHookEx(MouseHook,code,message,data);
  }
  private static IntPtr OnKeyboard(int code,IntPtr message,IntPtr data) {
    try {
      long kind=message.ToInt64();
      bool down=kind==0x0100 || kind==0x0104;
      bool up=kind==0x0101 || kind==0x0105;
      if(code>=0 && (down || up)) {
        KEYBOARDINFO key=(KEYBOARDINFO)Marshal.PtrToStructure(data,typeof(KEYBOARDINFO));
        UpdateShortcutFromKey(key.Key,down);
        if(down && IsShowSource(GetForegroundWindow())
        && (GetAsyncKeyState(0x11)&0x8000)==0 && (GetAsyncKeyState(0x12)&0x8000)==0) {
          bool navigation=(key.Key>=0x21 && key.Key<=0x28) || key.Key==0x20
            || key.Key==0x0D || key.Key==0x08 || key.Key==0x1B || key.Key==0x4E || key.Key==0x50;
          if(navigation)Interlocked.Increment(ref NavigationSerial);
        }
      }
    } catch {}
    return CallNextHookEx(KeyboardHook,code,message,data);
  }
  private static bool Down(int key) { return (GetAsyncKeyState(key)&0x8000)!=0; }
  private static void QueueInput(string value) {
    string discarded;
    while(InputEvents.Count>=64)InputEvents.TryDequeue(out discarded);
    InputEvents.Enqueue(value);InputReady.Set();
  }
  private static void SetShortcutStates(bool voice,bool lasso) {
    bool previousVoice=VoicePressed, previousLasso=LassoPressed;
    VoicePressed=voice;LassoPressed=lasso;
    if(voice && !previousVoice)QueueInput("voiceDown");
    if(!voice && previousVoice)QueueInput("voiceUp");
    if(lasso && !previousLasso && !voice)QueueInput("lassoDown");
  }
  private static void PollShortcuts() {
    bool control=Down(0x11),alt=Down(0x12);
    SetShortcutStates(control && alt && Down(0x20),control && alt && Down(0x58));
  }
  private static void UpdateShortcutFromKey(uint key,bool down) {
    if(key!=0x11 && key!=0x12 && key!=0x20 && key!=0x58 && key!=0xA2 && key!=0xA3 && key!=0xA4 && key!=0xA5)return;
    bool control=Down(0x11),alt=Down(0x12),space=Down(0x20),x=Down(0x58);
    if(key==0x11)control=down;
    if(key==0xA2)control=down || Down(0xA3);
    if(key==0xA3)control=down || Down(0xA2);
    if(key==0x12)alt=down;
    if(key==0xA4)alt=down || Down(0xA5);
    if(key==0xA5)alt=down || Down(0xA4);
    if(key==0x20)space=down;
    if(key==0x58)x=down;
    SetShortcutStates(control && alt && space,control && alt && x);
  }
  private static void InstallCoreHooks() {
    uint[,] ranges={{0x12,0x13},{0x800E,0x800E},{0x800B,0x800B}};
    for(int i=0;i<ranges.GetLength(0);i++) {
      IntPtr hook=SetWinEventHook(ranges[i,0],ranges[i,1],IntPtr.Zero,EventCallback,0,0,2);
      if(hook!=IntPtr.Zero)EventHooks.Add(hook);
    }
    MouseHook=SetWindowsHookEx(14,MouseCallback,GetModuleHandle(null),0);
    KeyboardHook=SetKeyboardHookEx(13,KeyboardCallback,GetModuleHandle(null),0);
  }
  private static void RemoveCoreHooks() {
    HookReady=false;
    foreach(IntPtr hook in EventHooks)UnhookWinEvent(hook);EventHooks.Clear();
    if(MouseHook!=IntPtr.Zero)UnhookWindowsHookEx(MouseHook);MouseHook=IntPtr.Zero;
    if(KeyboardHook!=IntPtr.Zero)UnhookWindowsHookEx(KeyboardHook);KeyboardHook=IntPtr.Zero;
  }
  private static void HookLoop() {
    System.Windows.Forms.Timer timer=null;
    try {
      HookThreadId=GetCurrentThreadId();
      Interlocked.Exchange(ref LastPumpStamp,Stopwatch.GetTimestamp());
      InstallCoreHooks();
      timer=new System.Windows.Forms.Timer();timer.Interval=20;
      timer.Tick+=(sender,args)=>{
        Interlocked.Exchange(ref LastPumpStamp,Stopwatch.GetTimestamp());
        TrackForeground(GetForegroundWindow());PollShortcuts();
      };
      HookReady=true;timer.Start();HookStarted.Set();
      // The hook message pump never performs Office COM calls, output writes,
      // sleeps, screenshot work or recognition. Slow COM cannot starve it.
      System.Windows.Forms.Application.Run();
    } catch { HookReady=false; }
    finally {
      if(timer!=null){timer.Stop();timer.Dispose();}
      SetShortcutStates(false,false);RemoveCoreHooks();HookStarted.Set();
    }
  }
  public static void WriteState(string json) {
    lock(OutputGate){Console.Out.WriteLine(json);Console.Out.Flush();}
  }
  private static void OutputLoop() {
    long lastHeartbeat=0;
    while(!StopOutput) {
      InputReady.WaitOne(250);
      string input;
      while(InputEvents.TryDequeue(out input))WriteState("{\"type\":\"input\",\"evt\":\""+input+"\"}");
      long now=Stopwatch.GetTimestamp();
      if((now-lastHeartbeat)*1000.0/Stopwatch.Frequency<500)continue;
      lastHeartbeat=now;
      // A helper must not remain orphaned after its owning Electron process is
      // forcibly terminated. This handle identifies that process, not a reused PID.
      if(OwnerHandle!=IntPtr.Zero && WaitForSingleObject(OwnerHandle,0)==0){Environment.Exit(0);return;}
      WriteState("{\"type\":\"heartbeat\",\"navigationTracking\":\""+NavigationTracking()+
        "\",\"activityTracking\":\""+ActivityTracking()+"\",\"hookAgeMs\":"+HookAgeMs()+
        ",\"hookHealth\":\""+HookHealth()+"\""+
        ",\"activitySerial\":"+ActivitySerial()+",\"navigationSerial\":"+ShowNavigationSerial()+
        ",\"showHwnd\":"+Interlocked.Read(ref CurrentShowWindow)+"}");
    }
  }
  public static string StartHooks(uint owner) {
    OwnerProcess=owner;StopOutput=false;HookStarted.Reset();
    if(owner!=0)OwnerHandle=OpenProcess(0x100000,false,owner);
    HookThread=new Thread(new ThreadStart(HookLoop));HookThread.IsBackground=true;
    HookThread.SetApartmentState(ApartmentState.STA);HookThread.Start();HookStarted.WaitOne(2000);
    OutputThread=new Thread(new ThreadStart(OutputLoop));OutputThread.IsBackground=true;OutputThread.Start();
    return ActivityTracking();
  }
  public static long HookAgeMs() {
    long last=Interlocked.Read(ref LastPumpStamp);
    return last==0 ? Int64.MaxValue : (long)Math.Max(0,(Stopwatch.GetTimestamp()-last)*1000.0/Stopwatch.Frequency);
  }
  private static bool PumpResponsive() { return HookReady && HookThread!=null && HookThread.IsAlive && HookAgeMs()<1500; }
  // Windows does not expose a supported validity query for silently removed
  // low-level hooks. Report responsive registration separately from observed
  // navigation counters rather than calling a saved HHOOK proof of delivery.
  public static string HookHealth() { return PumpResponsive() ? "responsive-registration" : "pump-unavailable"; }
  public static bool VoiceHeld() { return VoicePressed; }
  public static bool LassoHeld() { return LassoPressed; }
  public static long ActivitySerial() { return Interlocked.Read(ref Serial); }
  public static long ShowNavigationSerial() { return Interlocked.Read(ref NavigationSerial); }
  public static string ActivityTracking() {
    if(!PumpResponsive())return "unavailable";
    if(EventHooks.Count==3 && MouseHook!=IntPtr.Zero)return "native";
    return EventHooks.Count>0 || MouseHook!=IntPtr.Zero ? "partial" : "unavailable";
  }
  public static string NavigationTracking() {
    if(!PumpResponsive())return "unavailable";
    if(MouseHook!=IntPtr.Zero && KeyboardHook!=IntPtr.Zero)return "native";
    return MouseHook!=IntPtr.Zero || KeyboardHook!=IntPtr.Zero ? "partial" : "unavailable";
  }
  public static void StopHooks() {
    HookReady=false;
    if(HookThreadId!=0)PostThreadMessage(HookThreadId,0x0012,IntPtr.Zero,IntPtr.Zero);
    if(HookThread!=null && HookThread.IsAlive)HookThread.Join(1000);
    StopOutput=true;InputReady.Set();
    if(OutputThread!=null && OutputThread.IsAlive)OutputThread.Join(1000);
    if(OwnerHandle!=IntPtr.Zero){CloseHandle(OwnerHandle);OwnerHandle=IntPtr.Zero;}
    Interlocked.Exchange(ref CurrentShowWindow,0);
  }
}
"@

function Release-ComReference($Value) {
  if($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) {
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Value) } catch {}
  }
}

function Get-OfficeWindowHandle($Value) {
  $handle=[long]$Value
  # Office's automation contract may expose HWND as a signed 32-bit integer.
  if($handle -lt 0 -and $handle -ge [int32]::MinValue) { return $handle + 4294967296L }
  return $handle
}

function Get-PresentationIdentity($Presentation) {
  $identity=''
  try { $identity=[string]$Presentation.FullName } catch {}
  if(-not $identity) { try { $identity=[string]$Presentation.Name } catch {} }
  if(-not $identity) { return '' }
  $hasher=[Security.Cryptography.SHA256]::Create()
  try {
    $bytes=[Text.Encoding]::UTF8.GetBytes($identity)
    return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
  } finally { $hasher.Dispose() }
}

function Get-ShowInfo($ShowWindow,$Application,$ProgId,$Candidates) {
  $view=$null;$slide=$null;$presentation=$null;$activeShow=$null
  try {
    $handle=Get-OfficeWindowHandle $ShowWindow.HWND
    $native=$Candidates | Where-Object { $_.Hwnd -eq $handle } | Select-Object -First 1
    if($null -eq $native) { return $null }
    $view=$ShowWindow.View
    $index=$null;$position=$null;$pageSource='slide-index';$pageToken=''
    try {
      $slide=$view.Slide
      $candidateIndex=[int]$slide.SlideIndex
      if($candidateIndex -gt 0) { $index=$candidateIndex;$pageToken="index:$index" }
    } catch {}
    if($null -eq $index) {
      try {
        $candidatePosition=[int]$view.CurrentShowPosition
        if($candidatePosition -gt 0) {
          $position=$candidatePosition;$pageSource='show-position';$pageToken="position:$position"
        }
      } catch {}
      if($null -eq $position) { return $null }
    }
    try { $presentation=$ShowWindow.Presentation } catch {}
    if($null -eq $presentation) {
      $presentation=$Application.ActivePresentation
      $activeShow=$presentation.SlideShowWindow
      if((Get-OfficeWindowHandle $activeShow.HWND) -ne $handle) { return $null }
    }
    $identity=Get-PresentationIdentity $presentation
    if(-not $identity) { return $null }
    return [pscustomobject]@{
      hwnd=$handle;pageKey="$ProgId|$handle|$identity|$pageToken";slideIndex=$index;showPosition=$position;pageSource=$pageSource;native=$native
    }
  } catch { return $null }
  finally {
    Release-ComReference $activeShow
    Release-ComReference $presentation
    Release-ComReference $slide
    Release-ComReference $view
  }
}

function Get-TrackedShows($Candidates) {
  if($Candidates.Count -eq 0) { return }
  foreach($progId in @('PowerPoint.Application','KWPP.Application','WPP.Application')) {
    $isPowerPoint=$progId -eq 'PowerPoint.Application'
    $matching=@($Candidates | Where-Object { if($isPowerPoint){$_.Exe -ieq 'POWERPNT.EXE'}else{$_.Exe -ieq 'wpp.exe'} })
    if($matching.Count -eq 0) { continue }
    $application=$null;$windows=$null;$active=$null;$fallback=$null
    try {
      # GetActiveObject only attaches to a running application; it never starts Office.
      $application=[Runtime.InteropServices.Marshal]::GetActiveObject($progId)
      $count=0
      try { $windows=$application.SlideShowWindows;$count=[int]$windows.Count } catch {}
      if($count -gt 0) {
        for($i=1;$i -le $count;$i++) {
          $showWindow=$null
          try {
            $showWindow=$windows.Item($i)
            $info=Get-ShowInfo $showWindow $application $progId $matching
            if($null -ne $info) { $info }
          } catch {}
          finally { Release-ComReference $showWindow }
        }
      } else {
        # Some WPS versions expose the active presentation's show window only.
        $active=$application.ActivePresentation
        $fallback=$active.SlideShowWindow
        $info=Get-ShowInfo $fallback $application $progId $matching
        if($null -ne $info) { $info }
      }
    } catch {}
    finally {
      Release-ComReference $fallback
      Release-ComReference $active
      Release-ComReference $windows
      Release-ComReference $application
    }
  }
}

[W]::EnablePhysicalCoordinates()
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$null=[W]::StartHooks([uint32][Math]::Max(0,$OwnerPid))
try {
  while($true) {
    $h=[W]::GetForegroundWindow()
    $foreground=[W]::Info($h)
    $root=[W]::GetAncestor($h,2)
    if($root -eq [IntPtr]::Zero){$root=$h}
    $rootInfo=[W]::Info($root)
    $candidates=@([W]::FindShows())
    $tracked=@(Get-TrackedShows $candidates)
    $show=$tracked | Where-Object { $_.hwnd -eq $root.ToInt64() } | Select-Object -First 1
    if($null -eq $show){$show=$tracked | Select-Object -First 1}
    $showNative=$null;$showHwnd=0;$pageKey='';$tracking='unavailable';$slideIndex=$null;$showPosition=$null;$pageSource='unavailable'
    if($null -ne $show) {
      $showNative=$show.native;$showHwnd=$show.hwnd;$pageKey=$show.pageKey;$tracking='slide';$slideIndex=$show.slideIndex
      $showPosition=$show.showPosition;$pageSource=$show.pageSource
    } else {
      # A matching title alone could be an editor document name. Without COM,
      # only a known slideshow window class is a native show candidate.
      $nativeShows=@($candidates | Where-Object { $_.ShowClass })
      $showNative=$nativeShows | Where-Object { $_.Hwnd -eq $root.ToInt64() } | Select-Object -First 1
      if($null -eq $showNative){$showNative=$nativeShows | Select-Object -First 1}
      if($null -ne $showNative){$showHwnd=$showNative.Hwnd}
    }
    [W]::SetShowWindow([IntPtr]$showHwnd)
    $voice=[W]::VoiceHeld();$lasso=[W]::LassoHeld()
    $showRect='';$showTitle=''
    if($null -ne $showNative){$showRect=$showNative.Rect;$showTitle=$showNative.Title}
    $o=[pscustomobject]@{
      fg=$h.ToInt64();pid=$foreground.Pid;exe=$foreground.Exe;full=$foreground.Full;rect=$foreground.Rect
      title=$foreground.Title;windowClass=$foreground.ClassName
      foregroundWindowRoot=$root.ToInt64();foregroundPid=$rootInfo.Pid
      show=($showHwnd -ne 0);showHwnd=$showHwnd;showRect=$showRect;showTitle=$showTitle
      pageKey=$pageKey;tracking=$tracking;slideIndex=$slideIndex;showPosition=$showPosition;pageSource=$pageSource
      activitySerial=[W]::ActivitySerial();activityTracking=[W]::ActivityTracking()
      navigationSerial=[W]::ShowNavigationSerial();navigationTracking=[W]::NavigationTracking()
      hookAgeMs=[W]::HookAgeMs()
      hookHealth=[W]::HookHealth()
      voice=$voice;lasso=$lasso;evt=''
    }
    [W]::WriteState(($o | ConvertTo-Json -Compress))
    Start-Sleep -Milliseconds 200
  }
} finally { [W]::StopHooks() }

