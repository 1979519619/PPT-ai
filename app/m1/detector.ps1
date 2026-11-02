Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int v);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, uint pid);
  [DllImport("kernel32.dll")] public static extern bool QueryFullProcessImageName(IntPtr p, uint f, StringBuilder n, ref uint s);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }

  public static string ExeOf(uint pid) {
    IntPtr hp = OpenProcess(0x1000, false, pid);
    if (hp == IntPtr.Zero) return "";
    try {
      var sb = new StringBuilder(512); uint sz = 512;
      if (QueryFullProcessImageName(hp, 0, sb, ref sz)) return System.IO.Path.GetFileName(sb.ToString());
      return "";
    } finally { CloseHandle(hp); }
  }

  public static IntPtr FindShow(int sw, int sh, string[] names) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      if (r.L > 2 || r.T > 2 || r.R < sw - 2 || r.B < sh - 2) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      string exe = ExeOf(pid);
      foreach (var n in names) {
        if (string.Equals(n, exe, StringComparison.OrdinalIgnoreCase)) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$VK_CONTROL=0x11; $VK_MENU=0x12; $VK_SPACE=0x20; $VK_X=0x58
$prevVoice=$false; $prevLasso=$false
$out=[Console]::Out
$names=@('wpp.exe','POWERPNT.EXE')
while($true){
  Start-Sleep -Milliseconds 200
  $h=[W]::GetForegroundWindow()
  $r=New-Object W+RECT
  [void][W]::GetWindowRect($h,[ref]$r)
  $p=0; [void][W]::GetWindowThreadProcessId($h,[ref]$p)
  $exe=[W]::ExeOf($p)
  $scr=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $full=($r.L -le ($scr.X+2)) -and ($r.T -le ($scr.Y+2)) -and ($r.R -ge ($scr.Right-2)) -and ($r.B -ge ($scr.Bottom-2))
  $showW=[W]::FindShow($scr.Right,$scr.Bottom,$names)
  $showHwnd=0
  if($showW -ne [IntPtr]::Zero){ $showHwnd=$showW.ToInt64() }
  $ctrl=([W]::GetAsyncKeyState($VK_CONTROL) -band 0x8000) -ne 0
  $alt=([W]::GetAsyncKeyState($VK_MENU) -band 0x8000) -ne 0
  $space=([W]::GetAsyncKeyState($VK_SPACE) -band 0x8000) -ne 0
  $x=([W]::GetAsyncKeyState($VK_X) -band 0x8000) -ne 0
  $voice=$ctrl -and $alt -and $space
  $lasso=$ctrl -and $alt -and $x
  $evt=""
  if($voice -and -not $prevVoice){$evt="voiceDown"} elseif(-not $voice -and $prevVoice){$evt="voiceUp"} elseif($lasso -and -not $prevLasso){$evt="lassoDown"}
  $prevVoice=$voice; $prevLasso=$lasso
  $o=[pscustomobject]@{fg=$h.ToInt64(); pid=$p; exe=$exe; full=$full; rect="$($r.L),$($r.T),$($r.R),$($r.B)"; show=($showHwnd -ne 0); showHwnd=$showHwnd; voice=$voice; lasso=$lasso; evt=$evt}
  $out.WriteLine(($o | ConvertTo-Json -Compress)); $out.Flush()
}
