# Read-only, optional slideshow metadata. This helper never creates Office,
# opens a presentation, edits a shape, advances animation, or writes source text.
# Unsupported visibility/animation/coordinate capabilities return an empty result.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$WarningPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)

function Release-NativeCom($Value) {
  if($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) {
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Value) } catch {}
  }
}
function Get-NativeHandle($Value) {
  $handle=[long]$Value
  if($handle -lt 0 -and $handle -ge [int32]::MinValue) { return $handle + 4294967296L }
  return $handle
}
function Get-NativeIdentity($Presentation) {
  $name=''
  try { $name=[string]$Presentation.FullName } catch {}
  if(-not $name) { try { $name=[string]$Presentation.Name } catch {} }
  if(-not $name) { return '' }
  $hash=[Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($name)))).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
function Test-NativeNumber($Value) {
  try { $number=[double]$Value;return -not ([double]::IsNaN($number) -or [double]::IsInfinity($number)) } catch { return $false }
}
function Test-NativeRect($Rect) {
  if($null -eq $Rect) { return $false }
  foreach($member in @('x','y','width','height')) { if(-not (Test-NativeNumber $Rect.$member)) { return $false } }
  return ([double]$Rect.width -gt 0 -and [double]$Rect.height -gt 0)
}
function Test-NativeContained($Rect,$Bounds,[double]$Tolerance=0.5) {
  return (Test-NativeRect $Rect) -and (Test-NativeRect $Bounds) -and
    $Rect.x -ge ($Bounds.x-$Tolerance) -and $Rect.y -ge ($Bounds.y-$Tolerance) -and
    ($Rect.x+$Rect.width) -le ($Bounds.x+$Bounds.width+$Tolerance) -and
    ($Rect.y+$Rect.height) -le ($Bounds.y+$Bounds.height+$Tolerance)
}
function Get-NativeUnion($Rects) {
  $items=@($Rects)
  if($items.Count -eq 0) { return $null }
  $left=[double]::PositiveInfinity;$top=[double]::PositiveInfinity
  $right=[double]::NegativeInfinity;$bottom=[double]::NegativeInfinity
  foreach($rect in $items) {
    $left=[Math]::Min($left,$rect.x);$top=[Math]::Min($top,$rect.y)
    $right=[Math]::Max($right,$rect.x+$rect.width);$bottom=[Math]::Max($bottom,$rect.y+$rect.height)
  }
  return [pscustomobject]@{x=$left;y=$top;width=$right-$left;height=$bottom-$top}
}
function Convert-NativeSlideRect($Rect,$Map) {
  return [pscustomobject]@{
    x=$Map.screenX+($Map.left+$Rect.x*$Map.scale-$Map.monitorX)*$Map.dipX
    y=$Map.screenY+($Map.top+$Rect.y*$Map.scale-$Map.monitorY)*$Map.dipY
    width=$Rect.width*$Map.scale*$Map.dipX
    height=$Rect.height*$Map.scale*$Map.dipY
  }
}
function Get-NativeTextRect($Range,$Map) {
  # BoundLeft and BoundTop are already relative to the slide, not the Shape.
  $pointRect=[pscustomobject]@{x=[double]$Range.BoundLeft;y=[double]$Range.BoundTop;
    width=[double]$Range.BoundWidth;height=[double]$Range.BoundHeight}
  if(-not (Test-NativeContained $pointRect $Map.slideRect 1)) { return $null }
  return Convert-NativeSlideRect $pointRect $Map
}
function Add-NativeSequenceIds($Sequence,$Ids) {
  $count=[int]$Sequence.Count
  if($count -lt 0 -or $count -gt 2000) { throw 'unsupported-animation-count' }
  for($index=1;$index -le $count;$index++) {
    $effect=$null;$animated=$null
    try { $effect=$Sequence.Item($index);$animated=$effect.Shape;[void]$Ids.Add([int]$animated.Id) }
    finally { Release-NativeCom $animated;Release-NativeCom $effect }
  }
}
function Get-NativeAnimatedIds($Slide) {
  $timeline=$null;$main=$null;$interactive=$null
  $ids=[Collections.Generic.HashSet[int]]::new()
  try {
    $timeline=$Slide.TimeLine
    # Capability failure is deliberately not interpreted as "no animation".
    $main=$timeline.MainSequence
    Add-NativeSequenceIds $main $ids
    $interactive=$timeline.InteractiveSequences
    $count=[int]$interactive.Count
    if($count -lt 0 -or $count -gt 1000) { throw 'unsupported-animation-count' }
    for($index=1;$index -le $count;$index++) {
      $sequence=$null
      try { $sequence=$interactive.Item($index);Add-NativeSequenceIds $sequence $ids }
      finally { Release-NativeCom $sequence }
    }
    # Prevent PowerShell from enumerating a collection when returning it.
    return ,$ids
  } finally { Release-NativeCom $interactive;Release-NativeCom $main;Release-NativeCom $timeline }
}
function Get-NativeLineFont($Range,$Map) {
  $runs=$null;$points=$null;$mixed=$false
  try {
    $runs=$Range.Runs();$count=[int]$runs.Count
    if($count -lt 1 -or $count -gt 1000) { return [pscustomobject]@{mixedFont=$true} }
    for($index=1;$index -le $count;$index++) {
      $run=$null;$font=$null
      try {
        $run=$Range.Runs($index,1);$font=$run.Font;$size=[double]$font.Size
        if(-not (Test-NativeNumber $size) -or $size -le 0 -or $size -gt 4000) { $mixed=$true;continue }
        if($null -eq $points) { $points=$size } elseif([Math]::Abs($points-$size) -gt 0.05) { $mixed=$true }
      } finally { Release-NativeCom $font;Release-NativeCom $run }
    }
    if($mixed -or $null -eq $points) { return [pscustomobject]@{mixedFont=$true} }
    return [pscustomobject]@{mixedFont=$false;fontPoints=$points;fontSize=$points*$Map.scale*$Map.dipY}
  } catch { return [pscustomobject]@{mixedFont=$true} }
  finally { Release-NativeCom $runs }
}
function Get-NativeShapeLines($Shape,$Map,$Regions,$Animated) {
  $frame=$null;$range=$null;$allLines=$null;$legacy=$null
  try {
    if([int]$Shape.Visible -ne -1 -or $Animated.Contains([int]$Shape.Id)) { return }
    # Groups/SmartArt/images/embedded objects are intentionally OCR-only.
    if([int]$Shape.Type -notin @(1,14,17)) { return }
    if([Math]::Abs([double]$Shape.Rotation) -gt 0.01 -or [int]$Shape.HasTextFrame -ne -1) { return }
    $legacy=$Shape.AnimationSettings
    if([int]$legacy.Animate -ne 0 -or [int]$legacy.EntryEffect -ne 0) { return }
    $frame=$Shape.TextFrame
    if([int]$frame.HasText -ne -1 -or [int]$frame.Orientation -ne 1) { return }
    $range=$frame.TextRange
    $rect=Get-NativeTextRect $range $Map
    if($null -eq $rect) { return }
    $selection=$Regions | Where-Object { Test-NativeContained $rect $_.rect 0.5 } | Select-Object -First 1
    if($null -eq $selection) { return }
    # Read only shapes wholly within a user region; never return surrounding text.
    $allLines=$range.Lines();$count=[int]$allLines.Count
    if($count -lt 1 -or $count -gt 400) { return }
    for($index=1;$index -le $count;$index++) {
      $line=$null
      try {
        $line=$range.Lines($index,1)
        $lineRect=Get-NativeTextRect $line $Map
        if($null -eq $lineRect -or -not (Test-NativeContained $lineRect $selection.rect 0.5)) { continue }
        $text=([string]$line.Text).Replace("`r","`n").Replace([char]11,[char]10).Trim()
        if(-not $text -or $text.Length -gt 10000) { continue }
        $font=Get-NativeLineFont $line $Map
        $value=[ordered]@{id=[string]$selection.id;text=$text;rect=$lineRect;confidence=1;mixedFont=$font.mixedFont}
        if($null -ne $font.fontSize) { $value.fontSize=$font.fontSize;$value.fontPoints=$font.fontPoints }
        [pscustomobject]$value
      } finally { Release-NativeCom $line }
    }
  } catch { return }
  finally { Release-NativeCom $allLines;Release-NativeCom $range;Release-NativeCom $frame;Release-NativeCom $legacy }
}

