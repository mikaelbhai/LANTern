# Draws LANTern's two Android launcher icons and the TV banner, and writes
# them into the Android project's resources.
#
#   phone  ic_launcher*      a gold lantern with the network triangle, on charcoal
#   TV     ic_launcher_tv*   the same lantern with a play button, on navy
#   TV     tv_banner         the lantern, "LANTV" and a line under it
#
# Both builds used to ship the Tauri template's launcher icon, because
# `tauri android init` writes it and nothing ever replaced it; only the TV
# banner was ours. The manifest picks the icon through the ${appIcon}
# placeholder (app/build.gradle.kts), so the two packages can differ without a
# second resource tree.
#
# Run from anywhere:  powershell -File scripts\make-android-icons.ps1
# Drawn with GDI+ so there is no dependency to install; re-running overwrites.

Add-Type -AssemblyName System.Drawing

$res = Join-Path $PSScriptRoot '..\src-tauri\gen\android\app\src\main\res' | Resolve-Path

$gold = [System.Drawing.Color]::FromArgb(255, 245, 166, 35)
$goldLight = [System.Drawing.Color]::FromArgb(255, 255, 217, 138)
$white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

# The lantern, in a 512 unit square: the body as a closed outline, centred on
# (256, 258), 232 wide and 324 tall including its stroke.
$body = @(
  @(222, 118), @(290, 118), @(350, 205), @(350, 350),
  @(318, 398), @(194, 398), @(162, 350), @(162, 205)
)
$strokeW = 44.0
$boxH = 324.0

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  return @{ Bitmap = $bmp; G = $g }
}

# Draws the lantern with its middle at (cx, cy), `h` pixels tall.
function Draw-Lantern($g, [double]$cx, [double]$cy, [double]$h, [string]$glyph) {
  $k = $h / $boxH
  $pt = { param($x, $y) New-Object System.Drawing.PointF(($cx + ($x - 256) * $k), ($cy + ($y - 258) * $k)) }

  $pen = New-Object System.Drawing.Pen($gold, [single]($strokeW * $k))
  $pen.LineJoin = 'Round'
  $points = [System.Drawing.PointF[]]($body | ForEach-Object { & $pt $_[0] $_[1] })
  $g.DrawPolygon($pen, $points)

  if ($glyph -eq 'play') {
    # A play button where the nodes were: this is the television one.
    $fill = New-Object System.Drawing.SolidBrush($white)
    $tri = [System.Drawing.PointF[]]@((& $pt 238 205), (& $pt 238 331), (& $pt 322 268))
    $g.FillPolygon($fill, $tri)
    $edge = New-Object System.Drawing.Pen($white, [single](14 * $k))
    $edge.LineJoin = 'Round'
    $g.DrawPolygon($edge, $tri)
  } else {
    # The network triangle: three devices and the links between them.
    $link = New-Object System.Drawing.Pen($gold, [single](9 * $k))
    $link.StartCap = 'Round'; $link.EndCap = 'Round'
    $top = & $pt 256 222; $left = & $pt 209 310; $right = & $pt 302 310
    $g.DrawLine($link, $top, $left)
    $g.DrawLine($link, $top, $right)
    $g.DrawLine($link, (& $pt 232 310), (& $pt 280 310))
    $light = New-Object System.Drawing.SolidBrush($goldLight)
    $solid = New-Object System.Drawing.SolidBrush($gold)
    $r1 = 15 * $k; $r2 = 12 * $k
    $g.FillEllipse($light, [single]($top.X - $r1), [single]($top.Y - $r1), [single](2 * $r1), [single](2 * $r1))
    $g.FillEllipse($solid, [single]($left.X - $r2), [single]($left.Y - $r2), [single](2 * $r2), [single](2 * $r2))
    $g.FillEllipse($solid, [single]($right.X - $r2), [single]($right.Y - $r2), [single](2 * $r2), [single](2 * $r2))
  }
}

function Fill-Background($g, [int]$w, [int]$h, [string]$kind) {
  if ($kind -eq 'tv') {
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $b = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      $rect,
      [System.Drawing.Color]::FromArgb(255, 22, 40, 70),
      [System.Drawing.Color]::FromArgb(255, 7, 11, 22), 55.0)
    $g.FillRectangle($b, $rect)
  } else {
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 11, 13, 16))
    $g.FillRectangle($b, 0, 0, $w, $h)
  }
}

function Save-Png($canvas, [string]$path) {
  New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
  $canvas.Bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.G.Dispose(); $canvas.Bitmap.Dispose()
}

# Legacy launcher icons (before adaptive icons, and for round launchers).
function Launcher([int]$size, [string]$kind, [string]$shape, [string]$glyph) {
  $c = New-Canvas $size $size
  $g = $c.G
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  if ($shape -eq 'round') {
    $path.AddEllipse(0, 0, $size, $size)
  } else {
    $r = $size * 0.22
    $d = $r * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
  }
  $g.SetClip($path)
  Fill-Background $g $size $size $kind
  $g.ResetClip()
  Draw-Lantern $g ($size / 2) ($size / 2) ($size * 0.62) $glyph
  return $c
}

# The adaptive icon's foreground: 108dp, with the mark inside the 66dp that
# every launcher mask keeps.
function Foreground([int]$size, [string]$glyph) {
  $c = New-Canvas $size $size
  Draw-Lantern $c.G ($size / 2) ($size / 2) ($size * 0.54) $glyph
  return $c
}

$density = [ordered]@{ mdpi = 1.0; hdpi = 1.5; xhdpi = 2.0; xxhdpi = 3.0; xxxhdpi = 4.0 }
foreach ($name in $density.Keys) {
  $f = $density[$name]
  $dir = Join-Path $res "mipmap-$name"
  $legacy = [int](48 * $f)
  $fore = [int](108 * $f)

  Save-Png (Launcher $legacy 'phone' 'square' 'nodes') (Join-Path $dir 'ic_launcher.png')
  Save-Png (Launcher $legacy 'phone' 'round' 'nodes') (Join-Path $dir 'ic_launcher_round.png')
  Save-Png (Foreground $fore 'nodes') (Join-Path $dir 'ic_launcher_foreground.png')

  Save-Png (Launcher $legacy 'tv' 'square' 'play') (Join-Path $dir 'ic_launcher_tv.png')
  Save-Png (Launcher $legacy 'tv' 'round' 'play') (Join-Path $dir 'ic_launcher_tv_round.png')
  Save-Png (Foreground $fore 'play') (Join-Path $dir 'ic_launcher_tv_foreground.png')
}

# The television launcher's banner: 320 x 180 dp, drawn at xhdpi (640 x 360)
# so it stays sharp on a 4K set.
$bw = 640; $bh = 360
$c = New-Canvas $bw $bh
Fill-Background $c.G $bw $bh 'tv'
Draw-Lantern $c.G 150 ($bh / 2) 250 'play'
$titleFont = New-Object System.Drawing.Font('Segoe UI', 92, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$subFont = New-Object System.Drawing.Font('Segoe UI', 26, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$c.G.DrawString('LANTV', $titleFont, [System.Drawing.Brushes]::White, 262, 110)
$c.G.DrawString('Theatre on your network', $subFont,
  (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 190, 200, 220))), 268, 214)
Save-Png $c (Join-Path $res 'drawable-xhdpi\tv_banner.png')

Write-Host 'icons written'