$request=$null;$result=$null
try {
  $inputText=[Console]::In.ReadToEnd()
  if($inputText.Length -gt 128000) { throw 'input-limit' }
  $request=$inputText | ConvertFrom-Json
  if(-not (Test-NativeRect $request.screenBounds) -or -not $request.pageKey -or
      [long]$request.showHwnd -le 0 -or @($request.regions).Count -lt 1 -or @($request.regions).Count -gt 5) { throw 'invalid-request' }

  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeSlideWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor,Work; public uint Flags; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window,out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window,ref POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window,uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT point,uint flags);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor,ref MONITORINFO info);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access,bool inherit,uint process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public static string Exe(IntPtr window) {
    uint process;GetWindowThreadProcessId(window,out process);IntPtr handle=OpenProcess(0x1000,false,process);
    if(handle==IntPtr.Zero)return "";
    try { StringBuilder value=new StringBuilder(32768);uint size=32768;
      return QueryFullProcessImageName(handle,0,value,ref size)?System.IO.Path.GetFileName(value.ToString()):"";
    } finally { CloseHandle(handle); }
  }
  public static bool ForegroundMatches(IntPtr source,uint owner) {
    IntPtr current=GetForegroundWindow();IntPtr root=GetAncestor(current,2);if(root==IntPtr.Zero)root=current;
    if(root==source || current==source)return true;
    uint process;GetWindowThreadProcessId(root,out process);return process==owner;
  }
}
'@
  try { [void][NativeSlideWindow]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
  $handle=[IntPtr]([long]$request.showHwnd)
  if(-not [NativeSlideWindow]::IsWindowVisible($handle) -or [NativeSlideWindow]::IsIconic($handle) -or
      -not [NativeSlideWindow]::ForegroundMatches($handle,[uint32]$request.ownerPid)) { throw 'source-window-unavailable' }
  $exe=[NativeSlideWindow]::Exe($handle)
  $parts=([string]$request.pageKey).Split('|')
  if($parts.Count -ne 4 -or [long]$parts[1] -ne [long]$request.showHwnd) { throw 'page-identity-unavailable' }
  $progId=$parts[0]
  if(($progId -eq 'PowerPoint.Application' -and $exe -ine 'POWERPNT.EXE') -or
      ($progId -in @('KWPP.Application','WPP.Application') -and $exe -ine 'wpp.exe') -or
      $progId -notin @('PowerPoint.Application','KWPP.Application','WPP.Application')) { throw 'source-application-unavailable' }
  $client=[NativeSlideWindow+RECT]::new();$origin=[NativeSlideWindow+POINT]::new()
  if(-not [NativeSlideWindow]::GetClientRect($handle,[ref]$client) -or
      -not [NativeSlideWindow]::ClientToScreen($handle,[ref]$origin)) { throw 'client-geometry-unavailable' }
  $monitorInfo=[NativeSlideWindow+MONITORINFO]::new();$monitorInfo.Size=[Runtime.InteropServices.Marshal]::SizeOf($monitorInfo)
  $zero=[NativeSlideWindow+POINT]::new();$monitor=[NativeSlideWindow]::MonitorFromPoint($zero,1)
  if(-not [NativeSlideWindow]::GetMonitorInfo($monitor,[ref]$monitorInfo) -or ($monitorInfo.Flags -band 1) -eq 0) { throw 'primary-display-unavailable' }
  $monitorWidth=$monitorInfo.Monitor.Right-$monitorInfo.Monitor.Left
  $monitorHeight=$monitorInfo.Monitor.Bottom-$monitorInfo.Monitor.Top
  if([Math]::Abs($monitorWidth-[double]$request.pixelSize.width) -gt 2 -or
      [Math]::Abs($monitorHeight-[double]$request.pixelSize.height) -gt 2) { throw 'capture-geometry-mismatch' }
  $clientWidth=$client.Right-$client.Left;$clientHeight=$client.Bottom-$client.Top
  if($clientWidth -lt 200 -or $clientHeight -lt 150 -or $origin.X -lt $monitorInfo.Monitor.Left -or
      $origin.Y -lt $monitorInfo.Monitor.Top -or $origin.X+$clientWidth -gt $monitorInfo.Monitor.Right+1 -or
      $origin.Y+$clientHeight -gt $monitorInfo.Monitor.Bottom+1) { throw 'source-viewport-unavailable' }

  $application=$null;$shows=$null;$presentation=$null;$show=$null;$view=$null;$slide=$null;$setup=$null;$shapes=$null
  try {
    # Attach only; never call CreateObject, Presentations.Open or SlideShow.Run.
    $application=[Runtime.InteropServices.Marshal]::GetActiveObject($progId)
    try { $shows=$application.SlideShowWindows;$showCount=[int]$shows.Count } catch { $showCount=0 }
    if($showCount -gt 0 -and $showCount -le 20) {
      for($index=1;$index -le $showCount;$index++) {
        $candidate=$null
        try {
          $candidate=$shows.Item($index)
          if((Get-NativeHandle $candidate.HWND) -eq [long]$request.showHwnd) { $show=$candidate;$candidate=$null;break }
        } finally { Release-NativeCom $candidate }
      }
    } else {
      $presentation=$application.ActivePresentation;$show=$presentation.SlideShowWindow
    }
    if($null -eq $show -or (Get-NativeHandle $show.HWND) -ne [long]$request.showHwnd) { throw 'slideshow-unavailable' }
    $view=$show.View
    if([int]$view.State -ne 1) { throw 'slideshow-not-running' }
    $slide=$view.Slide;$slideIndex=[int]$slide.SlideIndex
    if($slideIndex -le 0) { throw 'slide-index-unavailable' }
    if($null -eq $presentation) { try { $presentation=$show.Presentation } catch {} }
    if($null -eq $presentation) { $presentation=$application.ActivePresentation }
    $identity=Get-NativeIdentity $presentation
    $pageKey="$progId|$($request.showHwnd)|$identity|index:$slideIndex"
    if($pageKey -ne [string]$request.pageKey) { throw 'page-changed' }
    # Embedded presentations can have a different point size/identity. Skip them.
    $slideParent=$null;$slideGrandparent=$null
    try {
      $slideParent=$slide.Parent;$parentIdentity=Get-NativeIdentity $slideParent
      # Object-model wrappers may expose Presentation directly or via Slides.
      # Traverse one parent, but still require the same presentation identity.
      if($parentIdentity -ne $identity) {
        $slideGrandparent=$slideParent.Parent;$parentIdentity=Get-NativeIdentity $slideGrandparent
      }
      if($parentIdentity -ne $identity) { throw 'embedded-slide-unavailable' }
    } finally { Release-NativeCom $slideGrandparent;Release-NativeCom $slideParent }
    $setup=$presentation.PageSetup;$slideWidth=[double]$setup.SlideWidth;$slideHeight=[double]$setup.SlideHeight
    if($slideWidth -le 0 -or $slideHeight -le 0 -or $slideWidth -gt 10000 -or $slideHeight -gt 10000) { throw 'slide-size-unavailable' }
    # The client viewport is in physical pixels; fit the slide with letterboxing.
    $scale=[Math]::Min($clientWidth/$slideWidth,$clientHeight/$slideHeight)
    $map=[pscustomobject]@{
      left=$origin.X+($clientWidth-$slideWidth*$scale)/2
      top=$origin.Y+($clientHeight-$slideHeight*$scale)/2;scale=$scale
      monitorX=$monitorInfo.Monitor.Left;monitorY=$monitorInfo.Monitor.Top
      dipX=[double]$request.screenBounds.width/$monitorWidth;dipY=[double]$request.screenBounds.height/$monitorHeight
      screenX=[double]$request.screenBounds.x;screenY=[double]$request.screenBounds.y
      slideRect=[pscustomobject]@{x=0;y=0;width=$slideWidth;height=$slideHeight}
    }
    try { $animated=Get-NativeAnimatedIds $slide } catch { throw 'animation-visibility-unavailable' }
    $all=[Collections.Generic.List[object]]::new()
    $shapes=$slide.Shapes;$shapeCount=[int]$shapes.Count
    if($shapeCount -gt 2000) { throw 'shape-count-unavailable' }
    for($index=1;$index -le $shapeCount;$index++) {
      $shape=$null
      try {
        $shape=$shapes.Item($index)
        foreach($line in @(Get-NativeShapeLines $shape $map $request.regions $animated)) { if($null -ne $line) { $all.Add($line) } }
      } finally { Release-NativeCom $shape }
      if($all.Count -gt 2000) { throw 'text-output-limit' }
    }
    # Recheck identity and window after potentially slow COM calls.
    $currentSlide=$null
    try {
      $currentSlide=$view.Slide
      if([int]$currentSlide.SlideIndex -ne $slideIndex -or [int]$view.State -ne 1 -or
          (Get-NativeHandle $show.HWND) -ne [long]$request.showHwnd -or
          (Get-NativeIdentity $presentation) -ne $identity) { throw 'page-changed' }
    }
    finally { Release-NativeCom $currentSlide }
    if(-not [NativeSlideWindow]::ForegroundMatches($handle,[uint32]$request.ownerPid) -or
        -not [NativeSlideWindow]::IsWindowVisible($handle)) { throw 'source-window-changed' }
    $clientAfter=[NativeSlideWindow+RECT]::new();$originAfter=[NativeSlideWindow+POINT]::new()
    if(-not [NativeSlideWindow]::GetClientRect($handle,[ref]$clientAfter) -or
        -not [NativeSlideWindow]::ClientToScreen($handle,[ref]$originAfter) -or
        $originAfter.X -ne $origin.X -or $originAfter.Y -ne $origin.Y -or
        $clientAfter.Right -ne $client.Right -or $clientAfter.Bottom -ne $client.Bottom) { throw 'source-geometry-changed' }
    $items=[Collections.Generic.List[object]]::new()
    foreach($region in @($request.regions)) {
      $lines=@($all | Where-Object { $_.id -eq [string]$region.id } | Sort-Object @{Expression={$_.rect.y}},@{Expression={$_.rect.x}})
      if($lines.Count -eq 0 -or $lines.Count -gt 400) { continue }
      $text=($lines | ForEach-Object { $_.text }) -join "`n"
      if($text.Length -gt 20000) { continue }
      $rects=@($lines | ForEach-Object { $_.rect });$rect=Get-NativeUnion $rects
      $heights=@($lines | ForEach-Object { $_.rect.height } | Sort-Object)
      $mixed=@($lines | Where-Object { $_.mixedFont -or $null -eq $_.fontSize }).Count -gt 0
      $fontSizes=@($lines | Where-Object { $null -ne $_.fontSize } | ForEach-Object { [double]$_.fontSize })
      if($fontSizes.Count -gt 0 -and (($fontSizes | Measure-Object -Maximum).Maximum - ($fontSizes | Measure-Object -Minimum).Minimum) -gt 0.1) { $mixed=$true }
      $value=[ordered]@{id=[string]$region.id;text=$text;rect=$rect;lines=$lines;
        glyphHeight=$heights[[int][Math]::Floor($heights.Count/2)];mixedFont=$mixed;confidence=1}
      if(-not $mixed -and $fontSizes.Count -gt 0) { $value.fontSize=$fontSizes[0] }
      $items.Add([pscustomobject]$value)
    }
    $result=[pscustomobject]@{regions=@($items.ToArray());provider=$(if($progId -eq 'PowerPoint.Application'){'powerpoint'}else{'wps'});
      pageKey=[string]$request.pageKey;snapshotId=[string]$request.snapshotId;diagnostic=$(if($items.Count){'native-available'}else{'native-no-supported-text'})}
  } finally {
    Release-NativeCom $shapes;Release-NativeCom $setup;Release-NativeCom $slide;Release-NativeCom $view
    Release-NativeCom $show;Release-NativeCom $presentation;Release-NativeCom $shows;Release-NativeCom $application
  }
} catch {
  # Only a fixed code is returned. Exception messages can reveal document paths.
  $diagnostic='native-capability-unavailable'
  $allowed=@('input-limit','invalid-request','source-window-unavailable','page-identity-unavailable',
    'source-application-unavailable','client-geometry-unavailable','primary-display-unavailable',
    'capture-geometry-mismatch','source-viewport-unavailable','slideshow-unavailable','slideshow-not-running',
    'slide-index-unavailable','page-changed','embedded-slide-unavailable','slide-size-unavailable',
    'animation-visibility-unavailable','shape-count-unavailable','text-output-limit','source-window-changed','source-geometry-changed')
  if($_.Exception.Message -in $allowed) { $diagnostic='native-'+$_.Exception.Message }
  $result=[pscustomobject]@{regions=@();provider='native';pageKey=[string]$request.pageKey;snapshotId=[string]$request.snapshotId;diagnostic=$diagnostic}
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 10 -Compress))
